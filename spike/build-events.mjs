/**
 * 离线因子表构建管线（开发期一次性任务，不属于插件运行时）。
 *
 * 目的：让插件在**腾讯不可用时**也能拿到正确的复权事件，摆脱"精度依赖源站健康度"。
 *
 * 阶段（可单独运行、全部带缓存、可续跑）：
 *   A 基础事件：东财数据中心**按报告期批量**拉分红送转（全市场，每期约 10 页）
 *   B 差异探测：逐只拉「东财原始价 + 东财后复权」，用 hfq 当日隐含跳变与推导因子比对，
 *               偏差 > 阈值的股票进入 flagged（这类事件就是"东财漏记同日多笔分配"）
 *   C 事件修正：对 flagged 股票拉腾讯 K 线内嵌事件，与东财事件合并 + hfq 仲裁
 *   D 产出：data/factor-events.json.gz（紧凑数组）+ data/factor-events.meta.json（来源与统计）
 *
 * 用法:
 *   node spike/build-events.mjs --phase=A                 # 只跑批量分红
 *   node spike/build-events.mjs --phase=B --limit=200     # 差异探测（限 200 只）
 *   node spike/build-events.mjs --phase=C                 # 修正所有 flagged
 *   node spike/build-events.mjs --phase=all --limit=200   # 串起来（演示用）
 *
 * 全量构建规模（5400 只）：A 约 640 次请求；B 约 10,800 次请求（2/只）；C 仅对 flagged。
 * 按 3–4 req/s 礼貌限速，A 约 3–5 分钟、B 约 45–60 分钟。**建议离线跑一次并入库**。
 */

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { emDatacenter, emKline, emList, tencentKline, rawKline, ALL_A_FS } from '../lib/data/sources.mjs'
import { mergeDividendEvents, resolveEventFactors, fromEmDividend } from '../lib/data/events.mjs'
import { mapPool, httpSummary, resetCircuits } from '../lib/data/http.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)=?(.*)$/.exec(a)
  return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true]
}))
const PHASE = String(args.phase ?? 'all')
const LIMIT = args.limit ? Number(args.limit) : Infinity
const CACHE = 'spike/out/build-cache'
const OUT_DIR = 'data'
const MISMATCH_TOL_PCT = Number(args.tol ?? 1.0)
const CONCURRENCY = Number(args.concurrency ?? 3)
const REPORT_FROM = Number(args.from ?? 2015)
const REPORT_TO = Number(args.to ?? 2026)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cachePath = (...p) => join(CACHE, ...p)

async function readCache(path) {
  if (!existsSync(path)) return null
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}
async function writeCache(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

const stats = { phaseA: null, phaseB: null, phaseC: null, startedAt: new Date().toISOString() }

// ── A 基础事件：按报告期批量 ────────────────────────────────────────────────
async function phaseA() {
  const periods = []
  for (let y = REPORT_FROM; y <= REPORT_TO; y++) for (const md of ['03-31', '06-30', '09-30', '12-31']) periods.push(`${y}-${md}`)
  const base = new Map() // `${code}|${exDate}` → {code, exDate, cash, bonus, transfer, plans[]}
  let requests = 0
  for (const reportDate of periods) {
    const cpath = cachePath('dividends', `${reportDate}.json`)
    let rows = await readCache(cpath)
    if (rows === null) {
      const r = await emDatacenter('RPT_SHAREBONUS_DET', {
        filter: `(REPORTDATE='${reportDate}')`,
        pageSize: 500, maxPages: 30, sortColumns: 'SECURITY_CODE',
      })
      rows = r.rows.map((x) => ({
        code: String(x.SECURITY_CODE).padStart(6, '0'),
        exDate: x.EX_DIVIDEND_DATE ? Number(String(x.EX_DIVIDEND_DATE).slice(0, 10).replace(/-/g, '')) : null,
        cashPerShare: (x.PRETAX_BONUS_RMB ?? 0) / 10,
        bonusPerShare: (x.BONUS_RATIO ?? 0) / 10,
        transferPerShare: (x.IT_RATIO ?? 0) / 10,
        plan: x.IMPL_PLAN_PROFILE ?? null,
        progress: x.ASSIGN_PROGRESS ?? null,
        noticeDate: x.NOTICE_DATE ? Number(String(x.NOTICE_DATE).slice(0, 10).replace(/-/g, '')) : null,
      })).filter((x) => x.exDate && x.progress === '实施分配')
      await writeCache(cpath, rows)
      requests++
      await sleep(120)
    }
    for (const row of rows) {
      const key = `${row.code}|${row.exDate}`
      const g = base.get(key) ?? { code: row.code, exDate: row.exDate, cash: 0, bonus: 0, transfer: 0, plans: [] }
      g.cash += row.cashPerShare; g.bonus += row.bonusPerShare; g.transfer += row.transferPerShare
      if (row.plan) g.plans.push(row.plan)
      base.set(key, g)
    }
  }
  const out = [...base.values()].map((g) => ({
    code: g.code, exDate: g.exDate,
    cashPerShare: +g.cash.toFixed(6), bonusPerShare: +g.bonus.toFixed(6), transferPerShare: +g.transfer.toFixed(6),
    source: 'em-bulk', plans: g.plans,
  }))
  stats.phaseA = { periods: periods.length, events: out.length, stocks: new Set(out.map((e) => e.code)).size, newRequests: requests }
  await writeCache(cachePath('events-base.json'), out)
  return out
}

// ── B 差异探测 ──────────────────────────────────────────────────────────────
async function phaseB(baseEvents) {
  const byCode = new Map()
  for (const e of baseEvents) {
    if (!byCode.has(e.code)) byCode.set(e.code, [])
    byCode.get(e.code).push(e)
  }
  const listed = await emList({ fs: ALL_A_FS, pageSize: 200, maxPages: 40 })
  let codes = listed.rows.map((r) => r.code)
  if (!codes.length) codes = [...byCode.keys()] // 东财列表不可用时退化为"有分红记录的股票"
  codes = codes.slice(0, LIMIT === Infinity ? codes.length : LIMIT)

  const results = []
  await mapPool(codes, CONCURRENCY, async (code) => {
    const cpath = cachePath('perstock', `${code}.json`)
    let rec = await readCache(cpath)
    if (rec === null) {
      const [raw, hfq] = await Promise.all([
        rawKline(code, { beg: '20150101', end: '20260923', tries: 4 }),
        emKline(code, { fqt: 2, beg: '20150101', end: '20260923', tries: 4 }),
      ])
      let hfqRows = hfq.rows
      let hfqSource = 'em'
      if (!hfqRows.length) {
        const t = await tencentKline(code, { period: 'hfq', begYear: 2015, endYear: 2026, tries: 3 })
        hfqRows = t.rows; hfqSource = 'tencent'
      }
      const evs = resolveEventFactors(byCode.get(code) ?? [], raw.rows, hfqRows)
      rec = {
        code, rawRows: raw.rows.length, hfqRows: hfqRows.length, hfqSource,
        provenance: raw.provenance ?? null,
        events: evs.map((e) => ({
          exDate: e.exDate, factor: e.factor ?? null,
          devPct: e.arbitration?.candidates ? Math.min(...e.arbitration.candidates.map((c) => c.devPct)) : null,
          chosen: e.arbitration?.chosen ?? null,
          reason: e.arbitration?.reason ?? null,
        })),
      }
      await writeCache(cpath, rec)
      await sleep(80)
    }
    results.push(rec)
  })

  const flagged = results.filter((r) => r.events.some((e) => e.devPct !== null && e.devPct > MISMATCH_TOL_PCT))
  stats.phaseB = {
    stocksProbed: results.length,
    flagged: flagged.length,
    flaggedCodes: flagged.slice(0, 50).map((r) => r.code),
    mismatchTolPct: MISMATCH_TOL_PCT,
    hfqSource: results.reduce((a, r) => { a[r.hfqSource] = (a[r.hfqSource] ?? 0) + 1; return a }, {}),
  }
  await writeCache(cachePath('flagged.json'), flagged.map((r) => r.code))
  return flagged.map((r) => r.code)
}

// ── C 事件修正（对 flagged 股票用腾讯内嵌事件） ─────────────────────────────
async function phaseC(baseEvents, flaggedCodes) {
  const byCode = new Map()
  for (const e of baseEvents) {
    if (!byCode.has(e.code)) byCode.set(e.code, [])
    byCode.get(e.code).push(e)
  }
  const corrections = []
  await mapPool(flaggedCodes, CONCURRENCY, async (code) => {
    const cpath = cachePath('tencent', `${code}.json`)
    let tx = await readCache(cpath)
    if (tx === null) {
      const t = await tencentKline(code, { period: 'raw', begYear: 2010, endYear: 2026, tries: 4 })
      tx = t.events ?? []
      await writeCache(cpath, tx)
      await sleep(80)
    }
    if (!tx.length) return
    const em = (byCode.get(code) ?? []).map((e) => ({
      code, exDate: e.exDate, cashPerShare: e.cashPerShare, bonusPerShare: e.bonusPerShare,
      transferPerShare: e.transferPerShare, plan: e.plans?.[0] ?? null,
    }))
    const { events, disagreements } = mergeDividendEvents({ tencentEvents: tx, emEvents: em })
    for (const e of events) {
      if (e.mergeMode === 'same-distribution' || e.mergeMode === 'em-only') continue
      corrections.push({
        code: e.code, exDate: e.exDate,
        cashPerShare: e.cashPerShare, bonusPerShare: e.bonusPerShare, transferPerShare: e.transferPerShare,
        mergeMode: e.mergeMode,
        candidates: e.candidates ?? null,
        plans: e.plans ?? [],
      })
    }
    if (disagreements.length) {
      const prev = (await readCache(cachePath('disagreements.json'))) ?? []
      await writeCache(cachePath('disagreements.json'), prev.concat(disagreements.map((d) => ({ ...d, plans: tx.find((t) => t.exDate === d.exDate)?.planText ?? null }))))
    }
  })
  stats.phaseC = { flaggedStocks: flaggedCodes.length, corrections: corrections.length }
  await writeCache(cachePath('events-corrections.json'), corrections)
  return corrections
}

// ── D 产出 ──────────────────────────────────────────────────────────────────
async function produce(baseEvents, corrections) {
  const map = new Map()
  for (const e of baseEvents) map.set(`${e.code}|${e.exDate}`, e)
  for (const c of corrections) {
    map.set(`${c.code}|${c.exDate}`, {
      code: c.code, exDate: c.exDate,
      cashPerShare: c.cashPerShare, bonusPerShare: c.bonusPerShare, transferPerShare: c.transferPerShare,
      source: `corrected:${c.mergeMode}`, plans: c.plans ?? [],
    })
  }
  const events = [...map.values()].sort((a, b) => (a.code === b.code ? a.exDate - b.exDate : a.code.localeCompare(b.code)))
  // 紧凑数组：[code, exDate, cash, bonus, transfer, sourceCode]
  const SRC = { 'em-bulk': 0, 'corrected:same-distribution': 1, 'corrected:two-distributions-summed': 2, 'corrected:tencent-only': 3, 'corrected:em-only': 4 }
  const packed = events.map((e) => [e.code, e.exDate, e.cashPerShare, e.bonusPerShare, e.transferPerShare, SRC[e.source] ?? 9])
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    convention: 'cash/bonus/transfer 均为每股口径；factor 由运行时用 round(前收-现金)/(1+送+转),2 计算',
    sourceCodes: SRC,
    events: packed,
  }
  await mkdir(OUT_DIR, { recursive: true })
  const json = JSON.stringify(payload)
  await writeFile(join(OUT_DIR, 'factor-events.json.gz'), gzipSync(json, { level: 9 }))
  const meta = {
    ...payload, events: undefined,
    counts: {
      total: events.length,
      stocks: new Set(events.map((e) => e.code)).size,
      corrected: corrections.length,
      bySource: events.reduce((a, e) => { a[e.source] = (a[e.source] ?? 0) + 1; return a }, {}),
    },
    buildStats: stats,
    http: httpSummary(),
  }
  await writeFile(join(OUT_DIR, 'factor-events.meta.json'), JSON.stringify(meta, null, 2))
  return { events, meta }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
resetCircuits()
let base = await readCache(cachePath('events-base.json'))
if (!base || PHASE === 'A') {
  console.log('[A] 批量拉取分红送转 ...')
  base = await phaseA()
}
console.log(`[A] 基础事件 ${base.length} 条（${stats.phaseA?.stocks ?? new Set(base.map((e) => e.code)).size} 只股票）`)

let corrections = await readCache(cachePath('events-corrections.json'))
if (PHASE === 'B' || PHASE === 'C' || PHASE === 'all') {
  console.log(`[B] 差异探测（上限 ${LIMIT === Infinity ? '全部' : LIMIT} 只）...`)
  const flagged = await phaseB(base)
  console.log(`[B] 探测完成，flagged ${flagged.length} 只：${flagged.slice(0, 10).join(',')}${flagged.length > 10 ? ' ...' : ''}`)
  if (flagged.length) {
    console.log('[C] 修正 flagged 股票的事件 ...')
    corrections = await phaseC(base, flagged)
    console.log(`[C] 修正 ${corrections.length} 条事件`)
  } else corrections = corrections ?? []
}
corrections = corrections ?? []

const { meta } = await produce(base, corrections)
console.log('\n=== 产出 ===')
console.log(JSON.stringify(meta.counts, null, 2))
console.log('buildStats:', JSON.stringify(stats, null, 1).slice(0, 800))
console.log('http:', JSON.stringify(meta.http.byHost))

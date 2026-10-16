/**
 * P0-G1/G2 — 数据可得性与限速实测（v2：带多源回退）
 *
 * v1 的教训：`push2his.eastmoney.com` 会被 IP 级拒绝（http=000），而同路径的
 * `push2.eastmoney.com` 正常。故适配层必须自带主机回退，且回退链要实测。
 *
 * G1a 复权因子链（raw vs 后复权）+ 官方涨跌幅对账
 * G1b 停牌（volume=0 / 缺失交易日）
 * G1c 涨跌停（官方 pct + 限价校验）
 * G1d ST / 退市 / 基本面批量（NOTICE_DATE）
 * G2  并发与成功率（真实代码，非合成）
 *
 * 用法: node spike/p0-eastmoney-probe.mjs [输出目录]
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const OUT_DIR = process.argv[2] ?? 'spike/out'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const CLIST = 'https://push2.eastmoney.com/api/qt/clist/get'
const DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get'

// 东财 kline 主机回退链：同一路径与 schema，仅主机不同
const EM_KLINE_HOSTS = [
  'https://push2.eastmoney.com/api/qt/stock/kline/get',
  'https://push2his.eastmoney.com/api/qt/stock/kline/get',
]
const TX_KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
const SOHU_KLINE = 'https://q.stock.sohu.com/hisHq'

const stats = { em: {}, tx: 0, sohu: 0, failures: [] }
const results = { startedAt: new Date().toISOString(), probes: {} }

async function getJson(url, { timeoutMs = 15000, referer = 'https://quote.eastmoney.com/' } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = performance.now()
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: referer }, signal: ctrl.signal })
    const text = await res.text()
    const ms = Math.round(performance.now() - t0)
    if (!res.ok) return { ok: false, status: res.status, ms, error: text.slice(0, 160) }
    try { return { ok: true, status: res.status, ms, json: JSON.parse(text) } }
    catch { return { ok: false, status: res.status, ms, error: 'non-json: ' + text.slice(0, 160) } }
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), error: String(e?.cause?.code ?? e?.message ?? e) }
  } finally { clearTimeout(timer) }
}

const n = (v) => (v === '' || v === '-' || v == null ? null : Number(v))

/** 东财 kline 规范：date,open,close,high,low,volume,amount,amplitude,pct,change,turnover */
function parseEmKlines(json) {
  return (json?.data?.klines ?? []).map((line) => {
    const [date, open, close, high, low, volume, amount, amplitude, pct, change, turnover] = line.split(',')
    return { date, open: n(open), close: n(close), high: n(high), low: n(low), volume: n(volume), amount: n(amount), amplitude: n(amplitude), pct: n(pct), change: n(change), turnover: n(turnover) }
  })
}

/** 腾讯 fqkline → 与东财同构（无 amount/pct，需自算） */
function parseTxKlines(json, code) {
  const node = json?.data?.[code] ?? {}
  const arr = node.qfqday ?? node.day ?? node.hfqday ?? []
  return arr.map((row) => {
    const [date, open, close, high, low, volume] = row
    return { date, open: n(open), close: n(close), high: n(high), low: n(low), volume: n(volume) != null ? n(volume) * 100 : null, amount: null, amplitude: null, pct: null, change: null, turnover: null }
  })
}

function emKlineUrl(host, secid, { fqt = 0, klt = 101, beg = '0', end = '20500101' } = {}) {
  return `${host}?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${klt}&fqt=${fqt}&beg=${beg}&end=${end}`
}
const txCode = (secid) => (secid.startsWith('1.') ? 'sh' : 'sz') + secid.slice(2)
function txKlineUrl(secid, { fqt = 0, beg = '2020-01-01', end = '2050-01-01', count = 10000 } = {}) {
  const period = fqt === 2 ? 'hfq' : 'qfq'
  return `${TX_KLINE}?param=${txCode(secid)},day,${beg},${end},${count},${period}`
}

/** 带主机回退的日线获取：返回 { source, host, rows } */
async function kline(secid, opts = {}) {
  for (const host of EM_KLINE_HOSTS) {
    const res = await getJson(emKlineUrl(host, secid, opts))
    const rows = res.ok ? parseEmKlines(res.json) : []
    const key = new URL(host).host
    if (rows.length > 0) { stats.em[key] = (stats.em[key] ?? 0) + 1; return { source: 'em', host: key, rows, ms: res.ms } }
    if (!res.ok) stats.failures.push({ secid, host: key, error: res.error })
  }
  const tx = await getJson(txKlineUrl(secid, opts), { referer: 'https://gu.qq.com/' })
  if (tx.ok) {
    const rows = parseTxKlines(tx.json, txCode(secid))
    if (rows.length > 0) { stats.tx++; return { source: 'tencent', host: 'web.ifzq.gtimg.cn', rows, ms: tx.ms } }
  }
  stats.failures.push({ secid, host: 'tencent', error: tx.error ?? 'empty' })
  return { source: null, rows: [] }
}

// ── G1a 复权因子链 + 官方涨跌幅对账 ──────────────────────────────────────────
async function probeAdjFactor() {
  const secid = '1.600519' // 贵州茅台：2020-06-24 除权
  const [rawR, hfqR] = await Promise.all([
    kline(secid, { fqt: 0, beg: '20200101', end: '20241231' }),
    kline(secid, { fqt: 2, beg: '20200101', end: '20241231' }),
  ])
  const raw = rawR.rows, hfq = hfqR.rows
  const byDate = new Map(hfq.map((k) => [k.date, k]))
  const ratios = raw.filter((k) => byDate.has(k.date) && k.close).map((k) => ({ date: k.date, factor: byDate.get(k.date).close / k.close }))
  let monotonic = true
  const jumps = []
  for (let i = 1; i < ratios.length; i++) {
    if (ratios[i].factor < ratios[i - 1].factor - 1e-9) monotonic = false
    const rel = ratios[i].factor / ratios[i - 1].factor - 1
    if (Math.abs(rel) > 1e-6) jumps.push({ date: ratios[i].date, deltaPct: +(rel * 100).toFixed(4) })
  }
  let maxDev = 0, devCount = 0, checked = 0
  for (let i = 1; i < hfq.length; i++) {
    const prev = hfq[i - 1].close, pct = hfq[i].pct
    if (!prev || pct == null) continue
    checked++
    const dev = Math.abs((hfq[i].close / prev - 1) * 100 - pct)
    if (dev > maxDev) maxDev = dev
    if (dev > 0.01) devCount++
  }
  return {
    ok: raw.length > 0 && hfq.length > 0, sources: { raw: rawR.source, hfq: hfqR.source },
    rawRows: raw.length, rows: ratios.length, monotonic,
    jumpCount: jumps.length, jumps: jumps.slice(0, 6),
    firstFactor: ratios[0] ? +ratios[0].factor.toFixed(6) : null,
    lastFactor: ratios.at(-1) ? +ratios.at(-1).factor.toFixed(6) : null,
    pctCrossCheck: { checked, maxDeviationPp: +maxDev.toFixed(6), over001pp: devCount },
  }
}

// ── G1b 停牌 + G1c 涨跌停 ────────────────────────────────────────────────────
async function probeSuspensionAndLimits() {
  const secids = ['1.600519', '0.000001', '0.300750', '1.601318', '0.002594', '1.688981', '0.000002', '1.600009', '0.002415', '1.601899']
  let zeroVolumeDays = 0, totalDays = 0, limitUp = 0, limitDown = 0
  let limitPriceMatched = 0, limitPriceChecked = 0
  const zeroExamples = [], limitExamples = []
  for (const secid of secids) {
    const { rows } = await kline(secid, { fqt: 0, beg: '20230101', end: '20241231' })
    for (let i = 0; i < rows.length; i++) {
      const k = rows[i]
      totalDays++
      if (k.volume === 0) { zeroVolumeDays++; if (zeroExamples.length < 5) zeroExamples.push(`${secid} ${k.date}`) }
      if (k.pct != null && Math.abs(k.pct) >= 9.8) {
        if (k.pct > 0) limitUp++; else limitDown++
        const prev = rows[i - 1]
        if (prev?.close) {
          limitPriceChecked++
          const up = +(prev.close * 1.1).toFixed(2), down = +(prev.close * 0.9).toFixed(2)
          const matched = Math.abs(k.close - up) < 0.011 || Math.abs(k.close - down) < 0.011
          if (matched) limitPriceMatched++
          if (limitExamples.length < 3) limitExamples.push({ secid, date: k.date, pct: k.pct, close: k.close, prevClose: prev.close, up, down, matched })
        }
      }
    }
  }
  return { ok: totalDays > 0, codesProbed: secids.length, totalDays, zeroVolumeDays, zeroExamples, limitUpDays: limitUp, limitDownDays: limitDown, limitPriceCheck: { checked: limitPriceChecked, matched: limitPriceMatched }, limitExamples }
}

// ── G1d 全域 / ST / 退市 / 基本面 ────────────────────────────────────────────
const ALL_A_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048'

async function probeUniverse() {
  const first = await getJson(`${CLIST}?pn=1&pz=200&po=0&np=1&fltt=2&invt=2&fid=f12&fs=${encodeURIComponent(ALL_A_FS)}&fields=f12,f13,f14,f2,f3`)
  if (!first.ok) return { ok: false, first }
  const diff = first.json?.data?.diff ?? []
  const stLike = diff.filter((d) => /ST/i.test(String(d.f14)))
  const delistLike = diff.filter((d) => /退/i.test(String(d.f14)))
  return {
    ok: true, totalUniverse: first.json?.data?.total, sampleSize: diff.length,
    stInSample: stLike.length, stSamples: stLike.slice(0, 3).map((d) => `${d.f12} ${d.f14}`),
    delistInSample: delistLike.length, delistSamples: delistLike.slice(0, 3).map((d) => `${d.f12} ${d.f14}`),
    hasMarketField: diff.every((d) => d.f13 != null), latencyMs: first.ms,
    // 供 G2 使用：真实代码
    secids: diff.slice(0, 60).map((d) => `${d.f13}.${d.f12}`),
  }
}

async function probeDelisted() {
  const board = await getJson(`${CLIST}?pn=1&pz=20&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+s:3&fields=f12,f14,f2`)
  const res = await kline('1.600001', { fqt: 0, beg: '20080101', end: '20091231' })
  return {
    ok: res.rows.length > 0,
    delistedBoardTotal: board.json?.data?.total ?? null,
    boardSample: (board.json?.data?.diff ?? []).slice(0, 3).map((d) => `${d.f12} ${d.f14}`),
    delistedHistory: { code: '600001', source: res.source, rows: res.rows.length, first: res.rows[0]?.date, last: res.rows.at(-1)?.date },
  }
}

async function probeFundamentals() {
  const mk = (page) => `${DC}?reportName=RPT_LICO_FN_CPD&columns=ALL&filter=${encodeURIComponent("(REPORTDATE='2024-12-31')")}&pageNumber=${page}&pageSize=500&sortColumns=SECURITY_CODE&sortTypes=1`
  const [p1, p2] = await Promise.all([getJson(mk(1)), getJson(mk(2))])
  if (!p1.ok) return { ok: false, p1 }
  const rows = [...(p1.json?.result?.data ?? []), ...(p2.ok ? (p2.json?.result?.data ?? []) : [])]
  const noticeDates = rows.map((r) => String(r.NOTICE_DATE ?? '').slice(0, 10)).filter(Boolean).sort()
  return {
    ok: rows.length > 0, pages: p1.json?.result?.pages, pageSize: 500,
    fetched: rows.length, distinctCodes: new Set(rows.map((r) => r.SECURITY_CODE)).size,
    withNoticeDate: rows.filter((r) => r.NOTICE_DATE).length,
    noticeDateRange: [noticeDates[0], noticeDates.at(-1)],
    fieldsPresent: ['BASIC_EPS', 'WEIGHTAVG_ROE', 'YSTZ', 'SJLTZ', 'BPS', 'XSMLL', 'TOTAL_OPERATE_INCOME'].filter((f) => rows.some((r) => r[f] != null)),
    latencyMs: p1.ms,
  }
}

// ── G2 并发与成功率（真实代码 + 主机回退） ───────────────────────────────────
async function probeConcurrency(concurrency, secids) {
  const lat = []
  let okCount = 0, failCount = 0, fallbackUsed = 0
  let idx = 0
  const t0 = performance.now()
  async function worker() {
    while (idx < secids.length) {
      const secid = secids[idx++]
      const r = await kline(secid, { fqt: 0, beg: '20240101', end: '20241231' })
      if (r.rows.length > 0) { okCount++; lat.push(r.ms ?? 0); if (r.source !== 'em' || r.host !== 'push2.eastmoney.com') fallbackUsed++ }
      else failCount++
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  const wall = performance.now() - t0
  lat.sort((a, b) => a - b)
  return {
    concurrency, requests: secids.length, ok: okCount, failed: failCount,
    successRate: +(okCount / secids.length).toFixed(4), fallbackUsed,
    wallMs: Math.round(wall), throughputPerSec: +(secids.length / (wall / 1000)).toFixed(2),
    p50: lat[Math.floor(lat.length * 0.5)] ?? null, p95: lat[Math.floor(lat.length * 0.95)] ?? null,
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const step = async (name, fn) => {
  process.stderr.write(`[probe] ${name} ...\n`)
  try { results.probes[name] = await fn() }
  catch (e) { results.probes[name] = { ok: false, error: String(e?.message ?? e) } }
  process.stderr.write(`[probe] ${name} -> ok=${results.probes[name].ok}\n`)
}

await step('adjFactor', probeAdjFactor)
await step('suspensionAndLimits', probeSuspensionAndLimits)
await step('universe', probeUniverse)
await step('delisted', probeDelisted)
await step('fundamentals', probeFundamentals)

const secids = results.probes.universe?.secids ?? []
if (secids.length >= 40) {
  await step('concurrency8', () => probeConcurrency(8, secids.slice(0, 40)))
  await step('concurrency16', () => probeConcurrency(16, secids.slice(0, 40)))
  await step('concurrency32', () => probeConcurrency(32, secids.slice(0, 40)))
}

results.sourceStats = stats
results.finishedAt = new Date().toISOString()
await mkdir(OUT_DIR, { recursive: true })
const outFile = join(OUT_DIR, 'p0-eastmoney.json')
await writeFile(outFile, JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
process.stderr.write(`\n[probe] written: ${outFile}\n`)

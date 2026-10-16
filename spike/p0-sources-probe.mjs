/**
 * P0-G1/G2 — 多源适配层实测（v3）
 *
 * v2 的教训：
 *  1. 东财 DNS 轮询到多个边缘节点，部分节点对同 IP 直接 RST（curl -4/-6 亦 000）→ 必须主机级回退 + 重试
 *  2. 腾讯 fqkline 单次区间有上限（传 2020→2050 返回空）→ 必须分段拉取
 *  3. `datacenter-web`（基本面）稳定性明显好于 push2 系
 *
 * v3 测量：
 *  A 各源单独成功率（每源 12 次，串行小请求）
 *  B 腾讯分段拉全历史是否成立
 *  C 复权因子链推导（EM: raw vs hfq；腾讯: day vs qfqday）+ 官方涨跌幅对账
 *  D 端到端回退链成功率（并发 4 / 8 / 16）
 *
 * 用法: node spike/p0-sources-probe.mjs [输出目录]
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const OUT_DIR = process.argv[2] ?? 'spike/out'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const REFERER = 'https://quote.eastmoney.com/'
const DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
const CLIST = 'https://push2.eastmoney.com/api/qt/clist/get'

const EM_HOSTS = ['https://push2.eastmoney.com/api/qt/stock/kline/get', 'https://push2his.eastmoney.com/api/qt/stock/kline/get']
const TX_HOST = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
const SOHU_HOST = 'https://q.stock.sohu.com/hisHq'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { startedAt: new Date().toISOString(), probes: {}, sourceLatency: {} }

async function getJson(url, { timeoutMs = 12000, referer = REFERER, raw = false } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = performance.now()
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: referer }, signal: ctrl.signal })
    const text = await res.text()
    const ms = Math.round(performance.now() - t0)
    if (!res.ok) return { ok: false, status: res.status, ms, error: `http ${res.status}` }
    if (raw) return { ok: true, status: res.status, ms, text }
    try { return { ok: true, status: res.status, ms, json: JSON.parse(text) } }
    catch { return { ok: false, status: res.status, ms, error: 'non-json' } }
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), error: String(e?.cause?.code ?? e?.message ?? e) }
  } finally { clearTimeout(timer) }
}

const n = (v) => (v === '' || v === '-' || v == null ? null : Number(v))

function parseEm(json) {
  return (json?.data?.klines ?? []).map((line) => {
    const [date, open, close, high, low, volume, amount, amplitude, pct, change, turnover] = line.split(',')
    return { date, open: n(open), close: n(close), high: n(high), low: n(low), volume: n(volume), amount: n(amount), amplitude: n(amplitude), pct: n(pct), change: n(change), turnover: n(turnover) }
  })
}

/** 腾讯 fqkline：段内返回 [{date,open,close,high,low,volume}]；volume 单位为手 */
function parseTxSection(json, code, period) {
  const node = json?.data?.[code]
  if (!node) return []
  const arr = node[period] ?? []
  return arr.map((row) => {
    const [date, open, close, high, low, volume] = row
    return { date, open: n(open), close: n(close), high: n(high), low: n(low), volume: n(volume) != null ? Math.round(n(volume) * 100) : null, amount: null, amplitude: null, pct: null, change: null, turnover: null }
  })
}

/** 搜狐 hisHq：[{code,stat,hq:[date,open,close,change,pct,low,high,volume(手),amount(万),turnover]}] */
function parseSohu(json) {
  const hq = json?.[0]?.hq ?? []
  return hq.map((row) => {
    const [date, open, close, , pct, low, high, volume, amount, turnover] = row
    return { date, open: n(open), close: n(close), high: n(high), low: n(low), volume: n(volume) != null ? Math.round(n(volume) * 100) : null, amount: n(amount) != null ? n(amount) * 1e4 : null, amplitude: null, pct: n(String(pct).replace('%', '')), change: null, turnover: n(String(turnover).replace('%', '')) }
  })
}

const txCode = (secid) => (secid.startsWith('1.') ? 'sh' : 'sz') + secid.slice(2)

// ── A. 各源单独成功率 ───────────────────────────────────────────────────────
async function sourceSuccess(secids, perSource = 12) {
  const result = { em: {}, tencent: { ok: 0, fail: 0, latencies: [], errors: [] }, sohu: { ok: 0, fail: 0, latencies: [], errors: [] } }
  for (const host of EM_HOSTS) result.em[new URL(host).host] = { ok: 0, fail: 0, latencies: [], errors: [] }

  for (let i = 0; i < perSource; i++) {
    const secid = secids[i % secids.length]
    // 东财
    for (const host of EM_HOSTS) {
      const h = new URL(host).host
      const r = await getJson(`${host}?secid=${secid}&fields1=f1,f2&fields2=f51,f53&klt=101&fqt=0&beg=20240101&end=20240301`)
      const rows = r.ok ? parseEm(r.json) : []
      if (rows.length) { result.em[h].ok++; result.em[h].latencies.push(r.ms) } else { result.em[h].fail++; result.em[h].errors.push(r.error ?? 'empty') }
      await sleep(120)
    }
    // 腾讯
    {
      const code = txCode(secid)
      const url = `${TX_HOST}?param=${code},day,2024-01-01,2024-03-01,120,qfq`
      const r = await getJson(url, { referer: 'https://gu.qq.com/' })
      const rows = r.ok ? parseTxSection(r.json, code, 'qfqday') : []
      if (rows.length) { result.tencent.ok++; result.tencent.latencies.push(r.ms) } else { result.tencent.fail++; result.tencent.errors.push(r.error ?? 'empty') }
      await sleep(120)
    }
    // 搜狐
    {
      const code = txCode(secid)
      const url = `${SOHU_HOST}?code=cn_${secid.slice(2)}&start=20240101&end=20240301`
      const r = await getJson(url, { referer: 'https://q.stock.sohu.com/' })
      const rows = r.ok ? parseSohu(r.json) : []
      if (rows.length) { result.sohu.ok++; result.sohu.latencies.push(r.ms) } else { result.sohu.fail++; result.sohu.errors.push(r.error ?? 'empty') }
      await sleep(120)
    }
  }
  const summarize = (s) => ({ ok: s.ok, fail: s.fail, successRate: +(s.ok / (s.ok + s.fail || 1)).toFixed(3), p50: s.latencies.sort((a, b) => a - b)[Math.floor(s.latencies.length / 2)] ?? null, errors: [...new Set(s.errors)].slice(0, 3) })
  return { em: Object.fromEntries(Object.entries(result.em).map(([k, v]) => [k, summarize(v)])), tencent: summarize(result.tencent), sohu: summarize(result.sohu) }
}

// ── B. 腾讯分段拉全历史 ─────────────────────────────────────────────────────
function* windows(begYear, endYear, stepYears = 2) {
  for (let y = begYear; y <= endYear; y += stepYears) yield [`${y}-01-01`, `${Math.min(y + stepYears - 1, endYear)}-12-31`]
}

async function tencentFullHistory(secid, begYear = 2020, endYear = 2024) {
  const code = txCode(secid)
  const period = 'qfqday'
  const seen = new Map()
  const segs = []
  for (const [beg, end] of windows(begYear, endYear, 2)) {
    const r = await getJson(`${TX_HOST}?param=${code},day,${beg},${end},800,qfq`, { referer: 'https://gu.qq.com/' })
    const rows = r.ok ? parseTxSection(r.json, code, period) : []
    segs.push({ beg, end, rows: rows.length, ok: r.ok })
    for (const row of rows) seen.set(row.date, row)
    await sleep(150)
  }
  const all = [...seen.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
  return { segments: segs, totalRows: all.length, first: all[0]?.date, last: all.at(-1)?.date, rows: all }
}

// ── C. 复权因子链推导 ───────────────────────────────────────────────────────
function deriveFactorChain(rawRows, adjRows, label) {
  const adj = new Map(adjRows.map((k) => [k.date, k]))
  const ratios = rawRows.filter((k) => adj.has(k.date) && k.close).map((k) => ({ date: k.date, factor: adj.get(k.date).close / k.close }))
  if (!ratios.length) return { ok: false, label }
  let monotonic = true
  const jumps = []
  for (let i = 1; i < ratios.length; i++) {
    if (ratios[i].factor < ratios[i - 1].factor - 1e-9) monotonic = false
    const rel = ratios[i].factor / ratios[i - 1].factor - 1
    if (Math.abs(rel) > 1e-6) jumps.push({ date: ratios[i].date, deltaPct: +(rel * 100).toFixed(4) })
  }
  return { ok: true, label, rows: ratios.length, monotonic, jumpCount: jumps.length, jumps: jumps.slice(0, 6), first: +ratios[0].factor.toFixed(6), last: +ratios.at(-1).factor.toFixed(6) }
}

function pctCrossCheck(rows, label) {
  let maxDev = 0, over = 0, checked = 0
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].close, pct = rows[i].pct
    if (!prev || pct == null) continue
    checked++
    const dev = Math.abs((rows[i].close / prev - 1) * 100 - pct)
    if (dev > maxDev) maxDev = dev
    if (dev > 0.01) over++
  }
  return { label, checked, maxDeviationPp: +maxDev.toFixed(6), over001pp: over }
}

async function probeAdjFactors() {
  const secid = '1.600519'
  const emRaw = await getJson(`${EM_HOSTS[0]}?secid=${secid}&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=0&beg=20200101&end=20241231`)
  const emHfq = await getJson(`${EM_HOSTS[0]}?secid=${secid}&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=2&beg=20200101&end=20241231`)
  const raw = emRaw.ok ? parseEm(emRaw.json) : []
  const hfq = emHfq.ok ? parseEm(emHfq.json) : []
  const txRaw = await tencentFullHistory(secid)
  const txQfqRows = txRaw.rows // qfqday
  const txRawRows = await (async () => {
    const code = txCode(secid); const seen = new Map()
    for (const [beg, end] of windows(2020, 2024, 2)) {
      const r = await getJson(`${TX_HOST}?param=${code},day,${beg},${end},800,`, { referer: 'https://gu.qq.com/' })
      const rows = r.ok ? parseTxSection(r.json, code, 'day') : []
      for (const row of rows) seen.set(row.date, row)
      await sleep(150)
    }
    return [...seen.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
  })()
  return {
    ok: raw.length > 0 || txQfqRows.length > 0,
    em: { rawRows: raw.length, hfqRows: hfq.length, factorChain: deriveFactorChain(raw, hfq, 'em raw vs hfq'), pctCheck: pctCrossCheck(hfq, 'em hfq') },
    tencent: { qfqRows: txQfqRows.length, rawRows: txRawRows.length, factorChain: deriveFactorChain(txRawRows, txQfqRows, 'tx day vs qfqday') },
  }
}

// ── D. 端到端回退链（EM 主机 → EM 备主机 → 腾讯分段 → 搜狐） ────────────────
async function fetchDailyWithFallback(secid, { beg = '20240101', end = '20241231', begYear = 2024, endYear = 2024 } = {}) {
  const attempts = []
  for (const host of EM_HOSTS) {
    const r = await getJson(`${host}?secid=${secid}&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=0&beg=${beg}&end=${end}`)
    const rows = r.ok ? parseEm(r.json) : []
    attempts.push({ src: new URL(host).host, ok: rows.length > 0, ms: r.ms, err: r.error })
    if (rows.length) return { source: new URL(host).host, rows: rows.length, ms: r.ms, attempts }
  }
  const code = txCode(secid); const seen = new Map()
  for (const [b, e] of windows(begYear, endYear, 2)) {
    const r = await getJson(`${TX_HOST}?param=${code},day,${b},${e},800,`, { referer: 'https://gu.qq.com/' })
    for (const row of (r.ok ? parseTxSection(r.json, code, 'day') : [])) seen.set(row.date, row)
    await sleep(120)
  }
  attempts.push({ src: 'tencent', ok: seen.size > 0 })
  if (seen.size) return { source: 'tencent', rows: seen.size, attempts }
  const sh = await getJson(`${SOHU_HOST}?code=cn_${secid.slice(2)}&start=${beg}&end=${end}`, { referer: 'https://q.stock.sohu.com/' })
  const shRows = sh.ok ? parseSohu(sh.json) : []
  attempts.push({ src: 'sohu', ok: shRows.length > 0, err: sh.error })
  return { source: shRows.length ? 'sohu' : null, rows: shRows.length, attempts }
}

async function endToEnd(concurrency, secids) {
  let ok = 0, fail = 0
  const bySource = {}
  let idx = 0
  const t0 = performance.now()
  async function worker() {
    while (idx < secids.length) {
      const secid = secids[idx++]
      const r = await fetchDailyWithFallback(secid)
      if (r.rows > 0) { ok++; bySource[r.source] = (bySource[r.source] ?? 0) + 1 } else fail++
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  const wall = performance.now() - t0
  return { concurrency, requests: secids.length, ok, fail, successRate: +(ok / secids.length).toFixed(4), bySource, wallMs: Math.round(wall), throughputPerSec: +(secids.length / (wall / 1000)).toFixed(2) }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
process.stderr.write('[probe] 取真实代码表 ...\n')
const listRes = await getJson(`${CLIST}?pn=1&pz=200&po=0&np=1&fltt=2&invt=2&fid=f12&fs=${encodeURIComponent('m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23')}&fields=f12,f13,f14`)
const universe = listRes.ok ? (listRes.json?.data?.diff ?? []) : []
const secids = universe.map((d) => `${d.f13}.${d.f12}`)
out.universe = { ok: universe.length > 0, total: listRes.json?.data?.total ?? null, sample: universe.length, secids: secids.slice(0, 5) }

const step = async (name, fn) => {
  process.stderr.write(`[probe] ${name} ...\n`)
  try { out.probes[name] = await fn() } catch (e) { out.probes[name] = { ok: false, error: String(e?.message ?? e) } }
  process.stderr.write(`[probe] ${name} -> ok=${out.probes[name]?.ok}\n`)
}

await step('sourceSuccess', () => sourceSuccess(secids.length ? secids : ['1.600519', '0.000001', '0.300750'], 12))
await step('tencentFullHistory', () => tencentFullHistory('1.600519', 2020, 2024).then((r) => ({ ok: r.totalRows > 1000, ...r, rows: undefined })))
await step('adjFactors', probeAdjFactors)
if (secids.length >= 32) {
  await step('endToEnd4', () => endToEnd(4, secids.slice(0, 32)))
  await step('endToEnd8', () => endToEnd(8, secids.slice(0, 32)))
  await step('endToEnd16', () => endToEnd(16, secids.slice(0, 32)))
}
await step('fundamentalsStillOk', async () => {
  const r = await getJson(`${DC}?reportName=RPT_LICO_FN_CPD&columns=ALL&filter=${encodeURIComponent("(REPORTDATE='2024-12-31')")}&pageNumber=1&pageSize=500`)
  const rows = r.json?.result?.data ?? []
  return { ok: rows.length > 0, rows: rows.length, pages: r.json?.result?.pages, withNoticeDate: rows.filter((x) => x.NOTICE_DATE).length, latencyMs: r.ms }
})
await step('delistedHistory', async () => {
  const r = await fetchDailyWithFallback('1.600001', { beg: '20080101', end: '20091231', begYear: 2008, endYear: 2009 })
  return { ok: r.rows > 0, source: r.source, rows: r.rows }
})

out.finishedAt = new Date().toISOString()
await mkdir(OUT_DIR, { recursive: true })
const outFile = join(OUT_DIR, 'p0-sources.json')
await writeFile(outFile, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
process.stderr.write(`\n[probe] written: ${outFile}\n`)

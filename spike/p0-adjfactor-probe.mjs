/**
 * P0-G1a — 复权因子链与官方涨跌幅对账（以「后复权」为基准）
 *
 * 教训：厂商的「前复权(qfq) ÷ 不复权(raw)」比值**不是**复权因子链
 * （实测 1212 根里 1204 处跳变、非单调）。因子链必须以**后复权**为基准。
 *
 * 本脚本验证：
 *  1. EM  push2his fqt=0 vs fqt=2  → 因子链是否单调、跳变点是否落在除权日
 *  2. 腾讯 day vs hfqday           → 同上（跨厂商交叉验证）
 *  3. 用后复权收盘价自算涨跌幅 vs 官方 pct 字段 → 最大偏差
 *  4. 腾讯前复权 vs 东财后复权 → 是否互相印证（同一天的比值应一致）
 *
 * 用法: node spike/p0-adjfactor-probe.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const OUT = 'spike/out'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const EM = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
const TX = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url, referer = 'https://quote.eastmoney.com/') {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: referer } })
    const t = await res.text()
    if (!res.ok) return { ok: false, error: `http ${res.status}` }
    try { return { ok: true, json: JSON.parse(t) } } catch { return { ok: false, error: 'non-json' } }
  } catch (e) { return { ok: false, error: String(e?.cause?.code ?? e?.message) } }
}
const n = (v) => (v === '' || v === '-' || v == null ? null : Number(v))
const parseEm = (j) => (j?.data?.klines ?? []).map((l) => {
  const [date, open, close, high, low, volume, amount, amplitude, pct, change, turnover] = l.split(',')
  return { date, open: n(open), close: n(close), high: n(high), low: n(low), volume: n(volume), pct: n(pct), turnover: n(turnover) }
})

/** 东财取数（带重试，push2his 单次成功率约 92%） */
async function em(secid, fqt, beg, end, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await getJson(`${EM}?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=${fqt}&beg=${beg}&end=${end}`)
    const rows = r.ok ? parseEm(r.json) : []
    if (rows.length) return rows
    await sleep(250 * (i + 1))
  }
  return []
}

const txCode = (s) => (s.startsWith('1.') ? 'sh' : 'sz') + s.slice(2)
async function tx(secid, period, begYear, endYear, tries = 3) {
  const code = txCode(secid)
  const seen = new Map()
  for (let y = begYear; y <= endYear; y += 2) {
    const beg = `${y}-01-01`, end = `${Math.min(y + 1, endYear)}-12-31`
    let rows = []
    for (let i = 0; i < tries && rows.length === 0; i++) {
      const r = await getJson(`${TX}?param=${code},day,${beg},${end},800,${period}`, 'https://gu.qq.com/')
      const node = r.ok ? r.json?.data?.[code] : null
      rows = (node?.[period === 'hfq' ? 'hfqday' : period === 'qfq' ? 'qfqday' : 'day'] ?? []).map((row) => {
        const [date, open, close, high, low, volume] = row
        return { date, open: n(open), close: n(close), high: n(high), low: n(low), volume: n(volume) != null ? Math.round(n(volume) * 100) : null }
      })
      if (!rows.length) await sleep(250 * (i + 1))
    }
    for (const row of rows) seen.set(row.date, row)
    await sleep(150)
  }
  return [...seen.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

function chain(rawRows, adjRows, label) {
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
  return { ok: true, label, rows: ratios.length, monotonic, jumpCount: jumps.length, jumps: jumps.slice(0, 8), first: +ratios[0].factor.toFixed(6), last: +ratios.at(-1).factor.toFixed(6) }
}

function pctCheck(rows, label) {
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

/** 跨厂商交叉验证：东财后复权 / 腾讯后复权 应只差一个常数 */
function crossVendor(emHfq, txHfq) {
  const m = new Map(txHfq.map((k) => [k.date, k.close]))
  const ratios = emHfq.filter((k) => m.has(k.date) && k.close).map((k) => m.get(k.date) / k.close)
  if (ratios.length < 10) return { ok: false, rows: ratios.length }
  const min = Math.min(...ratios), max = Math.max(...ratios)
  return { ok: true, rows: ratios.length, min: +min.toFixed(6), max: +max.toFixed(6), spreadPct: +(((max - min) / min) * 100).toFixed(4) }
}

const result = { startedAt: new Date().toISOString(), cases: [] }
const CASES = [
  { secid: '1.600519', name: '贵州茅台（高分红，2020-06-24 除权）' },
  { secid: '0.000001', name: '平安银行（多年分红）' },
  { secid: '1.601318', name: '中国平安' },
  { secid: '0.300750', name: '宁德时代（2022 送转）' },
]

for (const c of CASES) {
  process.stderr.write(`[adj] ${c.name} ...\n`)
  const [emRaw, emHfq] = await Promise.all([
    em(c.secid, 0, '20200101', '20241231'),
    em(c.secid, 2, '20200101', '20241231'),
  ])
  const [txRaw, txHfq, txQfq] = await Promise.all([
    tx(c.secid, '', 2020, 2024),
    tx(c.secid, 'hfq', 2020, 2024),
    tx(c.secid, 'qfq', 2020, 2024),
  ])
  result.cases.push({
    ...c,
    rows: { emRaw: emRaw.length, emHfq: emHfq.length, txRaw: txRaw.length, txHfq: txHfq.length, txQfq: txQfq.length },
    emChain_hfq: chain(emRaw, emHfq, 'EM raw/hfq'),
    txChain_hfq: chain(txRaw, txHfq, 'TX day/hfqday'),
    txChain_qfq: chain(txRaw, txQfq, 'TX day/qfqday(反例)'),
    pctCheck_emHfq: pctCheck(emHfq, 'EM hfq close vs 官方pct'),
    pctCheck_emRaw: pctCheck(emRaw, 'EM raw close vs 官方pct'),
    crossVendorHfq: crossVendor(emHfq, txHfq),
  })
  await sleep(300)
}

result.finishedAt = new Date().toISOString()
await mkdir(OUT, { recursive: true })
const f = join(OUT, 'p0-adjfactor.json')
await writeFile(f, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
process.stderr.write(`[adj] written: ${f}\n`)

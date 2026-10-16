/**
 * P1 验收门：数据层对账。
 *
 * 流程：东财原始价/后复权 + 东财分红表 + 腾讯内嵌事件 → 合并事件 → 推导跳变比 → 四条校验。
 * 最终独立验收由 `spike/oracle-baostock.py` 完成（用交易所官方涨跌幅作基准）。
 *
 * 用法: node spike/verify-data.mjs [输出目录] [代码1,代码2,...]
 */

import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { openStore } from '../lib/data/store.mjs'
import { emKline, emDividends, tencentKline, rawKline } from '../lib/data/sources.mjs'
import { mergeDividendEvents, resolveEventFactors } from '../lib/data/events.mjs'
import { loadEventTable, applyEventTable } from '../lib/data/eventTable.mjs'
import { runVerification } from '../lib/data/verify.mjs'
import { mapPool, httpSummary } from '../lib/data/http.mjs'

const OUT = process.argv[2] ?? 'spike/out'
const DB = join(OUT, 'p1-verify.db')
const TODAY = 20260923

const DEFAULT_CODES = [
  '600519', '000001', '300750', '603535', '600283', '600001',
  '601318', '000002', '002594', '688981', '300059', '600036',
  '601899', '000858', '002415',
]

const codes = (process.argv[3] ? process.argv[3].split(',') : DEFAULT_CODES).map((c) => c.trim()).filter(Boolean)

const table = loadEventTable()
console.log(`离线因子表：${table.available ? `已加载 v${table.version}（${table.size} 条事件，生成于 ${table.generatedAt}）` : '未找到（' + table.path + '）'}`)

await mkdir(OUT, { recursive: true })
await rm(DB, { force: true })
const store = openStore(DB)

const perCode = []
const allDisagreements = []
await mapPool(codes, 3, async (code) => {
  const t0 = Date.now()
  const beg = code === '600001' ? 20070101 : 20180101
  const begYear = Math.floor(beg / 10000)
  const endYear = 2026
  const rec = { code, ok: false }

  const [raw, hfqEm, div, tx] = await Promise.all([
    rawKline(code, { beg, end: TODAY, tries: 6 }),
    emKline(code, { fqt: 2, beg, end: TODAY, tries: 4 }),
    emDividends(code),
    tencentKline(code, { period: 'raw', begYear, endYear, tries: 5 }),
  ])
  // 后复权基准：东财优先，被熔断时用腾讯 hfqday（同样只作交叉校验用）
  let hfq = hfqEm
  if (!hfqEm.ok || hfqEm.rows.length === 0) {
    const t = await tencentKline(code, { period: 'hfq', begYear, endYear, tries: 4 })
    hfq = { ok: t.ok, rows: t.rows, source: 'tencent', error: t.ok ? null : 'tencent-hfq-empty' }
  }

  rec.raw = { ok: raw.ok, rows: raw.rows.length, provenance: raw.provenance ?? raw.source, error: raw.error ?? raw.emError ?? null, name: raw.name ?? null }
  rec.hfq = { ok: hfq.ok, rows: hfq.rows.length, source: hfq.source ?? 'em', error: hfq.error ?? null }
  rec.emDividends = div.rows.length
  rec.tencentEvents = tx.events?.length ?? 0

  if (raw.ok && raw.rows.length) {
    store.upsertBars(code, raw.rows)
    store.upsertCodes([{ code, name: raw.name ?? code, market: Number(code.startsWith('6') ? 1 : 0), board: null, isSt: /ST/i.test(raw.name ?? '') }])
  }
  if (hfq.ok && hfq.rows.length) store.upsertHfq(code, hfq.rows)

  const { events, disagreements } = mergeDividendEvents({ tencentEvents: tx.events ?? [], emEvents: div.rows })
  allDisagreements.push(...disagreements)
  const applied = applyEventTable(events, table, code)
  const withFactors = resolveEventFactors(applied.events, raw.rows, hfq.rows)
  store.upsertAdjEvents(code, withFactors)
  rec.events = withFactors.length
  rec.eventsWithoutFactor = withFactors.filter((e) => !e.factor).length
  rec.disagreements = disagreements.length
  rec.fromTable = applied.fromTable
  rec.tableOverrides = applied.overridden
  rec.arbitrated = withFactors.filter((e) => e.arbitration?.reason === 'hfq-implied-step').length
  rec.arbitrationPicks = withFactors.filter((e) => e.arbitration?.reason === 'hfq-implied-step').map((e) => `${e.exDate}:${e.arbitration.chosen}`)

  store.setSyncState(code, {
    barsLast: raw.rows.at(-1)?.date ?? null,
    hfqLast: hfq.rows.at(-1)?.date ?? null,
    adjLast: withFactors.at(-1)?.exDate ?? null,
    status: raw.ok ? 'ok' : 'error',
    error: raw.ok ? null : `raw:${raw.error ?? '-'}`,
  })
  rec.ok = raw.ok && raw.rows.length > 0
  rec.ms = Date.now() - t0
  perCode.push(rec)
})

const okCodes = perCode.filter((p) => p.ok && p.raw.rows >= 100).map((p) => p.code)
const verification = okCodes.length > 0
  ? runVerification(store, okCodes, { disagreements: allDisagreements })
  : { codes: [], raw: [], events: [], jumps: [], steps: [], summary: {}, gates: {}, verdict: 'NO_DATA' }
const stats = store.stats()
store.close()

// 门必须要求真实数据量，否则"没有数据所以没有偏差"会伪装成 PASS
if (verification.verdict !== 'NO_DATA') {
  const totalBars = stats.bars
  if (okCodes.length < 3 || totalBars < 1000) {
    verification.gates.E_sufficient_data = false
    verification.verdict = 'INSUFFICIENT_DATA'
  } else {
    verification.gates.E_sufficient_data = true
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  db: DB,
  samples: perCode.sort((a, b) => a.code.localeCompare(b.code)),
  store: stats,
  verification,
  http: httpSummary(),
}
report.verdict = verification.verdict
await writeFile(join(OUT, 'p1-verify.json'), JSON.stringify(report, null, 2))

console.log('样本抓取：')
for (const s of report.samples) {
  console.log(`  ${s.code} ${s.raw.name ?? ''} raw=${s.raw.rows}(${s.raw.provenance}) hfq=${s.hfq.rows}(${s.hfq.source}) 东财事件=${s.emDividends} 腾讯事件=${s.tencentEvents} 合并=${s.events} 分歧=${s.disagreements} 表内=${s.fromTable ?? 0}(覆盖${s.tableOverrides ?? 0}) 仲裁=${s.arbitrated ?? 0}${s.arbitrationPicks?.length ? ' [' + s.arbitrationPicks.join(' ') + ']' : ''} ${s.ok ? '' : '(raw 失败: ' + (s.raw.error ?? '-') + ')'} ${s.ms}ms`)
}
console.log('\n仓库：', JSON.stringify(stats))
console.log('\n对账：')
for (const r of verification.raw) console.log(`  A raw 完整性 ${r.code}: ${r.checked} 天, 最大偏差 ${r.maxDeviationPp}pp, 超0.01pp ${r.over001pp} 天`)
for (const j of verification.jumps) console.log(`  C 除权跳变 ${j.code}: ${j.exDatesWithBar} 个除权日, raw 最大 |${j.maxAbsRawPct}%| → 复权后 |${j.maxAbsAdjPct}%|, 在涨跌停内=${j.adjWithinLimit}`)
for (const s of verification.steps) console.log(`  D 跳变比 ${s.code}: 可比 ${s.compared}, 最大偏差 ${s.maxDevPct}%, 超2% ${s.overTolerance}`)
console.log('\n事件源分歧（预期存在，并集才完整）：')
for (const d of allDisagreements.slice(0, 6)) console.log(`  ${d.code} ${d.exDate}: 腾讯 ${JSON.stringify(d.tencent)} vs 东财 ${JSON.stringify(d.em)}`)
console.log('\n汇总：', JSON.stringify(verification.summary))
console.log('门：', JSON.stringify(verification.gates), '→', verification.verdict)
console.log('HTTP：', JSON.stringify(report.http.byHost))

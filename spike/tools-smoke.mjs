/**
 * P3 工具面冒烟：把 29 个 quant_* 工具**逐个真调用一次**。
 *
 * 为什么不是只检查"注册成功"：注册只证明 schema 合法。真正会坏的是
 * execute 里的数据访问、参数解析与错误分支 —— 那些只有调用才暴露。
 *
 * 用法: node spike/tools-smoke.mjs [数据目录]
 */

import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { createRuntime } from '../lib/runtime.mjs'
import { factorTools } from '../lib/tools/factor.mjs'
import { strategyTools } from '../lib/tools/strategy.mjs'
import { backtestTools } from '../lib/tools/backtest.mjs'
import { dataTools } from '../lib/tools/data.mjs'
import { portfolioTools } from '../lib/tools/portfolio.mjs'
import { autosyncTools } from '../lib/tools/autosync.mjs'
import { exportTools } from '../lib/tools/export.mjs'
import { createAutoSync } from '../lib/data/autosync.mjs'

const DIR = process.argv[2] ?? 'spike/out/quantdir'
// 用一份 P1 验证库做数据底座（15 只 / 2018–2026）
if (!existsSync(`${DIR}/quant.db`)) {
  mkdirSync(DIR, { recursive: true })
  copyFileSync('spike/out/p1-verify.db', `${DIR}/quant.db`)
}

const runtime = createRuntime({ dataDir: DIR })
const ALL = [
  ...factorTools(runtime), ...strategyTools(runtime), ...backtestTools(runtime),
  ...dataTools(runtime), ...portfolioTools(runtime),
  ...autosyncTools(runtime), ...exportTools(runtime),
]

// 给 runtime 挂上自动同步控制器，这样 `action=run_now` 走的是**真实**路径而不是 NO_CONTROLLER。
// 定时器是假的（回调永不触发），所以冒烟是确定性的、不会在后台偷偷跑。
const fakeTimer = { timeout: () => () => {}, interval: () => () => {} }
createAutoSync({ get: (n) => (n === 'timer' ? fakeTimer : undefined) }, runtime, {})

// cwd 给导出用：没有它 quant_export 会退回数据目录，冒烟就看不到"落进工作目录"这条路径
const FAKE_EXEC = { agent: { session: { header: { id: 'sess-smoke', cwd: 'spike/out/exports' }, events: [] } } }
let pass = 0, fail = 0
const results = []

async function call(name, args, { expectOk = true, network = false } = {}) {
  const t = ALL.find((x) => x.name === name)
  if (!t) { console.log(`❌ ${name} 未注册`); fail++; return null }
  let value
  try { value = await t.execute(args, FAKE_EXEC) } catch (e) {
    console.log(`❌ ${name} 抛出异常：${e.message}`); fail++; return null
  }
  const ok = value?.ok === true
  // 网络类工具：可达与不可达都是合法结果，只要给了结构化信封就算通过
  if (network && value !== null && typeof value?.ok === 'boolean') {
    pass++
    const rendered = t.output.render(args, value)[0].text
    results.push({ name, args, ok, rendered })
    console.log(`✅ ${name.padEnd(30)} [网络] ${String(rendered).split('\n')[0].slice(0, 70)}`)
    return value
  }
  if (ok === expectOk) {
    pass++
    // 渲染也要能跑通（render 抛错会让模型拿到一个空结果）
    let rendered
    try { rendered = t.output.render(args, value)[0].text } catch (e) { rendered = `⚠️ render 抛错：${e.message}`; fail++ }
    results.push({ name, args, ok, rendered })
    const mark = expectOk ? '✅' : '✅(预期失败)'
    console.log(`${mark} ${name.padEnd(30)} ${String(rendered).split('\n')[0].slice(0, 78)}`)
  } else {
    fail++
    console.log(`❌ ${name.padEnd(30)} ok=${value?.ok} ${JSON.stringify(value?.error ?? value).slice(0, 110)}`)
  }
  return value
}

console.log(`=== P3 工具面冒烟（${ALL.length} 个工具）===\n`)

console.log('── 数据域 ──')
await call('quant_data_status', {})
await call('quant_data_sync', { scope: 'bars', codes: ['600519', '000001'], resume: false }, { network: true })   // 网络不可用时也应给结构化结果
await call('quant_data_cleanup', { scope: 'panels', keep: 4 })
await call('quant_trading_calendar', { limit: 5 })
await call('quant_resolve_date', { expr: 'latest' })
await call('quant_resolve_date', { expr: '-20d' })
await call('quant_resolve_date', { expr: '2024-06-15' })
await call('quant_resolve_date', { expr: '这不是日期' }, { expectOk: false })
await call('quant_kline_history', { code: '600519', limit: 5, adjust: 'adj' })
await call('quant_kline_history', { code: '600519', limit: 5, adjust: 'raw' })
await call('quant_quote', { code: '600519' }, { network: true })                  // 走网络，失败也算通过（只要不抛）
await call('quant_financial_summary', { code: '600519' }, { network: true })
await call('quant_quarterly_financials', { reportDate: '2024-12-31', limit: 3 }, { network: true })
await call('quant_industry_stocks', { industry: '半导体' }, { network: true })
await call('quant_index_constituents', { index: '沪深300' }, { network: true })
await call('quant_index_constituents', { index: '不存在的指数' }, { expectOk: false })

console.log('\n── 因子域 ──')
await call('quant_factor_list', { limit: 3 })
await call('quant_factor_search', { query: '动量' })
await call('quant_factor_preview', { formula: '$close / Ref($close, 20) - 1', topN: 3 })
await call('quant_factor_preview', { formula: 'Evil($close, 5)' }, { expectOk: false })
await call('quant_factor_create', { id: 'smoke_mom10', name: '10日动量', formula: '$close / Ref($close, 10) - 1' })
await call('quant_factor_create', { id: 'BAD-ID', formula: '$close' }, { expectOk: false })
await call('quant_factor_create', { id: 'smoke_bad', formula: '$nope' }, { expectOk: false })

console.log('\n── 策略域 ──')
const composed = await call('quant_strategy_compose', { factorIds: ['momentum_1m'], name: '冒烟动量', topK: 3, rebalance: 'monthly', start: 20190101, end: 20260923 })
await call('quant_strategy_compose', { factorIds: ['不存在的因子'] }, { expectOk: false })
await call('quant_strategy_compose', { factorIds: ['momentum_1m'], topK: 9999 }, { expectOk: false })
if (composed?.ok) {
  await call('quant_strategy_save', { strategyId: 'smoke_mom', config: composed.config })
  await call('quant_strategy_save', { strategyId: 'smoke_mom', config: { ...composed.config, name: '冒烟动量v2', selection: { rule: 'top_k', k: 5 } } })
}
await call('quant_strategy_load', { strategyId: 'smoke_mom' })
await call('quant_strategy_load', { strategyId: '不存在' }, { expectOk: false })
await call('quant_strategy_list', {})
await call('quant_strategy_search', { query: '冒烟' })
await call('quant_strategy_versions', { strategyId: 'smoke_mom', compare: [1, 2] })

console.log('\n── 回测域 ──')
const bt = await call('quant_backtest_run', { strategyId: 'smoke_mom', config: { ...composed.config, start: 20240101, end: 20260923 } })
if (bt?.ok) {
  await call('quant_backtest_get', { backtestId: bt.backtestId })
  await call('quant_backtest_analyze', { backtestId: bt.backtestId })
}
await call('quant_backtest_get', { backtestId: 'bt_不存在' }, { expectOk: false })
await call('quant_backtest_run', { strategyId: 'smoke_mom', config: { ...composed.config, start: 20150101, end: 20260923 } }, { expectOk: false })  // 长区间需确认
await call('quant_select_stocks', { formula: '$close / Ref($close, 20) - 1', topK: 3 })
await call('quant_select_stocks', { factorId: 'momentum_1m', topK: 3 })
await call('quant_optimize_parameters', { strategyId: 'smoke_mom', space: { topK: [2, 3], rebalance: ['monthly'] } })
await call('quant_optimize_parameters', { strategyId: 'smoke_mom', space: { topK: [1, 2, 3, 4, 5, 6], rebalance: ['daily', 'weekly', 'monthly'], weight: ['equal', 'factor'], buffer: [1, 2, 3] } }, { expectOk: false })  // 108 组 > 100 → 护栏

console.log('\n── 仓位域 ──')
await call('quant_save_holdings', { holdings: [{ code: '600519', shares: 100, cost: 1500 }, { code: '000001', shares: 1000, cost: 11 }] })
await call('quant_save_holdings', { holdings: [{ code: '600519', shares: -5 }] }, { expectOk: false })
await call('quant_portfolio_status', { cash: 50000 })
await call('quant_save_position_rules', { maxPositionPct: 0.2, stopLossPct: 0.1 })
await call('quant_save_position_rules', { stopLossPct: 1.5 }, { expectOk: false })

console.log('\n── 自动同步域 ──')
await call('quant_autosync', { action: 'get' })
// 开启 = 长期授权：不带 confirm 必须被拦（这是 P5 决策 A 的那道门）
await call('quant_autosync', { action: 'enable' }, { expectOk: false })
await call('quant_autosync', { action: 'enable', at: '25:99', confirm: true }, { expectOk: false })   // 非法时刻
await call('quant_autosync', { action: 'enable', at: '18:30', codes: ['600519'], confirm: true })
await call('quant_autosync', { action: 'get' })
// 手动补跑：范围被授权收窄到 1 只，网络可达与否都算通过
await call('quant_autosync', { action: 'run_now' }, { network: true })
await call('quant_autosync', { action: 'disable' })

console.log('\n── 导出域 ──')
await call('quant_export', { kind: 'data_status' })
await call('quant_export', { kind: 'select', formula: '$close / Ref($close, 20) - 1', topK: 3, format: 'both' })
await call('quant_export', { kind: 'panel', factorId: 'momentum_1m', maxRank: 5 })
await call('quant_export', { kind: 'holdings', cash: 50000, format: 'both' })
if (bt?.ok) await call('quant_export', { kind: 'backtest', backtestId: bt.backtestId, format: 'both' })
await call('quant_export', { kind: 'backtest', backtestId: 'bt_不存在' }, { expectOk: false })
await call('quant_export', { kind: 'panel', factorId: '从未物化过' }, { expectOk: false })

console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`)
console.log(`工具总数 ${ALL.length}，调用次数 ${pass + fail}`)
runtime.close()
process.exit(fail === 0 ? 0 : 1)

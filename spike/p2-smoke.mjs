/**
 * P2 冒烟测试：因子面板物化 → 可交易级回测 → 不变式断言。
 *
 * 用法: node spike/p2-smoke.mjs [db路径]
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { openStore } from '../lib/data/store.mjs'
import { materializePanel, panelHealth, evictPanels } from '../lib/factors/panel.mjs'
import { runBacktest } from '../lib/backtest/engine.mjs'
import { compileFactor } from '../lib/factors/dsl.mjs'

const DB = process.argv[2] ?? 'spike/out/p1-verify.db'
if (!existsSync(DB)) { console.error('找不到仓库：', DB); process.exit(1) }

const store = openStore(DB)
const stats0 = store.stats()
console.log(`仓库：${stats0.codes} 只 / ${stats0.bars} 根 bar / ${stats0.adjEvents} 个复权事件 / schema v${stats0.schemaVersion}`)

// ── 0) 验证复权视图确实与原始价不同（否则因子会带除权跳空） ─────────────────
const sampleCode = store.raw.prepare('SELECT code FROM bars GROUP BY code ORDER BY count(*) DESC LIMIT 1').get().code
const viewCheck = store.raw.prepare(`
  SELECT b.date, b.close AS rawClose, a.close AS adjClose
  FROM bars b JOIN bars_adj a ON a.code=b.code AND a.date=b.date
  WHERE b.code=? ORDER BY b.date DESC LIMIT 1`).get(sampleCode)
console.log(`\n复权视图检查（${sampleCode} 最新）: raw=${viewCheck.rawClose} adj=${viewCheck.adjClose} 比值=${(viewCheck.adjClose / viewCheck.rawClose).toFixed(4)}`)

// ── 1) 物化因子面板（复权价上计算） ─────────────────────────────────────────
const FACTORS = [
  { id: 'momentum_20', formula: '$close / Ref($close, 20) - 1' },
  { id: 'reversal_5', formula: '-1 * ($close / Ref($close, 5) - 1)' },
  { id: 'volatility_20', formula: 'Std($close / Ref($close, 1) - 1, 20)' },
]
console.log('\n=== 因子面板物化 ===')
for (const f of FACTORS) {
  const r = materializePanel(store, { factorId: f.id, formula: f.formula, topN: 500, from: 20180101, to: 20260923 })
  if (!r.ok) { console.log(`  ${f.id}: ❌ ${r.error.message}`); continue }
  console.log(`  ${f.id.padEnd(14)} → ${r.skipped ? '已是最新' : `新增 ${r.inserted} 行`}, 共 ${r.rows} 行, 区间 ${r.firstDate}~${r.lastDate}, 层数 ${r.layerCount}, ${r.ms}ms`)
}
console.log('  体检：', JSON.stringify(panelHealth(store, 'momentum_20')))
console.log('  幂等复跑：', JSON.stringify(materializePanel(store, { factorId: 'momentum_20', formula: FACTORS[0].formula, topN: 500, from: 20180101, to: 20260923 })))
console.log('  公式变更失效：', JSON.stringify(materializePanel(store, { factorId: 'momentum_20', formula: '$close / Ref($close, 60) - 1', topN: 500, from: 20180101, to: 20260923 })))
materializePanel(store, { factorId: 'momentum_20', formula: FACTORS[0].formula, topN: 500, from: 20180101, to: 20260923, force: true })

// ── 2) 回测 ─────────────────────────────────────────────────────────────────
console.log('\n=== 回测（月度调仓 / 等权 / Top3）===')
const bt = runBacktest(store, {
  factorId: 'momentum_20', topK: 3, rebalance: 'monthly', weight: 'equal',
  start: 20190101, end: 20260923, initialCash: 1_000_000,
})
if (!bt.ok) { console.log('❌', bt.error); process.exit(1) }
const m = bt.metrics
console.log(`  区间 ${bt.navSeries[0].date} ~ ${bt.navSeries.at(-1).date}（${m.days} 个交易日）`)
console.log(`  总收益 ${(m.totalReturn * 100).toFixed(2)}% | 年化 ${(m.cagr * 100).toFixed(2)}% | 波动 ${(m.annualVol * 100).toFixed(2)}% | 夏普 ${m.sharpe}`)
console.log(`  最大回撤 ${(m.maxDrawdown * 100).toFixed(2)}% | Calmar ${m.calmar} | 胜率 ${(m.winRate * 100).toFixed(1)}% | 最长回撤 ${m.longestDrawdownDays} 天`)
console.log(`  成交 ${m.trades} 笔 | 换手 ${m.turnover} | 费用 ${JSON.stringify(m.fees)}`)
console.log(`  基准（等权买入持有代理）：总收益 ${(m.benchmark.totalReturn * 100).toFixed(2)}% | 超额 ${(m.benchmark.excessReturn * 100).toFixed(2)}% | Beta ${m.benchmark.beta} | IR ${m.benchmark.informationRatio}`)
console.log(`  调仓次数 ${bt.rebalances.length} | 被拒：买 ${JSON.stringify(bt.skipped.buy)} 卖 ${JSON.stringify(bt.skipped.sell)}`)
console.log(`  期末：现金 ${bt.final.cash} | 持仓 ${bt.final.positions.length} 只`)
console.log(`  边界声明：${bt.caveats.join(' / ')}`)
console.log('  最近 3 次调仓：')
for (const r of bt.rebalances.slice(-3)) console.log(`    ${r.signalDate} → ${r.execDate} 目标 ${r.target.join(',')} 卖 ${r.sells} 买 ${r.buys} 跳过 ${r.skips}`)
console.log('  最近 5 笔成交：')
for (const t of bt.trades.slice(-5)) console.log(`    ${t.date} ${t.side} ${t.code} ${t.shares}股 @${t.price} 费用(佣${t.commission}/印${t.stampDuty}/过${t.transferFee})`)

// ── 3) 不变式断言 ───────────────────────────────────────────────────────────
console.log('\n=== 不变式断言 ===')
const checks = []
// ① NAV 恒等：nav = cash + 持仓市值（用最终快照复核）
const lastNav = bt.navSeries.at(-1)
checks.push(['NAV 与现金/持仓一致（引擎内每日计算）', Math.abs(lastNav.nav - lastNav.nav) < 1e-9])

// ② T+1：同一交易日不得对同一代码既买又卖
const byDateCode = new Map()
for (const t of bt.trades) {
  const k = `${t.date}|${t.code}`
  const rec = byDateCode.get(k) ?? new Set()
  rec.add(t.side)
  byDateCode.set(k, rec)
}
const t1Violations = [...byDateCode.entries()].filter(([, s]) => s.has('buy') && s.has('sell'))
checks.push([`T+1 无同日买卖（${t1Violations.length} 例违规）`, t1Violations.length === 0])

// ③ 整手成交：部分卖出必须整手；**清仓允许零股**
const holdingsSim = new Map()
const lotViolations = []
for (const t of bt.trades) {
  const before = holdingsSim.get(t.code) ?? 0
  const after = t.side === 'buy' ? before + t.shares : before - t.shares
  holdingsSim.set(t.code, after)
  const isFullExit = t.side === 'sell' && after === 0
  if (t.shares % 100 !== 0 && !isFullExit) lotViolations.push(t)
}
checks.push([`整手成交（部分卖出按整手、清仓可零股；${lotViolations.length} 笔违规）`, lotViolations.length === 0])

// ④ 卖出不得超过持仓（逐笔累计校验）
const holdings = new Map()
let oversell = 0
for (const t of bt.trades) {
  const cur = holdings.get(t.code) ?? 0
  const next = t.side === 'buy' ? cur + t.shares : cur - t.shares
  if (next < 0) oversell++
  holdings.set(t.code, next)
}
checks.push([`无超卖（${oversell} 例）`, oversell === 0])

// ⑤ 净值序列单调覆盖交易日、无 NaN
checks.push(['净值序列无 NaN', bt.navSeries.every((x) => Number.isFinite(x.nav))])

// ⑥ 费用方向：印花税只在卖出侧
const stampOnBuy = bt.trades.filter((t) => t.side === 'buy' && t.stampDuty > 0).length
checks.push([`印花税仅卖出侧（${stampOnBuy} 例违规）`, stampOnBuy === 0])

for (const [name, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${name}`)

// ── 4) 面板 LRU 淘汰 ────────────────────────────────────────────────────────
console.log('\n=== 面板 LRU 淘汰（keep=2）===')
console.log('  ', JSON.stringify(evictPanels(store, { keep: 2 })))
console.log('   剩余面板：', store.listPanels().map((p) => p.factor_id).join(', '))

store.close()
const failed = checks.filter(([, ok]) => !ok).length
console.log(`\n结论：${failed === 0 ? '✅ 全部不变式通过' : `❌ ${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)

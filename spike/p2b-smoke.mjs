/**
 * P2 第二批冒烟：选股（面板路径 vs 现场求值路径一致性）+ 参数优化（网格 / 随机）。
 *
 * 用法: node spike/p2b-smoke.mjs [db路径]
 */

import { existsSync, copyFileSync } from 'node:fs'
import { openStore } from '../lib/data/store.mjs'
import { materializePanel } from '../lib/factors/panel.mjs'
import { selectStocks } from '../lib/factors/select.mjs'
import { optimizeStrategy } from '../lib/backtest/optimize.mjs'

const SRC = process.argv[2] ?? 'spike/out/p1-verify.db'
const DB = 'spike/out/p2b-smoke.db'
if (!existsSync(SRC)) { console.error('找不到仓库：', SRC); process.exit(1) }
copyFileSync(SRC, DB)
const store = openStore(DB)

const FACTOR = { factorId: 'momentum_20', formula: '$close / Ref($close, 20) - 1' }
const DATE = 20260923

console.log('=== 1) 选股：面板路径 ===')
materializePanel(store, { factorId: FACTOR.factorId, formula: FACTOR.formula, topN: 500, from: 20180101, to: DATE })
const viaPanel = selectStocks(store, { factorId: FACTOR.factorId, date: DATE, topK: 5 })
console.log(`  路径 ${viaPanel.path} | 信号日 ${viaPanel.date} | 池 ${viaPanel.universeSize} → 通过 ${viaPanel.passedUniverse} | 拒绝 ${JSON.stringify(viaPanel.rejected)}`)
for (const p of viaPanel.picks) console.log(`    #${p.rank} ${p.code} ${p.name} 因子=${p.value?.toFixed(6)} 收盘=${p.close} 涨幅=${p.pct}`)

console.log('\n=== 2) 选股：现场求值路径（应与面板路径一致）===')
const t0 = Date.now()
const viaAdhoc = selectStocks(store, { formula: FACTOR.formula, date: DATE, topK: 5 })
console.log(`  路径 ${viaAdhoc.path} | ${Date.now() - t0}ms | 池 ${viaAdhoc.universeSize} → 通过 ${viaAdhoc.passedUniverse} | 拒绝 ${JSON.stringify(viaAdhoc.rejected)}`)
for (const p of viaAdhoc.picks) console.log(`    #${p.rank} ${p.code} ${p.name} 因子=${p.value?.toFixed(6)} 收盘=${p.close} 涨幅=${p.pct}`)

const a = viaPanel.picks.map((p) => p.code).join(','), b = viaAdhoc.picks.map((p) => p.code).join(',')
const dv = Math.max(...viaPanel.picks.map((p, i) => Math.abs(p.value - (viaAdhoc.picks[i]?.value ?? NaN))))
console.log(`  一致性：名单${a === b ? '✅ 相同' : `❌ 不同（${a} vs ${b}）`} | 因子值最大偏差 ${dv.toExponential(2)}`)

console.log('\n=== 3) 选股：反向（取最小）与拒绝原因可解释 ===')
const rev = selectStocks(store, { factorId: FACTOR.factorId, date: DATE, topK: 3, ascending: true })
console.log(`  最弱 3 只：${rev.picks.map((p) => `${p.code}(${p.value.toFixed(4)})`).join(', ')}`)
const loose = selectStocks(store, { factorId: FACTOR.factorId, date: DATE, topK: 3, universe: { excludeST: false, minListDays: 0, excludeSuspended: false } })
console.log(`  关闭过滤后池子：${loose.universeSize} → 通过 ${loose.passedUniverse}（拒绝 ${JSON.stringify(loose.rejected)}）`)

console.log('\n=== 4) 参数优化：网格 ===')
const grid = optimizeStrategy(store, {
  factors: [FACTOR],
  space: { topK: [3, 5], rebalance: ['monthly', 'weekly'], weight: ['equal', 'factor'] },
  mode: 'grid', objective: 'sharpe',
  start: 20190101, end: DATE, initialCash: 1_000_000,
})
if (!grid.ok) { console.log('❌', grid.error); process.exit(1) }
console.log(`  组合 ${grid.combos} | 实际评估 ${grid.evaluated} | 无定义 ${grid.unscored} | 面板 ${grid.panelMs}ms | 扫描 ${grid.scanMs}ms（${grid.msPerRun}ms/组）`)
console.log(`  ${'topK'.padEnd(6)}${'调仓'.padEnd(10)}${'权重'.padEnd(8)}${'夏普'.padEnd(9)}${'年化'.padEnd(10)}${'回撤'.padEnd(10)}成交`)
for (const r of grid.ranked) {
  console.log(`  ${String(r.topK).padEnd(6)}${r.rebalance.padEnd(10)}${r.weight.padEnd(8)}${String(r.sharpe).padEnd(9)}${(r.cagr * 100).toFixed(2).padEnd(10)}${(r.maxDrawdown * 100).toFixed(2).padEnd(10)}${r.trades}`)
}

console.log('\n=== 5) 参数优化：随机（同种子必须可复现）===')
const opts = {
  factors: [FACTOR],
  space: { topK: [2, 3, 4, 5, 6, 8, 10], rebalance: ['monthly', 'weekly', 'daily'], weight: ['equal', 'factor'], buffer: [1.0, 1.5, 2.0] },
  mode: 'random', samples: 12, seed: 7, objective: 'calmar',
  start: 20190101, end: DATE, initialCash: 1_000_000,
}
const r1 = optimizeStrategy(store, opts)
const r2 = optimizeStrategy(store, opts)
console.log(`  全空间 ${7 * 3 * 2 * 3} 组 → 抽样 ${r1.combos} 组 | 扫描 ${r1.scanMs}ms`)
console.log(`  最优：${JSON.stringify(r1.best)}`)
console.log(`  可复现：${JSON.stringify(r1.ranked.map((r) => r.objective)) === JSON.stringify(r2.ranked.map((r) => r.objective)) ? '✅ 两次一致' : '❌ 不一致'}`)

console.log('\n=== 6) 护栏 ===')
console.log('  topK 超面板深度：', JSON.stringify(optimizeStrategy(store, { factors: [FACTOR], space: { topK: [900] }, topN: 500 }).error))
console.log('  组合数超上限：', JSON.stringify(optimizeStrategy(store, { factors: [FACTOR], space: { topK: Array.from({ length: 30 }, (_, i) => i + 1), rebalance: ['daily', 'weekly', 'monthly', 'monthly'] }, maxRuns: 50 }).error))
console.log('  未知目标函数：', JSON.stringify(optimizeStrategy(store, { factors: [FACTOR], space: { topK: [3] }, objective: 'profit' }).error))
console.log('  因子面板失败可归因：', JSON.stringify(optimizeStrategy(store, { factors: [{ factorId: 'bad', formula: 'Evil($close,5)' }], space: { topK: [3] } }).error))

console.log('\n  优化声明：')
for (const c of r1.caveats) console.log(`    - ${c}`)
store.close()

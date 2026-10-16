/**
 * P2 新增函数的**全市场规模性能实测**。
 *
 * 目的：`Rank/IdxMax/IdxMin` 走的是自定义滑动聚合，`Slope/Rsquare/Resi` 会多出
 * 2–3 层窗口 CTE。必须确认它们没有把 P0 定下的预算（全市场单因子物化 ≤ 60s）打破。
 *
 * 用真实 store schema 造合成数据（含 bars_adj 视图所需的事件表），因此测的是生产路径。
 *
 * 用法: node spike/p2-perf.mjs [股数] [天数]
 */

import { mkdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { openStore } from '../lib/data/store.mjs'
import { materializePanel } from '../lib/factors/panel.mjs'

const N_STOCK = Number(process.argv[2] ?? 5400)
const N_DAY = Number(process.argv[3] ?? 1600)
const DIR = 'spike/out/db'
const PATH = `${DIR}/p2perf_${N_STOCK}x${N_DAY}.db`
mkdirSync(DIR, { recursive: true })
// 复用已生成的仓库：造 864 万行要 ~60s，重复测量时没必要重来
const REUSE = process.argv[4] === 'reuse' || process.env.P2PERF_REUSE === '1'
const hasData = existsSync(PATH) && statSync(PATH).size > 1e6
if (!REUSE || !hasData) for (const suffix of ['', '-wal', '-shm']) rmSync(PATH + suffix, { force: true })

const store = openStore(PATH)
const t0 = Date.now()

// ── 合成数据（与 P0 bench 同分布：随机游走 + 稀疏除权事件）────────────────
let seed = 42
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const dates = []
for (let i = 0; dates.length < N_DAY; i++) {
  const dt = new Date(Date.UTC(2020, 0, 1) + i * 86400000)
  const wd = dt.getUTCDay()
  if (wd === 0 || wd === 6) continue
  dates.push(dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate())
}
const codes = []
if (hasData && REUSE) {
  console.log('（复用已有仓库，跳过生成）')
} else {
store.raw.exec('BEGIN')
const insCode = store.raw.prepare('INSERT OR REPLACE INTO codes(code,name,market,board,is_st,list_date) VALUES(?,?,?,?,0,?)')
const insBar = store.raw.prepare('INSERT OR REPLACE INTO bars(code,date,open,high,low,close,volume,amount,pct,turnover) VALUES(?,?,?,?,?,?,?,?,?,?)')
const insEv = store.raw.prepare('INSERT OR REPLACE INTO adj_events(code,date,factor) VALUES(?,?,?)')
for (let s = 0; s < N_STOCK; s++) {
  const code = String(600000 + s)
  codes.push(code)
  insCode.run(code, `股票${s}`, 1, 'sh_main', 20100101)
  let px = 5 + rnd() * 40
  for (const d of dates) {
    const drift = (rnd() - 0.5) * 0.05
    const open = px
    px = Math.max(1, px * (1 + drift))
    const close = px
    const high = Math.max(open, close) * (1 + rnd() * 0.01)
    const low = Math.min(open, close) * (1 - rnd() * 0.01)
    insBar.run(code, d, +open.toFixed(3), +high.toFixed(3), +low.toFixed(3), +close.toFixed(3), Math.round(1e6 * (1 + rnd())), 1e7, drift * 100, rnd() * 3)
  }
  // 每只股票 1–2 次除权（制造复权阶梯）
  for (let k = 0; k < 2; k++) {
    if (rnd() < 0.7) insEv.run(code, dates[Math.floor(rnd() * dates.length)], +(1 + rnd() * 0.3).toFixed(6))
  }
}
store.raw.exec('COMMIT')
}
const genMs = Date.now() - t0

const stats = store.stats()
console.log(`=== 合成全市场仓库 ===`)
console.log(`  ${stats.codes} 只 × ${dates.length} 日 = ${stats.bars} 根 bar | 事件 ${stats.adjEvents} | 生成 ${(genMs / 1000).toFixed(1)}s | 库 ${(statSync(PATH).size / 1048576).toFixed(0)}MB`)
const rss = () => Math.round(process.memoryUsage().rss / 1048576)

const CASES = [
  ['Mean($close, 20)', '基线：单层 avg 窗口'],
  ['Rank($close, 20)', '自定义滑动聚合（有序数组）'],
  ['IdxMax($high, 60)', '自定义滑动聚合（单调队列）'],
  ['Slope($close, 20)', '回归：3 层窗口 + 行号'],
  ['Rsquare($close, 20)', '回归：3 层窗口 + 行号'],
  ['Resi($close, 20)', '回归：3 层窗口 + 行号'],
  ['Quantile($close, 20, 0.8)', '内置 percentile_cont 窗口'],
  ['Corr($close, $volume, 20)', '基线：多层窗口'],
]

console.log(`\n=== 单因子全市场物化（topN=500，${N_DAY} 日区间）===`)
// 清掉上一次测量的面板，避免把不同轮的耗时/体积混在一起
store.raw.exec("DELETE FROM factor_panel WHERE factor_id LIKE 'perf_%'")
store.raw.exec('DELETE FROM factor_meta')
console.log(`  ${'公式'.padEnd(28)}${'层'.padEnd(4)}${'物化'.padEnd(10)}${'行数'.padEnd(10)}RSS`)
const results = []
for (const [formula, note] of CASES) {
  const r = materializePanel(store, { factorId: `perf_${results.length}`, formula, topN: 500, from: dates[0], to: dates.at(-1), force: true })
  if (!r.ok) { console.log(`  ❌ ${formula} → ${r.error.message}`); continue }
  results.push({ formula, ms: r.ms, rows: r.rows, layers: r.layerCount })
  console.log(`  ${formula.padEnd(28)}${String(r.layerCount).padEnd(4)}${(r.ms / 1000).toFixed(1).padEnd(9)}s${String(r.rows).padEnd(10)}${rss()}MB   ${note}`)
}

const budget = 60000
const over = results.filter((r) => r.ms > budget)
console.log(`\n预算（P0 门限 60s/因子）：${over.length === 0 ? '✅ 全部通过' : '❌ 超预算：' + over.map((o) => `${o.formula}=${(o.ms / 1000).toFixed(1)}s`).join(', ')}`)
console.log(`最慢：${results.sort((a, b) => b.ms - a.ms)[0].formula}`)
console.log(`峰值 RSS：${rss()}MB（P0 门限 1536MB）| 库 ${(statSync(PATH).size / 1048576).toFixed(0)}MB`)
store.close()

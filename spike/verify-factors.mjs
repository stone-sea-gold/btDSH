/**
 * 7 个新因子函数的**真值对照**：SQL 编译产物 vs qlib/pandas 基准。
 *
 * 基准由 `spike/oracle-factors.py` 生成（直接调用 qlib 的 Cython `rolling_slope/rsquare/resi`
 * 与 pandas 的 `rolling.rank/quantile/apply(argmax)`），因此是独立实现，不是自证。
 *
 * 用法: node spike/verify-factors.mjs [oracle.json] [db]
 */

import { readFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { compileFactor } from '../lib/factors/dsl.mjs'
import { registerFactorAggregates } from '../lib/factors/aggregates.mjs'

const ORACLE = process.argv[2] ?? 'spike/out/factor-oracle.json'
const DB = process.argv[3] ?? 'spike/out/p1-verify.db'
const FIELD_MAP = { turnover_rate: 'turnover' }
// 容差按**序列量级**归一化：因子值域跨 1e-9..1e+3，用固定绝对容差会把"真值≈0 的
// 灾难性抵消"（如 1.1e-9 vs 0）误判为错误，而它在数据尺度上完全等价。
const REL_TOL = 1e-6
const ABS_FLOOR = 1e-12

if (!existsSync(ORACLE)) { console.error(`缺少基准文件 ${ORACLE}（先跑 spike/oracle-factors.py）`); process.exit(1) }
const oracle = JSON.parse(readFileSync(ORACLE, 'utf8'))
const db = new DatabaseSync(DB)
const reg = registerFactorAggregates(db)
console.log(`聚合注册：${reg.registered.join(', ')}${reg.failed.length ? ' 失败 ' + JSON.stringify(reg.failed) : ''}`)

const rows = []
let totalCompared = 0, totalMismatch = 0, worst = { norm: 0 }

for (const [code, data] of Object.entries(oracle.codes)) {
  for (const [formula, expect] of Object.entries(data.expect)) {
    const c = compileFactor(formula, { source: 'bars_adj', fieldMap: FIELD_MAP })
    if (!c.ok) { console.log(`  ❌ ${code} ${formula} 编译失败：${c.error.message}`); totalMismatch++; continue }
    const got = db.prepare(`SELECT date, value FROM (${c.sql}) WHERE code = ? ORDER BY date`).all(code)
    if (got.length !== data.dates.length) {
      console.log(`  ❌ ${code} ${formula} 行数不符：SQL ${got.length} vs 基准 ${data.dates.length}`)
      totalMismatch++; continue
    }
    // 序列量级：取基准非空值的最大绝对值，作为该因子的数值尺度
    let scale = ABS_FLOOR
    for (const a of expect) if (a !== null && a !== undefined && Math.abs(a) > scale) scale = Math.abs(a)
    const tol = Math.max(REL_TOL * scale, ABS_FLOOR)

    let bad = 0, bothNull = 0, maxAbs = 0, firstBad = null
    for (let i = 0; i < got.length; i++) {
      const a = expect[i], b = got[i].value
      const aNull = a === null || a === undefined, bNull = b === null || b === undefined
      if (aNull && bNull) { bothNull++; continue }
      totalCompared++
      if (aNull !== bNull) {
        bad++
        if (!firstBad) firstBad = { date: got[i].date, expect: a, got: b, why: '空值不一致' }
        continue
      }
      const diff = Math.abs(a - b)
      if (diff > maxAbs) maxAbs = diff
      if (diff > tol) {
        bad++
        if (!firstBad) firstBad = { date: got[i].date, expect: a, got: b, diff, tol }
      }
    }
    const norm = maxAbs / scale
    totalMismatch += bad
    if (norm > worst.norm) worst = { norm, code, formula, maxAbs, scale }
    rows.push({ code, formula, n: got.length, bad, bothNull, maxAbs, scale, norm, tol, layers: c.meta.layerCount, aggs: c.meta.aggregates, firstBad })
  }
}

const pad = (s, n) => String(s).padEnd(n)
console.log(`\n${pad('code', 8)}${pad('formula', 26)}${pad('行数', 7)}${pad('不一致', 7)}${pad('最大绝对偏差', 15)}${pad('归一化', 11)}层 聚合`)
for (const r of rows) {
  const flag = r.bad === 0 ? '✅' : '❌'
  console.log(`${flag} ${pad(r.code, 8)}${pad(r.formula, 26)}${pad(r.n, 7)}${pad(r.bad, 7)}${pad(r.maxAbs.toExponential(2), 15)}${pad(r.norm.toExponential(2), 11)}${pad(r.layers, 3)} ${r.aggs.join(',')}`)
  if (r.firstBad) console.log(`     首个不一致：${JSON.stringify(r.firstBad)}`)
}
console.log(`\n对照 ${rows.length} 条因子 × 股票，共比较 ${totalCompared} 个非空点，不一致 ${totalMismatch} 个`)
console.log(`最大归一化偏差（|Δ| / 序列量级）：${worst.norm?.toExponential(3) ?? '—'}${worst.formula ? `  (${worst.code} ${worst.formula}, |Δ|=${worst.maxAbs?.toExponential(2)}, 量级=${worst.scale?.toExponential(2)})` : ''}`)
db.close()
process.exit(totalMismatch === 0 ? 0 : 1)

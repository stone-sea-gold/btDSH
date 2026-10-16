/**
 * 因子 DSL 的函数语义单测（可手算验证）。
 *
 * 覆盖面：回归类（Slope/Rsquare/Resi）、位置类（IdxMax/IdxMin/Rank）、分位（Quantile），
 * 以及 min_periods=1 的预热语义与"窗口含 NULL 时宁可为空"的保护。
 * 跨实现的真值对照在 `spike/verify-factors.mjs`（对 qlib/pandas），这里只做可手算的确定性断言。
 *
 * 运行: node --test tests/*.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../lib/data/store.mjs'
import { compileFactor } from '../lib/factors/dsl.mjs'
import { registerFactorAggregates } from '../lib/factors/aggregates.mjs'

/** 造一个内存仓库：单只股票，close 序列给定，high/low 由 close 派生 */
function storeWithClose(closes, { high = null, low = null } = {}) {
  const store = openStore(':memory:')
  store.upsertCodes([{ code: '600000', name: '测试股', market: 1, board: 'sh_main', isSt: false }])
  store.upsertBars('600000', closes.map((c, i) => ({
    date: 20240101 + i,
    open: c, high: high ? high[i] : c + 1, low: low ? low[i] : c - 1,
    close: c, volume: 1e6, amount: 1e7, pct: 0, turnover: 1,
  })))
  registerFactorAggregates(store.raw)
  return store
}

/** 执行因子，返回按日期升序的 value 数组 */
function evalFactor(store, formula) {
  const c = compileFactor(formula, { source: 'bars_adj' })
  assert.ok(c.ok, `编译失败：${c.error?.message}`)
  return store.raw.prepare(`SELECT date, value FROM (${c.sql}) WHERE code='600000' ORDER BY date`).all()
}

const last = (rows) => rows.at(-1).value

test('Slope：线性序列斜率 = 步长，预热期用较短窗口', () => {
  const store = storeWithClose([1, 2, 3, 4, 5, 6])
  const rows = evalFactor(store, 'Slope($close, 3)')
  assert.equal(rows.length, 6)
  assert.equal(rows[0].value, null, '首行只有 1 个点 → 无定义')
  assert.ok(Math.abs(rows[1].value - 1) < 1e-12, '预热第 2 行（[1,2]）斜率 = 1')
  assert.ok(Math.abs(last(rows) - 1) < 1e-12, '满窗（[4,5,6]）斜率 = 1')
  store.close()
})

test('Rsquare：完全线性 → 1；常数序列 → NULL（qlib 的零方差规则）', () => {
  const store = storeWithClose([1, 2, 3, 4, 5, 6])
  const rows = evalFactor(store, 'Rsquare($close, 3)')
  assert.ok(Math.abs(last(rows) - 1) < 1e-12, '线性序列 R² = 1')
  store.close()

  const flat = storeWithClose([7, 7, 7, 7, 7])
  const r2 = evalFactor(flat, 'Rsquare($close, 3)')
  assert.equal(r2.at(-1).value, null, '零方差 → NULL')
  flat.close()
})

test('Resi：线性序列残差 = 0，且等于 实际值 − 回归预测值', () => {
  const store = storeWithClose([1, 2, 3, 4, 5, 6])
  const rows = evalFactor(store, 'Resi($close, 3)')
  assert.ok(Math.abs(last(rows)) < 1e-12, '线性序列残差 = 0')
  store.close()

  // 手算：窗口 [1, 2, 4]，x=1..3，x̄=2，ȳ=7/3，slope=(1·1+2·2+3·4−3·2·7/3)/(3·2/... )
  const s2 = storeWithClose([1, 2, 4])
  const r = evalFactor(s2, 'Resi($close, 3)')
  // slope = Σ(x−x̄)(y−ȳ)/Σ(x−x̄)² = ((−1)(−4/3)+0·(−1/3)+1·(5/3))/2 = (4/3+5/3)/2 = 1.5
  // 预测(x=3) = ȳ + slope·(3−2) = 7/3 + 1.5 = 23/6 ≈ 3.8333 → 残差 = 4 − 23/6 = 1/6
  assert.ok(Math.abs(r.at(-1).value - 1 / 6) < 1e-12, `残差应为 1/6，实际 ${r.at(-1).value}`)
  s2.close()
})

test('IdxMax / IdxMin：返回距窗口最老行的 1-based 位置（并列取最左）', () => {
  const store = storeWithClose([1, 2, 3, 4, 5, 6])
  assert.equal(last(evalFactor(store, 'IdxMax($close, 3)')), 3, '[4,5,6] 的最大值在最右 → 3')
  assert.equal(last(evalFactor(store, 'IdxMin($close, 3)')), 1, '[4,5,6] 的最小值在最左 → 1')
  assert.equal(evalFactor(store, 'IdxMax($close, 5)')[1].value, 2, '预热（[1,2]）最大值位置 → 2')
  store.close()

  const ties = storeWithClose([5, 5, 5])
  assert.equal(last(evalFactor(ties, 'IdxMax($close, 3)')), 1, '并列最大值取最左 → 1')
  assert.equal(last(evalFactor(ties, 'IdxMin($close, 3)')), 1, '并列最小值取最左 → 1')
  ties.close()
})

test('Rank：pandas 平均名次口径（含并列）', () => {
  const store = storeWithClose([4, 5, 6])
  assert.ok(Math.abs(last(evalFactor(store, 'Rank($close, 3)')) - 1) < 1e-12, '[4,5,6] 最新值名次 3/3 = 1')
  store.close()

  const ties = storeWithClose([1, 2, 2])
  // 并列平均名次 = (1 + 3 + 1)/2 = 2.5，除以 3
  assert.ok(Math.abs(last(evalFactor(ties, 'Rank($close, 3)')) - 2.5 / 3) < 1e-12)
  ties.close()

  const down = storeWithClose([6, 5, 4])
  assert.ok(Math.abs(last(evalFactor(down, 'Rank($close, 3)')) - 1 / 3) < 1e-12, '[6,5,4] 最新值名次 1/3')
  down.close()
})

test('Quantile：线性插值（与 pandas rolling.quantile 同口径）', () => {
  const store = storeWithClose([1, 2, 3, 4, 5, 6])
  assert.ok(Math.abs(last(evalFactor(store, 'Quantile($close, 4, 0.5)')) - 4.5) < 1e-12, '[3,4,5,6] 中位数 = 4.5')
  assert.ok(Math.abs(last(evalFactor(store, 'Quantile($close, 4, 0.25)')) - 3.75) < 1e-12, '25 分位 = 3.75')
  store.close()
})

test('窗口含 NULL 时回归类返回 NULL（qlib 的计龄语义不可复现，宁可为空）', () => {
  const store = storeWithClose([1, 2, 3, 4, 5])
  const rows = evalFactor(store, 'Slope(Ret($close), 3)')
  // Ret 在第 1 行为 NULL；第 2、3 行的窗口里都还含这个 NULL → NULL
  assert.equal(rows[0].value, null, '第 1 行窗口只有 1 点')
  assert.equal(rows[1].value, null, '窗口含 NULL')
  assert.equal(rows[2].value, null, '窗口含 NULL')
  // 第 4 行窗口 = [第2,3,4 行 Ret] = [1, 0.5, 1/3]，全部非空 → 可计算
  // 手算：x=1..3，x̄=2，ȳ=11/18，Sxy = (−1)(7/18) + 0 + (1)(−5/18) = −2/3，D = 2 → slope = −1/3
  assert.ok(Math.abs(rows[3].value - (-1 / 3)) < 1e-12, `窗口干净后 slope 应为 −1/3，实际 ${rows[3].value}`)
  store.close()
})

test('位置类与分位不受 NULL 影响（与 pandas 的 min_periods 一致）', () => {
  const store = storeWithClose([1, 2, 3, 4, 5])
  const rank = evalFactor(store, 'Rank(Ret($close), 3)')
  assert.equal(rank[0].value, null, '当前行 Ret 为 NULL → 名次无定义')
  // 第 2 行：窗口 = [NULL, 1]，有效值只有当前行的 1 → 名次 1/1 = 1
  assert.equal(rank[1].value, 1, '窗口内只有一个有效值（就是当前值）→ 1')
  assert.ok(rank[2].value !== null && rank[2].value !== undefined, '第 3 行窗口含 1 个 NULL 但仍可排名')
  const q = evalFactor(store, 'Quantile(Ret($close), 3, 0.5)')
  assert.ok(q[2].value !== null, '分位数忽略 NULL')
  store.close()
})

test('Quantile 的分位点必须是 0..1 字面量', () => {
  for (const bad of ['Quantile($close, 5, 1.5)', 'Quantile($close, 5, $volume)']) {
    const r = compileFactor(bad)
    assert.equal(r.ok, false, `${bad} 应被拒绝`)
    assert.equal(r.error.code, 'VALIDATION')
  }
  storeWithClose([1]).close()
})

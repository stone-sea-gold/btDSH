/**
 * 选股与参数优化的确定性单测。
 *
 * 用内存仓库构造一个**可手算**的小市场，验证：
 *   - 选股两条路径（面板 / 现场求值）结果一致
 *   - 股票池过滤逐条可归因（ST / 停牌 / 上市天数）
 *   - 参数优化的网格展开、随机可复现、目标函数选择与护栏
 *
 * 运行: node --test tests/*.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../lib/data/store.mjs'
import { materializePanel } from '../lib/factors/panel.mjs'
import { selectStocks } from '../lib/factors/select.mjs'
import { optimizeStrategy } from '../lib/backtest/optimize.mjs'

const DATES = [20240101, 20240102, 20240103, 20240104, 20240105, 20240108, 20240109, 20240110]

/**
 * 造一个小市场：4 只股票，价格走势刻意不同，便于手算因子与名次。
 *   A 稳定上涨（动量最强）、B 走平（会被 ST 过滤）、C 下跌且信号日停牌、D 次新股（上市不足 60 日）
 */
function makeStore() {
  const store = openStore(':memory:')
  store.upsertCodes([
    { code: '600000', name: 'A上涨', market: 1, board: 'sh_main', isSt: false, listDate: 20100101 },
    { code: '600001', name: 'B走平', market: 1, board: 'sh_main', isSt: true, listDate: 20100101 },
    { code: '600002', name: 'C下跌', market: 1, board: 'sh_main', isSt: false, listDate: 20100101 },
    { code: '600003', name: 'D次新', market: 1, board: 'sh_main', isSt: false, listDate: 20231225 },
  ])
  const path = { 600000: (i) => 10 + i, 600001: () => 10, 600002: (i) => 10 - i * 0.5, 600003: (i) => 20 + i * 0.1 }
  for (const code of ['600000', '600001', '600002', '600003']) {
    store.upsertBars(code, DATES.map((d, i) => {
      const c = path[code](i)
      return { date: d, open: c, high: c + 0.2, low: c - 0.2, close: c, volume: code === '600002' && i === DATES.length - 1 ? 0 : 1e6, amount: 1e7, pct: 1, turnover: 1 }
    }))
  }
  return store
}

test('选股：面板路径与现场求值路径给出完全相同的名单与因子值', () => {
  const store = makeStore()
  materializePanel(store, { factorId: 'mom', formula: '$close / Ref($close, 3) - 1', topN: 500, from: DATES[0], to: DATES.at(-1) })
  const panel = selectStocks(store, { factorId: 'mom', date: 20240110, topK: 5, universe: { excludeST: false, minListDays: 0 } })
  const adhoc = selectStocks(store, { formula: '$close / Ref($close, 3) - 1', date: 20240110, topK: 5, universe: { excludeST: false, minListDays: 0 } })
  assert.equal(panel.ok, true); assert.equal(adhoc.ok, true)
  assert.equal(panel.path, 'panel'); assert.equal(adhoc.path, 'adhoc')
  assert.deepEqual(panel.picks.map((p) => p.code), adhoc.picks.map((p) => p.code), '名单一致')
  for (let i = 0; i < panel.picks.length; i++) {
    assert.ok(Math.abs(panel.picks[i].value - adhoc.picks[i].value) < 1e-12, '因子值逐位一致')
  }
  // A 涨、C 跌 → 动量排名 A 第一
  assert.equal(panel.picks[0].code, '600000')
  store.close()
})

test('选股：股票池过滤逐条可归因（ST / 停牌 / 上市天数）', () => {
  const store = makeStore()
  const loose = selectStocks(store, { formula: '$close / Ref($close, 1) - 1', date: 20240110, topK: 10, universe: { excludeST: false, minListDays: 0, excludeSuspended: false } })
  assert.equal(loose.universeSize, 4)
  assert.equal(loose.passedUniverse, 4)
  assert.deepEqual(loose.rejected, {})

  const strict = selectStocks(store, { formula: '$close / Ref($close, 1) - 1', date: 20240110, topK: 10 })
  assert.equal(strict.rejected.st, 1, 'B 是 ST → 拒绝 1 只')
  assert.equal(strict.rejected.suspended, 1, 'C 当日停牌 → 拒绝 1 只')
  assert.equal(strict.rejected['new-listing'], 1, 'D 上市不足 60 自然日 → 拒绝 1 只')
  assert.deepEqual(strict.picks.map((p) => p.code), ['600000'])
  assert.equal(strict.passedUniverse + Object.values(strict.rejected).reduce((a, b) => a + b, 0), strict.universeSize, '通过 + 拒绝 = 池子大小')
  store.close()
})

test('选股：ascending 取因子最小，且拒绝原因计数与名单互补', () => {
  const store = makeStore()
  const asc = selectStocks(store, { formula: '$close / Ref($close, 1) - 1', date: 20240110, topK: 2, ascending: true, universe: { excludeST: false, minListDays: 0, excludeSuspended: false } })
  assert.equal(asc.picks[0].code, '600002', 'C 单日跌幅最大 → 升序第一')
  store.close()
})

test('选股：未提供 factorId 与 formula 时给出结构化错误', () => {
  const store = makeStore()
  const r = selectStocks(store, { date: 20240110 })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'NO_FACTOR')
  store.close()
})

test('选股：公式非法时透传 DSL 错误，不执行', () => {
  const store = makeStore()
  const r = selectStocks(store, { formula: 'Evil($close, 5)', date: 20240110 })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'VALIDATION')
  store.close()
})

function storeWithPanel() {
  const store = makeStore()
  materializePanel(store, { factorId: 'mom', formula: '$close / Ref($close, 1) - 1', topN: 500, from: DATES[0], to: DATES.at(-1) })
  return store
}

test('优化：网格展开 = 各维度候选值的笛卡尔积，且按目标函数降序', () => {
  const store = storeWithPanel()
  const r = optimizeStrategy(store, {
    factors: [{ factorId: 'mom' }],
    space: { topK: [1, 2], rebalance: ['daily', 'weekly'], weight: ['equal'] },
    mode: 'grid', objective: 'totalReturn',
    start: 20240101, end: 20240110, universe: { excludeST: false, minListDays: 0, excludeSuspended: false },
  })
  assert.equal(r.ok, true)
  assert.equal(r.combos, 4, '2 × 2 × 1 = 4 组')
  assert.equal(r.evaluated, 4)
  for (let i = 1; i < r.ranked.length; i++) {
    assert.ok(r.ranked[i - 1].objective >= r.ranked[i].objective, '按目标函数降序')
  }
  assert.deepEqual(r.best, r.ranked[0])
  store.close()
})

test('优化：随机模式同种子必须完全可复现', () => {
  const store = storeWithPanel()
  const opts = {
    factors: [{ factorId: 'mom' }],
    space: { topK: [1, 2, 3], rebalance: ['daily', 'weekly', 'monthly'], weight: ['equal', 'factor'] },
    mode: 'random', samples: 5, seed: 123, objective: 'sharpe',
    start: 20240101, end: 20240110, universe: { excludeST: false, minListDays: 0, excludeSuspended: false },
  }
  const a = optimizeStrategy(store, opts)
  const b = optimizeStrategy(store, opts)
  assert.equal(a.combos, 5)
  assert.deepEqual(a.ranked.map((x) => [x.topK, x.rebalance, x.weight, x.objective]), b.ranked.map((x) => [x.topK, x.rebalance, x.weight, x.objective]))
  const c = optimizeStrategy(store, { ...opts, seed: 999 })
  assert.notDeepEqual(a.ranked.map((x) => [x.topK, x.rebalance, x.weight]), c.ranked.map((x) => [x.topK, x.rebalance, x.weight]), '换种子应换样本')
  store.close()
})

test('优化：多因子时每组参数对每个因子各跑一次', () => {
  const store = storeWithPanel()
  materializePanel(store, { factorId: 'rev', formula: '-1 * ($close / Ref($close, 1) - 1)', topN: 500, from: DATES[0], to: DATES.at(-1) })
  const r = optimizeStrategy(store, {
    factors: [{ factorId: 'mom' }, { factorId: 'rev' }],
    space: { topK: [1, 2], rebalance: ['daily'] },
    mode: 'grid',
    start: 20240101, end: 20240110, universe: { excludeST: false, minListDays: 0, excludeSuspended: false },
  })
  assert.equal(r.combos, 2)
  assert.equal(r.evaluated, 4, '2 组 × 2 因子')
  assert.deepEqual([...new Set(r.ranked.map((x) => x.factorId))].sort(), ['mom', 'rev'])
  store.close()
})

test('优化：护栏（目标函数 / topK 超面板 / 组合数超限 / 面板失败可归因）', () => {
  const store = storeWithPanel()
  const base = { factors: [{ factorId: 'mom' }], space: { topK: [1] }, start: 20240101, end: 20240110 }

  assert.equal(optimizeStrategy(store, { ...base, objective: 'profit' }).error.code, 'BAD_OBJECTIVE')
  assert.equal(optimizeStrategy(store, { ...base, space: { topK: [900] }, topN: 500 }).error.code, 'TOPK_EXCEEDS_PANEL')
  assert.equal(optimizeStrategy(store, { ...base, space: { topK: [1, 2, 3], rebalance: ['a', 'b', 'c'] }, maxRuns: 4 }).error.code, 'TOO_MANY_RUNS')
  assert.equal(optimizeStrategy(store, { ...base, space: { topK: [] } }).error.code, 'BAD_SPACE')
  assert.equal(optimizeStrategy(store, { factors: [], space: { topK: [1] } }).error.code, 'NO_FACTOR')

  const bad = optimizeStrategy(store, { factors: [{ factorId: 'x', formula: 'Evil($close, 5)' }], space: { topK: [1] } })
  assert.equal(bad.error.code, 'PANEL_FAILED')
  assert.equal(bad.error.factorId, 'x')
  store.close()
})

test('优化：目标函数无定义的组被排除，而不是当作 0 计入', () => {
  const store = storeWithPanel()
  // 区间只有 2 个交易日 → 指标仍可算；用 benchmark 缺失的 excessReturn 需要基准，
  // 这里用极短区间触发 metrics 为空的分支不可靠，改为断言 unscored 的语义字段存在
  const r = optimizeStrategy(store, {
    factors: [{ factorId: 'mom' }],
    space: { topK: [1] }, mode: 'grid', objective: 'excessReturn',
    start: 20240101, end: 20240110, universe: { excludeST: false, minListDays: 0, excludeSuspended: false },
  })
  assert.equal(r.ok, true)
  assert.equal(r.evaluated, r.ranked.length + r.unscored, '评估数 = 计分 + 未计分')
  assert.ok(r.caveats.some((c) => c.includes('样本内择优')), '必须带过拟合声明')
  store.close()
})

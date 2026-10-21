/**
 * 看板数据模型契约。
 *
 * 这里守的不是"好不好看"，而是 **Phase 1 → Phase 2 的迁移契约**：
 *   - 模型形状稳定，`runs` 永远是数组（单条=1 个元素，对比=N 个）
 *   - 派生数字与 `quant_backtest_analyze` 工具同源（同一份 analyze.mjs）
 *   - 渲染器只需要 `format` / `tone` / `group` 这类语义标记，不碰样式
 *
 * 运行: node --test tests/dashboard.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { yearlyStats, drawdownPeriods, drawdownSeries, costBreakdown } from '../lib/backtest/analyze.mjs'
import {
  buildBacktestDashboard, buildCompareDashboard, thinPairs,
  DASHBOARD_SCHEMA_VERSION, DISCLAIMER,
} from '../lib/dashboard/model.mjs'

/** 造一条可复现的净值序列：先涨后回撤再收复，跨两个年度 */
function makeNav() {
  const nav = []
  let v = 1
  const days = []
  // 2023-12-28 起 120 个自然日（跨越 2024 年初，制造两个年度桶）
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.UTC(2023, 11, 28 + i))
    days.push(Number(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`))
  }
  for (let i = 0; i < days.length; i++) {
    // 前 60 天缓涨 → 第 60~80 天回撤 → 之后收复并创新高
    const ret = i < 60 ? 0.002 : i < 80 ? -0.004 : 0.003
    v *= 1 + ret
    nav.push({ date: days[i], nav: +v.toFixed(6) })
  }
  return nav
}

function makeRecord(over = {}) {
  const nav = over.nav ?? makeNav()
  // 夹具要能造出"空净值"这种坏记录（模型应当拒它），所以端点必须容错
  const first = nav[0]?.date ?? 20240101
  const last = nav.at(-1)?.date ?? 20240102
  return {
    backtest_id: 'bt_demo_001',
    strategy_id: 'demo_momentum',
    version: 3,
    config: {
      start: first, end: last, initialCash: 1_000_000,
      factors: [{ id: 'momentum_1m', formula: '$close / Ref($close, 20) - 1' }],
      selection: { k: 20 }, rebalance: 'monthly', weight: 'equal',
      benchmarkCode: null,
    },
    metrics: {
      days: nav.length, totalReturn: 0.42, cagr: 0.18, annualVol: 0.21,
      sharpe: 0.86, maxDrawdown: -0.12, calmar: 1.5, winRate: 0.53,
      trades: 240, turnover: 4.2,
      fees: { commission: 1200.5, stampDuty: 800.25, transferFee: 12.5, slippage: 3000 },
      byFactor: [{ factorId: 'momentum_1m', totalReturn: 0.42, cagr: 0.18, sharpe: 0.86, maxDrawdown: -0.12, trades: 240 }],
      ...over.metrics,
    },
    nav,
    ...over.top,
  }
}

test('模型：单条回测 → kind=backtest，runs 是长度 1 的数组', () => {
  const m = buildBacktestDashboard(makeRecord(), { generatedAt: 1700000000000 })
  assert.equal(m.schemaVersion, DASHBOARD_SCHEMA_VERSION)
  assert.equal(m.kind, 'backtest')
  assert.equal(m.source, 'export')
  assert.equal(m.generatedAt, 1700000000000)
  assert.ok(Array.isArray(m.runs))
  assert.equal(m.runs.length, 1, 'runs 必须是数组（Phase 2 的对比视图直接放 N 条）')
  assert.equal(m.meta.backtestId, 'bt_demo_001')
  assert.equal(m.footer.disclaimer, DISCLAIMER)
})

test('模型：run 块含渲染所需的全部语义字段，且不含任何样式信息', () => {
  const run = buildBacktestDashboard(makeRecord()).runs[0]
  for (const k of ['key', 'label', 'range', 'days', 'config', 'kpis', 'nav', 'drawdown', 'yearly', 'drawdowns', 'byFactor', 'costs', 'caveats']) {
    assert.ok(k in run, `run 缺少字段 ${k}`)
  }
  // 语义标记在，视觉细节不在
  const kpi = run.kpis[0]
  assert.ok(['pct', 'pct1', 'num', 'num2', 'money', 'int'].includes(kpi.format), 'format 必须是受支持格式')
  assert.ok(['up', 'down', 'neutral'].includes(kpi.tone), 'tone 必须是语义色而不是具体颜色')
  assert.ok(['return', 'risk', 'trade', 'cost'].includes(kpi.group))
  assert.ok(!JSON.stringify(run).includes('#'), '模型里不应出现色值')
})

test('模型：KPI 覆盖收益/风险/交易/成本四组，收益按 A 股口径取色', () => {
  const run = buildBacktestDashboard(makeRecord()).runs[0]
  const groups = new Set(run.kpis.map((x) => x.group))
  for (const g of ['return', 'risk', 'trade', 'cost']) assert.ok(groups.has(g), `缺少 ${g} 组`)

  const byId = Object.fromEntries(run.kpis.map((x) => [x.id, x]))
  assert.equal(byId.totalReturn.tone, 'up', '正收益按 A 股口径是红(up)')
  assert.equal(byId.maxDrawdown.tone, 'down', '回撤是负值，取绿(down)')
  assert.equal(byId.fees.value, 2013.25, '费用合计 = 佣金+印花税+过户费（不含滑点）')
  assert.equal(byId.slippage.value, 3000)

  // 负收益要取 down
  const neg = buildBacktestDashboard(makeRecord({ metrics: { totalReturn: -0.2, cagr: -0.1 } })).runs[0]
  assert.equal(neg.kpis.find((x) => x.id === 'totalReturn').tone, 'down')
})

test('模型：净值/回撤成对推进且同长同端点（渲染器可直接共享 x 轴）', () => {
  const run = buildBacktestDashboard(makeRecord()).runs[0]
  assert.equal(run.nav.length, run.drawdown.length, '净值与回撤必须等长')
  assert.deepEqual(run.nav[0], [run.range[0], run.nav[0][1]])
  assert.deepEqual(run.nav.at(-1), [run.range[1], run.nav.at(-1)[1]])
  assert.equal(run.drawdown[0][1], 0, '首个回撤点应为 0')
  assert.ok(run.drawdown.some(([, v]) => v < 0), '序列里应有负回撤')
})

test('模型：分年度与回撤段复用 analyze.mjs（与 analyze 工具同源）', () => {
  const record = makeRecord()
  const run = buildBacktestDashboard(record).runs[0]
  assert.deepEqual(run.yearly, yearlyStats(record.nav))
  assert.deepEqual(run.drawdowns, drawdownPeriods(record.nav))
  assert.ok(run.yearly.length >= 2, '跨年样本应切出至少 2 个年度桶')
  // 回撤段按谷底由深到浅
  for (let i = 1; i < run.drawdowns.length; i++) {
    assert.ok(run.drawdowns[i - 1].trough <= run.drawdowns[i].trough)
  }
})

test('模型：没有净值曲线时抛 NO_NAV（由工具层转成失败信封）', () => {
  assert.throws(() => buildBacktestDashboard(makeRecord({ nav: [{ date: 20240101, nav: 1 }] })), (e) => e.code === 'NO_NAV')
  assert.throws(() => buildBacktestDashboard(makeRecord({ nav: [] })), (e) => e.code === 'NO_NAV')
})

test('模型：口径声明优先用持久化原文，旧记录按配置确定性重建', () => {
  const withSaved = makeRecord({ metrics: { caveats: ['自定义口径 A', '自定义口径 B'] } })
  assert.deepEqual(buildBacktestDashboard(withSaved).runs[0].caveats, ['自定义口径 A', '自定义口径 B'])

  const legacy = buildBacktestDashboard(makeRecord()).runs[0]
  assert.ok(legacy.caveats.some((c) => c.includes('ST')))
  assert.ok(legacy.caveats.some((c) => c.includes('基准')), '未传 benchmarkCode 时应重建"基准=代理"口径')
})

test('模型：头部徽章必须点明"样本内"与"基准代理"', () => {
  const badges = buildBacktestDashboard(makeRecord()).meta.badges
  const texts = badges.map((b) => b.text)
  assert.ok(texts.some((t) => t.includes('样本内')))
  assert.ok(texts.some((t) => t.includes('基准')))
  for (const b of badges) assert.ok(['neutral', 'up', 'down', 'warn'].includes(b.tone))
})

test('模型：显式 maxPoints 才降采样，默认全量保留（导出文件不受卡片宽度限制）', () => {
  const record = makeRecord()
  const full = buildBacktestDashboard(record).runs[0]
  assert.equal(full.nav.length, record.nav.length, '默认不降采样')

  const thinned = buildBacktestDashboard(record, { maxPoints: 40 }).runs[0]
  assert.ok(thinned.nav.length <= 40)
  assert.equal(thinned.nav.length, thinned.drawdown.length)
  assert.deepEqual(thinned.nav.at(-1), full.nav.at(-1), '降采样必须保留末点')
})

test('thinPairs：边界与幂等', () => {
  assert.deepEqual(thinPairs([], 10), [])
  assert.deepEqual(thinPairs(null, 10), [])
  const pairs = [[1, 1], [2, 2], [3, 3]]
  assert.deepEqual(thinPairs(pairs, 0), pairs, '0 = 不降采样')
  assert.deepEqual(thinPairs(pairs, 10), pairs, '上限大于长度时原样返回')
  assert.equal(thinPairs(pairs, 2).length, 2)
})

test('对比看板：runs 支持多条，标签可区分（Phase 2 的入口现在就可用）', () => {
  const a = makeRecord()
  const b = {
    ...makeRecord(),
    backtest_id: 'bt_demo_002',
    config: { ...makeRecord().config, selection: { k: 10 } },
  }
  const m = buildCompareDashboard([a, b], { generatedAt: 1700000000000 })
  assert.equal(m.kind, 'compare')
  assert.equal(m.runs.length, 2)
  assert.notEqual(m.runs[0].label, m.runs[1].label, '两条 run 的标签必须可区分')
  assert.ok(m.runs[0].label.includes('top20'), `标签应带 topK，实际 ${m.runs[0].label}`)
  assert.throws(() => buildCompareDashboard([]), (e) => e.code === 'NO_RUNS')
})

test('模型体积：7 年日频回测的内联 JSON 不至于撑爆 HTML', () => {
  const nav = []
  let v = 1
  let d = new Date(Date.UTC(2018, 0, 1))
  for (let i = 0; i < 1750; i++) {
    d = new Date(d.getTime() + 86400000)
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue
    v *= 1.0004
    nav.push({ date: Number(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`), nav: +v.toFixed(6) })
  }
  const m = buildBacktestDashboard(makeRecord({ nav }))
  const bytes = JSON.stringify(m).length
  assert.ok(bytes < 200_000, `模型 JSON 应小于 200KB，实际 ${bytes}`)
  assert.ok(m.runs[0].nav.length === nav.length)
})

test('分析层：回撤序列与回撤段自洽', () => {
  const nav = makeNav()
  const segs = drawdownPeriods(nav)
  const series = drawdownSeries(nav)
  assert.equal(series.length, nav.length)
  const deepest = Math.min(...series.map(([, v]) => v))
  assert.equal(segs[0].trough, +deepest.toFixed(6), '最深回撤段应等于回撤序列的极值')
  // 未收复的段 recoverDate 必须是 null，而不是 0 或 undefined
  for (const s of segs) {
    assert.ok(s.recoverDate === null || typeof s.recoverDate === 'number')
  }
})

test('分析层：成本拆分不含滑点、占比以初始资金为分母', () => {
  const c = costBreakdown({ fees: { commission: 100, stampDuty: 50, transferFee: 10, slippage: 999 } }, null, 1_000_000)
  assert.equal(c.fees, 160)
  assert.equal(c.total, 1159)
  assert.equal(c.shareOfInitial, +(160 / 1_000_000).toFixed(4))
  assert.ok(c.note.includes('滑点'))
})

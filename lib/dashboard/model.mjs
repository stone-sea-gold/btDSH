/**
 * 看板数据模型（Prompt 2 的**唯一契约**）。
 *
 * ## 为什么要有这一层
 *
 * Phase 1 是"导出一份自包含 HTML"，Phase 2 是"活数据面板"。两者的**内容、栏目、
 * 视觉都不该变**，变的只有一件事：数据从哪来。
 *     Phase 1：数据内联在 HTML 里（快照）
 *     Phase 2：页面向 /quant/dashboard/:id 拉同一份 JSON（活数据）
 * 所以把"回测记录 → 看板模型"这一步单独抽出来，渲染器只吃模型。
 * 届时渲染器一行不改，只把 bootstrap 的取数函数换掉。
 *
 * ## 模型的两条设计约束
 *
 * 1. **`runs` 永远是数组**。Phase 1 只放一条（`kind: 'backtest'`），
 *    Phase 2 的对比视图直接放 N 条（`kind: 'compare'`）。渲染器从第一天就按
 *    "多列指标 + 多条净值曲线"来写，Phase 2 不用改结构。
 * 2. **模型里不出现任何"怎么画"的信息**。没有颜色、没有像素、没有图表库类型，
 *    只有 `format` / `tone` / `group` 这类**语义**标记，由渲染器翻译成视觉。
 *    这样换渲染器（SVG→Canvas、卡片→面板）不用动数据层。
 *
 * ## 数值口径
 *
 * 所有派生数字来自 `lib/backtest/analyze.mjs`——与 `quant_backtest_analyze`
 * 工具是同一份实现，保证"工具说的"和"看板画的"永远一致。
 */

import { yearlyStats, drawdownPeriods, drawdownSeries, costBreakdown } from '../backtest/analyze.mjs'

export const DASHBOARD_SCHEMA_VERSION = 1

export const GENERATOR = 'dsh-quant-assistant'
export const DISCLAIMER = '本报告是对历史数据的统计描述，不构成投资建议，也不预测未来收益。'

/** 与 export.mjs 的 DEFAULT 一致，但独立声明，避免看板依赖导出模块 */
const DEFAULT_CASH = 1_000_000

const isNum = (x) => typeof x === 'number' && Number.isFinite(x)

/** KPI 定义：语义字段由渲染器翻译成视觉，模型不碰样式 */
const kpi = (id, label, value, format, group, tone = 'neutral', hint = null) =>
  ({ id, label, value: isNum(value) ? value : null, format, group, tone, hint })

/** 收益类：A 股口径，正=红(up)、负=绿(down) */
const toneBySign = (v) => (isNum(v) ? (v >= 0 ? 'up' : 'down') : 'neutral')

/**
 * 把 KPI 按"收益 / 风险 / 交易 / 成本"分组。
 *
 * 分组而不是平铺 16 个指标：一屏之内先看收益与风险，交易与成本是第二眼信息。
 * 渲染器按 group 决定堆叠顺序与分隔，换布局时不用改模型。
 */
function buildKpis(metrics, cost, { trades = null, rebalances = null } = {}) {
  const m = metrics ?? {}
  const b = m.benchmark ?? null
  return [
    kpi('totalReturn', '总收益', m.totalReturn, 'pct', 'return', toneBySign(m.totalReturn)),
    kpi('cagr', '年化收益', m.cagr, 'pct', 'return', toneBySign(m.cagr)),
    b ? kpi('benchmarkReturn', '基准收益', b.totalReturn, 'pct', 'return', toneBySign(b.totalReturn),
      '基准为区间内等权买入持有代理（v1 未接入指数行情）') : null,
    b ? kpi('excessReturn', '超额收益', b.excessReturn, 'pct', 'return', toneBySign(b.excessReturn)) : null,

    kpi('maxDrawdown', '最大回撤', m.maxDrawdown, 'pct', 'risk', 'down'),
    kpi('annualVol', '年化波动', m.annualVol, 'pct', 'risk'),
    kpi('sharpe', '夏普', m.sharpe, 'num', 'risk', 'neutral', '日收益年化：(均值/标准差)×√252'),
    kpi('calmar', 'Calmar', m.calmar, 'num', 'risk', 'neutral', '年化收益 / |最大回撤|'),

    kpi('winRate', '胜率', m.winRate, 'pct', 'trade', 'neutral', '日收益为正的比例'),
    kpi('trades', '成交笔数', trades ?? m.trades, 'int', 'trade'),
    kpi('turnover', '年化换手', m.turnover, 'num2', 'trade', 'neutral', m.turnoverNote ?? '年化双边成交额 / 平均净值'),
    rebalances === null ? null : kpi('rebalances', '调仓次数', rebalances, 'int', 'trade'),

    kpi('fees', '费用合计', cost.fees, 'money', 'cost', 'neutral', '佣金 + 印花税 + 过户费（不含滑点）'),
    kpi('slippage', '滑点', cost.slippage, 'money', 'cost'),
    kpi('feeShare', '费用占初始资金', cost.shareOfInitial, 'pct', 'cost'),
  ].filter(Boolean)
}

/**
 * 净值序列降采样：保留首尾与形状。
 * 只在**明确给了上限**时才降（Phase 2 的列表页/对比页需要）；
 * 导出文件不受卡片宽度限制，默认全量保留。
 */
export function thinPairs(pairs, max = 0) {
  const n = pairs?.length ?? 0
  if (!max || max <= 0 || n <= max) return pairs ?? []
  const step = (n - 1) / (max - 1)
  const out = []
  for (let i = 0; i < max; i++) out.push(pairs[Math.round(i * step)])
  return out
}

/** 口径声明：优先用持久化的原文，缺失时按配置确定性重建 */
function caveatsOf(record) {
  const saved = record?.metrics?.caveats
  if (Array.isArray(saved) && saved.length) return saved
  const cfg = record?.config ?? {}
  return [
    'ST 状态使用当前快照，非历史逐日状态',
    '上市天数用自然日近似（未按交易日历计数）',
    '日频无法表达盘中路径；止损类规则需显式假设',
    cfg.benchmarkCode ? null : '基准为区间内等权买入持有代理（未接入指数数据）',
  ].filter(Boolean)
}

/** 头部徽章：把"读这张图必须知道的限定"顶到最上面，而不是埋在脚注 */
function badgesOf(record) {
  const cfg = record?.config ?? {}
  const startYear = Math.floor((cfg.start ?? 0) / 10000)
  const endYear = Math.floor((cfg.end ?? 0) / 10000)
  const span = endYear && startYear ? endYear - startYear : 0
  return [
    { text: '样本内结果', tone: 'warn', hint: '参数是在这段历史上选的，换区间/换参数可能显著不同' },
    span > 5 ? { text: `长区间 ${span} 年`, tone: 'warn', hint: '区间越长越容易挑出好看的结果，需样本外复核' } : null,
    cfg.benchmarkCode ? null : { text: '基准=等权代理', tone: 'neutral', hint: 'v1 未接入指数行情，基准是区间内等权买入持有' },
  ].filter(Boolean)
}

/** 一条 run 的标签：单条时用策略名，对比时用于区分曲线 */
function labelOf(record, index, total) {
  const sid = record?.strategy_id ?? record?.strategyId ?? '—'
  if (total <= 1) return sid
  const cfg = record?.config ?? {}
  const k = cfg.selection?.k
  return `${sid}${k ? ` · top${k}` : ''}${index === 0 ? ' （主）' : ''}`
}

/** 单条回测记录 → 一个 run 块（渲染器的数据单元，Phase 2 直接复用） */
function buildRun(record, { index = 0, total = 1, maxPoints = 0 } = {}) {
  const nav = Array.isArray(record?.nav) ? record.nav : []
  if (nav.length < 2) {
    const e = new Error('这条回测没有净值曲线（或只有 1 个点），无法生成看板')
    e.code = 'NO_NAV'
    throw e
  }
  const cfg = record.config ?? {}
  const metrics = record.metrics ?? {}
  const cost = costBreakdown(metrics, nav, cfg.initialCash ?? metrics.initialCash ?? DEFAULT_CASH)

  const navPairs = thinPairs(nav.map((p) => [p.date, +Number(p.nav).toFixed(4)]), maxPoints)
  const ddPairs = thinPairs(drawdownSeries(nav), maxPoints)
  const byFactor = Array.isArray(metrics.byFactor) ? metrics.byFactor : []

  return {
    key: record.backtest_id ?? record.backtestId ?? `run${index}`,
    label: labelOf(record, index, total),
    range: [nav[0].date, nav.at(-1).date],
    days: nav.length,
    config: {
      strategyId: record.strategy_id ?? record.strategyId ?? null,
      version: record.version ?? null,
      initialCash: cfg.initialCash ?? DEFAULT_CASH,
      factors: (cfg.factors ?? []).map((f) => ({ id: f.id, formula: f.formula ?? null })),
      topK: cfg.selection?.k ?? null,
      rebalance: cfg.rebalance ?? null,
      weight: cfg.weight ?? null,
    },
    kpis: buildKpis(metrics, cost, { rebalances: metrics.rebalances ?? null }),
    nav: navPairs,
    drawdown: ddPairs,
    yearly: yearlyStats(nav),
    drawdowns: drawdownPeriods(nav),
    byFactor: byFactor.map((f) => ({
      factorId: f.factorId,
      totalReturn: f.totalReturn ?? null,
      cagr: f.cagr ?? null,
      sharpe: f.sharpe ?? null,
      maxDrawdown: f.maxDrawdown ?? null,
      trades: f.trades ?? null,
    })),
    costs: cost,
    rejected: metrics.skipped ?? null,
    caveats: caveatsOf(record),
  }
}

/**
 * 回测记录 → 看板模型。
 *
 * @param {object} record `store.getBacktest()` 返回的行（snake_case），
 *                        或 `quant_backtest_run` 的内存结果（camelCase，均可）
 * @param {object} opts
 *   - generatedAt 生成时刻（ms），测试里固定它以保证可复现
 *   - source      'export'（内联快照）| 'live'（Phase 2 面板）
 *   - maxPoints   净值点数上限（0 = 全量；Phase 2 列表页可传 400 控体积）
 */
export function buildBacktestDashboard(record, { generatedAt = Date.now(), source = 'export', maxPoints = 0 } = {}) {
  const run = buildRun(record, { index: 0, total: 1, maxPoints })
  const strategyId = record.strategy_id ?? record.strategyId ?? null
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    kind: 'backtest',
    source,
    generatedAt,
    meta: {
      title: `回测报告：${strategyId ?? '—'}`,
      subtitle: String(record.backtest_id ?? record.backtestId ?? '—'),
      strategyId,
      backtestId: record.backtest_id ?? record.backtestId ?? null,
      version: record.version ?? null,
      badges: badgesOf(record),
    },
    runs: [run],
    footer: { disclaimer: DISCLAIMER, generator: GENERATOR },
  }
}

/**
 * 对比看板（**Phase 2 的入口，Phase 1 不产出**）。
 *
 * 现在就写好，是为了让 `runs` 的"多 run"形态有唯一实现可依 ——
 * 渲染器据此从第一天就支持多条曲线，Phase 2 只需调用这个函数。
 */
export function buildCompareDashboard(records, { generatedAt = Date.now(), source = 'export', maxPoints = 0, title = null } = {}) {
  const list = (records ?? []).filter(Boolean)
  if (!list.length) {
    const e = new Error('没有可对比的回测')
    e.code = 'NO_RUNS'
    throw e
  }
  const runs = list.map((r, i) => buildRun(r, { index: i, total: list.length, maxPoints }))
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    kind: 'compare',
    source,
    generatedAt,
    meta: {
      title: title ?? `回测对比（${runs.length} 条）`,
      subtitle: runs.map((r) => r.key).join('、'),
      strategyId: null,
      backtestId: null,
      version: null,
      badges: [{ text: '样本内结果', tone: 'warn', hint: '参数是在这段历史上选的，换区间/换参数可能显著不同' }],
    },
    runs,
    footer: { disclaimer: DISCLAIMER, generator: GENERATOR },
  }
}

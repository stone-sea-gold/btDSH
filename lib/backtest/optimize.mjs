/**
 * 参数优化（网格 / 随机）。
 *
 * 关键性能设计：**因子面板只物化一次，参数扫描只换策略参数**。
 * 面板里存的是 top-N + 每日排名，所以 topK ≤ N、调仓频率、权重方式、缓冲
 * 都可以在**不重算因子**的前提下扫。P0 实测全市场单组回测 0.47s、扫参 0.67s/组。
 *
 * 诚实的边界（必须随结果一起返回）：
 *   - 参数扫描是**样本内择优**，最好的那组天然带选择偏差 → 必须样本外复核
 *   - 只扫策略参数，不扫因子本身；因子集不同时结果不可直接比较
 *   - 目标函数含 null 时该组被排除，而不是当作 0
 */

import { runBacktest } from './engine.mjs'
import { materializePanel, DEFAULT_TOP_N } from '../factors/panel.mjs'

export const OBJECTIVES = ['sharpe', 'cagr', 'calmar', 'totalReturn', 'excessReturn', 'informationRatio']

/** 确定性 PRNG（mulberry32）：随机扫描必须可复现，否则"最优参数"没有意义 */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function cartesian(space) {
  const keys = Object.keys(space)
  let out = [{}]
  for (const k of keys) {
    const vals = space[k]
    const next = []
    for (const o of out) for (const v of vals) next.push({ ...o, [k]: v })
    out = next
  }
  return out
}

/** 从 space 里随机抽 n 组（不重复，n 超过组合总数时退化为全量） */
function sample(space, n, seed) {
  const all = cartesian(space)
  if (n >= all.length) return all
  const rnd = mulberry32(seed)
  const idx = new Set()
  while (idx.size < n) idx.add(Math.floor(rnd() * all.length))
  return [...idx].map((i) => all[i])
}

function objectiveOf(metrics, objective) {
  if (!metrics) return null
  const v = objective === 'excessReturn' || objective === 'informationRatio'
    ? metrics.benchmark?.[objective]
    : metrics[objective]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * @param {object} store
 * @param {object} opts
 *   factors: [{factorId, formula}]（≥1；formula 用于按需物化面板）
 *   space:   { topK: [..], rebalance: [..], weight: [..], buffer: [..], execPrice: [..] }
 *   mode:    'grid' | 'random'
 *   samples: 随机模式的抽样组数（默认 40）
 *   seed:    随机种子（默认 42，保证可复现）
 *   objective: 目标函数，见 OBJECTIVES（默认 sharpe）
 *   maxRuns: 组合数上限（默认 500，超过直接拒绝而不是跑一整天）
 *   其余透传给 runBacktest：start/end/initialCash/universe/costs/benchmarkCode
 */
export function optimizeStrategy(store, {
  factors = [], space = {}, mode = 'grid', samples = 40, seed = 42,
  objective = 'sharpe', maxRuns = 500, topN = DEFAULT_TOP_N,
  start = 0, end = 99999999, initialCash = 1_000_000,
  universe = {}, costs = {}, benchmarkCode = null, onProgress,
} = {}) {
  if (!OBJECTIVES.includes(objective)) {
    return { ok: false, error: { code: 'BAD_OBJECTIVE', message: `目标函数必须是 ${OBJECTIVES.join(' / ')}` } }
  }
  if (!factors.length) return { ok: false, error: { code: 'NO_FACTOR', message: '至少需要一个因子' } }
  for (const k of Object.keys(space)) {
    if (!Array.isArray(space[k]) || space[k].length === 0) {
      return { ok: false, error: { code: 'BAD_SPACE', message: `参数 ${k} 的候选值必须是非空数组` } }
    }
  }

  // topK 不能超过面板深度，否则排名不够用
  const maxTopK = Math.max(...(space.topK ?? [1]), 1)
  if (maxTopK > topN) {
    return { ok: false, error: { code: 'TOPK_EXCEEDS_PANEL', message: `topK 最大 ${maxTopK} 超过面板深度 ${topN}；请提高 topN 后重新物化` } }
  }

  // ① 因子面板只物化一次
  const panels = []
  const t0 = Date.now()
  for (const f of factors) {
    if (!f.formula) { panels.push({ factorId: f.factorId, skipped: true, reason: 'assumed-materialized' }); continue }
    const r = materializePanel(store, { factorId: f.factorId, formula: f.formula, topN, from: start, to: end })
    if (!r.ok) return { ok: false, error: { code: 'PANEL_FAILED', message: `因子 ${f.factorId} 面板物化失败：${r.error?.message}`, factorId: f.factorId } }
    panels.push({ factorId: f.factorId, rows: r.rows, skipped: !!r.skipped, ms: r.ms })
  }
  const panelMs = Date.now() - t0

  // ② 展开参数组合
  const combos = mode === 'random' ? sample(space, samples, seed) : cartesian(space)
  if (combos.length > maxRuns) {
    return {
      ok: false,
      error: {
        code: 'TOO_MANY_RUNS',
        message: `参数组合 ${combos.length} 组超过上限 ${maxRuns}；请收窄空间或改用 random 模式（samples ≤ ${maxRuns}）`,
        combos: combos.length,
      },
    }
  }

  // ③ 逐组回测（因子已物化，这里只换策略参数）
  const t1 = Date.now()
  const results = []
  let done = 0
  for (const combo of combos) {
    for (const f of factors) {
      const cfg = { ...combo, factorId: f.factorId, start, end, initialCash, universe, costs, benchmarkCode }
      const r = runBacktest(store, cfg)
      done++
      onProgress?.({ done, total: combos.length * factors.length, combo, factorId: f.factorId })
      if (!r.ok) { results.push({ ...combo, factorId: f.factorId, error: r.error.code }); continue }
      const obj = objectiveOf(r.metrics, objective)
      results.push({
        ...combo,
        factorId: f.factorId,
        objective: obj,
        totalReturn: r.metrics.totalReturn,
        cagr: r.metrics.cagr,
        sharpe: r.metrics.sharpe,
        maxDrawdown: r.metrics.maxDrawdown,
        calmar: r.metrics.calmar,
        turnover: r.metrics.turnover,
        trades: r.metrics.trades,
        excessReturn: r.metrics.benchmark?.excessReturn ?? null,
        informationRatio: r.metrics.benchmark?.informationRatio ?? null,
      })
    }
  }
  const scanMs = Date.now() - t1

  const scored = results.filter((r) => r.objective !== null && r.objective !== undefined)
  scored.sort((a, b) => b.objective - a.objective)
  const failed = results.length - scored.length

  return {
    ok: true,
    mode, objective, seed: mode === 'random' ? seed : null,
    factors: factors.map((f) => f.factorId),
    space,
    combos: combos.length,
    evaluated: results.length,
    unscored: failed,
    panelMs, scanMs,
    msPerRun: results.length ? +(scanMs / results.length).toFixed(1) : null,
    best: scored[0] ?? null,
    ranked: scored,
    caveats: [
      '参数扫描是样本内择优，最优组天然带选择偏差 → 必须用样本外区间复核',
      '只扫策略参数，不扫因子本身；不同因子集之间的结果不可直接比较',
      failed > 0 ? `${failed} 组因目标函数无定义（如基准缺失/样本过短）被排除，未按 0 计入` : null,
      'ST 状态使用当前快照；基准未接指数时为等权买入持有代理',
    ].filter(Boolean),
  }
}

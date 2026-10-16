/**
 * 因子面板物化（P0 性能结论的落地）。
 *
 * P0 实测（全市场 5400 只 × 1600 日 = 864 万根 bar）：
 *   逐日因子表 + 查询时排名：物化 16.3s（无排名）、回测 19.1s、库 1706MB
 *   事件表 + 物化排名 + top-N(500)：物化 36.9s、**回测 0.47s**、扫库 802MB、扫参 0.67s/组
 * → 面板必须**连排名一起物化**，且**只物化 top-N**（排名深度 = 策略可能用到的最大 top_k）。
 *
 * 排名在 SQL 层用 `row_number()` 计算（**不能用 `rank()`**：并列会产生重复 rank，撞主键）。
 */

import { createHash } from 'node:crypto'
import { compileFactor } from './dsl.mjs'
import { ensureFactorAggregates } from './aggregates.mjs'

export const DEFAULT_TOP_N = 500
const FIELD_MAP = { turnover_rate: 'turnover' }

export function formulaHash(formula, topN, source = 'bars_adj') {
  return createHash('sha1').update(`${formula}::${topN}::${source}`).digest('hex').slice(0, 16)
}

/**
 * 物化因子面板（幂等；同 formula_hash 且已覆盖到 to 时直接跳过）。
 *
 * @param {object} store openStore 的返回值
 * @param {{factorId: string, formula: string, topN?: number, from?: number, to?: number, force?: boolean, source?: string, onProgress?: Function}} opts
 *   source 默认 `bars_adj`（复权价视图）——**价格类因子必须用复权价**，否则除权日会产生假信号
 */
export function materializePanel(store, { factorId, formula, topN = DEFAULT_TOP_N, from = 0, to = 99999999, force = false, source = 'bars_adj', onProgress } = {}) {
  const t0 = Date.now()
  const hash = formulaHash(formula, topN, source)
  const meta = store.panelMeta(factorId)

  if (!force && meta && meta.formula_hash === hash && (meta.last_date ?? 0) >= to) {
    return { ok: true, skipped: true, reason: 'up-to-date', factorId, rows: meta.rows, topN: meta.top_n, firstDate: meta.first_date, lastDate: meta.last_date, ms: 0 }
  }
  if (!force && meta && meta.formula_hash !== hash) {
    // 公式变了 → 旧面板失效，先清掉（避免新旧混用）
    store.deletePanel(factorId)
  }

  const compiled = compileFactor(formula, { source, fieldMap: FIELD_MAP })
  if (!compiled.ok) return { ok: false, factorId, error: compiled.error }
  // Rank / IdxMax / IdxMin 依赖自定义滑动聚合，注册是幂等的
  if (compiled.meta.aggregates?.length) ensureFactorAggregates(store)

  // 增量：已有同 hash 面板则只补新日期（窗口函数仍能看到更早的历史行，故正确）
  const existing = store.panelMeta(factorId)
  const startFrom = force || !existing || existing.formula_hash !== hash ? from : Math.max(from, (existing.last_date ?? 0) + 1)

  const cteSql = compiled.ctes.length ? `WITH ${compiled.ctes.join(',\n     ')}, _v AS (${compiled.finalSelect})` : `WITH _v AS (${compiled.finalSelect})`
  const insertSql = `${cteSql}
INSERT OR REPLACE INTO factor_panel(factor_id, date, rank, code, value)
SELECT ?, date, row_number() OVER (PARTITION BY date ORDER BY value DESC, code), code, value
FROM _v WHERE value IS NOT NULL AND date BETWEEN ? AND ?`

  const before = store.raw.prepare('SELECT count(*) c FROM factor_panel WHERE factor_id=?').get(factorId)?.c ?? 0
  store.raw.prepare(insertSql).run(factorId, startFrom, to)
  const after = store.raw.prepare('SELECT count(*) c FROM factor_panel WHERE factor_id=?').get(factorId)?.c ?? 0
  const range = store.raw.prepare('SELECT min(date) a, max(date) b FROM factor_panel WHERE factor_id=?').get(factorId)

  store.setPanelMeta({ factorId, formula, formulaHash: hash, topN, firstDate: range?.a ?? null, lastDate: range?.b ?? null, rows: after })
  onProgress?.({ factorId, inserted: after - before, rows: after })

  return {
    ok: true, skipped: false, factorId, topN, hash,
    inserted: after - before, rows: after, firstDate: range?.a ?? null, lastDate: range?.b ?? null,
    layerCount: compiled.meta.layerCount, ms: Date.now() - t0,
  }
}

/**
 * LRU 淘汰：保留最近使用的 keep 个面板（默认 8 个因子 / 可按磁盘配额调整）。
 * @returns {{evicted: string[]}}
 */
export function evictPanels(store, { keep = 8 } = {}) {
  const panels = store.listPanels()
  const evicted = []
  for (const p of panels.slice(keep)) {
    store.deletePanel(p.factor_id)
    evicted.push(p.factor_id)
  }
  return { evicted }
}

/** 取某个信号日的候选（按 rank 升序） */
export function candidatesOn(store, factorId, date, topK) {
  return store.panelRanksOn(factorId, date, topK)
}

/** 面板体检：返回覆盖率、每日候选数分布，用于判断 top-N 是否足够 */
export function panelHealth(store, factorId, { sample = 20 } = {}) {
  const meta = store.panelMeta(factorId)
  if (!meta) return { ok: false, reason: 'no-panel' }
  const topN = meta.top_n ?? DEFAULT_TOP_N
  const perDay = store.raw.prepare(`SELECT date, count(*) c, max(rank) mx FROM factor_panel WHERE factor_id=? GROUP BY date ORDER BY date DESC LIMIT ?`).all(factorId, sample)
  const full = perDay.filter((d) => d.mx >= topN).length
  const universe = store.raw.prepare('SELECT count(DISTINCT code) c FROM bars').get()?.c ?? 0
  const maxPossible = Math.min(topN, universe)
  return {
    ok: true, factorId, topN, rows: meta.rows,
    firstDate: meta.first_date, lastDate: meta.last_date,
    universeStocks: universe,
    sampledDays: perDay.length, daysHittingTopN: full,
    note: full < perDay.length
      ? (universe < topN
        ? `股票池只有 ${universe} 只 < top-N(${topN})，排名自然填不满（预期行为）`
        : `部分交易日不足 top-N（可能存在数据缺口）`)
      : 'ok',
    effectiveDepth: maxPossible,
  }
}

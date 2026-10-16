/**
 * 选股：给定因子与信号日，输出**可执行**的候选名单。
 *
 * 两条路径，结果口径一致：
 *   ① 面板路径（推荐）：因子已物化 → 直接读 `factor_panel` 的 rank，O(候选数)
 *   ② 临时路径：未物化时现场编译求值。只取信号日截面，因此把源数据裁到
 *      **每只股票最后 lookback+1 行**（lookback 由 DSL 编译器给出），
 *      窗口函数层只处理 ~K×股票数 行，而不是全历史。
 *
 * 股票池过滤与回测引擎同口径（ST / 停牌 / 上市天数），并**逐条给出拒绝原因计数**，
 * 使"为什么这只没入选"可回答，而不是一个黑箱 top-K。
 */

import { compileFactor } from './dsl.mjs'
import { ensureFactorAggregates } from './aggregates.mjs'
import { boardOf, limitRatioOf, calendarDaysBetween } from '../data/codes.mjs'

const FIELD_MAP = { turnover_rate: 'turnover' }

/** 信号日的股票池过滤（与 backtest/engine.mjs 的 tradability 保持一致） */
function universeFilter(store, date, { excludeST = true, minListDays = 60, excludeSuspended = true } = {}) {
  const codes = new Map(store.codesList().map((c) => [c.code, c]))
  return (row) => {
    const info = codes.get(row.code)
    if (!info) return 'unknown-code'
    if (excludeST && info.is_st) return 'st'
    if (excludeSuspended && (!row.volume || row.volume === 0)) return 'suspended'
    const listedDays = info.list_date ? calendarDaysBetween(date, info.list_date) : null
    if (minListDays > 0 && listedDays !== null && listedDays < minListDays) return 'new-listing'
    return null
  }
}

function latestBarDate(store, upperBound) {
  const r = store.raw.prepare('SELECT max(date) d FROM bars WHERE date <= ?').get(upperBound ?? 99999999)
  return r?.d ?? null
}

/**
 * @param {object} store
 * @param {object} opts
 *   factorId 已物化面板的 id（可选）
 *   formula  DSL 公式（factorId 无面板时必需）
 *   date     信号日 YYYYMMDD（默认最新交易日）
 *   topK     取前 K 名（默认 20）
 *   ascending 是否取因子值最小（默认 false = 取最大）
 *   universe { excludeST, minListDays, excludeSuspended }
 * @returns {{ok: boolean, error?: object, date, picks: object[], rejected: object, universeSize: number, caveats: string[]}}
 */
export function selectStocks(store, {
  factorId = null, formula = null, date = null, topK = 20,
  ascending = false, source = 'bars_adj', universe = {},
} = {}) {
  const signalDate = date ?? latestBarDate(store)
  if (!signalDate) return { ok: false, error: { code: 'NO_DATA', message: '仓库中没有行情数据' } }
  const { excludeST = true, minListDays = 60, excludeSuspended = true } = universe
  const order = ascending ? 'ASC' : 'DESC'

  let rows = []
  let path = 'panel'
  let dateAdjusted = null
  const meta = factorId ? store.panelMeta(factorId) : null

  // 面板新鲜度与行情新鲜度是**两件事**：同步了新行情之后，旧面板并不会自动延伸。
  // 默认取"最新交易日"时如果面板还没覆盖到，就退到面板实际覆盖的最后一天并**明确告知**；
  // 但如果调用方**显式指定**了日期，就不猜——直接报错，避免悄悄换掉用户要的那天。
  let effectiveDate = signalDate
  if (factorId && meta && date === null && (meta.last_date ?? 0) < signalDate) {
    dateAdjusted = {
      requested: signalDate, used: meta.last_date,
      reason: `因子面板 ${factorId} 只物化到 ${meta.last_date}，行情已到 ${signalDate}；已退到面板覆盖的最后一天`,
      fix: '要覆盖最新行情，请用 quant_backtest_run 或重新物化面板（materializePanel 的 to 设为最新交易日）',
    }
    effectiveDate = meta.last_date
  }

  if (factorId && meta && (meta.last_date ?? 0) >= effectiveDate && (meta.first_date ?? 0) <= effectiveDate) {
    rows = store.raw.prepare(`
      SELECT p.code, p.value, b.close, b.pct, b.turnover AS turnover, b.amount, b.volume,
             c.name, c.board, c.is_st, c.list_date
      FROM factor_panel p
      JOIN bars b ON b.code = p.code AND b.date = p.date
      LEFT JOIN codes c ON c.code = p.code
      WHERE p.factor_id = ? AND p.date = ? AND p.value IS NOT NULL
      ORDER BY p.value ${order}, p.code`).all(factorId, effectiveDate)
  } else {
    if (!formula) {
      return {
        ok: false,
        error: {
          code: 'NO_FACTOR',
          message: factorId
            ? `因子面板 ${factorId} 未覆盖 ${signalDate}，且未提供 formula 供现场求值`
            : '必须提供 factorId（已物化面板）或 formula（现场求值）',
        },
      }
    }
    path = 'adhoc'
    const probe = compileFactor(formula, { source, fieldMap: FIELD_MAP })
    if (!probe.ok) return { ok: false, error: probe.error }
    if (probe.meta.aggregates?.length) ensureFactorAggregates(store)
    // 裁到每只股票最后 lookback+1 行：窗口函数只需看到足够的历史
    const k = (probe.meta.lookback ?? 0) + 1
    const trimmed = `(SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY code ORDER BY date DESC) AS __rn
                      FROM ${source} WHERE date <= ${Number(effectiveDate)}) WHERE __rn <= ${k})`
    const c = compileFactor(formula, { source: trimmed, fieldMap: FIELD_MAP })
    if (!c.ok) return { ok: false, error: c.error }
    const sql = `
      SELECT v.code, v.value, b.close, b.pct, b.turnover AS turnover, b.amount, b.volume,
             c.name, c.board, c.is_st, c.list_date
      FROM (${c.sql}) v
      JOIN bars b ON b.code = v.code AND b.date = v.date
      LEFT JOIN codes c ON c.code = v.code
      WHERE v.date = ? AND v.value IS NOT NULL
      ORDER BY v.value ${order}, v.code`
    rows = store.raw.prepare(sql).all(effectiveDate)
  }

  const reject = universeFilter(store, effectiveDate, { excludeST, minListDays, excludeSuspended })
  const rejected = {}
  const kept = []
  for (const r of rows) {
    const why = reject(r)
    if (why) { rejected[why] = (rejected[why] ?? 0) + 1; continue }
    kept.push(r)
  }
  const picks = kept.slice(0, Math.max(0, topK)).map((r, i) => ({
    rank: i + 1,
    code: r.code,
    name: r.name ?? null,
    board: r.board ?? boardOf(r.code),
    value: r.value,
    close: r.close,
    pct: r.pct,
    turnover: r.turnover,
    amount: r.amount,
    limitRatio: limitRatioOf(r.code, false),
  }))

  return {
    ok: true,
    path,
    date: effectiveDate,
    dateAdjusted,
    factorId: factorId ?? null,
    formula: formula ?? meta?.formula ?? null,
    topK,
    ascending,
    universeSize: rows.length,
    passedUniverse: kept.length,
    rejected,
    picks,
    caveats: [
      'ST 状态使用当前快照，非信号日的历史状态',
      '上市天数用自然日近似（未按交易日历计数）',
      '因子值基于复权价计算；涨跌停/停牌的可交易性在 T+1 执行时判定',
      path === 'adhoc' ? '现场求值路径只返回信号日截面，未落库；重复使用建议先物化面板' : null,
      dateAdjusted ? dateAdjusted.reason : null,
    ].filter(Boolean),
  }
}

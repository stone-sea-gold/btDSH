/**
 * 回测结果的**派生分析**（纯函数）。
 *
 * 为什么要单独一层：同一份净值曲线会被三处消费 ——
 *   `quant_backtest_analyze` 工具（给模型读的文本）
 *   HTML 看板（给人看的图）
 *   将来的活数据面板（同一套图，换投递通道）
 * 三处各写一遍分年度/回撤的循环，迟早漂移成"工具说 -18.2%、看板说 -17.9%"。
 * 所以算法只在这里有一份，其余地方只负责排版。
 *
 * 口径：全部输入都是**已持久化的净值序列** `[{ date: YYYYMMDD, nav }]`，
 * 因此对历史回测（从库里读回来）和刚跑完的回测结果完全一致。
 */

import { computeMetrics } from './engine.mjs'
import { calendarDaysBetween } from '../data/codes.mjs'

const r6 = (x) => (Number.isFinite(x) ? +x.toFixed(6) : null)

/**
 * 分年度统计。
 * 每年的夏普用该年自身的日收益序列算（不是把全年化指标切一刀），
 * 所以年数少的年份夏普会很跳 —— 这是**如实反映**，不做平滑。
 */
export function yearlyStats(nav) {
  const byYear = new Map()
  for (const p of nav) {
    const y = Math.floor(p.date / 10000)
    if (!byYear.has(y)) byYear.set(y, [])
    byYear.get(y).push(p)
  }
  return [...byYear.entries()].map(([year, pts]) => {
    let peak = pts[0].nav
    let mdd = 0
    for (const p of pts) {
      if (p.nav > peak) peak = p.nav
      mdd = Math.min(mdd, p.nav / peak - 1)
    }
    return {
      year,
      days: pts.length,
      return: r6(pts.at(-1).nav / pts[0].nav - 1),
      maxDrawdown: r6(mdd),
      sharpe: computeMetrics(pts.map((p) => ({ date: p.date, nav: p.nav })))?.sharpe ?? null,
    }
  })
}

/**
 * 回撤区间（去重相邻段，按谷底由深到浅排序）。
 *
 * `recoverDate: null` 表示至期末尚未收复 —— 看板必须如实标"未收复"，
 * 不能把未收复的回撤与已收复的混在一张表里不区分。
 */
export function drawdownPeriods(nav) {
  if (nav.length < 2) return []
  const out = []
  let peak = nav[0].nav
  let peakDate = nav[0].date
  let cur = null
  for (const p of nav) {
    if (p.nav >= peak) {
      if (cur) {
        cur.recoverDate = p.date
        cur.days = calendarDaysBetween(p.date, cur.startDate)
        out.push(cur)
        cur = null
      }
      peak = p.nav
      peakDate = p.date
    } else {
      const dd = p.nav / peak - 1
      if (!cur) cur = { startDate: peakDate, troughDate: p.date, trough: dd }
      else if (dd < cur.trough) { cur.trough = dd; cur.troughDate = p.date }
    }
  }
  if (cur) {
    cur.recoverDate = null
    cur.days = calendarDaysBetween(nav.at(-1).date, cur.startDate)
    out.push(cur)
  }
  return out
    .map((d) => ({ ...d, trough: r6(d.trough) }))
    .sort((a, b) => a.trough - b.trough)
}

/** 回撤序列（逐日，用于看板的下方副图；与净值同长、同 x 轴） */
export function drawdownSeries(nav) {
  let peak = -Infinity
  return nav.map((p) => {
    if (p.nav > peak) peak = p.nav
    return [p.date, r6(p.nav / peak - 1)]
  })
}

/**
 * 成本拆分与占比。
 *
 * 口径要点（沿用 v1 的既有定义，不在这里悄悄改数）：
 *   - `fees` = 佣金 + 印花税 + 过户费（**不含滑点**）。滑点已经体现在成交价里，
 *     把它再算进"费用"会与券商对账单每次都差一截。
 *   - `slippage` 单独给，供看板单列一行。
 *   - `shareOfInitial` 的分母是**初始资金**而不是收益：收益率可能为负，
 *     用负收益当分母会算出"费用占收益 -300%"这种读不出来的数。
 */
export function costBreakdown(metrics, nav, initialCash = 1_000_000) {
  const f = metrics?.fees ?? {}
  const commission = f.commission ?? 0
  const stampDuty = f.stampDuty ?? 0
  const transferFee = f.transferFee ?? 0
  const slippage = f.slippage ?? 0
  const fees = commission + stampDuty + transferFee
  const base = Number.isFinite(initialCash) && initialCash > 0
    ? initialCash
    : (nav?.length ? nav[0].nav : null)
  return {
    commission: +commission.toFixed(2),
    stampDuty: +stampDuty.toFixed(2),
    transferFee: +transferFee.toFixed(2),
    slippage: +slippage.toFixed(2),
    fees: +fees.toFixed(2),
    total: +(fees + slippage).toFixed(2),
    shareOfInitial: base ? +(fees / base).toFixed(4) : null,
    note: '费用已计入净值；此处给出绝对金额与占初始资金比例，滑点体现在成交价里',
  }
}

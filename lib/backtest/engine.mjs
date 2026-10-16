/**
 * 可交易级回测引擎（v1：日频截面 + 轻量逐日账务）。
 *
 * 架构（ARCHITECTURE §8 的落地）：
 *   ① 信号层：读**已物化的因子面板**（`factor_panel` 的 rank ≤ k）——不在回测时算因子
 *   ② 组合层：调仓日展开目标权重（等权 / 因子加权），带缓冲
 *   ③ 执行与账务层：PortfolioBook 状态机，逐日循环
 *
 * 口径：
 *   - 信号 T 日收盘计算，**T+1 开盘成交**（可配 T+1 收盘）
 *   - 涨停不买、跌停不卖、停牌不交易（用**原始价**判定）
 *   - T+1 制度（当日买入不可卖出）
 *   - 价格空间 = **复权价**（分红送转已隐含；原始价仅用于可交易性判定）
 *   - 佣金/印花税/过户费/滑点按 A 股实际规则
 *
 * 已知边界（写入回测结果）：ST 状态用当前快照（非历史逐日）；上市天数用自然日近似；
 * 日频无法表达盘中路径（止损类规则使用显式假设）。
 */

import { PortfolioBook, DEFAULT_COSTS } from './book.mjs'
import { limitRatioOf, calendarDaysBetween } from '../data/codes.mjs'

/** 载入回测窗口的市场数据（原始价 + 复权价） */
export function loadMarket(store, { start = 0, end = 99999999, codes = null } = {}) {
  const filter = codes && codes.length ? `AND b.code IN (${codes.map(() => '?').join(',')})` : ''
  const params = codes && codes.length ? [start, end, ...codes] : [start, end]
  const rows = store.raw.prepare(`
    SELECT b.code, b.date, b.open, b.high, b.low, b.close, b.volume,
           a.open AS adjOpen, a.close AS adjClose
    FROM bars b JOIN bars_adj a ON a.code = b.code AND a.date = b.date
    WHERE b.date BETWEEN ? AND ? ${filter}
    ORDER BY b.date, b.code`).all(...params)

  const meta = new Map(store.codesList().map((c) => [c.code, c]))
  const byCode = new Map()
  const dateSet = new Set()
  for (const r of rows) {
    dateSet.add(r.date)
    if (!byCode.has(r.code)) byCode.set(r.code, new Map())
    byCode.get(r.code).set(r.date, r)
  }
  const dates = [...dateSet].sort((a, b) => a - b)
  // 每只股票的前一交易日原始收盘（用于涨跌停判定）
  const prevRaw = new Map()
  for (const [code, m] of byCode) {
    const ds = [...m.keys()].sort((a, b) => a - b)
    let prev = null
    for (const d of ds) { prevRaw.set(`${code}|${d}`, prev); prev = m.get(d).close }
  }
  return { rows, byCode, dates, prevRaw, meta, codes: [...byCode.keys()] }
}

function isLastTradingDayOfPeriod(dates, i, period) {
  if (period === 'daily') return true
  const d = dates[i]
  const next = dates[i + 1]
  if (next === undefined) return true
  const key = (x) => {
    const y = Math.floor(x / 10000), m = Math.floor(x / 100) % 100, day = x % 100
    if (period === 'monthly') return `${y}-${m}`
    // weekly：ISO 周（用日期差近似，周一为一周开始）
    const dt = new Date(Date.UTC(y, m - 1, day))
    const dayIdx = (dt.getUTCDay() + 6) % 7
    const monday = new Date(dt.getTime() - dayIdx * 86400000)
    return `${monday.getUTCFullYear()}-${monday.getUTCMonth() + 1}-${monday.getUTCDate()}`
  }
  return key(d) !== key(next)
}

/** 可交易性判定（用原始价） */
export function tradability(market, code, date, side, { excludeST = true, minListDays = 60 } = {}) {
  const bar = market.byCode.get(code)?.get(date)
  if (!bar) return { ok: false, reason: 'no-bar' }
  if (bar.volume == null || bar.volume === 0) return { ok: false, reason: 'suspended' }
  const info = market.meta.get(code)
  if (excludeST && info?.is_st) return { ok: false, reason: 'st' }
  // 必须用真实自然日差：YYYYMMDD 整数相减不是天数（20240110−20231225 = 8885 ≠ 16）
  const listedDays = info?.list_date ? calendarDaysBetween(date, info.list_date) : null
  if (listedDays !== null && listedDays < minListDays) return { ok: false, reason: 'new-listing' }
  const prev = market.prevRaw.get(`${code}|${date}`)
  if (prev && prev > 0 && bar.open) {
    const limit = limitRatioOf(code, false)
    const up = prev * (1 + limit), down = prev * (1 - limit)
    if (side === 'buy' && bar.open >= up - 1e-6) return { ok: false, reason: 'limit-up' }
    if (side === 'sell' && bar.open <= down + 1e-6) return { ok: false, reason: 'limit-down' }
  }
  return { ok: true, bar }
}

/**
 * 运行回测。
 * @param {object} store
 * @param {object} config
 *   factorId, topK=20, rebalance='monthly'|'weekly'|'daily', weight='equal'|'factor',
 *   start, end, initialCash=1e6, buffer=1.0, execPrice='open'|'close',
 *   universe={excludeST,minListDays}, costs={...}, benchmarkCode=null
 */
export function runBacktest(store, config = {}) {
  const {
    factorId, topK = 20, rebalance = 'monthly', weight = 'equal',
    start = 0, end = 99999999, initialCash = 1_000_000,
    buffer = 1.0, execPrice = 'open', universe = {}, costs = {}, benchmarkCode = null,
    minTradeRatio = 0.005, universeCodes = null, onDay = null,
  } = config

  // universeCodes：把回测限制在指定股票池。
  // 没有它就没法与外部实现做同口径对照——面板里的排名是**全池**算的，
  // 池外股票会挤进 top-K，导致两边选出的组合根本不是同一批（实测踩过）。
  const market = loadMarket(store, { start, end, codes: universeCodes })
  if (market.dates.length < 3) return { ok: false, error: { code: 'NO_DATA', message: '回测区间内没有足够的交易日' } }

  const book = new PortfolioBook({ cash: initialCash, costs: { ...DEFAULT_COSTS, ...costs } })
  const navSeries = []
  const rebalances = []
  const skipped = { buy: {}, sell: {} }
  // 停牌当日 `bars` 里没有该股的行。若持仓在估值时被跳过，它就按 **0** 计入 NAV，
  // 复牌当天再跳回来——实测 688981 停牌 6 天导致单日 +43% 的假跳变，并把最大回撤
  // 从 −20% 夸大到 −47%。因此必须**沿用停牌前最后一个收盘价**估值。
  const lastClose = new Map()
  const lastOpen = new Map()
  let carryForwardDays = 0

  for (let i = 0; i < market.dates.length; i++) {
    const d = market.dates[i]
    book.startDay()

    // 估值用的复权收盘价（停牌股沿用最后已知价）
    const closePrices = new Map()
    for (const [code, m] of market.byCode) {
      const bar = m.get(d)
      if (bar) { closePrices.set(code, bar.adjClose); lastClose.set(code, bar.adjClose) }
    }
    for (const code of book.positions.keys()) {
      if (!closePrices.has(code) && lastClose.has(code)) { closePrices.set(code, lastClose.get(code)); carryForwardDays++ }
    }

    // ── 执行：信号来自前一交易日 ────────────────────────────────────────────
    if (i > 0) {
      const signalDate = market.dates[i - 1]
      if (isLastTradingDayOfPeriod(market.dates, i - 1, rebalance)) {
        // 限定股票池时必须**先放宽候选数再过滤**：面板排名是全池算的，
        // 若先截断 top-K 再过滤，池外股票占掉的名额就补不回来，
        // 结果是组合只买进 2 只而不是 3 只（实测踩过，直接导致收益差 30pp）
        let cands = universeCodes
          ? store.panelRanksOn(factorId, signalDate, Math.max(200, topK * 20))
              .filter((c) => universeCodes.includes(c.code))
              .slice(0, Math.max(topK, Math.ceil(topK * buffer)))
          : store.panelRanksOn(factorId, signalDate, Math.max(topK, Math.ceil(topK * buffer)))
        if (cands.length > 0) {
          const selected = cands.slice(0, topK)
          const targetCodes = new Set(selected.map((c) => c.code))

          // 目标权重
          const weights = new Map()
          if (weight === 'factor') {
            const positive = selected.filter((c) => (c.value ?? 0) > 0)
            const sum = positive.reduce((a, c) => a + c.value, 0)
            if (positive.length && sum > 0) for (const c of positive) weights.set(c.code, c.value / sum)
            else for (const c of selected) weights.set(c.code, 1 / selected.length)
          } else {
            for (const c of selected) weights.set(c.code, 1 / selected.length)
          }

          const priceOf = (code) => {
            const bar = market.byCode.get(code)?.get(d)
            if (!bar) return null
            return execPrice === 'close' ? bar.adjClose : bar.adjOpen
          }

          // 开盘估值（用于算目标金额）
          const openPrices = new Map()
          for (const [code, m] of market.byCode) {
            const b = m.get(d)
            if (b) { openPrices.set(code, b.adjOpen); lastOpen.set(code, b.adjOpen) }
          }
          for (const code of book.positions.keys()) {
            if (!openPrices.has(code) && lastOpen.has(code)) openPrices.set(code, lastOpen.get(code))
          }
          const navAtOpen = book.nav(openPrices)

          const actions = { sells: [], buys: [], skips: [] }

          // ① 卖出：不在目标内或超出目标
          for (const [code, pos] of [...book.positions]) {
            const px = priceOf(code)
            if (px == null) { actions.skips.push({ code, side: 'sell', reason: 'no-price' }); continue }
            const targetShares = targetCodes.has(code) ? Math.floor((weights.get(code) ?? 0) * navAtOpen / px) : 0
            const excess = pos.shares - targetShares
            if (excess <= 0) continue
            if (excess * px < navAtOpen * minTradeRatio) continue
            const t = tradability(market, code, d, 'sell', universe)
            if (!t.ok) { skipped.sell[t.reason] = (skipped.sell[t.reason] ?? 0) + 1; actions.skips.push({ code, side: 'sell', reason: t.reason }); continue }
            const filled = book.sell(code, excess, px, d)
            actions.sells.push({ code, shares: filled })
          }

          // ② 买入：目标内不足的
          for (const code of targetCodes) {
            const px = priceOf(code)
            if (px == null) continue
            const t = tradability(market, code, d, 'buy', universe)
            if (!t.ok) { skipped.buy[t.reason] = (skipped.buy[t.reason] ?? 0) + 1; actions.skips.push({ code, side: 'buy', reason: t.reason }); continue }
            const targetShares = Math.floor((weights.get(code) ?? 0) * navAtOpen / px)
            const have = book.positions.get(code)?.shares ?? 0
            const need = targetShares - have
            if (need <= 0) continue
            if (need * px < navAtOpen * minTradeRatio) continue
            const filled = book.buy(code, need, px, d)
            actions.buys.push({ code, shares: filled })
          }

          rebalances.push({ signalDate, execDate: d, target: [...targetCodes], sells: actions.sells.length, buys: actions.buys.length, skips: actions.skips.length, navAtOpen: +navAtOpen.toFixed(2) })
        }
      }
    }

    const nav = book.nav(closePrices)
    navSeries.push({ date: d, nav: +nav.toFixed(2), cash: +book.cash.toFixed(2), positions: book.positions.size })
    // onDay：逐日回调（用于对外暴露持仓，做同口径对照）
    onDay?.(d, book)
  }

  // ── 基准：给定代码则用之，否则用等权买入持有作为代理 ────────────────────────
  let benchmark = null
  if (benchmarkCode && market.byCode.has(benchmarkCode)) {
    const m = market.byCode.get(benchmarkCode)
    const base = m.get(market.dates[0])?.adjClose
    if (base) benchmark = market.dates.map((d) => ({ date: d, nav: (m.get(d)?.adjClose ?? base) / base * initialCash }))
  } else {
    const base = new Map()
    for (const code of market.codes) { const b = market.byCode.get(code).get(market.dates[0]); if (b) base.set(code, b.adjClose) }
    if (base.size) {
      benchmark = market.dates.map((d) => {
        let sum = 0, n = 0
        for (const [code, b0] of base) {
          const b = market.byCode.get(code).get(d)
          if (b && b0 > 0) { sum += b.adjClose / b0; n++ }
        }
        return { date: d, nav: n ? (sum / n) * initialCash : initialCash }
      })
    }
  }

  const metrics = computeMetrics(navSeries, { benchmark, trades: book.trades, initialCash, costs: book.costs })
  return {
    ok: true,
    config: { factorId, topK, rebalance, weight, start, end, initialCash, buffer, execPrice, universe, universeCodes },
    navSeries, benchmark, trades: book.trades, rebalances,
    skipped, final: book.snapshot(),
    carryForwardDays,
    metrics,
    caveats: [
      'ST 状态使用当前快照，非历史逐日状态',
      '上市天数用自然日近似（未按交易日历计数）',
      '日频无法表达盘中路径；止损类规则需显式假设',
      carryForwardDays > 0 ? `有 ${carryForwardDays} 个持仓日在停牌中，按最后已知收盘价估值（未按 0 计）` : null,
      benchmarkCode ? null : '基准为区间内等权买入持有代理（未接入指数数据）',
    ].filter(Boolean),
  }
}

/** 指标：从净值序列与成交流水计算 */
export function computeMetrics(navSeries, { benchmark = null, trades = [], initialCash = 1_000_000, costs = DEFAULT_COSTS } = {}) {
  if (navSeries.length < 2) return null
  const navs = navSeries.map((x) => x.nav)
  const rets = []
  for (let i = 1; i < navs.length; i++) rets.push(navs[i] / navs[i - 1] - 1)
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1)
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1)
  const sd = Math.sqrt(variance)
  const years = rets.length / 252
  const totalReturn = navs[navs.length - 1] / navs[0] - 1
  const cagr = years > 0 ? (navs[navs.length - 1] / navs[0]) ** (1 / years) - 1 : null

  let peak = navs[0], maxDD = 0, ddStart = null, longestDD = 0, curDD = 0
  for (let i = 0; i < navs.length; i++) {
    if (navs[i] > peak) { peak = navs[i]; ddStart = navSeries[i].date; curDD = 0 }
    const dd = navs[i] / peak - 1
    if (dd < maxDD) maxDD = dd
    if (dd < 0) { curDD++; longestDD = Math.max(longestDD, curDD) } else curDD = 0
  }

  const tradedNotional = trades.reduce((a, t) => a + t.notional, 0)
  const avgNav = navs.reduce((a, b) => a + b, 0) / navs.length
  const winRate = rets.filter((r) => r > 0).length / (rets.length || 1)

  let bench = null
  if (benchmark && benchmark.length === navs.length) {
    const bnavs = benchmark.map((x) => x.nav)
    const brets = []
    for (let i = 1; i < bnavs.length; i++) brets.push(bnavs[i] / bnavs[i - 1] - 1)
    const bTotal = bnavs[bnavs.length - 1] / bnavs[0] - 1
    const bMean = brets.reduce((a, b) => a + b, 0) / (brets.length || 1)
    const cov = rets.reduce((a, r, i) => a + (r - mean) * (brets[i] - bMean), 0) / Math.max(1, rets.length - 1)
    const bVar = brets.reduce((a, r) => a + (r - bMean) ** 2, 0) / Math.max(1, brets.length - 1)
    const beta = bVar > 0 ? cov / bVar : null
    const active = rets.map((r, i) => r - brets[i])
    const aMean = active.reduce((a, b) => a + b, 0) / (active.length || 1)
    const aSd = Math.sqrt(active.reduce((a, b) => a + (b - aMean) ** 2, 0) / Math.max(1, active.length - 1))
    bench = {
      totalReturn: +bTotal.toFixed(6),
      excessReturn: +(totalReturn - bTotal).toFixed(6),
      beta: beta === null ? null : +beta.toFixed(4),
      informationRatio: aSd > 0 ? +((aMean / aSd) * Math.sqrt(252)).toFixed(4) : null,
    }
  }

  return {
    days: navSeries.length,
    totalReturn: +totalReturn.toFixed(6),
    cagr: cagr === null ? null : +cagr.toFixed(6),
    annualVol: +(sd * Math.sqrt(252)).toFixed(6),
    sharpe: sd > 0 ? +((mean / sd) * Math.sqrt(252)).toFixed(4) : null,
    maxDrawdown: +maxDD.toFixed(6),
    calmar: cagr !== null && maxDD < 0 ? +(cagr / Math.abs(maxDD)).toFixed(4) : null,
    winRate: +winRate.toFixed(4),
    longestDrawdownDays: longestDD,
    trades: trades.length,
    turnover: avgNav > 0 && years > 0 ? +(tradedNotional / avgNav / years).toFixed(4) : null,
    turnoverNote: '年化双边成交额 / 平均净值',
    fees: {
      commission: +trades.reduce((a, t) => a + (t.commission ?? 0), 0).toFixed(2),
      stampDuty: +trades.reduce((a, t) => a + (t.stampDuty ?? 0), 0).toFixed(2),
      transferFee: +trades.reduce((a, t) => a + (t.transferFee ?? 0), 0).toFixed(2),
    },
    benchmark: bench,
  }
}

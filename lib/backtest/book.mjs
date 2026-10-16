/**
 * 组合账务（PortfolioBook）—— 与频率无关，日频与将来的日内事件驱动共用。
 *
 * 约定（A 股）：
 *  - 股票按 **手**（100 股）整数成交
 *  - T+1：当日买入不可当日卖出
 *  - 费用：佣金（含最低 5 元）、印花税（仅卖出）、过户费（双边）、滑点
 *
 * 价格空间：整个引擎跑在**复权价**上（原始价用于涨跌停/停牌判定）。
 * 复权价空间下分红送转已隐含在价格里，无需再记现金分红与送股 —— 这是与"原始价 + 现金入账"等价的
 * 标准做法，且避免了逐笔公司行为记账的复杂度。
 */

export const DEFAULT_COSTS = {
  commissionRate: 0.00025,   // 佣金 万 2.5（双边）
  minCommission: 5,          // 最低 5 元
  stampDutyRate: 0.001,      // 印花税 千 1（仅卖出）
  transferFeeRate: 0.00001,  // 过户费 十万分之一（双边）
  slippageRate: 0.001,       // 滑点 千 1
  lotSize: 100,
}

export class PortfolioBook {
  constructor({ cash = 1_000_000, costs = {}, allowOddLot = false } = {}) {
    this.costs = { ...DEFAULT_COSTS, ...costs }
    this.initialCash = cash
    this.cash = cash
    this.positions = new Map() // code → { shares, cost }
    this.boughtToday = new Set()
    this.trades = []
    this.fees = { commission: 0, stampDuty: 0, transferFee: 0 }
    this.allowOddLot = allowOddLot
  }

  get lotSize() { return this.costs.lotSize }

  /** 买入：price 为复权价；返回实际成交股数（0 表示未成交） */
  buy(code, shares, price, date) {
    const lot = this.lotSize
    let qty = Math.floor(shares / lot) * lot
    if (this.allowOddLot) qty = Math.floor(shares)
    if (qty <= 0 || !(price > 0)) return 0
    const px = price * (1 + this.costs.slippageRate)
    let notional = qty * px
    let commission = Math.max(notional * this.costs.commissionRate, this.costs.minCommission)
    let transferFee = notional * this.costs.transferFeeRate
    let total = notional + commission + transferFee
    // 现金不足则按可用现金缩量（并保持整手）
    if (total > this.cash) {
      const usable = this.cash / (1 + this.costs.commissionRate + this.costs.transferFeeRate)
      qty = Math.floor(usable / px / lot) * lot
      if (qty <= 0) return 0
      notional = qty * px
      commission = Math.max(notional * this.costs.commissionRate, this.costs.minCommission)
      transferFee = notional * this.costs.transferFeeRate
      total = notional + commission + transferFee
      if (total > this.cash) return 0
    }
    this.cash -= total
    const pos = this.positions.get(code) ?? { shares: 0, cost: 0 }
    pos.cost += total
    pos.shares += qty
    this.positions.set(code, pos)
    this.boughtToday.add(code)
    this.fees.commission += commission
    this.fees.transferFee += transferFee
    this.trades.push({ date, code, side: 'buy', shares: qty, price: +px.toFixed(6), notional: +notional.toFixed(2), commission: +commission.toFixed(2), transferFee: +transferFee.toFixed(2), stampDuty: 0 })
    return qty
  }

  /** 卖出：返回实际成交股数。部分卖出必须整手；**清仓允许零股**（A 股规则） */
  sell(code, shares, price, date) {
    const pos = this.positions.get(code)
    if (!pos || pos.shares <= 0) return 0
    if (this.boughtToday.has(code)) return 0 // T+1：当日买入不可卖出
    const lot = this.lotSize
    let qty = Math.min(Math.floor(shares), pos.shares)
    if (!this.allowOddLot && qty < pos.shares) qty = Math.floor(qty / lot) * lot // 部分卖出按整手
    if (qty <= 0 || !(price > 0)) return 0
    const px = price * (1 - this.costs.slippageRate)
    const notional = qty * px
    const commission = Math.max(notional * this.costs.commissionRate, this.costs.minCommission)
    const stampDuty = notional * this.costs.stampDutyRate
    const transferFee = notional * this.costs.transferFeeRate
    const proceeds = notional - commission - stampDuty - transferFee
    this.cash += proceeds
    const costOut = pos.cost * (qty / pos.shares)
    pos.cost -= costOut
    pos.shares -= qty
    if (pos.shares === 0) this.positions.delete(code)
    else this.positions.set(code, pos)
    this.fees.commission += commission
    this.fees.stampDuty += stampDuty
    this.fees.transferFee += transferFee
    this.trades.push({ date, code, side: 'sell', shares: qty, price: +px.toFixed(6), notional: +notional.toFixed(2), commission: +commission.toFixed(2), transferFee: +transferFee.toFixed(2), stampDuty: +stampDuty.toFixed(2) })
    return qty
  }

  /** 逐日估值（prices: Map(code → 复权收盘价)） */
  marketValue(prices) {
    let mv = 0
    for (const [code, pos] of this.positions) {
      const p = prices.get(code)
      if (p == null) continue
      mv += pos.shares * p
    }
    return mv
  }

  nav(prices) { return this.cash + this.marketValue(prices) }

  /** 新交易日开始：清空 T+1 锁 */
  startDay() { this.boughtToday = new Set() }

  snapshot() {
    return {
      cash: +this.cash.toFixed(2),
      positions: [...this.positions.entries()].map(([code, p]) => ({ code, shares: p.shares, cost: +p.cost.toFixed(2) })),
      fees: Object.fromEntries(Object.entries(this.fees).map(([k, v]) => [k, +v.toFixed(2)])),
    }
  }
}

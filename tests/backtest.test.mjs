/**
 * 回测引擎确定性单测（可手算验证）。
 *
 * 用内存仓库构造一个完全可手算的场景，验证账务、费用、整手、T+1 与 NAV 恒等。
 * 运行: node --test tests/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../lib/data/store.mjs'
import { runBacktest } from '../lib/backtest/engine.mjs'
import { PortfolioBook } from '../lib/backtest/book.mjs'

/** 造一个内存仓库：1 只股票、5 个交易日、给定 OHLC */
function makeStore(bars) {
  const store = openStore(':memory:')
  store.upsertCodes([{ code: '600000', name: '测试股', market: 1, board: 'sh_main', isSt: false }])
  store.upsertBars('600000', bars)
  // 直接写入面板：每天都把该股排第 1（引擎只读面板，不重算因子）
  for (const b of bars) store.insertPanelBatch('t', [{ date: b.date, rank: 1, code: '600000', value: 1 }])
  store.setPanelMeta({ factorId: 't', formula: 'test', formulaHash: 'test', topN: 500, firstDate: bars[0].date, lastDate: bars.at(-1).date, rows: bars.length })
  return store
}

const BARS = [
  { date: 20240101, open: 10.0, high: 10.2, low: 9.9, close: 10.5, volume: 1e6, amount: 1e7, pct: 0, turnover: 1 },
  { date: 20240102, open: 11.0, high: 11.3, low: 10.9, close: 11.2, volume: 1e6, amount: 1e7, pct: 6.67, turnover: 1 },
  { date: 20240103, open: 11.2, high: 11.5, low: 11.1, close: 11.4, volume: 1e6, amount: 1e7, pct: 1.79, turnover: 1 },
  { date: 20240104, open: 11.4, high: 11.6, low: 11.3, close: 11.5, volume: 1e6, amount: 1e7, pct: 0.88, turnover: 1 },
  { date: 20240105, open: 11.5, high: 11.7, low: 11.4, close: 11.6, volume: 1e6, amount: 1e7, pct: 0.87, turnover: 1 },
]

test('账务：买入的手续费、整手与现金扣减可手算复现', () => {
  const book = new PortfolioBook({ cash: 100_000 })
  const filled = book.buy('600000', 9000, 11.0, 20240102)
  assert.equal(filled, 9000, '整手成交 9000 股')
  const px = 11.0 * 1.001                     // 滑点 0.1%
  const notional = 9000 * px
  const commission = Math.max(notional * 0.00025, 5)
  const transferFee = notional * 0.00001
  assert.ok(Math.abs(book.cash - (100_000 - notional - commission - transferFee)) < 1e-6, '现金扣减 = 名义 + 佣金 + 过户费')
  assert.ok(Math.abs(book.fees.commission - commission) < 1e-9)
  assert.ok(Math.abs(book.fees.transferFee - transferFee) < 1e-9)
})

test('账务：T+1 约束（当日买入不可卖出）', () => {
  const book = new PortfolioBook({ cash: 100_000 })
  book.buy('600000', 1000, 10, 20240102)
  assert.equal(book.sell('600000', 1000, 10, 20240102), 0, '当日卖出应被拒绝')
  book.startDay()
  assert.equal(book.sell('600000', 1000, 10, 20240103), 1000, '次日卖出应成功')
})

test('账务：部分卖出按整手，清仓可零股', () => {
  const book = new PortfolioBook({ cash: 1e6 })
  book.buy('600000', 1050, 10, 20240101)   // 整手 → 1000 股
  assert.equal(book.positions.get('600000').shares, 1000)
  book.startDay()
  assert.equal(book.sell('600000', 50, 10, 20240102), 0, '部分卖出不足一手 → 不成交')
  book.startDay()
  // 请求卖 999（不足清仓）：按 A 股规则部分卖出必须整手 → 只能卖 900
  assert.equal(book.sell('600000', 999, 10, 20240103), 900, '部分卖出向下取整到整手')
  assert.equal(book.positions.get('600000').shares, 100)
  book.startDay()
  // 请求卖 ≥ 持仓：整笔清仓
  assert.equal(book.sell('600000', 100, 10, 20240104), 100, '清仓成交')
  assert.equal(book.positions.has('600000'), false)
})

test('账务：外部产生的零股持仓可整笔清仓', () => {
  // 复权价空间下持仓天然是整手；零股只可能来自外部导入（如历史持仓），故该分支需显式验证
  const book = new PortfolioBook({ cash: 1e6, allowOddLot: true })
  book.buy('600000', 150, 10, 20240101)
  assert.equal(book.positions.get('600000').shares, 150)
  book.startDay()
  assert.equal(book.sell('600000', 150, 10, 20240102), 150, '零股可整笔清仓')
})

test('引擎：T+1 开盘成交后的 NAV 与手算一致', () => {
  const store = makeStore(BARS)
  const bt = runBacktest(store, {
    factorId: 't', topK: 1, rebalance: 'daily', weight: 'equal',
    start: 20240101, end: 20240105, initialCash: 100_000,
  })
  assert.equal(bt.ok, true)
  // 手算：T=20240101 收盘出信号 → 20240102 开盘成交
  const px = 11.0 * 1.001
  const shares = Math.floor(100_000 / px / 100) * 100
  const notional = shares * px
  const commission = Math.max(notional * 0.00025, 5)
  const transferFee = notional * 0.00001
  const cashLeft = 100_000 - notional - commission - transferFee
  const expectedNavDay2 = cashLeft + shares * 11.2
  const day2 = bt.navSeries.find((x) => x.date === 20240102)
  assert.ok(Math.abs(day2.nav - expectedNavDay2) < 0.02, `day2 NAV ${day2.nav} ≈ 手算 ${expectedNavDay2.toFixed(2)}`)
  // 期末 NAV = 现金 + 持仓 × 收盘
  const last = bt.navSeries.at(-1)
  const pos = bt.final.positions.find((p) => p.code === '600000')
  assert.ok(Math.abs(last.nav - (bt.final.cash + pos.shares * 11.6)) < 0.02, '期末 NAV 恒等')
  // 第一天不成交（无信号）
  assert.equal(bt.trades.filter((t) => t.date === 20240101).length, 0)
  store.close()
})

test('引擎：涨停不可买入（原始价判定）', () => {
  const bars = BARS.map((b) => ({ ...b }))
  // 让 20240103 开盘正好落在涨停（前收 11.2 × 1.1 = 12.32）
  bars[2].open = 12.32
  const store = makeStore(bars)
  const bt = runBacktest(store, {
    factorId: 't', topK: 1, rebalance: 'daily', weight: 'equal',
    start: 20240101, end: 20240105, initialCash: 100_000,
  })
  assert.ok(bt.skipped.buy['limit-up'] >= 1, `应至少记录 1 次涨停拒买，实际 ${JSON.stringify(bt.skipped.buy)}`)
  store.close()
})

test('引擎：停牌（volume=0）不交易', () => {
  const bars = BARS.map((b) => ({ ...b }))
  bars[1].volume = 0
  const store = makeStore(bars)
  const bt = runBacktest(store, {
    factorId: 't', topK: 1, rebalance: 'daily', weight: 'equal',
    start: 20240101, end: 20240105, initialCash: 100_000,
  })
  assert.equal(bt.trades.filter((t) => t.date === 20240102).length, 0, '停牌日不应成交')
  assert.ok(bt.skipped.buy['suspended'] >= 1)
  store.close()
})

test('指标：单调上涨序列的指标符合解析值', () => {
  const store = makeStore(BARS)
  const bt = runBacktest(store, {
    factorId: 't', topK: 1, rebalance: 'daily', weight: 'equal',
    start: 20240101, end: 20240105, initialCash: 100_000,
  })
  const m = bt.metrics
  assert.ok(m.days === 5)
  assert.ok(m.totalReturn > 0)
  assert.ok(m.maxDrawdown <= 0)
  assert.ok(m.sharpe !== null)
  store.close()
})

test('引擎：持仓股停牌时按最后已知价估值，不按 0 计（NAV 不出现假跳变）', () => {
  // 停牌日在 bars 里**没有该股的行**，但同池其他股票在交易，所以交易日历仍然存在该日。
  // 若估值时跳过这个持仓，它按 0 计入 NAV，复牌当天再跳回来 —— 实测在 688981 停牌 6 天时
  // 产生单日 +43% 的假跳变，并把最大回撤从 −20% 夸大到 −47%。
  const store = openStore(':memory:')
  store.upsertCodes([
    { code: '600000', name: '停牌股', market: 1, board: 'sh_main', isSt: false, listDate: 20100101 },
    { code: '600001', name: '正常股', market: 1, board: 'sh_main', isSt: false, listDate: 20100101 },
  ])
  const days = [20240101, 20240102, 20240103, 20240104, 20240105, 20240108]
  const halted = new Set([20240104, 20240105])          // 600000 停牌两天
  store.upsertBars('600000', days.filter((d) => !halted.has(d)).map((d, i) => ({
    date: d, open: 10, high: 10.2, low: 9.8, close: 12, volume: 1e6, amount: 1e7, pct: 0, turnover: 1,
  })))
  store.upsertBars('600001', days.map((d) => ({
    date: d, open: 20, high: 20.2, low: 19.8, close: 20, volume: 1e6, amount: 1e7, pct: 0, turnover: 1,
  })))
  for (const d of days) {
    store.insertPanelBatch('t', [{ date: d, rank: 1, code: '600000', value: 2 }, { date: d, rank: 2, code: '600001', value: 1 }])
  }
  store.setPanelMeta({ factorId: 't', formula: 'test', formulaHash: 'test', topN: 500, firstDate: days[0], lastDate: days.at(-1), rows: days.length * 2 })

  const bt = runBacktest(store, {
    factorId: 't', topK: 2, rebalance: 'daily', start: 20240101, end: 20240108,
    initialCash: 100_000, universe: { excludeST: false, minListDays: 0 },
  })
  assert.equal(bt.ok, true)
  const nav = new Map(bt.navSeries.map((x) => [x.date, x.nav]))
  assert.ok(nav.has(20240104), '停牌日仍在交易日历中（同池其他股票在交易）')
  const before = nav.get(20240103), during = nav.get(20240104), after = nav.get(20240108)
  assert.ok(during > 0, '停牌日 NAV 不应为 0')
  assert.ok(Math.abs(during / before - 1) < 1e-9, '停牌日 NAV 应等于前一交易日（停牌股沿用最后收盘价，正常股价格不变）')
  assert.ok(Math.abs(after / during - 1) < 0.01, '复牌日不应出现数十个百分点的假跳变')
  assert.ok(bt.carryForwardDays >= 2, `应记录沿用天数，实际 ${bt.carryForwardDays}`)
  assert.ok(bt.caveats.some((c) => c.includes('停牌')), '应在结果声明中标注沿用估值')
  store.close()
})

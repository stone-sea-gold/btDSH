/**
 * 仓位与风控工具（3 个）。
 *
 * v1 的边界（必须让模型说清楚）：这里管的是**用户自报的持仓**，不是券商实盘。
 * 因此没有对账、没有成交确认；`quant_portfolio_status` 用最新收盘价估值，
 * 数据来源是本地库，可能滞后 —— 返回里带 `asOf`。
 */

import { tool, S, output, fail, fmt } from './kit.mjs'
import { normalizeCode } from '../data/codes.mjs'

/** 用本地库最新收盘价估值 */
function valueHoldings(store, holdings) {
  const out = []
  let marketValue = 0, costValue = 0
  for (const h of holdings) {
    const bar = store.raw.prepare('SELECT date, close FROM bars WHERE code=? ORDER BY date DESC LIMIT 1').get(h.code)
    const px = bar?.close ?? null
    const mv = px === null ? null : px * h.shares
    if (mv !== null) marketValue += mv
    if (h.cost !== null && h.cost !== undefined) costValue += h.cost * h.shares
    out.push({
      code: h.code, shares: h.shares, cost: h.cost ?? null,
      lastClose: px, asOf: bar?.date ?? null,
      marketValue: mv === null ? null : +mv.toFixed(2),
      pnl: px !== null && h.cost ? +((px - h.cost) * h.shares).toFixed(2) : null,
      pnlPct: px !== null && h.cost ? +((px / h.cost - 1)).toFixed(6) : null,
    })
  }
  return { positions: out, marketValue: +marketValue.toFixed(2), costValue: +costValue.toFixed(2) }
}

export function portfolioTools(runtime) {
  return [
    tool({
      name: 'quant_save_holdings',
      description: [
        '保存用户当前持仓（**用户自报**，不是券商实盘）。整表替换。',
        'shares 为股数，cost 为成本价（可省略）。保存后可用 quant_portfolio_status 估值。',
      ].join(' '),
      parameters: S.obj({
        holdings: S.arr(
          S.obj({
            code: S.str('6 位代码'),
            shares: S.num('股数'),
            cost: S.num('成本价（可省略）'),
          }, ['code', 'shares']),
          '持仓列表（整表替换）',
        ),
      }, ['holdings']),
      outputSchema: output({
        count: { type: 'integer' }, codes: { type: 'array', items: { type: 'string' } },
      }, ['count']),
      execute: (args) => {
        const rows = []
        for (const h of args.holdings) {
          const code = normalizeCode(h.code)
          if (!Number.isFinite(h.shares) || h.shares <= 0) return fail('BAD_SHARES', `${h.code} 的股数必须是正数`)
          rows.push({ code, shares: h.shares, cost: Number.isFinite(h.cost) ? h.cost : null })
        }
        const n = runtime.store().saveHoldings(rows)
        return { ok: true, count: n, codes: rows.map((r) => r.code) }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}` : `已保存 ${v.count} 只持仓：${v.codes.join(' ')}`,
    }),

    tool({
      name: 'quant_portfolio_status',
      description: [
        '持仓估值：用**本地库最新收盘价**算市值、浮动盈亏与权重。',
        '返回 `asOf` 是估值所用行情日期 —— 数据可能滞后，结论要带上这个日期。',
        '本地库没有该股行情时该行市值为 null（不猜价格）。',
      ].join(' '),
      parameters: S.obj({ cash: S.num('现金（可选，用于算总资产与仓位比例）') }, []),
      outputSchema: output({
        asOf: { type: 'integer' }, count: { type: 'integer' },
        marketValue: { type: 'number' }, costValue: { type: 'number' },
        totalAssets: { type: 'number' }, positionRatio: { type: 'number' },
        positions: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }, ['count', 'marketValue', 'positions']),
      execute: (args) => {
        if (!runtime.exists()) return fail('NO_STORE', '仓库不存在，无法估值')
        const store = runtime.store()
        const holdings = store.listHoldings()
        if (!holdings.length) return { ok: true, asOf: null, count: 0, marketValue: 0, costValue: 0, positions: [] }
        const v = valueHoldings(store, holdings)
        const cash = Number.isFinite(args.cash) ? args.cash : null
        const totalAssets = cash === null ? v.marketValue : cash + v.marketValue
        // 权重：优先按总资产（有现金时），否则按持仓市值内部占比
        for (const p of v.positions) {
          p.weight = totalAssets > 0 && p.marketValue !== null ? +(p.marketValue / totalAssets).toFixed(6) : null
        }
        const asOf = v.positions.map((p) => p.asOf).filter(Boolean).sort().at(-1) ?? null
        return {
          ok: true, asOf, count: v.positions.length,
          marketValue: v.marketValue, costValue: v.costValue,
          totalAssets: +totalAssets.toFixed(2),
          positionRatio: totalAssets > 0 ? +(v.marketValue / totalAssets).toFixed(6) : null,
          positions: v.positions,
        }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : v.count === 0 ? '还没有保存持仓（用 quant_save_holdings）'
          : `持仓 ${v.count} 只，市值 ${fmt.money(v.marketValue)}（行情截至 ${fmt.date(v.asOf)}）\n` +
            v.positions.map((p) => `  ${p.code} ${p.shares} 股 现价 ${fmt.num(p.lastClose, 2)} 市值 ${fmt.money(p.marketValue)}${p.pnlPct !== null ? ` 盈亏 ${fmt.pct(p.pnlPct)}` : ''}${p.weight !== null ? ` 仓位 ${fmt.pct(p.weight)}` : ''}`).join('\n') +
            (v.positionRatio !== null ? `\n总资产 ${fmt.money(v.totalAssets)}，仓位 ${fmt.pct(v.positionRatio)}` : ''),
    }),

    tool({
      name: 'quant_save_position_rules',
      description: [
        '保存仓位与止损规则（**声明性配置**，不会自动下单，也不会在回测里隐式生效）。',
        '规则示例：单票上限、行业上限、最大回撤止损、个股止损线、加仓间隔。',
        '保存后回测若要使用，必须在策略 config 里显式引用 —— 避免"以为设了止损其实没生效"。',
      ].join(' '),
      parameters: S.obj({
        id: S.str('规则集 id（默认 default）'),
        maxPositionPct: S.num('单票最大仓位（0–1，例如 0.2）'),
        maxDrawdownStop: S.num('组合最大回撤止损（0–1，例如 0.2）'),
        stopLossPct: S.num('个股止损线（0–1，例如 0.1）'),
        takeProfitPct: S.num('个股止盈线（0–1）'),
        minDaysBetweenTrades: S.int('两次调仓之间至少间隔几个交易日'),
        notes: S.str('备注'),
      }, []),
      outputSchema: output({
        id: { type: 'string' }, rules: { type: 'object', additionalProperties: true },
        note: { type: 'string' },
      }, ['id', 'rules']),
      execute: (args) => {
        const id = args.id ?? 'default'
        const rules = {}
        for (const k of ['maxPositionPct', 'maxDrawdownStop', 'stopLossPct', 'takeProfitPct']) {
          if (args[k] === undefined) continue
          if (!(args[k] > 0 && args[k] < 1)) return fail('BAD_RULE', `${k} 必须在 0 与 1 之间（收到 ${args[k]}）`)
          rules[k] = args[k]
        }
        if (args.minDaysBetweenTrades !== undefined) {
          if (!Number.isInteger(args.minDaysBetweenTrades) || args.minDaysBetweenTrades < 0) return fail('BAD_RULE', 'minDaysBetweenTrades 必须是非负整数')
          rules.minDaysBetweenTrades = args.minDaysBetweenTrades
        }
        if (args.notes) rules.notes = args.notes
        runtime.store().savePositionRules(id, rules)
        return {
          ok: true, id, rules,
          note: '规则已保存为声明性配置。回测中**不会自动生效**：需要在策略 config 里显式引用，或由引擎显式实现。',
        }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : `已保存规则集「${v.id}」：${Object.entries(v.rules).map(([k, x]) => `${k}=${x}`).join(' ')}\n${v.note}`,
    }),
  ]
}

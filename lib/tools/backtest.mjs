/**
 * 回测 / 选股 / 优化工具（5 个）。
 *
 * 三层结构（与引擎一致）：面板物化 → 调仓目标 → 逐日账务。
 * 工具层只做三件事：**参数校验**、**把面板准备好**、**把结果讲清楚**。
 *
 * 结果里强制携带 `caveats`（引擎产出的口径声明），不因为"太长"而省略 ——
 * 用户看到收益数字时，必须同时看到它是在什么假设下算出来的。
 */

import { tool, S, output, fail, fmt, downsample } from './kit.mjs'
import { materializePanel, panelHealth, evictPanels, DEFAULT_TOP_N } from '../factors/panel.mjs'
import { runBacktest } from '../backtest/engine.mjs'
import { yearlyStats, drawdownPeriods, costBreakdown } from '../backtest/analyze.mjs'
import { selectStocks } from '../factors/select.mjs'
import { optimizeStrategy, OBJECTIVES } from '../backtest/optimize.mjs'
import { provenance } from './strategy.mjs'

const REBALANCE = ['daily', 'weekly', 'monthly']
const WEIGHTS = ['equal', 'factor']

function backtestId(strategyId, cfg) {
  const key = `${strategyId}|${cfg.start}|${cfg.end}|${cfg.selection?.k}|${cfg.rebalance}|${cfg.weight}`
  let h = 0
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0
  return `bt_${strategyId}_${(h >>> 0).toString(36)}`
}

/** 把策略配置里的因子逐个物化面板；返回可回测的因子列表与失败项 */
function preparePanels(store, cfg, { topN = DEFAULT_TOP_N, force = false } = {}) {
  const ready = [], failed = []
  for (const f of cfg.factors) {
    const r = materializePanel(store, {
      factorId: f.id, formula: f.formula, topN,
      from: cfg.start ?? 0, to: cfg.end ?? 99999999, force,
    })
    if (r.ok) ready.push({ id: f.id, rows: r.rows, firstDate: r.firstDate, lastDate: r.lastDate, skipped: !!r.skipped, ms: r.ms })
    else failed.push({ id: f.id, error: r.error })
  }
  return { ready, failed }
}

export function backtestTools(runtime) {
  return [
    tool({
      name: 'quant_backtest_run',
      description: [
        '运行一次可交易级回测。会先把用到的因子物化成面板（幂等，已有则跳过），再逐日模拟。',
        '口径：**T 日收盘出信号、T+1 开盘成交**；涨停不买、跌停不卖、停牌不交易（用不复权原始价判定）；',
        'T+1 制度；100 股整手；佣金（最低 5 元）/印花税（仅卖出）/过户费/滑点。',
        '返回指标、净值曲线、成交统计与**口径声明**。结果会留档，可用 quant_backtest_get 再取。',
      ].join(' '),
      parameters: S.obj({
        strategyId: S.str('策略 id（需已保存；用于留档与溯源）'),
        config: { type: 'object', properties: {}, additionalProperties: true, description: '策略 config；不传则用已保存的最新版本' },
        topN: S.int('面板排名深度（默认 500；必须 ≥ topK）'),
        force: S.bool('强制重建面板（默认 false，幂等复用）'),
        confirm: S.bool('长区间（>5 年）时必须显式确认'),
      }, ['strategyId']),
      outputSchema: output({
        backtestId: { type: 'string' }, strategyId: { type: 'string' },
        range: { type: 'array', items: { type: 'integer' } }, days: { type: 'integer' },
        metrics: { type: 'object', additionalProperties: true },
        nav: { type: 'array', items: { type: 'object', additionalProperties: true } },
        skipped: { type: 'object', additionalProperties: true },
        panels: { type: 'array', items: { type: 'object', additionalProperties: true } },
        caveats: { type: 'array', items: { type: 'string' } },
      }, ['backtestId', 'metrics', 'caveats']),
      timeoutMs: 15 * 60 * 1000,
      execute: (args, exec) => {
        const store = runtime.store()
        const cfg = args.config ?? store.getStrategy(String(args.strategyId))?.config
        if (!cfg) return fail('NOT_FOUND', `策略 ${args.strategyId} 不存在，且没有传 config`)
        if (!cfg.start || !cfg.end) return fail('NO_RANGE', 'config 必须带 start 与 end（YYYYMMDD）')
        const topK = cfg.selection?.k ?? 20
        const topN = args.topN ?? DEFAULT_TOP_N
        if (topK > topN) return fail('TOPK_EXCEEDS_PANEL', `topK ${topK} 超过面板深度 ${topN}；请提高 topN`)

        const years = Math.abs(Math.floor(cfg.end / 10000) - Math.floor(cfg.start / 10000))
        if (years > 5 && args.confirm !== true) {
          return fail('APPROVAL_REQUIRED', `回测区间 ${years} 年，超过 5 年阈值`,
            '先与用户确认区间是否必要（长区间回测耗时且更容易过拟合），再带 confirm=true 重试')
        }
        const panels = preparePanels(store, cfg, { topN, force: !!args.force })
        if (panels.failed.length) {
          return fail('PANEL_FAILED', `因子面板物化失败：${panels.failed.map((f) => `${f.id}(${f.error.message})`).join(', ')}`)
        }

        // 多因子：逐因子各跑一次，便于比较单个因子的贡献（而不是只给一个混合结果）
        const runs = []
        for (const f of cfg.factors) {
          const bt = runBacktest(store, {
            factorId: f.id, topK, rebalance: cfg.rebalance ?? 'monthly', weight: cfg.weight ?? 'equal',
            start: cfg.start, end: cfg.end, initialCash: cfg.initialCash ?? 1_000_000,
            universe: cfg.universe ?? {}, costs: cfg.costs ?? {},
            universeCodes: cfg.universe?.codes ?? null,
            benchmarkCode: cfg.benchmarkCode ?? null,
          })
          if (!bt.ok) { runs.push({ factorId: f.id, error: bt.error }); continue }
          runs.push({ factorId: f.id, bt })
        }
        const good = runs.filter((r) => r.bt)
        if (!good.length) return fail('BACKTEST_FAILED', `全部因子回测失败：${JSON.stringify(runs[0]?.error)}`)

        const primary = good[0]
        const id = backtestId(String(args.strategyId), cfg)
        const { sessionId } = provenance(exec)
        const version = store.getStrategy(String(args.strategyId))?.version ?? null
        const result = {
          ok: true,
          backtestId: id,
          strategyId: args.strategyId,
          range: [primary.bt.navSeries[0].date, primary.bt.navSeries.at(-1).date],
          days: primary.bt.metrics.days,
          metrics: primary.bt.metrics,
          // 净值曲线降采样到 ≤140 点：客户端卡片用它画图，完整曲线塞进事件只会撑大日志
          nav: downsample(primary.bt.navSeries.map((x) => ({ date: x.date, nav: x.nav })), 140),
          byFactor: good.map((r) => ({
            factorId: r.factorId, totalReturn: r.bt.metrics.totalReturn, cagr: r.bt.metrics.cagr,
            sharpe: r.bt.metrics.sharpe, maxDrawdown: r.bt.metrics.maxDrawdown, trades: r.bt.metrics.trades,
          })),
          skipped: primary.bt.skipped,
          rebalances: primary.bt.rebalances.length,
          panels: panels.ready,
          caveats: primary.bt.caveats,
        }
        store.saveBacktest({
          backtestId: id, strategyId: String(args.strategyId), version,
          // 除指标外还归档口径声明与"不可交易被拒"计数：
          // 它们决定一张回测图怎么读（例如"有 12 天停牌按最后收盘估值"），
          // 但都不在 nav 里。塞进 metrics JSON 即可，无需 schema 迁移；
          // 旧记录没有这两个字段，看板按配置确定性重建。
          config: cfg,
          metrics: {
            ...primary.bt.metrics, byFactor: result.byFactor,
            caveats: primary.bt.caveats, skipped: primary.bt.skipped,
            // 调仓次数不在 computeMetrics 里（它属于执行轨迹而非收益指标），
            // 但看板的身份条要显示它，所以随 metrics 一起归档。
            rebalances: primary.bt.rebalances.length,
          },
          nav: primary.bt.navSeries, sessionId,
        })
        return result
      },
      presentationMeta: (a, v) => v.ok === false
        ? { kind: 'backtest', ok: false, code: v.error?.code ?? 'ERROR', message: v.error?.message ?? '' }
        : {
            kind: 'backtest', ok: true,
            backtestId: v.backtestId, strategyId: v.strategyId,
            range: v.range, days: v.days, rebalances: v.rebalances,
            nav: v.nav ?? [],
            metrics: v.metrics,
            byFactor: v.byFactor, skipped: v.skipped, caveats: v.caveats,
          },
      render: (a, v) => {
        if (v.ok === false) return `失败：${v.error.code} — ${v.error.message}${v.error.hint ? `\n${v.error.hint}` : ''}`
        const m = v.metrics
        const lines = [
          `回测 ${v.strategyId} → ${v.backtestId}`,
          `区间 ${fmt.date(v.range[0])} ~ ${fmt.date(v.range[1])}（${v.days} 个交易日）| 调仓 ${v.rebalances} 次`,
          `总收益 ${fmt.pct(m.totalReturn)} | 年化 ${fmt.pct(m.cagr)} | 波动 ${fmt.pct(m.annualVol)} | 夏普 ${fmt.num(m.sharpe)}`,
          `最大回撤 ${fmt.pct(m.maxDrawdown)} | Calmar ${fmt.num(m.calmar)} | 胜率 ${fmt.pct(m.winRate)} | 年化换手 ${fmt.num(m.turnover, 2)}`,
          `成交 ${m.trades} 笔 | 费用 佣金 ${fmt.money(m.fees.commission)} / 印花税 ${fmt.money(m.fees.stampDuty)} / 过户费 ${fmt.money(m.fees.transferFee)}`,
        ]
        if (m.benchmark) lines.push(`基准 ${fmt.pct(m.benchmark.totalReturn)} | 超额 ${fmt.pct(m.benchmark.excessReturn)} | Beta ${fmt.num(m.benchmark.beta)} | IR ${fmt.num(m.benchmark.informationRatio)}`)
        const rej = { ...v.skipped.buy, ...v.skipped.sell }
        if (Object.keys(rej).length) lines.push(`因不可交易被拒：${Object.entries(rej).map(([k, n]) => `${k}×${n}`).join(' ')}`)
        if (v.byFactor.length > 1) lines.push(`分因子：${v.byFactor.map((f) => `${f.factorId} ${fmt.pct(f.cagr)}`).join(' | ')}`)
        if (v.caveats.length) lines.push(`口径声明：\n${v.caveats.map((c) => `  - ${c}`).join('\n')}`)
        return lines.join('\n')
      },
    }),

    tool({
      name: 'quant_backtest_get',
      description: '取回一次已留档的回测结果（指标 + 净值曲线）。',
      parameters: S.obj({
        backtestId: S.str('回测 id（quant_backtest_run 返回的）'),
        includeNav: S.bool('是否包含净值曲线（默认 false，曲线可能很长）'),
      }, ['backtestId']),
      outputSchema: output({
        backtestId: { type: 'string' }, strategyId: { type: 'string' }, version: { type: 'integer' },
        metrics: { type: 'object', additionalProperties: true },
        nav: { type: 'array', items: { type: 'object', additionalProperties: true } },
        sessionId: { type: 'string' },
      }, ['backtestId', 'metrics']),
      execute: (args) => {
        const r = runtime.store().getBacktest(String(args.backtestId))
        if (!r) return fail('NOT_FOUND', `回测 ${args.backtestId} 不存在`)
        return {
          ok: true, backtestId: r.backtest_id, strategyId: r.strategy_id, version: r.version,
          metrics: r.metrics, nav: args.includeNav ? r.nav : [], sessionId: r.session_id,
        }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : `${v.backtestId}（策略 ${v.strategyId} v${v.version}）\n  总收益 ${fmt.pct(v.metrics.totalReturn)} | 年化 ${fmt.pct(v.metrics.cagr)} | 夏普 ${fmt.num(v.metrics.sharpe)} | 最大回撤 ${fmt.pct(v.metrics.maxDrawdown)}`,
    }),

    tool({
      name: 'quant_backtest_analyze',
      description: [
        '分析一次回测结果：分年度收益、最大回撤区间、连续亏损、换手与费用占比。',
        '用于回答"这个策略什么时候亏的""费用吃掉了多少收益"这类问题。',
        '必须传 backtestId 或 nav（净值曲线），否则无从分析。',
      ].join(' '),
      parameters: S.obj({
        backtestId: S.str('回测 id'),
        topDrawdowns: S.int('列出前几段最大回撤（默认 3）'),
      }, ['backtestId']),
      outputSchema: output({
        backtestId: { type: 'string' },
        yearly: { type: 'array', items: { type: 'object', additionalProperties: true } },
        drawdowns: { type: 'array', items: { type: 'object', additionalProperties: true } },
        costShare: { type: 'object', additionalProperties: true },
      }, ['backtestId', 'yearly']),
      execute: (args) => {
        const r = runtime.store().getBacktest(String(args.backtestId))
        if (!r) return fail('NOT_FOUND', `回测 ${args.backtestId} 不存在`)
        const nav = r.nav ?? []
        if (nav.length < 2) return fail('NO_NAV', '这条回测没有净值曲线，无法分析')

        // 分年度 / 回撤段 / 成本占比都来自 lib/backtest/analyze.mjs 的共享实现 ——
        // 同一份净值曲线被本工具、HTML 看板、将来的活数据面板共同消费，
        // 算法只留一份，避免三处各写一遍后数字互相漂移。
        const yearly = yearlyStats(nav)
        const drawdowns = drawdownPeriods(nav)

        const m = r.metrics ?? {}
        const cost = costBreakdown(m, nav, m.initialCash)
        const gross = nav.at(-1).nav / nav[0].nav - 1
        return {
          ok: true, backtestId: args.backtestId, yearly,
          drawdowns: drawdowns.slice(0, Math.min(args.topDrawdowns ?? 3, 10)),
          costShare: {
            fees: cost.fees,
            netReturn: +gross.toFixed(6),
            note: cost.note,
            shareOfInitial: cost.shareOfInitial,
          },
        }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : `${v.backtestId} 分年度：\n` +
          v.yearly.map((y) => `  ${y.year}: ${fmt.pct(y.return)}（回撤 ${fmt.pct(y.maxDrawdown)}，夏普 ${fmt.num(y.sharpe)}）`).join('\n') +
          `\n最大回撤段：\n` +
          v.drawdowns.map((d) => `  ${fmt.date(d.startDate)} → ${fmt.date(d.troughDate)} 谷底 ${fmt.pct(d.trough)}${d.recoverDate ? `，${fmt.date(d.recoverDate)} 收复（${d.days} 天）` : '，至期末未收复'}`).join('\n') +
          `\n费用 ${fmt.money(v.costShare.fees)}，占初始资金 ${fmt.pct(v.costShare.shareOfInitial)}`,
    }),

    tool({
      name: 'quant_select_stocks',
      description: [
        '按因子选股：给定因子与信号日，返回可执行候选名单。',
        '股票池过滤与回测**同口径**（ST / 停牌 / 上市天数），并逐条给出拒绝原因计数。',
        '有已物化面板时走面板路径（快）；否则现场求值（只取信号日截面，不落库）。',
      ].join(' '),
      parameters: S.obj({
        factorId: S.str('已物化面板的因子 id（可选）'),
        formula: S.str('DSL 公式（没有面板时必填）'),
        date: S.int('信号日 YYYYMMDD（默认最新交易日）'),
        topK: S.int('取前几名（默认 20）'),
        ascending: S.bool('取因子值最小（默认 false = 取最大）'),
        excludeST: S.bool('剔除 ST（默认 true）'),
        minListDays: S.int('上市至少多少自然日（默认 60）'),
      }, []),
      outputSchema: output({
        path: { type: 'string' }, date: { type: 'integer' },
        dateAdjusted: { type: 'object', additionalProperties: true },
        universeSize: { type: 'integer' }, passedUniverse: { type: 'integer' },
        rejected: { type: 'object', additionalProperties: true },
        picks: { type: 'array', items: { type: 'object', additionalProperties: true } },
        caveats: { type: 'array', items: { type: 'string' } },
      }, ['date', 'picks']),
      execute: (args) => {
        const r = selectStocks(runtime.store(), {
          factorId: args.factorId ?? null, formula: args.formula ?? null,
          date: args.date ?? null, topK: args.topK ?? 20, ascending: !!args.ascending,
          universe: { excludeST: args.excludeST ?? true, minListDays: args.minListDays ?? 60 },
        })
        return r.ok ? { ...r } : r
      },
      presentationMeta: (a, v) => v.ok === false
        ? { kind: 'select', ok: false, code: v.error?.code ?? 'ERROR', message: v.error?.message ?? '' }
        : {
            kind: 'select', ok: true, date: v.date, path: v.path, dateAdjusted: v.dateAdjusted,
            universeSize: v.universeSize, passedUniverse: v.passedUniverse, rejected: v.rejected,
            picks: (v.picks ?? []).slice(0, 30), caveats: v.caveats,
          },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : `信号日 ${fmt.date(v.date)}（${v.path === 'panel' ? '面板' : '现场求值'}路径）` +
          (v.dateAdjusted ? `\n⚠️ ${v.dateAdjusted.reason}` : '') + '\n' +
          `股票池 ${v.universeSize} 只 → 通过 ${v.passedUniverse} 只${Object.keys(v.rejected).length ? `，拒绝 ${Object.entries(v.rejected).map(([k, n]) => `${k}×${n}`).join(' ')}` : ''}\n` +
          v.picks.map((p) => `  #${p.rank} ${p.code}${p.name ? ` ${p.name}` : ''} 因子 ${fmt.num(p.value, 6)} 收盘 ${fmt.num(p.close, 2)}`).join('\n') +
          (v.caveats?.length ? `\n声明：${v.caveats.join('；')}` : ''),
    }),

    tool({
      name: 'quant_optimize_parameters',
      description: [
        '参数扫描（网格或随机），目标是找出在该区间表现最好的一组策略参数。',
        '**必须把结论当作样本内择优**：返回里带过拟合声明，需要样本外复核。',
        '因子面板只物化一次，扫描只换策略参数（topK / 调仓 / 权重 / 缓冲）。',
        '随机模式同种子完全可复现。组合数超过上限会直接拒绝而不是跑一整天。',
      ].join(' '),
      parameters: S.obj({
        strategyId: S.str('策略 id（用它的因子与区间）'),
        space: {
          type: 'object',
          properties: {
            topK: { type: 'array', items: { type: 'integer' }, description: '候选持仓只数' },
            rebalance: { type: 'array', items: { type: 'string', enum: REBALANCE }, description: '候选调仓频率' },
            weight: { type: 'array', items: { type: 'string', enum: WEIGHTS }, description: '候选权重方式' },
            buffer: { type: 'array', items: { type: 'number' }, description: '候选缓冲倍数' },
          },
          required: ['topK'],
          additionalProperties: false,
        },
        mode: S.enum(['grid', 'random'], '网格或随机（默认 grid）'),
        samples: S.int('随机模式抽样组数（默认 40）'),
        seed: S.int('随机种子（默认 42，保证可复现）'),
        objective: S.enum(OBJECTIVES, '目标函数（默认 sharpe）'),
        maxRuns: S.int('组合数上限（默认 500）'),
        topN: S.int('面板深度（默认 500）'),
        confirm: S.bool('组合数超过 100 时必须显式确认'),
      }, ['strategyId', 'space']),
      outputSchema: output({
        mode: { type: 'string' }, objective: { type: 'string' },
        combos: { type: 'integer' }, evaluated: { type: 'integer' }, unscored: { type: 'integer' },
        panelMs: { type: 'integer' }, scanMs: { type: 'integer' },
        best: { type: 'object', additionalProperties: true },
        ranked: { type: 'array', items: { type: 'object', additionalProperties: true } },
        caveats: { type: 'array', items: { type: 'string' } },
      }, ['combos', 'evaluated', 'caveats']),
      timeoutMs: 30 * 60 * 1000,
      execute: (args) => {
        const store = runtime.store()
        const saved = store.getStrategy(String(args.strategyId))
        if (!saved) return fail('NOT_FOUND', `策略 ${args.strategyId} 不存在`)
        const cfg = saved.config
        const estCombos = (args.space?.topK?.length ?? 1) * (args.space?.rebalance?.length ?? 1) *
          (args.space?.weight?.length ?? 1) * (args.space?.buffer?.length ?? 1) * cfg.factors.length
        if (estCombos > 100 && args.confirm !== true) {
          return fail('APPROVAL_REQUIRED', `参数组合约 ${estCombos} 组，超过 100 组阈值`,
            '先向用户确认（扫描耗时且是样本内择优），再带 confirm=true 重试；或收窄空间 / 用 random 模式')
        }
        const r = optimizeStrategy(store, {
          factors: cfg.factors.map((f) => ({ factorId: f.id, formula: f.formula })),
          space: args.space, mode: args.mode ?? 'grid', samples: args.samples ?? 40,
          seed: args.seed ?? 42, objective: args.objective ?? 'sharpe',
          maxRuns: args.maxRuns ?? 500, topN: args.topN ?? DEFAULT_TOP_N,
          start: cfg.start, end: cfg.end, initialCash: cfg.initialCash ?? 1_000_000,
          universe: cfg.universe ?? {}, costs: cfg.costs ?? {},
        })
        return r.ok ? { ...r, ranked: r.ranked.slice(0, 20) } : r
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.code} — ${v.error.message}${v.error.hint ? `\n${v.error.hint}` : ''}`
        : `参数扫描（${v.mode} / 目标 ${v.objective}）：${v.combos} 组，评估 ${v.evaluated} 组${v.unscored ? `，${v.unscored} 组目标无定义被排除` : ''}\n` +
          `面板 ${(v.panelMs / 1000).toFixed(1)}s | 扫描 ${(v.scanMs / 1000).toFixed(1)}s\n` +
          (v.best ? `最优：${JSON.stringify({ topK: v.best.topK, rebalance: v.best.rebalance, weight: v.best.weight, buffer: v.best.buffer })} → 夏普 ${fmt.num(v.best.sharpe)}，年化 ${fmt.pct(v.best.cagr)}，回撤 ${fmt.pct(v.best.maxDrawdown)}\n` : '') +
          `前几名：\n` + v.ranked.slice(0, 5).map((x, i) => `  ${i + 1}. topK=${x.topK} ${x.rebalance} ${x.weight} → ${v.objective}=${fmt.num(x.objective)}`).join('\n') +
          `\n声明：\n${v.caveats.map((c) => `  - ${c}`).join('\n')}`,
    }),
  ]
}

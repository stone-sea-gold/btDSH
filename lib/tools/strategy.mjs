/**
 * 策略域工具（6 个）：组合、保存、读取、列表、检索、版本链。
 *
 * 版本链语义：**保存即新增版本，永不覆盖**。`(strategy_id, version)` 为主键。
 * 每个版本记录产出它的 `session_id`，因此可以从一条策略跳回产生它的那段对话。
 *
 * 组合（compose）与保存（save）分开是刻意的：compose 是**纯函数**（可反复试算、不落库），
 * save 才写盘。这样"用户拒绝保存"是一条真实存在的分支，而不是靠模型自觉。
 */

import { tool, S, output, fail, fmt } from './kit.mjs'
import { compileFactor } from '../factors/dsl.mjs'
import { builtinFactors } from './factor.mjs'

const REBALANCE = ['daily', 'weekly', 'monthly']
const WEIGHTS = ['equal', 'factor']

/** 从 exec 上下文里尽力取溯源信息（取不到就是 null，不编造） */
function provenance(exec) {
  const sessionId = exec?.agent?.session?.header?.id ?? null
  const turnSeq = exec?.agent?.session?.events?.length ?? null
  // 工作区归属：会话创建时的绝对 cwd（宿主已校验）。会话中途换目录不回溯旧记录。
  const cwd = exec?.agent?.session?.header?.cwd ?? null
  return { sessionId, turnSeq, cwd }
}

/** 把工具入参归一成一个**自洽**的策略配置，并校验所有因子都能编译 */
function composeConfig(store, args) {
  const errors = []
  const catalog = new Map(builtinFactors().map((f) => [f.id, f]))
  // 自建因子也存在 meta 表
  try {
    for (const r of store.raw.prepare("SELECT key,value FROM meta WHERE key LIKE 'factor:%'").all()) {
      const f = JSON.parse(r.value)
      catalog.set(f.id, f)
    }
  } catch { /* 忽略 */ }

  const factors = []
  for (const id of args.factorIds) {
    let formula = args.formulas?.[id]
    let meta = catalog.get(id)
    if (!meta && !formula) { errors.push(`因子 ${id} 不存在（用 quant_factor_list 查可用 id）`); continue }
    formula = formula ?? meta.formula
    const c = compileFactor(formula, { source: 'bars_adj', fieldMap: { turnover_rate: 'turnover' } })
    if (!c.ok) { errors.push(`因子 ${id} 公式无法编译：${c.error.message}`); continue }
    factors.push({ id, formula, name: meta?.name ?? id, category: meta?.category ?? 'custom', layers: c.meta.layerCount, lookback: c.meta.lookback ?? 0 })
  }
  if (!factors.length) errors.push('至少需要一个可用因子')

  const topK = args.topK ?? 20
  if (!Number.isInteger(topK) || topK < 1 || topK > 500) errors.push('topK 必须是 1..500 的整数（面板深度上限 500）')
  const rebalance = args.rebalance ?? 'monthly'
  if (!REBALANCE.includes(rebalance)) errors.push(`调仓频率必须是 ${REBALANCE.join('/')}`)
  const weight = args.weight ?? 'equal'
  if (!WEIGHTS.includes(weight)) errors.push(`权重方式必须是 ${WEIGHTS.join('/')}`)

  return {
    errors,
    config: {
      name: args.name ?? '未命名策略',
      description: args.description ?? null,
      factors,
      // 因子加权需要正权重；默认等权
      weights: args.weights ?? Object.fromEntries(factors.map((f) => [f.id, 1 / Math.max(1, factors.length)])),
      selection: { rule: 'top_k', k: topK },
      rebalance,
      weight,
      universe: {
        excludeST: args.excludeST ?? true,
        minListDays: args.minListDays ?? 60,
        excludeSuspended: true,
        codes: args.codes ?? null,
      },
      costs: args.costs ?? null,
      start: args.start ?? null,
      end: args.end ?? null,
      initialCash: args.initialCash ?? 1_000_000,
    },
  }
}

export function strategyTools(runtime) {
  return [
    tool({
      name: 'quant_strategy_compose',
      description: [
        '把一个或几个因子组合成策略配置，并做**完整校验**（因子存在、公式可编译、参数合法）。',
        '这是纯计算，不落库 —— 用来跟用户确认方案。确认后再调 quant_strategy_save。',
        '返回 `ready` 表示是否可回测；`warnings` 里是口径提醒（如因子回看期长于回测区间）。',
      ].join(' '),
      parameters: S.obj({
        factorIds: S.arr(S.str('因子 id'), '要用的因子 id 列表（1–5 个）'),
        name: S.str('策略名'),
        description: S.str('一句话说明这个策略在赌什么'),
        topK: S.int('持仓只数（1..500，默认 20）'),
        rebalance: S.enum(REBALANCE, '调仓频率'),
        weight: S.enum(WEIGHTS, '权重方式：equal 等权 / factor 按因子值加权'),
        start: S.int('回测起始日 YYYYMMDD'),
        end: S.int('回测结束日 YYYYMMDD'),
        initialCash: S.num('初始资金（默认 1000000）'),
        excludeST: S.bool('是否剔除 ST（默认 true）'),
        minListDays: S.int('上市至少多少自然日（默认 60）'),
      }, ['factorIds']),
      outputSchema: output({
        ready: { type: 'boolean' },
        config: { type: 'object', additionalProperties: true },
        errors: { type: 'array', items: { type: 'string' } },
        warnings: { type: 'array', items: { type: 'string' } },
      }, ['ready', 'config', 'errors']),
      execute: (args) => {
        if (!Array.isArray(args.factorIds) || args.factorIds.length === 0) return fail('NO_FACTOR', 'factorIds 不能为空')
        if (args.factorIds.length > 5) return fail('TOO_MANY_FACTORS', '一次最多 5 个因子；再多会难以解释收益来源')
        const { errors, config } = composeConfig(runtime.store(), args)
        const warnings = []
        if (config.factors.length > 1 && config.weight === 'equal') {
          warnings.push('多因子等权只做信号融合（各因子独立排名后取并集），不是加权打分；若要加权打分请用 weight=factor')
        }
        const maxLookback = Math.max(0, ...config.factors.map((f) => f.lookback))
        if (config.start && maxLookback > 0) {
          warnings.push(`最长回看 ${maxLookback} 个交易日；回测起始日之前需要已有数据，否则开头会有空值`)
        }
        // 校验不通过 → ok:false（与其余工具的信封约定一致）。
        // 但 `errors` 数组与 `config` 仍然完整返回，模型能一次看到全部问题而不是只有第一条。
        if (errors.length) {
          return {
            ok: false, ready: false, config, errors, warnings,
            error: { code: 'INVALID_STRATEGY', message: errors.join('；'), hint: '修正后重新 compose；errors 里有完整清单' },
          }
        }
        return { ok: true, ready: true, config, errors: [], warnings }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : (v.ready
          ? `策略「${v.config.name}」可回测：\n` +
            `  因子：${v.config.factors.map((f) => `${f.id}(${f.formula})`).join('、')}\n` +
            `  选股：按因子排名取前 ${v.config.selection.k} 只，${v.config.rebalance === 'daily' ? '每日' : v.config.rebalance === 'weekly' ? '每周' : '每月'}调仓，${v.config.weight === 'equal' ? '等权' : '因子值加权'}\n` +
            `  股票池：${v.config.universe.excludeST ? '剔除 ST、' : ''}停牌不交易、上市满 ${v.config.universe.minListDays} 自然日\n` +
            `  区间：${fmt.date(v.config.start)} ~ ${fmt.date(v.config.end)}，初始资金 ${fmt.money(v.config.initialCash)}\n` +
            (v.warnings.length ? `注意：\n${v.warnings.map((w) => `  - ${w}`).join('\n')}` : '')
          : `策略不可用：\n${v.errors.map((e) => `  - ${e}`).join('\n')}`),
    }),

    tool({
      name: 'quant_strategy_save',
      description: [
        '保存策略为一个**新版本**（永不覆盖旧版本）。',
        '必须先经过 quant_strategy_compose 校验通过。',
        '保存时会记录产出它的会话 id，因此之后可以从策略跳回这段对话。',
      ].join(' '),
      parameters: S.obj({
        strategyId: S.str('策略 id（英文小写下划线；同 id 再存就是新版本）'),
        config: { type: 'object', properties: {}, additionalProperties: true, description: 'compose 返回的 config 原样传入' },
      }, ['strategyId', 'config']),
      outputSchema: output({
        strategyId: { type: 'string' }, version: { type: 'integer' }, sessionId: { type: 'string' },
      }, ['strategyId', 'version']),
      execute: (args, exec) => {
        const store = runtime.store()
        const id = String(args.strategyId).trim()
        if (!/^[a-z][a-z0-9_]{1,40}$/.test(id)) return fail('BAD_ID', 'strategyId 必须是英文小写字母开头、只含小写字母数字下划线')
        const cfg = args.config
        if (!cfg || !Array.isArray(cfg.factors) || !cfg.factors.length) return fail('BAD_CONFIG', 'config 必须是 quant_strategy_compose 的返回值')
        // 落库前再校验一次：调用方可能改了 config
        for (const f of cfg.factors) {
          const c = compileFactor(f.formula, { source: 'bars_adj', fieldMap: { turnover_rate: 'turnover' } })
          if (!c.ok) return fail('BAD_FORMULA', `因子 ${f.id} 的公式无法编译：${c.error.message}`)
        }
        const { sessionId, turnSeq, cwd } = provenance(exec)
        const r = store.saveStrategy({ strategyId: id, name: cfg.name, description: cfg.description, config: cfg, sessionId, turnSeq, cwd })
        if (cwd) store.touchWorkspace(cwd)
        return { ok: true, ...r, sessionId, cwd }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : `已保存 ${v.strategyId} v${v.version}${v.sessionId ? `（溯源会话 ${v.sessionId}）` : ''}`,
    }),

    tool({
      name: 'quant_strategy_load',
      description: '按 id 读取策略。不传 version 时取最新版本；传了就取那一个版本（可用来复现历史结果）。',
      parameters: S.obj({
        strategyId: S.str('策略 id'),
        version: S.int('版本号（默认最新）'),
      }, ['strategyId']),
      outputSchema: output({
        strategyId: { type: 'string' }, version: { type: 'integer' },
        config: { type: 'object', additionalProperties: true },
        sessionId: { type: 'string' }, createdAt: { type: 'integer' },
      }, ['strategyId', 'version', 'config']),
      execute: (args) => {
        const r = runtime.store().getStrategy(String(args.strategyId), args.version ?? null)
        if (!r) return fail('NOT_FOUND', `策略 ${args.strategyId}${args.version ? ` v${args.version}` : ''} 不存在`)
        return { ok: true, strategyId: r.strategy_id, version: r.version, config: r.config, sessionId: r.session_id, createdAt: r.created_at }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : `${v.strategyId} v${v.version}「${v.config.name}」\n  因子：${v.config.factors.map((f) => f.id).join('、')}\n  前 ${v.config.selection.k} 只 / ${v.config.rebalance} / ${v.config.weight}`,
    }),

    tool({
      name: 'quant_strategy_list',
      description: '列出所有已保存策略的**最新版本**（按保存时间倒序）。',
      parameters: S.obj({ limit: S.int('最多返回多少条（默认 20）') }, []),
      outputSchema: output({
        count: { type: 'integer' },
        strategies: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }, ['count', 'strategies']),
      execute: (args) => {
        const all = runtime.store().listStrategies()
        const limit = Math.min(args.limit ?? 20, 100)
        return {
          ok: true, count: Math.min(all.length, limit),
          strategies: all.slice(0, limit).map((s) => ({
            strategyId: s.strategy_id, version: s.version, name: s.name, description: s.description,
            factors: (s.config.factors ?? []).map((f) => f.id),
            topK: s.config.selection?.k, rebalance: s.config.rebalance,
            createdAt: s.created_at, sessionId: s.session_id,
          })),
        }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : (v.count === 0 ? '还没有保存过策略' : v.strategies.map((s) => `- ${s.strategyId} v${s.version}「${s.name}」因子 ${s.factors.join('+')} / 前${s.topK} / ${s.rebalance}`).join('\n')),
    }),

    tool({
      name: 'quant_strategy_search',
      description: '按关键词检索已保存策略（匹配 id / 名称 / 说明 / 因子 id）。',
      parameters: S.obj({
        query: S.str('关键词'),
        limit: S.int('最多返回多少条（默认 10）'),
      }, ['query']),
      outputSchema: output({
        query: { type: 'string' }, count: { type: 'integer' },
        matches: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }, ['query', 'count', 'matches']),
      execute: (args) => {
        const q = String(args.query ?? '').trim().toLowerCase()
        if (!q) return fail('EMPTY_QUERY', '关键词不能为空')
        const hits = runtime.store().listStrategies().filter((s) => {
          const hay = [s.strategy_id, s.name, s.description, (s.config.factors ?? []).map((f) => f.id).join(' ')].join(' ').toLowerCase()
          return hay.includes(q)
        })
        const limit = Math.min(args.limit ?? 10, 50)
        return {
          ok: true, query: args.query, count: Math.min(hits.length, limit),
          matches: hits.slice(0, limit).map((s) => ({ strategyId: s.strategy_id, version: s.version, name: s.name, description: s.description })),
        }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}` : (v.count ? v.matches.map((m) => `- ${m.strategyId} v${m.version}「${m.name}」`).join('\n') : '没有匹配的策略'),
    }),

    tool({
      name: 'quant_strategy_versions',
      description: [
        '查看一条策略的**完整版本链**，并可选地对比两个版本。',
        '用于回答"这版和上版差在哪"以及"这个结果是哪个版本跑出来的"。',
        '每版带 sessionId，可用于跳回产出该版本的对话。',
      ].join(' '),
      parameters: S.obj({
        strategyId: S.str('策略 id'),
        compare: S.arr(S.int('版本号'), '要对比的两个版本号，例如 [1, 3]'),
      }, ['strategyId']),
      outputSchema: output({
        strategyId: { type: 'string' },
        versions: { type: 'array', items: { type: 'object', additionalProperties: true } },
        diff: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }, ['strategyId', 'versions']),
      execute: (args) => {
        const store = runtime.store()
        const versions = store.strategyVersions(String(args.strategyId))
        if (!versions.length) return fail('NOT_FOUND', `策略 ${args.strategyId} 没有任何版本`)
        let diff = []
        if (Array.isArray(args.compare) && args.compare.length === 2) {
          const [a, b] = args.compare
          const ca = store.getStrategy(String(args.strategyId), a)
          const cb = store.getStrategy(String(args.strategyId), b)
          if (!ca || !cb) return fail('NOT_FOUND', `版本 ${!ca ? a : b} 不存在`)
          diff = diffConfig(ca.config, cb.config)
        }
        return {
          ok: true, strategyId: args.strategyId,
          versions: versions.map((v) => ({ version: v.version, name: v.name, description: v.description, sessionId: v.session_id, createdAt: v.created_at })),
          diff,
        }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : `${v.strategyId} 共 ${v.versions.length} 个版本：\n` +
          v.versions.map((x) => `  v${x.version} ${x.name ?? ''}${x.sessionId ? ` [会话 ${x.sessionId}]` : ''}`).join('\n') +
          (v.diff.length ? `\n对比差异：\n${v.diff.map((d) => `  ${d.field}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`).join('\n')}` : ''),
    }),
  ]
}

/** 配置差异：只比会影响结果的字段，避免把时间戳之类噪声算进来 */
function diffConfig(a, b) {
  const out = []
  const pick = (c) => ({
    factors: (c.factors ?? []).map((f) => `${f.id}:${f.formula}`).sort(),
    topK: c.selection?.k, rebalance: c.rebalance, weight: c.weight,
    start: c.start, end: c.end, initialCash: c.initialCash,
    universe: c.universe,
  })
  const pa = pick(a), pb = pick(b)
  for (const k of Object.keys(pa)) {
    const sa = JSON.stringify(pa[k]), sb = JSON.stringify(pb[k])
    if (sa !== sb) out.push({ field: k, from: pa[k], to: pb[k] })
  }
  return out
}

export { composeConfig, provenance }

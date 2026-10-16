/**
 * 审批护栏。
 *
 * DSH 的 `tools.guard(fn)` 是**单调否决**：返回字符串即拒绝，且没有任何 guard
 * 能推翻另一个 guard 的拒绝。所以这里的机制是"**拒绝 + 给出明确的复述路径**"，
 * 而不是"弹窗等确认"——插件拿不到交互式确认通道，编一个只会变成假的。
 *
 * 于是流程是可见且可审计的两步：
 *   1. 模型调用高风险工具 → 护栏拒绝，返回为什么拒、需要向用户确认什么
 *   2. 模型向用户说明 → 用户同意 → 模型带 `confirm: true` 重试
 *
 * 为什么不用"记住上次批准"：那会让批准脱离具体参数。用户同意的是"这次全市场同步"，
 * 不是"以后任何全市场同步"。护栏每次都按**当次参数**判断。
 */

/** 各工具的阈值与说明。key 是工具名，value 返回 null（放行）或拒绝理由 */
export const GUARD_RULES = {
  quant_data_sync(args) {
    const scope = args?.scope ?? 'all'
    if (scope === 'codes') return null                       // 代码表是秒级的，不拦
    if (args?.estimateOnly) return null                      // 只估算不落地
    const n = Array.isArray(args?.codes) ? args.codes.length : null
    // 指定了具体股票列表 → 用户已经明确了范围，按列表长度判断
    if (n !== null && n <= 200) return null
    if (n === null) {
      // 全库/全市场：从 0 起同步属于"重"操作，一律要确认
      return '全市场行情同步属于重操作（可能数十分钟、上万次请求）。请先向用户说明规模与耗时，取得明确同意后带 confirm=true 重试；或先用 estimateOnly=true 让用户看到估算。'
    }
    return `本次将同步 ${n} 只股票，规模较大。请先向用户说明耗时，取得同意后带 confirm=true 重试。`
  },

  quant_backtest_run(args) {
    const cfg = args?.config
    if (!cfg?.start || !cfg?.end) return null                // 缺参数交给工具自己报错
    const years = Math.abs(Math.floor(cfg.end / 10000) - Math.floor(cfg.start / 10000))
    if (years > 5 && args?.confirm !== true) {
      return `回测区间 ${years} 年超过 5 年阈值。请与用户确认区间是否必要（长区间更耗时、也更容易过拟合），取得同意后带 confirm=true 重试。`
    }
    return null
  },

  quant_optimize_parameters(args) {
    const sp = args?.space ?? {}
    const combos = (sp.topK?.length ?? 1) * (sp.rebalance?.length ?? 1) * (sp.weight?.length ?? 1) * (sp.buffer?.length ?? 1)
    if (combos > 100 && args?.confirm !== true) {
      return `参数组合约 ${combos} 组超过 100 组阈值。请先向用户确认（扫描耗时，且结果是样本内择优），取得同意后带 confirm=true 重试；或收窄空间 / 改用 random 模式。`
    }
    return null
  },

  quant_data_cleanup(args) {
    if ((args?.scope ?? 'panels') === 'all' && args?.confirm !== true) {
      return 'scope=all 会删除本地全部行情且不可恢复。请与用户确认（通常只需要 scope=panels 清因子面板），同意后带 confirm=true 重试。'
    }
    return null
  },

  /**
   * 开启自动同步 = 一次**长期授权**。
   *
   * 这里和其他规则有个本质区别：别的规则拦的是"这一次很重"，这条拦的是
   * "以后每天都会发生、而且没人再问"。自动任务没有弹窗通道，所以同意必须在
   * 配置时取得——护栏就是那道必须过的门。
   */
  quant_autosync(args) {
    if ((args?.action ?? 'get') !== 'enable') return null
    if (args?.confirm === true) return null
    return '开启自动同步是一次长期授权：之后**每天收盘后会自动联网同步**，不再逐次询问。请先向用户说明：' +
      '① 每天在指定时刻增量同步本地已有的股票；② DSH 没在运行时不会执行（下次启动会补跑）；' +
      '③ 只同步本地已有的股票，不会自动扩大到全市场；④ 超过硬上限会跳过并记录。' +
      '取得明确同意后带 confirm=true 重试。'
  },
}

/**
 * 安装护栏。返回注册结果，disposer 交给 ctx.effect 管理。
 *
 * @param {object} ctx 插件上下文
 * @param {{ enabled?: boolean, extra?: Record<string, Function> }} opts
 */
export function installGuards(ctx, opts = {}) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.guard !== 'function') {
    return { ok: false, reason: 'tools.guard unavailable', rules: [] }
  }
  if (opts.enabled === false) return { ok: true, rules: [], disabled: true }

  const rules = { ...GUARD_RULES, ...(opts.extra ?? {}) }
  const disposer = tools.guard((exec) => {
    const rule = rules[exec?.name]
    if (rule === undefined) return undefined
    try {
      const reason = rule(exec.arguments)
      return reason === null || reason === undefined ? undefined : reason
    } catch (e) {
      // 护栏自己出错时必须**放行**：宁可少拦一次，也不能因为护栏 bug 让所有调用失败
      return undefined
    }
  })
  return { ok: true, rules: Object.keys(rules), disposer }
}

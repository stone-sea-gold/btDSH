/**
 * 工具面基础设施。
 *
 * DSH 的 `ctx.tools.register()` 接受**普通对象**（P0-G4 实测），所以第三方插件包
 * 不需要 import DSH 内部模块，只需满足它的契约：
 *
 *   { name, description, parameters, output: { schema, render, presentationMeta? }, execute, timeoutMs? }
 *
 * 两个必须遵守的硬约束（读 `dsh-tools` 源码得来，违反会直接抛错）：
 *   1. **JSON Schema 只支持子集**：`type / oneOf / properties / required /
 *      additionalProperties / items / enum / const` + 注解（description/title）。
 *      `format`、`minimum`、`pattern` 这类关键字会被拒绝 —— 约束必须写进 description 或运行时校验。
 *   2. **`output.render` 必须存在且是函数**，返回 `[{ type: 'text', text }]`。
 *
 * 另外 `run_code` 是保留名，不能注册也不能遮蔽。
 */

// ── JSON Schema 构造器（只产出受支持的子集） ─────────────────────────────────
export const S = {
  obj: (properties, required = Object.keys(properties)) => ({
    type: 'object', properties, required, additionalProperties: false,
  }),
  str: (description, extra = {}) => ({ type: 'string', description, ...extra }),
  num: (description) => ({ type: 'number', description }),
  int: (description) => ({ type: 'integer', description }),
  bool: (description) => ({ type: 'boolean', description }),
  enum: (values, description) => ({ type: 'string', enum: values, description }),
  arr: (items, description) => ({ type: 'array', items, description }),
}

// ── 标准输出封装 ────────────────────────────────────────────────────────────
/**
 * 统一的结果信封。所有工具都返回 `{ ok, ... }`：
 *   - `ok: false` + `error: {code, message, hint?}` —— 可预期的失败（数据缺失、参数不合法）
 *   - 抛异常只用于真正的 bug；模型能自愈的失败一律走 `ok: false`
 *
 * 这样模型看到的是一个**稳定形状**，而不是一堆各不相同的异常文本。
 */
export function fail(code, message, hint) {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } }
}

/** 把内部错误对象转成信封 */
export function fromError(e, code = 'INTERNAL') {
  return fail(e?.code ?? code, e?.message ?? String(e))
}

/**
 * 摘要文本生成器：把结构化结果压成模型可读的几行，细节留在结构化输出里。
 * 不追求好看，追求**信息密度**与**可核对**（数字带单位、区间带起止）。
 */
export const fmt = {
  pct: (x, d = 2) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(d)}%`),
  num: (x, d = 4) => (x === null || x === undefined ? '—' : Number(x).toFixed(d)),
  money: (x) => (x === null || x === undefined ? '—' : Number(x).toLocaleString('zh-CN', { maximumFractionDigits: 0 })),
  date: (x) => (x === null || x === undefined ? '—' : String(x).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')),
}

/**
 * 把任意值净化成 **lossless JSON**。
 *
 * 为什么必须在工厂层统一做：DSH 对 `presentationMeta` 的返回值做快照校验，
 * 返回 `undefined` / 函数 / `NaN` 会直接抛 `output.presentationMeta returned non-lossless JSON`，
 * **整个工具调用失败**。而 meta 是手写的、字段可能来自可选的分支，
 * 让每个工具自己记得剔除 undefined 是不现实的（实测 `quant_data_status` 就踩了）。
 *
 * 规则：`undefined` 与函数 → 对象里丢弃、数组里变 null；`NaN`/`±Infinity` → null；
 * 其余递归处理。与 `JSON.parse(JSON.stringify(x))` 的结果一致，但显式且可预测。
 */
export function jsonSafe(value, depth = 0) {
  if (depth > 32) return null
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value
  if (t === 'number') return Number.isFinite(value) ? value : null
  if (t === 'bigint') return Number(value)
  if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined
  if (Array.isArray(value)) return value.map((x) => { const v = jsonSafe(x, depth + 1); return v === undefined ? null : v })
  if (t === 'object') {
    if (value instanceof Date) return value.toISOString()
    const out = {}
    for (const k of Object.keys(value)) {
      const v = jsonSafe(value[k], depth + 1)
      if (v !== undefined) out[k] = v
    }
    return out
  }
  return undefined
}

/**
 * 把序列降采样到 ≤max 个点（保留首尾与形状）。
 *
 * 为什么需要：净值曲线有 1800+ 个点，而卡片只有几百像素宽。
 * 完整曲线塞进 tool/result 事件既撑大日志又没有视觉收益。
 */
export function downsample(points, max = 140) {
  if (!Array.isArray(points) || points.length <= max) return points ?? []
  const step = (points.length - 1) / (max - 1)
  const out = []
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)])
  return out
}

// ── 工具工厂 ────────────────────────────────────────────────────────────────
/**
 * 构造一个 DSH 工具定义。
 *
 * @param {object} spec
 *   name        工具名（`quant_` 前缀）
 *   description 给模型看的说明（写清口径与限制，这是模型唯一的说明书）
 *   parameters  S.* 构造的 JSON Schema
 *   outputSchema 结构化输出 schema
 *   execute     async (args, ctx) => value
 *   render      (args, value) => string（默认：JSON 摘要）
 *   timeoutMs   可选
 */
export function tool(spec) {
  const { name, description, parameters, outputSchema, execute, render, presentationMeta, timeoutMs } = spec
  if (!name || !description || !parameters || !outputSchema || typeof execute !== 'function') {
    throw new Error(`tool(${name ?? '?'}): name/description/parameters/outputSchema/execute 都是必需的`)
  }
  const def = {
    name,
    description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => [{ type: 'text', text: (render ? render(args, value) : defaultRender(value)) }],
      // presentationMeta 会作为 `meta` 挂到 tool/result 事件上，客户端卡片从 `block.meta` 读它。
      // 这是**唯一**能把结构化数据送到 UI 的通道：`content` 只有渲染后的文本。
      // 它必须是 lossless JSON（DSH 会做快照校验），所以不能塞 live 对象、函数或 undefined。
      // 净化是**强制的**：meta 里一个 undefined 就会让整次工具调用失败（DSH 的快照校验）
      ...(presentationMeta ? { presentationMeta: (args, value) => jsonSafe(presentationMeta(args, value)) ?? null } : {}),
    },
    async execute(args, exec) {
      try {
        return await execute(args, exec)
      } catch (e) {
        // 预期内的失败走信封；真正的异常也转成信封，但保留 code 以便定位
        return fromError(e)
      }
    },
  }
  if (timeoutMs) def.timeoutMs = timeoutMs
  return def
}

function defaultRender(value) {
  if (value === null || value === undefined) return '(no result)'
  if (typeof value === 'string') return value
  if (value.ok === false) return `失败：${value.error?.code ?? 'ERROR'} — ${value.error?.message ?? ''}`
  return JSON.stringify(value, null, 1)
}

/** 结果信封的统一输出 schema（所有工具共用，避免 30 份重复定义） */
export const ENVELOPE = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '是否成功' },
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' }, hint: { type: 'string' } },
      required: ['code', 'message'],
      additionalProperties: false,
    },
  },
  required: ['ok'],
  additionalProperties: true,   // 各工具在此基础上追加自己的字段
}

/**
 * 带信封的完整输出 schema：**失败信封 ∥ 成功载荷**，oneOf 二选一。
 *
 * 为什么必须是 oneOf 而不是平铺的 `required: ['ok', ...业务字段]`：
 * DSH 宿主会拿这个 schema 校验工具的**实际返回值**，不过就抛
 * `INVALID_TOOL_OUTPUT`（模型只看到宿主报错，看不到工具自己的失败提示）。
 * 而 `fail()` 只返回 `{ok:false, error}`，不含业务字段 —— 平铺写法让**每一次
 * 预期失败**（数据缺失、参数不合法、审批拦截、异常兜底）都变成宿主级硬错误。
 * 实测：`quant_factor_preview` 空库时模型只看到
 * `missing required property "value.formula"`，看不到"先跑 quant_data_sync"。
 *
 * DSH 的 schema 子集恰好支持 `oneOf`（**恰好匹配一个分支**）与 `const`：
 *   - 失败分支 `{ok: const false, error 必填}` —— 只接受 fail() 信封
 *   - 成功分支 `{ok: const true, ...业务字段}` —— ok 互斥保证恰好匹配一个
 * 成功值缺业务字段（真正的违约）仍是 0 个分支匹配，照拦 —— 保护意义不变。
 */
export function output(properties, required = []) {
  return {
    oneOf: [
      {
        type: 'object',
        // const 必须与 type 并列（DSH 子集要求，缺 type 会在 schema 断言时被拒）
        properties: { ok: { type: 'boolean', const: false }, error: ENVELOPE.properties.error },
        required: ['ok', 'error'],
        additionalProperties: true,
      },
      {
        type: 'object',
        properties: { ok: { type: 'boolean', const: true }, ...properties },
        required: ['ok', ...required],
        additionalProperties: true,
      },
    ],
  }
}

/**
 * 显式可空声明：运行时确实会返回 null 的字段必须用它包一层。
 *
 * DSH 子集不支持 `type: ['integer','null']` 数组形式，声明了具体类型的字段
 * 收到 null 就是 `INVALID_TOOL_OUTPUT`（实测 quant_trading_calendar 空仓库时
 * `"value.first" must be an integer`）。nullable 用 `oneOf: [原声明, null]`
 * 表达"这个值要么是 X，要么是没有"。
 */
export const nullable = (schema) => ({ oneOf: [schema, { type: 'null' }] })

/**
 * 把工具定义列表装进一个插件作用域。
 * 返回 disposer 数组（由调用方交给 ctx.effect 管理生命周期）。
 */
export function registerAll(ctx, definitions) {
  const tools = ctx.get('tools')
  if (tools === undefined) return { ok: false, reason: 'tools service unavailable', registered: [] }
  const disposers = []
  const registered = []
  for (const def of definitions) {
    try {
      disposers.push(tools.register(def))
      registered.push(def.name)
    } catch (e) {
      // 单个工具注册失败不应该拖垮整个插件（例如与其他插件重名）
      registered.push({ name: def.name, error: e?.message ?? String(e) })
    }
  }
  return { ok: true, registered, disposers }
}

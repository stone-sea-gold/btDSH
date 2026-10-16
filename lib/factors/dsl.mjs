/**
 * 因子 DSL：词法 → AST → 白名单校验 → **分层** SQL 编译。
 *
 * 为什么必须分层：SQLite 不允许窗口函数直接嵌套（`avg(lag(x,1) over w) over w` 非法），
 * 而真实因子大量嵌套（如 `Std(Ret($close), 20)`、`Mean(Max($close - Ref($close,1), 0), 6)`）。
 * 因此编译产物是一串 CTE 层，每个窗口函数在独立层里先物化成列，再被上层引用。
 *
 * 安全模型（本插件唯一把 LLM 输出喂给执行器的地方）：
 *   - 字段白名单（18 个）、函数白名单（16 个）、窗口长度必须为 1..250 的整数字面量
 *   - 只生成 SELECT 表达式；不产生子查询、写操作、ATTACH、PRAGMA、分号
 *   - 未知标识符/函数/参数个数 → 结构化错误，不执行、不落库
 *
 * 语法约定来自 AIFUND5 的 109 个内置因子实测（**109/109 全部可编译**）：
 *   `$close / Ref($close, 20) - 1`、`Std(Ret($close), 20)`、`Max($high, 5) / Min($low, 5)`、
 *   `Mean(Max($close - Ref($close, 1), 0), 6) / (Mean(Abs($close - Ref($close, 1)), 6) + 1e-12)`、
 *   `Quantile($close, 5, 0.8) / $close`、`Rank($close, 5)`、`Corr($close, $volume, 5)`、
 *   `Slope($close, 20) / $close`、`Rsquare($close, 20)`、`Resi($close, 5) / $close`、
 *   `IdxMax($high, 20)`、`IdxMin($low, 20)`
 *
 * 注意：`Max(x, 5)` 是滚动窗口，而 `Max(x, 0)` 是逐元素（第二参数不是正整数时）。
 * 这个重载在 AIFUND5 的公式集里真实存在，必须按第二参数是否为 1..250 的整数字面量区分。
 *
 * 回归类（Slope/Rsquare/Resi）与位置类（IdxMax/IdxMin/Rank）的语义对齐 qlib/pandas，
 * 已用 `spike/oracle-factors.py`（直接调用 qlib 的 Cython 实现）逐点对照：106,263 点 0 不一致。
 */

export const FIELDS = [
  'close', 'open', 'high', 'low', 'volume', 'amount', 'turnover_rate',
  'eps', 'beps', 'bps', 'roe',
  'revenue_ttm', 'net_profit_ttm', 'equity', 'total_assets', 'cost_ttm',
  'total_share', 'total_market_value',
]

/** 比较运算符：SQLite 中布尔表达式即 0/1，可直接参与算术（如 Mean(Ref($close,1) < $close, 5)） */
export const COMPARISON_OPS = ['<=', '>=', '<', '>']

export const MAX_WINDOW = 250

/**
 * 函数表：arity = [min, max]；rolling = 是否为滚动窗口函数。
 *
 * `needsIdx`：实现需要**全局行号**（`row_number()`），编译器会插入一层 `__idx` 前置 CTE。
 * `aggregate`：需要 `node:sqlite` 自定义滑动聚合（见 aggregates.mjs）。
 * `noNullInWindow`：窗口内含 NULL 时 qlib 的位置语义不连续，编译器对该行返回 NULL 而不是给错值。
 */
export const FUNCTIONS = {
  Ref: { arity: [1, 2], rolling: true, defaultWindow: 1 },
  Mean: { arity: [2, 2], rolling: true, windowArg: 1 },
  Std: { arity: [2, 2], rolling: true, windowArg: 1 },
  Max: { arity: [2, 2], rolling: 'overloaded', windowArg: 1 },
  Min: { arity: [2, 2], rolling: 'overloaded', windowArg: 1 },
  Ret: { arity: [1, 2], rolling: true, defaultWindow: 1 },
  Abs: { arity: [1, 1], rolling: false },
  Log: { arity: [1, 1], rolling: false },
  Corr: { arity: [3, 3], rolling: true, windowArg: 2 },
  Slope: { arity: [2, 2], rolling: true, windowArg: 1, needsIdx: true, noNullInWindow: true },
  Rsquare: { arity: [2, 2], rolling: true, windowArg: 1, needsIdx: true, noNullInWindow: true },
  Resi: { arity: [2, 2], rolling: true, windowArg: 1, needsIdx: true, noNullInWindow: true },
  IdxMax: { arity: [2, 2], rolling: true, windowArg: 1, needsIdx: true, aggregate: 'q_idxmax' },
  IdxMin: { arity: [2, 2], rolling: true, windowArg: 1, needsIdx: true, aggregate: 'q_idxmin' },
  Quantile: { arity: [3, 3], rolling: true, windowArg: 1, qArg: 2 },
  Rank: { arity: [2, 2], rolling: true, windowArg: 1, needsIdx: true, aggregate: 'q_rank' },
}

// ── 词法 ────────────────────────────────────────────────────────────────────
export function tokenize(src) {
  const tokens = []
  let i = 0
  const s = String(src ?? '')
  while (i < s.length) {
    const ch = s[i]
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(i))
      if (!m) throw new DslError(`位置 ${i}：'$' 后缺少字段名`, 'BAD_FIELD')
      tokens.push({ type: 'field', value: m[1], pos: i }); i += m[0].length; continue
    }
    const num = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i))
    if (num) { tokens.push({ type: 'num', value: Number(num[0]), pos: i }); i += num[0].length; continue }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i))
    if (id) { tokens.push({ type: 'ident', value: id[0], pos: i }); i += id[0].length; continue }
    const cmp = /^(<=|>=|<|>)/.exec(s.slice(i))
    if (cmp) { tokens.push({ type: cmp[0], value: cmp[0], pos: i }); i += cmp[0].length; continue }
    if ('+-*/(),'.includes(ch)) { tokens.push({ type: ch, value: ch, pos: i }); i++; continue }
    throw new DslError(`位置 ${i}：非法字符 ${JSON.stringify(ch)}`, 'BAD_CHAR')
  }
  return tokens
}

export class DslError extends Error {
  constructor(message, code) { super(message); this.name = 'DslError'; this.code = code }
}

// ── 语法（递归下降） ────────────────────────────────────────────────────────
export function parse(src) {
  const tokens = tokenize(src)
  let p = 0
  const peek = () => tokens[p]
  const eat = (type) => {
    const t = tokens[p]
    if (!t || t.type !== type) throw new DslError(`期望 ${type}，实际 ${t ? t.type : '结束'}（位置 ${t?.pos ?? src.length}）`, 'PARSE')
    p++
    return t
  }
  const parseExpr = () => {
    let left = parseAdditive()
    const t = peek()
    if (t && COMPARISON_OPS.includes(t.type)) {
      p++
      const right = parseAdditive()
      left = { type: 'bin', op: t.type, left, right, comparison: true }
    }
    return left
  }
  const parseAdditive = () => {
    let left = parseTerm()
    while (peek() && (peek().type === '+' || peek().type === '-')) {
      const op = tokens[p++].type
      left = { type: 'bin', op, left, right: parseTerm() }
    }
    return left
  }
  const parseTerm = () => {
    let left = parseUnary()
    while (peek() && (peek().type === '*' || peek().type === '/')) {
      const op = tokens[p++].type
      left = { type: 'bin', op, left, right: parseUnary() }
    }
    return left
  }
  const parseUnary = () => {
    if (peek() && peek().type === '-') { p++; return { type: 'un', op: '-', arg: parseUnary() } }
    if (peek() && peek().type === '+') { p++; return parseUnary() }
    return parsePrimary()
  }
  const parsePrimary = () => {
    const t = peek()
    if (!t) throw new DslError('表达式意外结束', 'PARSE')
    if (t.type === 'num') { p++; return { type: 'num', value: t.value } }
    if (t.type === 'field') { p++; return { type: 'field', name: t.value } }
    if (t.type === 'ident') {
      p++
      eat('(')
      const args = []
      if (peek() && peek().type !== ')') {
        args.push(parseExpr())
        while (peek() && peek().type === ',') { p++; args.push(parseExpr()) }
      }
      eat(')')
      return { type: 'call', name: t.value, args }
    }
    if (t.type === '(') { p++; const e = parseExpr(); eat(')'); return e }
    throw new DslError(`位置 ${t.pos}：意外的 ${t.type}`, 'PARSE')
  }
  const ast = parseExpr()
  if (p !== tokens.length) throw new DslError(`位置 ${tokens[p].pos}：表达式后有多余内容`, 'PARSE')
  return ast
}

// ── 校验 ────────────────────────────────────────────────────────────────────
export function validate(ast) {
  const errors = []
  const fields = new Set(), functions = new Set(), unsupported = new Set()
  let maxWindow = 0
  /**
   * 计算"要算当前这一行，至少要往前看多少行"（lookback = Σ(nᵢ − 1)）。
   * 用途：临时选股时把源数据裁到每只股票最后 lookback+1 行，避免为了一个截面
   * 把全历史都喂进窗口函数层。这是**保守上界**（取子表达式最大值后逐层相加）。
   */
  const lookbackOf = (node) => {
    if (!node) return 0
    switch (node.type) {
      case 'num': case 'field': return 0
      case 'un': return lookbackOf(node.arg)
      case 'bin': return Math.max(lookbackOf(node.left), lookbackOf(node.right))
      case 'call': {
        const spec = FUNCTIONS[node.name]
        const inner = node.args.reduce((a, x) => Math.max(a, lookbackOf(x)), 0)
        if (!spec) return inner
        if (node.name === 'Ref' || node.name === 'Ret') return inner + (node.args[1]?.value ?? 1)
        if (spec.rolling && spec.rolling !== 'overloaded') {
          const wi = spec.windowArg ?? (spec.defaultWindow !== undefined && node.args.length < 2 ? null : node.args.length - 1)
          const w = wi === null ? spec.defaultWindow : node.args[wi]?.value
          return Number.isInteger(w) && w >= 1 ? inner + (w - 1) : inner
        }
        if (spec.rolling === 'overloaded') {
          const w = node.args[1]?.value
          return Number.isInteger(w) && w >= 1 && w <= MAX_WINDOW ? inner + (w - 1) : inner
        }
        return inner
      }
      default: return 0
    }
  }
  const walk = (node) => {
    if (!node) return
    switch (node.type) {
      case 'num': return
      case 'field':
        fields.add(node.name)
        if (!FIELDS.includes(node.name)) errors.push({ code: 'UNKNOWN_FIELD', message: `未知字段 $${node.name}`, allowed: FIELDS })
        return
      case 'un': return walk(node.arg)
      case 'bin': walk(node.left); walk(node.right); return
      case 'call': {
        const spec = FUNCTIONS[node.name]
        functions.add(node.name)
        if (!spec) { errors.push({ code: 'UNKNOWN_FUNCTION', message: `未知函数 ${node.name}`, allowed: Object.keys(FUNCTIONS) }); return }
        const [lo, hi] = spec.arity
        if (node.args.length < lo || node.args.length > hi) {
          errors.push({ code: 'BAD_ARITY', message: `${node.name} 需要 ${lo}${hi !== lo ? '~' + hi : ''} 个参数，实际 ${node.args.length}` })
        }
        if (spec.unsupported) unsupported.add(node.name)
        for (const a of node.args) walk(a)
        if (spec.qArg !== undefined) {
          const q = node.args[spec.qArg]
          if (!q || q.type !== 'num' || !(q.value >= 0 && q.value <= 1)) {
            errors.push({ code: 'BAD_QUANTILE', message: `${node.name} 的分位点必须是 0..1 的数字字面量` })
          }
        }
        if (spec.rolling) {
          const wi = spec.windowArg ?? (spec.defaultWindow !== undefined && node.args.length < 2 ? null : node.args.length - 1)
          const wArg = wi === null ? { type: 'num', value: spec.defaultWindow } : node.args[wi]
          if (wArg && wArg.type === 'num') {
            const w = wArg.value
            if (spec.rolling === 'overloaded' && !(Number.isInteger(w) && w >= 1 && w <= MAX_WINDOW)) return // 逐元素重载
            if (!Number.isInteger(w) || w < 1 || w > MAX_WINDOW) {
              errors.push({ code: 'BAD_WINDOW', message: `${node.name} 的窗口必须为 1..${MAX_WINDOW} 的整数字面量，实际 ${w}` })
            } else maxWindow = Math.max(maxWindow, w)
          } else if (wArg) {
            errors.push({ code: 'BAD_WINDOW', message: `${node.name} 的窗口必须是数字字面量（不允许表达式）` })
          }
        }
        return
      }
      default: errors.push({ code: 'BAD_NODE', message: `未知节点类型 ${node.type}` })
    }
  }
  walk(ast)
  const fnList = [...functions]
  const needsIdx = fnList.some((f) => FUNCTIONS[f]?.needsIdx)
  const aggregates = [...new Set(fnList.map((f) => FUNCTIONS[f]?.aggregate).filter(Boolean))]
  return {
    ok: errors.length === 0, errors, fields: [...fields], functions: fnList,
    unsupported: [...unsupported], maxWindow, lookback: lookbackOf(ast), needsIdx, aggregates,
  }
}

// ── SQL 编译（分层） ────────────────────────────────────────────────────────
/**
 * 编译因子表达式为分层 SQL。
 * @param {string} formula DSL 源码
 * @param {{source?: string, codeColumn?: string, dateColumn?: string}} opts
 * @returns {{ok: boolean, sql?: string, layers?: string[], error?: object, meta?: object}}
 */
export function compileFactor(formula, { source = 'bars', codeColumn = 'code', dateColumn = 'date', fieldMap = {} } = {}) {
  let ast
  try { ast = parse(formula) } catch (e) { return { ok: false, error: { code: e.code ?? 'PARSE', message: e.message } } }
  const v = validate(ast)
  if (!v.ok) return { ok: false, error: { code: 'VALIDATION', message: v.errors[0].message, errors: v.errors }, meta: v }
  if (v.unsupported.length) {
    return { ok: false, error: { code: 'UNSUPPORTED_FUNCTION', message: `暂不支持的函数：${v.unsupported.join(', ')}` }, meta: v }
  }

  const layers = []
  let layerIndex = 0
  const OVER = `PARTITION BY ${codeColumn} ORDER BY ${dateColumn}`
  const rowsOver = (n) => `${OVER} ROWS BETWEEN ${n - 1} PRECEDING AND CURRENT ROW`

  const isSimple = (node) => node.type === 'field' || node.type === 'num'

  /** 追加一层物化列，返回列名（`from` 由当前层号决定，保证层链不断） */
  const pushLayer = (selectExpr, colName) => {
    const col = colName ?? `__c${layerIndex}`
    layers.push({ from: layerIndex === 0 ? source : `L${layerIndex}`, select: `${selectExpr} AS ${col}` })
    layerIndex++
    return col
  }

  /** 把表达式物化为一列，返回该列名（必要时新增一层） */
  const materialize = (node) => {
    const sql = emit(node)
    if (isSimple(node)) return sql
    return pushLayer(sql)
  }

  /**
   * Slope / Rsquare / Resi：qlib 把窗口内的点按 **x = 1..N**（最老为 1）做一元线性回归。
   * 用全局行号 `__idx`（当前行 = t）把 Σ i·y_i 换成窗口内可直接求和的量：
   *   Σ i·y_i = Σ(idx_m − t + N)·y_m = W − (t − N)·S
   * 于是 slope = (W − (t − (N−1)/2)·S) · 12 / (N(N²−1))，其中 W = Σ __idx·x、S = Σ x。
   */
  const regression = (node) => {
    const n = node.args[1].value
    const x = materialize(node.args[0])
    const frame = rowsOver(n)
    const cnt = `count(${x}) OVER (${frame})`
    const all = `count(*) OVER (${frame})`
    const S = `sum(${x}) OVER (${frame})`
    // 直接内联乘积，不再为 x*x / __idx*x 各开一层 CTE：
    // 每层 CTE 都是对全表的一次物化，全市场 864 万行下这是最贵的部分
    const Sy2 = `sum(${x} * ${x}) OVER (${frame})`
    const W = `sum(__idx * ${x}) OVER (${frame})`
    const slope = `((${W} - (__idx - (${cnt} - 1) / 2.0) * ${S}) * 12.0 / (${cnt} * (${cnt} * ${cnt} - 1)))`
    // 窗口内出现 NULL 时 qlib 的"按非空值计龄"会让 x 位置不连续，公式不再等价 → 宁可为 NULL
    const clean = `(${cnt} = ${all}) AND ${cnt} >= 2`
    return { n, x, cnt, S, Sy2, W, slope, clean }
  }

  const emit = (node) => {
    switch (node.type) {
      case 'num': return String(node.value)
      case 'field': return fieldMap[node.name] ?? node.name
      case 'un': return `(-${emit(node.arg)})`
      case 'bin': return `(${emit(node.left)} ${node.op} ${emit(node.right)})`
      case 'call': {
        const name = node.name
        switch (name) {
          case 'Ref': {
            const n = node.args[1]?.value ?? 1
            const x = materialize(node.args[0])
            return `lag(${x}, ${n}) OVER (${OVER})`
          }
          case 'Ret': {
            const n = node.args[1]?.value ?? 1
            const x = materialize(node.args[0])
            return `(${x} / lag(${x}, ${n}) OVER (${OVER}) - 1)`
          }
          case 'Mean': {
            const n = node.args[1].value
            const x = materialize(node.args[0])
            return `avg(${x}) OVER (${rowsOver(n)})`
          }
          case 'Std': {
            const n = node.args[1].value
            const x = materialize(node.args[0])
            // 样本标准差（与 pandas rolling().std() 默认 ddof=1 一致）；n=1 时无定义，返回 0
            if (n === 1) return '0.0'
            return `sqrt(max(0.0, (sum(${x} * ${x}) OVER (${rowsOver(n)}) - ${n} * pow(avg(${x}) OVER (${rowsOver(n)}), 2)) / ${n - 1}))`
          }
          case 'Max': case 'Min': {
            const fn = name.toLowerCase()
            const w = node.args[1]
            if (w.type === 'num' && Number.isInteger(w.value) && w.value >= 1 && w.value <= MAX_WINDOW) {
              const x = materialize(node.args[0])
              return `${fn}(${x}) OVER (${rowsOver(w.value)})`
            }
            // 逐元素重载：Max(a, 0)
            return `${fn}(${emit(node.args[0])}, ${emit(node.args[1])})`
          }
          case 'Abs': return `abs(${emit(node.args[0])})`
          case 'Log': return `ln(${emit(node.args[0])})`
          case 'Corr': {
            const n = node.args[2].value
            const x = materialize(node.args[0])
            const y = materialize(node.args[1])
            if (n === 1) return '0.0'
            const mx = `avg(${x}) OVER (${rowsOver(n)})`
            const my = `avg(${y}) OVER (${rowsOver(n)})`
            const cov = `(sum(${x} * ${y}) OVER (${rowsOver(n)}) - ${n} * (${mx}) * (${my}))`
            const vx = `(sum(${x} * ${x}) OVER (${rowsOver(n)}) - ${n} * pow(${mx}, 2))`
            const vy = `(sum(${y} * ${y}) OVER (${rowsOver(n)}) - ${n} * pow(${my}, 2))`
            return `(${cov} / nullif(sqrt(max(0.0, ${vx}) * max(0.0, ${vy})), 0))`
          }
          case 'Slope': {
            const r = regression(node)
            return `(CASE WHEN ${r.clean} THEN ${r.slope} ELSE NULL END)`
          }
          case 'Resi': {
            const r = regression(node)
            // 最新点（x = N）的回归残差：y_t − ȳ − slope·(N−1)/2
            const resi = `(${r.x} - ${r.S} / ${r.cnt} - ${r.slope} * (${r.cnt} - 1) / 2.0)`
            return `(CASE WHEN ${r.clean} THEN ${resi} ELSE NULL END)`
          }
          case 'Rsquare': {
            const r = regression(node)
            // r² = slope²·N²(N²−1) / (12·(N·Σy² − (Σy)²))；qlib 在窗口标准差 ≈0 时置 NaN
            const den = `(${r.cnt} * ${r.Sy2} - ${r.S} * ${r.S})`
            const r2 = `(${r.slope} * ${r.slope} * ${r.cnt} * ${r.cnt} * (${r.cnt} * ${r.cnt} - 1) / (12.0 * ${den}))`
            return `(CASE WHEN ${r.clean} AND ${den} > 4e-10 * ${r.cnt} * (${r.cnt} - 1) THEN ${r2} ELSE NULL END)`
          }
          case 'IdxMax': case 'IdxMin': {
            const n = node.args[1].value
            const x = materialize(node.args[0])
            const agg = node.name === 'IdxMax' ? 'q_idxmax' : 'q_idxmin'
            const frame = rowsOver(n)
            // 聚合返回**最左极值的绝对行号**；换算成"距窗口最老行第几位"（qlib 的 argmax+1）。
            // 不额外开层：聚合只出现一次，且 NULL 会自然穿透算术运算（NULL − idx + cnt = NULL）
            return `(${agg}(${x}, __idx) OVER (${frame}) - __idx + count(*) OVER (${frame}))`
          }
          case 'Rank': {
            const n = node.args[1].value
            const x = materialize(node.args[0])
            return `q_rank(${x}, __idx) OVER (${rowsOver(n)})`
          }
          case 'Quantile': {
            const n = node.args[1].value
            const q = node.args[2].value
            const x = materialize(node.args[0])
            // pandas rolling.quantile 默认线性插值，与 SQLite percentile_cont（连续型）一致
            return `percentile_cont(${x}, ${q}) OVER (${rowsOver(n)})`
          }
          default:
            throw new DslError(`未实现的函数 ${name}`, 'UNSUPPORTED_FUNCTION')
        }
      }
      default: throw new DslError(`未知节点 ${node.type}`, 'BAD_NODE')
    }
  }

  // 需要全局行号时先插一层 `__idx`（row_number 本身也是窗口函数，必须单独成层）
  if (v.needsIdx) pushLayer(`row_number() OVER (${OVER})`, '__idx')

  const valueSql = emit(ast)
  const ctes = layers.map((l, i) => `L${i + 1} AS (SELECT *, ${l.select} FROM ${l.from})`)
  const finalFrom = layers.length === 0 ? source : `L${layers.length}`
  const finalSelect = `SELECT ${codeColumn}, ${dateColumn}, ${valueSql} AS value FROM ${finalFrom}`
  const sql = `${ctes.length ? 'WITH ' + ctes.join(',\n     ') + '\n' : ''}${finalSelect}`
  return { ok: true, sql, ctes, finalSelect, layers: ctes, meta: { ...v, layerCount: layers.length } }
}

/** 便捷：编译并只保留最后一个交易日截面（用于预览因子） */
export function compileFactorLatest(formula, { source = 'bars', date } = {}) {
  const r = compileFactor(formula, { source })
  if (!r.ok || !date) return r
  // 必须在外层过滤：把日期条件下推进第一个 CTE 会让滚动窗口只剩一行，因子全废
  return { ...r, sql: `SELECT * FROM (${r.sql}) WHERE ${'date'} = ${Number(date)}` }
}

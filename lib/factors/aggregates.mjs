/**
 * 因子 DSL 需要的 SQLite 自定义**滑动窗口聚合**。
 *
 * 为什么需要它们：`Rank` / `IdxMax` / `IdxMin` 都要"把窗口内的值和**当前行**的值比较"
 * 或"返回极值所在的位置"。SQL 里窗口函数的参数是按**框架行**求值的，拿不到当前行的值当常量，
 * 也无法表达 argmax。用相关子查询可以硬算，但代价是 O(行数 × 窗口)：
 * 全市场 864 万行 × 60 窗口 ≈ 5 亿次探测，直接毁掉 P0 定下的性能预算。
 *
 * 因此走 `node:sqlite` 的 `db.aggregate()`：提供 `step` + `inverse` 后它就是**真正的滑动窗口聚合**
 * （离开的行调 inverse，进入的行调 step，`result` 只做 O(log N) 或 O(1) 的查询）。
 * 生命周期已实测：每个分区一次 `start`，之后每行 `inverse*` → `step` → `result`。
 *
 * 语义对齐 qlib / pandas（AIFUND5 的因子就是 qlib 表达式）：
 *   - `q_rank(y, idx)`     = pandas `rolling(N, min_periods=1).rank(pct=True)`（平均名次 / 有效个数）
 *   - `q_idxmax(y, idx)`   = `rolling(N, min_periods=1).apply(lambda x: x.argmax() + 1)`
 *                            → 返回**窗口内最左极值的绝对行号**，由 SQL 侧换算成"距最老行第几位"
 *
 * 全部实现只依赖传入的行号与值，不持有任何 DSH 运行时对象。
 */

/** 注册到连接的聚合函数名（DSL 编译器会把这些名字写进 SQL） */
export const AGGREGATE_NAMES = ['q_rank', 'q_idxmax', 'q_idxmin']

// ── 有序数组：二分定位（q_rank 用） ─────────────────────────────────────────
/** 第一个 ≥ v 的下标（= 窗口内 < v 的个数） */
function lowerBound(a, v) {
  let lo = 0, hi = a.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m }
  return lo
}
/** 第一个 > v 的下标（= 窗口内 ≤ v 的个数） */
function upperBound(a, v) {
  let lo = 0, hi = a.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= v) lo = m + 1; else hi = m }
  return lo
}
function insertSorted(a, v) { a.splice(lowerBound(a, v), 0, v) }
function removeSorted(a, v) { const i = lowerBound(a, v); if (i < a.length && a[i] === v) a.splice(i, 1) }

// ── 聚合定义 ────────────────────────────────────────────────────────────────
/**
 * `q_rank(y, idx)`：返回窗口内**当前行**（行号最大的那行）的百分位名次。
 *
 * 用"行号最大的那行"而不是"最后一次 step 的那行"来认定当前行，是为了不依赖
 * SQLite 内部 step/inverse 的调用次序——框架永远以当前行结尾，所以两者等价，
 * 但前者在实现上是确定的。
 */
const rankAgg = {
  start: () => ({ vals: [], byIdx: new Map(), maxIdx: -Infinity }),
  step: (acc, y, idx) => {
    if (idx == null) return acc
    acc.byIdx.set(idx, y)
    if (y != null) insertSorted(acc.vals, y)
    if (idx > acc.maxIdx) acc.maxIdx = idx
    return acc
  },
  inverse: (acc, y, idx) => {
    if (idx == null) return acc
    acc.byIdx.delete(idx)
    if (y != null) removeSorted(acc.vals, y)
    if (idx === acc.maxIdx) {
      // 只在窗口退化为 1 行时发生；重扫一次代价可忽略
      acc.maxIdx = -Infinity
      for (const k of acc.byIdx.keys()) if (k > acc.maxIdx) acc.maxIdx = k
    }
    return acc
  },
  result: (acc) => {
    const n = acc.vals.length
    if (n === 0 || acc.maxIdx === -Infinity) return null
    const v = acc.byIdx.get(acc.maxIdx)
    if (v == null) return null
    const lo = lowerBound(acc.vals, v), hi = upperBound(acc.vals, v)
    // pandas 默认 method='average'：并列取平均名次（1-based），再除以有效个数
    return ((lo + hi + 1) / 2) / n
  },
}

/**
 * 单调队列求**最左**极值：队列内行号递增、值严格递减（求最大时）。
 * 新值只弹掉严格更小的尾部，因此并列时更早的那行存活 → 得到最左极值。
 * 离场的行一定是窗口内行号最小的，只可能在队首（或早已被弹掉），故只检查队首。
 */
function extremumAgg(wantMax) {
  const keep = (tail, y) => (wantMax ? tail < y : tail > y)
  return {
    start: () => ({ idxs: [], vals: [], head: 0, lastIdx: null, lastY: null }),
    step: (acc, y, idx) => {
      acc.lastIdx = idx
      acc.lastY = y
      if (y == null || idx == null) return acc
      while (acc.vals.length > acc.head && keep(acc.vals[acc.vals.length - 1], y)) {
        acc.vals.pop(); acc.idxs.pop()
      }
      acc.vals.push(y); acc.idxs.push(idx)
      return acc
    },
    inverse: (acc, y, idx) => {
      if (idx != null && acc.head < acc.idxs.length && acc.idxs[acc.head] === idx) {
        acc.head++
        if (acc.head > 64 && acc.head * 2 > acc.idxs.length) {
          acc.idxs = acc.idxs.slice(acc.head); acc.vals = acc.vals.slice(acc.head); acc.head = 0
        }
      }
      return acc
    },
    result: (acc) => {
      if (acc.lastY == null) return null          // 当前行无值 → 无定义
      if (acc.head >= acc.idxs.length) return null
      return acc.idxs[acc.head]                   // 最左极值的绝对行号
    },
  }
}

const SPECS = {
  q_rank: rankAgg,
  q_idxmax: extremumAgg(true),
  q_idxmin: extremumAgg(false),
}

const REGISTERED = new WeakSet()

/**
 * 在连接上注册全部因子聚合（幂等）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ok: boolean, registered: string[], failed: {name: string, message: string}[]}}
 */
export function registerFactorAggregates(db) {
  if (REGISTERED.has(db)) return { ok: true, registered: [], failed: [], cached: true }
  const registered = [], failed = []
  for (const [name, spec] of Object.entries(SPECS)) {
    try { db.aggregate(name, spec); registered.push(name) }
    catch (e) { failed.push({ name, message: e.message }) }
  }
  if (failed.length === 0) REGISTERED.add(db)
  return { ok: failed.length === 0, registered, failed }
}

/** 仓库对象上的便捷入口：面板物化 / 选股 / 回测共用同一条连接 */
export function ensureFactorAggregates(store) {
  const r = registerFactorAggregates(store.raw)
  if (!r.ok) {
    const e = new Error(`因子滑动聚合注册失败：${r.failed.map((f) => `${f.name}(${f.message})`).join(', ')}`)
    e.code = 'AGGREGATE_UNAVAILABLE'
    throw e
  }
  return r
}

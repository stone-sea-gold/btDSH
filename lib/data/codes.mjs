/**
 * A 股代码记法互转。
 *
 * 东财 secid = `${market}.${code}`，market：1 = 上交所，0 = 深交所/北交所。
 * 注意：北交所（43/83/87/920 开头）在东财同样走 market 0，此点待 P1 用真实样本复核。
 */

export const BOARD_BY_PREFIX = [
  { test: /^(600|601|603|605)/, board: 'sh_main', market: 1 },
  { test: /^(688|689)/, board: 'star', market: 1 },
  { test: /^(000|001|002|003)/, board: 'sz_main', market: 0 },
  { test: /^(300|301)/, board: 'chinext', market: 0 },
  { test: /^(43|83|87|920)/, board: 'bse', market: 0 },
]

/** 6 位代码 → 东财 secid */
export function secidOf(code) {
  const c = normalizeCode(code)
  for (const b of BOARD_BY_PREFIX) if (b.test.test(c)) return `${b.market}.${c}`
  // 兜底：6/9 开头视为沪市，其余深市
  return /^[69]/.test(c) ? `1.${c}` : `0.${c}`
}

/** 去掉市场前缀与后缀，得到 6 位代码 */
export function normalizeCode(input) {
  const s = String(input).trim().toUpperCase()
  const digits = s.replace(/[^0-9]/g, '')
  if (digits.length === 6) return digits
  if (digits.length > 6) return digits.slice(-6)
  return digits.padStart(6, '0')
}

export function marketOf(code) {
  return secidOf(code).split('.')[0]
}

export function boardOf(code) {
  const c = normalizeCode(code)
  const b = BOARD_BY_PREFIX.find((x) => x.test.test(c))
  return b?.board ?? 'unknown'
}

/** 交易所前缀形式：sh600519 / sz000001 */
export function prefixedCode(code) {
  return (marketOf(code) === '1' ? 'sh' : 'sz') + normalizeCode(code)
}

/** 涨跌停幅度（不含 ST，ST 由调用方覆盖为 5%） */
export function limitRatioOf(code, isSt = false) {
  if (isSt) return 0.05
  const board = boardOf(code)
  if (board === 'chinext' || board === 'star') return 0.2
  if (board === 'bse') return 0.3
  return 0.1
}

/**
 * YYYYMMDD → 自 1970-01-01 起的天序号（UTC）。
 *
 * 为什么必须有这个函数：仓库里的日期是 `20240110` 这种**十进制写法**，不是天数。
 * 直接做减法会得到荒谬的结果——`20240110 - 20231225 = 8885`，而实际只隔 16 天。
 * 用整数差做"上市满 N 日"判断会让过滤器几乎永不触发（这是实测发现的缺陷）。
 */
export function dayOrdinal(ymd) {
  const n = Number(ymd)
  if (!Number.isFinite(n)) return null
  const y = Math.floor(n / 10000), m = Math.floor(n / 100) % 100, d = n % 100
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000)
}

/** 两个 YYYYMMDD 之间的**自然日**差（a − b）；任一侧不可解析时返回 null */
export function calendarDaysBetween(a, b) {
  const oa = dayOrdinal(a), ob = dayOrdinal(b)
  return oa === null || ob === null ? null : oa - ob
}

/** 天序号 → YYYYMMDD（`dayOrdinal` 的逆；越界返回 null） */
export function ordinalToYmd(ord) {
  if (!Number.isFinite(ord)) return null
  const d = new Date(ord * 86400000)
  if (Number.isNaN(d.getTime())) return null
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
}

/** YYYYMMDD 往前推 n 个自然日 */
export function shiftYmd(ymd, days) {
  const o = dayOrdinal(ymd)
  return o === null ? null : ordinalToYmd(o + days)
}

/**
 * 两个 YYYYMMDD 之间的**工作日**数（a − b，只数周一~周五）。
 *
 * 为什么需要：A 股周末不交易，而"最新行情距今几天"如果用自然日算，
 * 每个周一早上都会报"过期 3 天"，这是噪声而不是信号。
 *
 * 注意它**不识别节假日**（需要一张交易所日历，本插件不维护）——
 * 春节/国庆长假仍会被算成若干工作日。这是已声明的近似，不是疏漏。
 */
export function weekdaysBetween(a, b) {
  const oa = dayOrdinal(a), ob = dayOrdinal(b)
  if (oa === null || ob === null) return null
  const lo = Math.min(oa, ob), hi = Math.max(oa, ob)
  let n = 0
  for (let o = lo; o < hi; o++) {
    const dow = new Date(o * 86400000).getUTCDay()
    if (dow !== 0 && dow !== 6) n++
  }
  return oa >= ob ? n : -n
}

/** 该 YYYYMMDD 是不是周末 */
export function isWeekend(ymd) {
  const o = dayOrdinal(ymd)
  return o === null ? null : [0, 6].includes(new Date(o * 86400000).getUTCDay())
}

/**
 * 数据源适配层。
 *
 * P0 实测决定的三条硬约束（不要"优化"掉它们）：
 *  1. **不复权原始价只有东财 `fqt=0` 提供**：腾讯 `day` 数值与 `qfqday` 一致（前复权），
 *     搜狐也是前复权 → 原始价是硬依赖东财，回退源只能提供复权序列。
 *  2. **东财 `pct` 字段是不复权口径**（4 例精确吻合 raw 口径，含 10 转 4.8 的 -31.88%），
 *     它不是交易所复权口径，不能用来对账复权收益。
 *  3. 东财 `fqt=2` 直接提供后复权序列，可直接作为收益基准；新增分红只给整条历史乘常数，
 *     **不改变任何历史收益率** → 收益可复现，无需自己推导因子链。
 *
 * 单位约定：东财/腾讯/搜狐的 volume 均为「手」→ 统一 ×100 转「股」；amount 为「元」。
 */

import { fetchJson, DEFAULT_REFERER } from './http.mjs'
import { normalizeCode, secidOf, prefixedCode } from './codes.mjs'

const EM_KLINE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
const EM_QUOTE = 'https://push2.eastmoney.com/api/qt/stock/get'
const EM_CLIST = 'https://push2.eastmoney.com/api/qt/clist/get'
const EM_DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
const TX_KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
const SOHU = 'https://q.stock.sohu.com/hisHq'

const num = (v) => (v === '' || v === '-' || v === null || v === undefined ? null : Number(v))

// ── 东财：日线 ──────────────────────────────────────────────────────────────

const EM_FIELDS2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'

/** 东财日线。fqt: 0=不复权（含官方 pct，实为不复权口径）, 1=前复权, 2=后复权 */
export async function emKline(code, { fqt = 0, klt = 101, beg = '0', end = '20500101', tries = 8 } = {}) {
  const url = `${EM_KLINE}?secid=${secidOf(code)}&fields1=f1,f2,f3,f4,f5,f6&fields2=${EM_FIELDS2}&klt=${klt}&fqt=${fqt}&beg=${beg}&end=${end}`
  const r = await fetchJson(url, {
    tries,
    validate: (j) => Array.isArray(j?.data?.klines),
  })
  if (!r.ok) return { ok: false, source: 'em', error: r.error, attempts: r.attempts, rows: [] }
  const rows = r.json.data.klines.map((line) => {
    const [date, open, close, high, low, volume, amount, amplitude, pct, change, turnover] = line.split(',')
    return {
      date: Number(date.replace(/-/g, '')),
      open: num(open), high: num(high), low: num(low), close: num(close),
      volume: num(volume) === null ? null : Math.round(num(volume) * 100), // 手 → 股
      amount: num(amount),
      pct: num(pct),            // ⚠️ 不复权口径
      turnover: num(turnover),
      amplitude: num(amplitude),
    }
  })
  return { ok: true, source: 'em', host: 'push2his.eastmoney.com', attempts: r.attempts, ms: r.ms, name: r.json?.data?.name ?? null, total: r.json?.data?.dktotal ?? null, rows }
}

// ── 腾讯：日线（仅复权序列） ────────────────────────────────────────────────

const txCode = (code) => prefixedCode(code)
const txKey = (period) => (period === 'hfq' ? 'hfqday' : period === 'qfq' ? 'qfqday' : 'day')
/** 腾讯 URL 的复权参数：raw 必须传空串（传 'raw' 会被拒），键名仍为 day */
const txFqParam = (period) => (period === 'hfq' ? 'hfq' : period === 'qfq' ? 'qfq' : '')

/** 解析腾讯的方案文本，例如 "10派1元转4.8股" / "10派20.11元(含税,扣税后18.099元)" */
export function parsePlan(text) {
  const t = String(text ?? '')
  const grab = (re) => {
    const m = t.match(re)
    return m ? Number(m[1]) : 0
  }
  return {
    cash10: grab(/派([\d.]+)元/),
    bonus10: grab(/送([\d.]+)股/),
    transfer10: grab(/转(?:增)?([\d.]+)股/),
  }
}

/**
 * 腾讯日线，单次区间 ≤2 年 / count ≤800，自动分段。period: 'hfq' | 'qfq' | 'raw'
 *
 * ⚠️ 重要（P1 实测）：腾讯 K 线行末尾会**内嵌分红事件元数据**
 *    {"nd":"2023","fh_sh":"30.17","djr":"2024-04-29","cqr":"2024-04-30","FHcontent":"10派30.17元"}
 * 同一天多次分配时东财 `RPT_SHAREBONUS_DET` 会漏记（实测 300750 2024-04-30 只记了 20.11，
 * 漏了 30.17，而交易所参考价用的是两者之和 50.28），因此**腾讯的嵌入事件是必需的事件源**，
 * 且它搭在本来就要发的请求上，零额外成本。
 */
export async function tencentKline(code, { period = 'hfq', begYear, endYear, tries = 4 } = {}) {
  const c = txCode(code)
  const key = txKey(period)
  const seen = new Map()
  const events = []
  const segments = []
  for (let y = begYear; y <= endYear; y += 2) {
    const beg = `${y}-01-01`
    const end = `${Math.min(y + 1, endYear)}-12-31`
    const url = `${TX_KLINE}?param=${c},day,${beg},${end},800,${txFqParam(period)}`
    const r = await fetchJson(url, { referer: 'https://gu.qq.com/', tries, validate: (j) => Array.isArray(j?.data?.[c]?.[key]) })
    const arr = r.ok ? r.json.data[c][key] : []
    segments.push({ beg, end, rows: arr.length, ok: r.ok })
    for (const row of arr) {
      const [date, open, close, high, low, volume, meta] = row
      const d = Number(date.replace(/-/g, ''))
      seen.set(d, {
        date: d,
        open: num(open), high: num(high), low: num(low), close: num(close),
        volume: num(volume) === null ? null : Math.round(num(volume) * 100),
      })
      if (meta && typeof meta === 'object' && meta.cqr) {
        const plan = parsePlan(meta.FHcontent)
        events.push({
          code: normalizeCode(code),
          exDate: Number(String(meta.cqr).replace(/-/g, '')),
          recordDate: meta.djr ? Number(String(meta.djr).replace(/-/g, '')) : null,
          reportYear: meta.nd ?? null,
          cash10: meta.fh_sh != null ? Number(meta.fh_sh) : plan.cash10,
          bonus10: plan.bonus10,
          transfer10: plan.transfer10,
          planText: meta.FHcontent ?? null,
          source: 'tencent-embedded',
        })
      }
    }
  }
  const rows = [...seen.values()].sort((a, b) => a.date - b.date)
  return { ok: rows.length > 0, source: 'tencent', adjusted: period, segments, rows, events }
}

// ── 搜狐：日线（前复权） ────────────────────────────────────────────────────

/** 搜狐日线（前复权）。hq 行 = [date, open, close, change, pct%, low, high, volume(手), amount(万), turnover%] */
export async function sohuKline(code, { beg, end, tries = 4 } = {}) {
  const url = `${SOHU}?code=cn_${normalizeCode(code)}&start=${beg}&end=${end}`
  const r = await fetchJson(url, { referer: 'https://q.stock.sohu.com/', tries, validate: (j) => Array.isArray(j?.[0]?.hq) })
  const rows = (r.ok ? r.json[0].hq : []).map((row) => ({
    date: Number(String(row[0]).replace(/-/g, '')),
    open: num(row[1]), close: num(row[2]), pct: num(String(row[4]).replace('%', '')),
    low: num(row[5]), high: num(row[6]),
    volume: num(row[7]) === null ? null : Math.round(num(row[7]) * 100),
    amount: num(row[8]) === null ? null : num(row[8]) * 1e4,
    turnover: num(String(row[9] ?? '').replace('%', '')),
  }))
  return { ok: rows.length > 0, source: 'sohu', adjusted: 'qfq', rows }
}

// ── 新浪：日线（不复权原始价，东财 push2 被封时的关键回退） ──────────────────

const SINA_KLINE = 'http://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData'

/**
 * 新浪日线 —— **不复权原始价**。
 *
 * P1 实测：与 BaoStock `adjustflag=3` 逐位一致（600519 1474.500/1460.010、
 * 300750 209.630/202.600、000001 11.680/11.980），单次可取 2500 根（10 年+）。
 * ⚠️ `volume` 单位是**股**（东财/腾讯是手，需 ×100）；无 `amount`、无官方 pct。
 */
export async function sinaKline(code, { datalen = 2600, tries = 4 } = {}) {
  const url = `${SINA_KLINE}?symbol=${prefixedCode(code)}&scale=240&ma=no&datalen=${datalen}`
  const r = await fetchJson(url, {
    referer: 'https://finance.sina.com.cn/',
    tries,
    validate: (j) => Array.isArray(j) && j.length > 0 && j[0]?.day !== undefined,
  })
  const rows = (r.ok ? r.json : []).map((x) => ({
    date: Number(String(x.day).replace(/-/g, '')),
    open: num(x.open), high: num(x.high), low: num(x.low), close: num(x.close),
    volume: num(x.volume), // 已是「股」
    amount: null,
    pct: null,             // 无官方字段；不要用自算值冒充官方口径
    turnover: null,
  }))
  return { ok: rows.length > 0, source: 'sina', raw: true, rows }
}

/**
 * 原始价编排：东财 push2his 优先（带官方 pct，可用于数据完整性对账），
 * 失败则回退新浪（不复权，与 BaoStock 一致）。
 *
 * P1 实测：东财 push2* 家族在密集请求后会被 IP 级封禁（0/5 成功，datacenter-web 仍 5/5），
 * 因此原始价**必须有第二个源**，否则整条回测链路停摆。
 */
export async function rawKline(code, { beg = '20180101', end = '20500101', tries = 6 } = {}) {
  const em = await emKline(code, { fqt: 0, beg, end, tries })
  if (em.ok && em.rows.length) return { ...em, provenance: 'em-push2his' }
  const sina = await sinaKline(code, { tries: Math.max(3, Math.floor(tries / 2)) })
  if (sina.ok) {
    const from = Number(beg)
    return { ...sina, provenance: 'sina-fallback', emError: em.error ?? null, rows: sina.rows.filter((r) => r.date >= from) }
  }
  return { ok: false, source: null, rows: [], provenance: 'none', emError: em.error, sinaError: sina.error }
}

// ── 东财：代码表 / 实时行情 ─────────────────────────────────────────────────

export const ALL_A_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048'
/** 三板/代办股份转让（400xxx 等）。**不是**沪深退市 A 股 —— 后者已在 ALL_A_FS 里 */
export const DELISTED_FS = 'm:0+s:3'

/**
 * 东财 `clist` 的单页上限。
 *
 * **实测**：`pz` 给 150/200/500 都只返回 100 行。这条上限不写下来，
 * 翻页的停止条件就会被它骗过去（见下面的注释）。
 */
export const EM_LIST_MAX_PAGE_SIZE = 100

/** 东财列表（板块成分、全市场、退市板）。自动翻页 */
export async function emList({ fs = ALL_A_FS, fields = 'f12,f13,f14,f2,f3', pageSize = EM_LIST_MAX_PAGE_SIZE, maxPages = 80 } = {}) {
  // 夹到上游真实上限：请求超过它并不会报错，只会**静默**少返回，
  // 而这正好会让"本页不足 pageSize 就是最后一页"的判断永远成立。
  const pz = Math.min(pageSize, EM_LIST_MAX_PAGE_SIZE)
  const out = []
  let total = null
  for (let page = 1; page <= maxPages; page++) {
    const url = `${EM_CLIST}?pn=${page}&pz=${pz}&po=0&np=1&fltt=2&invt=2&fid=f12&fs=${encodeURIComponent(fs)}&fields=${fields}`
    const r = await fetchJson(url, { validate: (j) => Array.isArray(j?.data?.diff) })
    if (!r.ok) break
    total = r.json.data.total ?? total
    const diff = r.json.data.diff ?? []
    out.push(...diff)
    // 停止条件**以 total 为准**，不能只看"本页不足 pageSize"。
    // 后者在 pz 被上游夹取时（历史上默认 200 > 上限 100）每页都成立，
    // 于是永远只拿第一页 —— 实测就是这个 bug 让"全市场"一直是 100 只，
    // 也让 quant_index_constituents 的沪深300 成分只返回 100 只。
    if (diff.length === 0) break
    if (total !== null && out.length >= total) break
  }
  return {
    ok: out.length > 0,
    total,
    rows: out.map((d) => ({
      code: normalizeCode(d.f12),
      name: d.f14 ?? null,
      market: d.f13 ?? null,
      price: d.f2 ?? null,
      pct: d.f3 ?? null,
    })),
  }
}

export async function emQuote(code) {
  const url = `${EM_QUOTE}?secid=${secidOf(code)}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f169,f170,f116,f117`
  const r = await fetchJson(url, { validate: (j) => j?.data != null })
  if (!r.ok) return { ok: false, error: r.error }
  const d = r.json.data
  return {
    ok: true,
    code: normalizeCode(code), name: d.f58, price: d.f43 == null ? null : d.f43 / 100,
    high: d.f44 == null ? null : d.f44 / 100, low: d.f45 == null ? null : d.f45 / 100,
    open: d.f46 == null ? null : d.f46 / 100, volume: d.f47 == null ? null : d.f47 * 100,
    amount: d.f48 ?? null, pct: d.f170 == null ? null : d.f170 / 100,
    change: d.f169 == null ? null : d.f169 / 100,
    marketCap: d.f116 ?? null, floatCap: d.f117 ?? null,
  }
}

// ── 东财数据中心：基本面 / 分红送转 ─────────────────────────────────────────

/** 通用 datacenter 查询，自动翻页 */
export async function emDatacenter(reportName, { filter = '', pageSize = 500, sortColumns = 'SECURITY_CODE', sortTypes = 1, maxPages = 60 } = {}) {
  const out = []
  let pages = null
  for (let page = 1; page <= maxPages; page++) {
    const parts = [`reportName=${reportName}`, 'columns=ALL', `pageNumber=${page}`, `pageSize=${pageSize}`, `sortColumns=${sortColumns}`, `sortTypes=${sortTypes}`]
    if (filter) parts.splice(1, 0, `filter=${encodeURIComponent(filter)}`)
    const r = await fetchJson(`${EM_DC}?${parts.join('&')}`, { validate: (j) => Array.isArray(j?.result?.data) })
    if (!r.ok) break
    pages = r.json.result.pages ?? pages
    const data = r.json.result.data ?? []
    out.push(...data)
    if (page >= (pages ?? 1)) break
  }
  return { ok: out.length > 0, pages, rows: out }
}

const d10 = (v) => (v == null ? null : Number(v) / 10)
const iso = (v) => (v ? String(v).slice(0, 10).replace(/-/g, '') : null)

/** 业绩报表（按报告期一次拿全市场，含 NOTICE_DATE → PIT 对齐锚点） */
export async function emFundamentals(reportDate, { maxPages = 60 } = {}) {
  const filter = `(REPORTDATE='${reportDate}')`
  const r = await emDatacenter('RPT_LICO_FN_CPD', { filter, maxPages, sortColumns: 'SECURITY_CODE' })
  const rows = r.rows.map((x) => ({
    code: normalizeCode(x.SECURITY_CODE),
    reportDate: iso(x.REPORTDATE),
    noticeDate: iso(x.NOTICE_DATE),          // ← PIT 生效时点
    eps: x.BASIC_EPS ?? null,
    bps: x.BPS ?? null,
    roe: x.WEIGHTAVG_ROE ?? null,
    revenueYoy: x.YSTZ ?? null,
    profitYoy: x.SJLTZ ?? null,
    grossMargin: x.XSMLL ?? null,
    revenue: x.TOTAL_OPERATE_INCOME ?? null,
    netProfit: x.PARENT_NETPROFIT ?? null,
    name: x.SECURITY_NAME_ABBR ?? null,
  }))
  return { ok: rows.length > 0, pages: r.pages, rows }
}

/** 分红送转（复权事件的权威来源）。金额/送转比均为「每 10 股」，此处已归一为「每股」 */
export async function emDividends(code, { maxPages = 3 } = {}) {
  const filter = `(SECURITY_CODE="${normalizeCode(code)}")`
  const r = await emDatacenter('RPT_SHAREBONUS_DET', { filter, maxPages, sortColumns: 'EX_DIVIDEND_DATE', sortTypes: -1 })
  const rows = r.rows
    .filter((x) => x.EX_DIVIDEND_DATE)
    .map((x) => ({
      code: normalizeCode(x.SECURITY_CODE),
      exDate: iso(x.EX_DIVIDEND_DATE),
      recordDate: iso(x.EQUITY_RECORD_DATE),
      noticeDate: iso(x.NOTICE_DATE),
      reportDate: iso(x.REPORT_DATE),
      cashPerShare: d10(x.PRETAX_BONUS_RMB),   // 每股税前现金
      bonusPerShare: d10(x.BONUS_RATIO),       // 每股送股
      transferPerShare: d10(x.IT_RATIO),       // 每股转增
      progress: x.ASSIGN_PROGRESS ?? null,
      plan: x.IMPL_PLAN_PROFILE ?? null,
    }))
  return { ok: true, rows }
}

export const SOURCE_NOTES = {
  rawOnlyFrom: 'em',
  emPctCaliber: 'unadjusted',
  adjustedBasis: 'em-fqt2-hfq',
}

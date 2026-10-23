/**
 * 数据同步编排（P1 遗留 + P3 工具面的依赖）。
 *
 * 设计约束（来自 P0/P1 实测）：
 *   - 全市场 5400 只 × 10 年 ≈ 864 万根 bar，一次拉完既不礼貌也不可靠 → **必须分批 + 断点续传**
 *   - 东财 `push2*` 家族在 ~300 次探测后被 IP 封禁 → 单源失败要能降级，且**熔断后不空转**
 *   - 复权用**事件表**（每股票每年 1–2 行）而不是逐日因子，库体积从 1706MB 降到 802MB
 *   - 离线事件表（`data/factor-events.json.gz`）优先于运行时事件：它把"所有源都缺"的日期固化了
 *
 * 断点续传的粒度是**每只股票**：`sync_state` 记录每只股票的进度与状态，
 * 中断后从 `status='pending'|'error'` 的股票继续，已完成的跳过。
 */

import { openStore } from './store.mjs'
import { emList, rawKline, emDividends, emFundamentals, emKline, tencentKline, ALL_A_FS, DELISTED_FS } from './sources.mjs'
import { mergeDividendEvents, resolveEventFactors } from './events.mjs'
import { loadEventTable, applyEventTable } from './eventTable.mjs'
import { normalizeCode, boardOf, shiftYmd, weekdaysBetween, calendarDaysBetween } from './codes.mjs'

/** 默认同步范围：近 10 年 */
export function defaultRange(now = new Date()) {
  const to = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate()
  return { from: (now.getFullYear() - 10) * 10000 + 101, to }
}

/**
 * 估算一次同步的规模，供审批与进度显示。
 * 不发起任何请求（只有已入库的代码表时用本地计数；否则用给定的股票数）。
 */
export function estimateSync(store, { from, to, codes = null, limit = null } = {}) {
  // from/to 缺省时必须补成默认区间再写进返回值：这个对象会被原样序列化成工具输出，
  // 一个 undefined 就会让宿主把整次调用判成 "value is not lossless JSON" 而失败。
  const d = defaultRange()
  const r = { from: from ?? d.from, to: to ?? d.to }
  const known = store.codesList().length
  const n = codes ? codes.length : (limit ?? known ?? 0)
  r.codes = n
  // 每只股票约 243 个交易日/年
  const years = Math.max(0, (Math.floor(r.to / 10000) - Math.floor(r.from / 10000))) || 1
  r.approxBars = n * years * 243
  r.approxRequests = n * 2 + Math.ceil(n / 50) // 每只 1 次 K 线 + 1 次分红，外加代码表分页
  r.approxMinutes = +(r.approxRequests * 0.35 / 60).toFixed(1) // P0 实测约 0.35s/请求
  r.needsApproval = r.codes > 200 || r.approxRequests > 400
  r.reason = r.needsApproval
    ? `规模较大（${r.codes} 只 / 约 ${r.approxRequests} 次请求 / 约 ${r.approxMinutes} 分钟），需要确认`
    : '规模较小，可直接执行'
  return r
}

/**
 * 同步代码表。
 *
 * **覆盖范围**（写清楚，因为"退市股"很容易被误解）：
 *   - 默认 `ALL_A_FS` 覆盖 沪深北 A 股 **含已退市的 A 股**（如 000003 PT金田A）——
 *     退市股并没有单独一个板块，它们仍在原市场段里，只是不再更新行情。
 *   - `includeOtc: true` 再并上 `DELISTED_FS`（三板/代办股份，400xxx）。
 *     那是**另一个市场**，不是沪深退市股，所以默认不取。
 *
 * 原来的签名是 `includeDelisted`，但 `emList` 从来没有这个参数 —— 传进去被静默丢弃，
 * 代码读起来像在控制什么、实际什么都没控制。这种"会撒谎的 API"已改掉。
 */
export async function syncCodes(store, { includeOtc = false, onProgress } = {}) {
  const t0 = Date.now()
  // 所有数据源统一返回 { ok, rows, ... }，不是裸数组
  const r = await emList({ fs: ALL_A_FS })
  if (!r.ok || !r.rows.length) {
    return { ok: false, error: { code: 'EMPTY_LIST', message: '代码表返回为空（多半是被限流或熔断中）' } }
  }
  let rows = r.rows
  let otc = 0
  if (includeOtc) {
    const o = await emList({ fs: DELISTED_FS }).catch(() => ({ ok: false, rows: [] }))
    if (o.rows?.length) { rows = rows.concat(o.rows); otc = o.rows.length }
  }
  // 去重（两个 fs 理论上不重叠，但不要依赖"理论上"）
  const seen = new Set()
  const unique = rows.filter((x) => {
    const c = normalizeCode(x.code)
    if (seen.has(c)) return false
    seen.add(c)
    return true
  })
  store.upsertCodes(unique.map((x) => {
    const code = normalizeCode(x.code)
    const name = x.name ?? null
    return {
      code, name, market: x.market, board: boardOf(code),
      // 东财列表接口不带 ST 标记与上市日，只能从名称推断 ST；上市日留空由后续来源补
      isSt: /^\*?ST|退$/.test(name ?? ''),
      listDate: null, delistDate: null,
    }
  }))
  onProgress?.({ done: unique.length, total: r.total ?? unique.length })
  return { ok: true, codes: unique.length, total: r.total ?? null, otc, ms: Date.now() - t0 }
}

/**
 * 同步一批股票的行情 + 复权事件 + 基本面。
 *
 * @param {object} opts
 *   codes      要同步的代码（null = 库里全部）
 *   from/to    YYYYMMDD
 *   resume     true 时跳过 `sync_state.status='done'` 且已覆盖到 to 的股票
 *   incremental  `{ overlapDays }`：**按股票各自算起点**，而不是所有股票共用一个 from。
 *                日频增量同步的关键——每天新增的只有 1 个交易日，如果 5400 只股票
 *                每天都重拉 10 年，那和全量同步没有任何区别（也就失去了"盘后每天跑一次"的意义）。
 *                起点 = `sync_state.bars_last − overlapDays`，重叠是为了兜住源站迟到的修正。
 *   batchSize  每处理多少只提交一次事务（默认 50）
 *   onProgress({done,total,code,status,error})
 *   signal     {aborted} 形式的中断信号，检查点在每只股票之间
 */
export async function syncBars(store, {
  codes = null, from, to, resume = true, batchSize = 50,
  withFundamentals = false, withDividends = true, onProgress, signal,
  incremental = null,
} = {}) {
  const table = loadEventTable()          // 离线事件表：优先于运行时事件
  const universe = codes ?? store.codesList().map((c) => c.code)
  const total = universe.length
  const t0 = Date.now()
  const stats = { done: 0, skipped: 0, failed: 0, bars: 0, events: 0, errors: [] }
  const pending = []

  for (let i = 0; i < universe.length; i++) {
    if (signal?.aborted) return { ok: false, aborted: true, ...stats, ms: Date.now() - t0 }
    const code = universe[i]
    const st = store.getSyncState(code)
    if (resume && st && st.status === 'ok' && (st.bars_last ?? 0) >= to) { stats.skipped++; continue }

    // 增量：这只股票自己上次同步到哪天，就从那天（往前留一点重叠）开始
    let codeFrom = from
    if (incremental && st?.bars_last) {
      const back = shiftYmd(st.bars_last, -(incremental.overlapDays ?? 10))
      if (back !== null) codeFrom = Math.max(from ?? 0, back)
    }

    try {
      const kr = await rawKline(code, { beg: String(codeFrom), end: String(to) })
      const rows = kr.rows ?? []
      if (!kr.ok && !rows.length) throw new Error(kr.error?.message ?? 'K 线拉取失败')
      if (rows.length) { store.upsertBars(code, rows); stats.bars += rows.length }

      // 后复权收盘用于事件仲裁（只有除权日前后两个点会被用到）
      let hfqRows = []
      const hfqEm = await emKline(code, { fqt: 2, beg: String(codeFrom), end: String(to) }).catch(() => ({ ok: false, rows: [] }))
      if (hfqEm.ok && hfqEm.rows.length) hfqRows = hfqEm.rows
      else {
        const hfqTx = await tencentKline(code, { period: 'hfq' }).catch(() => ({ ok: false, rows: [] }))
        if (hfqTx.ok && hfqTx.rows?.length) hfqRows = hfqTx.rows
      }
      if (hfqRows.length) store.upsertHfq(code, hfqRows)

      // ── 复权事件流水线（顺序不能变，来自 spike/verify-data.mjs 的验证路径）──
      //   ① 合并多源（东财分红 + 腾讯事件元数据）
      //   ② 离线表优先：它固化了"所有源都缺"的修正（见 DATA-SOURCES.md）
      //   ③ 仲裁：多源对同一次分配给出不同数值时，用**后复权序列的隐含跳变**选一个
      let events = []
      if (withDividends) {
        const dr = await emDividends(code).catch(() => ({ ok: false, rows: [] }))
        const tx = await tencentKline(code, { period: 'hfq' }).catch(() => ({ events: [] }))
        const merged = mergeDividendEvents({ tencentEvents: tx.events ?? [], emEvents: dr.rows ?? [] })
        events = merged.events ?? []
      }
      if (events.length || table?.byCode?.get(code)?.size) {
        const applied = applyEventTable(events, table, code)
        const withFactors = resolveEventFactors(applied.events, rows, hfqRows)
        // 没有因子的多半是"除权日之前没有可用前收盘"（区间起点附近）→ 这些事件会被丢弃，
        // 不是"无法仲裁"。命名要说准，否则排障时会被误导。
        const dropped = withFactors.filter((e) => !e.factor).length
        if (dropped) stats.droppedNoPrevBar = (stats.droppedNoPrevBar ?? 0) + dropped
        if (withFactors.length) { store.upsertAdjEvents(code, withFactors); stats.events += withFactors.length }
        stats.overridden = (stats.overridden ?? 0) + applied.overridden
        stats.fromTable = (stats.fromTable ?? 0) + applied.fromTable
      }
      if (withFundamentals) {
        const fr = await emFundamentals(code).catch(() => ({ ok: false, rows: [] }))
        if (fr.rows?.length) store.upsertFundamentals(fr.rows)
      }

      // status 词表由 store 定义：'ok' | 'pending' | 'error'（attempts 由 store 自己维护）
      store.setSyncState(code, { barsLast: rows.at(-1)?.date ?? null, adjLast: events.at(-1)?.date ?? null, status: 'ok' })
      stats.done++
      pending.push(code)
    } catch (e) {
      stats.failed++
      stats.errors.push({ code, message: e?.message ?? String(e) })
      store.setSyncState(code, { status: 'error', error: e?.message ?? String(e) })
    }
    onProgress?.({ done: i + 1, total, code, status: stats.errors.at(-1)?.code === code ? 'error' : 'done' })
    // 每 batchSize 只让出一次事件循环，避免长时间阻塞且给中断留出机会
    if (pending.length >= batchSize) { pending.length = 0; await new Promise((r) => setImmediate(r)) }
  }

  return { ok: stats.failed === 0, ...stats, ms: Date.now() - t0 }
}

/**
 * 同步状态总览：覆盖率、新鲜度、待续传、自动同步。
 *
 * **新鲜度用工作日而不是自然日**：A 股周末不交易，自然日口径会让每个周一早上
 * 都报"过期 3 天"，那是噪声不是信号。两者都返回，`stale` 用工作日判定。
 * 已知近似：不识别节假日（不维护交易所日历），长假仍会算成若干工作日。
 */
export function syncStatus(store, { staleDays = 5, now = Date.now() } = {}) {
  const s = store.stats()
  const states = store.raw.prepare(`SELECT status, count(*) c FROM sync_state GROUP BY status`).all()
  const byStatus = Object.fromEntries(states.map((x) => [x.status, x.c]))
  const lastDate = s.barsRange?.b ?? null
  const today = ymdOf(now)
  const cal = lastDate ? calendarDaysBetween(today, lastDate) : null
  const wd = lastDate ? weekdaysBetween(today, lastDate) : null
  // 没有数据时"过期"没有意义（是"未就绪"），保持与旧行为一致：视为过期以促使同步
  const stale = lastDate ? (wd === null || wd > staleDays) : true
  const pending = store.raw.prepare(`SELECT code FROM sync_state WHERE status IN ('pending','error') ORDER BY code`).all().map((x) => x.code)
  const uncovered = Math.max(0, s.codes - (byStatus.ok ?? 0))
  return {
    codes: s.codes, bars: s.bars, adjEvents: s.adjEvents, fundamentals: s.fundamentals,
    range: [s.barsRange?.a ?? null, lastDate],
    byStatus, uncovered, pending: pending.slice(0, 50), pendingCount: pending.length,
    stale, staleDays, lastDate,
    freshness: {
      today, lastDate,
      calendarDays: cal, weekdays: wd,
      stale, staleDays, basis: 'weekdays',
      note: '工作日口径（跳过周末，不识别节假日）；未同步到今日不代表异常，先看 autoSync 上次结果',
    },
    autoSync: autoSyncSummary(store),
    ready: s.bars > 0 && s.codes > 0,
  }
}

/** 自动同步状态摘要（供 quant_data_status 与卡片使用；未配置时返回 {enabled:false}） */
export function autoSyncSummary(store) {
  const st = store.getMeta?.('autosync')
  if (!st) return { enabled: false, configured: false }
  return {
    enabled: !!st.enabled, configured: true,
    at: st.atHour === null || st.atHour === undefined ? null : `${String(st.atHour).padStart(2, '0')}:${String(st.atMinute ?? 0).padStart(2, '0')}`,
    scope: st.codes ? `${st.codes.length} 只（指定）` : '已同步的全部',
    maxCodes: st.maxCodes,
    nextDueAt: st.nextDueAt ?? null,
    lastSuccessDate: st.lastSuccessDate ?? null,
    lastAttemptDate: st.lastAttemptDate ?? null,
    lastOutcome: st.lastOutcome ?? null,
    lastError: st.lastError ?? null,
    lastRunAt: st.lastRunAt ?? null,
    consentAt: st.consentAt ?? null,
  }
}

/** 本地时区的 YYYYMMDD */
export function ymdOf(ms = Date.now()) {
  const d = new Date(ms)
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
}

export { openStore }

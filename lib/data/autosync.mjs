/**
 * 盘后定时增量同步。
 *
 * ## 它解决什么问题
 *
 * 没有它的时候，"数据新鲜"靠用户记得说一句"先同步一下"。有了它，收盘后本地数据
 * 自己补到今天，`stale` 变成罕见情况而不是常态。
 *
 * ## 四个必须做对的地方（每一个都是这里的一条设计约束）
 *
 * 1. **增量，而不是每天重拉全市场。**
 *    每天真正新增的只有 1 个交易日。所以起点必须**按股票各自算**
 *    （`sync_state.bars_last − overlapDays`），而不是所有股票共用一个 10 年区间——
 *    后者和全量同步没有区别，也就没有"每天跑一次"的资格。
 *
 * 2. **重启后要能补跑。** `setTimeout` 活不过进程重启，所以"下次该什么时候跑"
 *    必须**落库**（`meta.autosync.nextDueAt`）。启动时读出来：
 *    如果它已经是过去时刻，说明这次被错过了 → 立刻补跑。
 *    这就是 P5 的门："定时任务在 DSH 重启后能正确恢复"。
 *
 * 3. **跑了 ≠ 成功了。** 任务执行完不代表数据更新了（源站可能还没出当天数据）。
 *    所以先**探测**再铺开：只探 3 只最活跃的股票，都没出新高就判定 `noNewData`，
 *    一次请求都不用铺开；铺开之后再校验库里的最大日期**确实前进了**，否则记 `staleSource`。
 *    两种情况都只重试一次，然后等下一个周期——不无限重试。
 *
 * 4. **授权发生在配置时，而不是运行时。** 自动任务没法弹窗问人。
 *    所以"开启"这个动作本身就是同意（记录 `consentAt` / `consentBy`），
 *    之后每次运行不再问；但运行时仍有**硬上限**（`maxCodes`），超了就跳过并记下来，
 *    而不是硬跑。
 *
 * ## 已知边界（不是疏漏，是声明）
 *
 * - DSH 在那个时刻必须**正在运行**。关机/休眠不会跑，只能靠下次启动补。
 * - 只跳过周末，**不识别节假日**（不维护交易所日历）。长假期间会空跑，代价已被探测压到 3 次请求。
 * - 非交易日拿到 0 根新 bar **不是错误**，记为 `noNewData`。
 */

import { rawKline } from './sources.mjs'
import { syncBars, defaultRange, ymdOf } from './sync.mjs'
import { shiftYmd } from './codes.mjs'

export const META_KEY = 'autosync'

/** Node 定时器能表示的最大延迟（2^31−1 ms） */
export const MAX_TIMER_DELAY = 2147483647

/** 默认配置。`enabled: false` —— 自动同步**默认关闭**，必须显式开启 */
export const DEFAULT_AUTO_SYNC = Object.freeze({
  enabled: false,
  atHour: 18,
  atMinute: 30,
  codes: null,            // null = 库里已同步的全部
  maxCodes: 3000,         // 单次运行的硬上限
  retryDelayMin: 60,      // 没拿到新数据/失败后的重试间隔
  maxRetriesPerDay: 1,
  overlapDays: 10,        // 增量起点往前留的重叠（兜住源站迟到的修正）
  probeCount: 3,          // 探测几只股票来判断"今天有没有新数据"
})

// ── 纯函数：时间 ────────────────────────────────────────────────────────────

/** 本地时区 `now` 当天的 hh:mm 对应的毫秒时刻 */
export function slotAt(now, hour, minute) {
  const d = new Date(now)
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

/**
 * `now` 之后**严格未来**的下一个执行时刻，跳过周六周日。
 *
 * 跳周末是廉价的确定性收益（一次判断省掉一次全市场空跑）；
 * 节假日识别不了，因为那需要一张交易所日历，本插件不维护。
 */
export function nextSlotAfter(now, hour, minute) {
  const d = new Date(slotAt(now, hour, minute))
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  d.setHours(hour, minute, 0, 0)
  // 循环而不是只判一次：**今天本身就是周末时也要跳过去**。
  // 只判"推进一天之后是不是周末"会漏掉这种情况——周六早上开启自动同步，
  // 就会排到周六 18:30 空跑一次（这是单测抓出来的真实缺陷）。
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1)
    d.setHours(hour, minute, 0, 0)
  }
  return d.getTime()
}

/** 是不是周末（本地时区） */
export function isWeekendLocal(now) {
  const dow = new Date(now).getDay()
  return dow === 0 || dow === 6
}

// ── 纯函数：配置规范化 ──────────────────────────────────────────────────────

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, Math.trunc(n)))
}

/** 把任意来源（cordis 配置 / 落库状态 / 工具参数）的配置规范化，永不抛错 */
export function normalizeAutoSync(raw = {}) {
  const r = raw ?? {}
  return {
    enabled: r.enabled === true,
    atHour: clampInt(r.atHour, 0, 23, DEFAULT_AUTO_SYNC.atHour),
    atMinute: clampInt(r.atMinute, 0, 59, DEFAULT_AUTO_SYNC.atMinute),
    codes: Array.isArray(r.codes) && r.codes.length ? [...new Set(r.codes.map((c) => String(c).trim()).filter(Boolean))] : null,
    maxCodes: clampInt(r.maxCodes, 1, 100000, DEFAULT_AUTO_SYNC.maxCodes),
    retryDelayMin: clampInt(r.retryDelayMin, 5, 24 * 60, DEFAULT_AUTO_SYNC.retryDelayMin),
    maxRetriesPerDay: clampInt(r.maxRetriesPerDay, 0, 10, DEFAULT_AUTO_SYNC.maxRetriesPerDay),
    overlapDays: clampInt(r.overlapDays, 0, 120, DEFAULT_AUTO_SYNC.overlapDays),
    probeCount: clampInt(r.probeCount, 1, 20, DEFAULT_AUTO_SYNC.probeCount),
  }
}

/** 把 `HH:MM` 解析成 {hour, minute}；解析不了返回 null */
export function parseClock(text) {
  const m = /^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*$/.exec(String(text ?? ''))
  if (!m) return null
  const hour = Number(m[1]), minute = Number(m[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

// ── 状态读写 ────────────────────────────────────────────────────────────────

/** 运行态的默认值（与配置分开：配置是用户的意图，运行态是事实） */
const DEFAULT_RUNTIME = Object.freeze({
  nextDueAt: null,
  lastAttemptAt: null, lastAttemptDate: null,
  lastSuccessAt: null, lastSuccessDate: null,
  lastRunAt: null, lastOutcome: null, lastError: null,
  lastBars: null, lastCodes: null, lastMs: null,
  retryCount: 0, retryDate: null,
  runCount: 0, skipReason: null,
  consentAt: null, consentBy: null, consentScope: null,
})

/** 读出（并规范化）当前状态；未配置过时返回默认值 + enabled:false */
export function readState(store) {
  const raw = store.getMeta?.(META_KEY) ?? {}
  const cfg = normalizeAutoSync({ ...DEFAULT_AUTO_SYNC, ...raw })
  const rt = { ...DEFAULT_RUNTIME }
  for (const k of Object.keys(DEFAULT_RUNTIME)) if (raw[k] !== undefined) rt[k] = raw[k]
  return { ...cfg, ...rt }
}

/** 写回状态（整体覆盖，调用方负责先 readState 合并） */
export function writeState(store, state) {
  return store.setMeta(META_KEY, state)
}

/**
 * 判断现在该不该跑。
 *
 * 判定完全基于落库的 `nextDueAt`，因此**重启后的补跑是自然结果**而不是特例：
 * 被错过的那次会让 `nextDueAt` 停留在过去，`due` 就为真。
 */
export function evaluateDue(state, now = Date.now()) {
  if (!state.enabled) return { due: false, reason: 'disabled', nextDueAt: null }
  const slot = slotAt(now, state.atHour, state.atMinute)
  const nextDueAt = state.nextDueAt ?? (now >= slot ? now : slot)
  if (now >= nextDueAt) {
    const missed = nextDueAt < slotAt(now, 0, 0)          // 应跑时刻早于今天 0 点 → 是补跑
    return { due: true, reason: missed ? 'catch-up' : 'scheduled', nextDueAt }
  }
  return { due: false, reason: 'waiting', nextDueAt }
}

/**
 * 本次运行之后，下次该在什么时候跑。
 *
 * 只有"可能下次就好了"的结果才安排重试；`noCodes` / `exceededCap` 重试也没用，
 * 直接等下一个周期。这样不会出现"每 60 分钟空转一次"。
 */
export function planNextDue(state, now, outcome) {
  if (!state.enabled) return null
  const today = ymdOf(now)
  const retriesUsed = state.retryDate === today ? (state.retryCount ?? 0) : 0
  const retriesLeft = retriesUsed < (state.maxRetriesPerDay ?? 0)
  const retryable = outcome === 'noNewData' || outcome === 'staleSource' || outcome === 'error' || outcome === 'aborted'
  if (retryable && retriesLeft) return now + state.retryDelayMin * 60000
  return nextSlotAfter(now, state.atHour, state.atMinute)
}

// ── 运行 ────────────────────────────────────────────────────────────────────

/** 该次运行要覆盖的股票：已授权的范围 ∩ 库里真实存在的代码 */
export function resolveScope(store, state) {
  const all = store.codesList().map((c) => c.code)
  if (!state.codes) return all
  const have = new Set(all)
  return state.codes.filter((c) => have.has(c))
}

/**
 * 探测"市场今天出数据了吗"。
 *
 * 取 `bars_last` 最新的几只（它们最可能是活跃且已更新的），只看有没有**比本地更新**的 bar。
 * 这一步把非交易日/源站延迟的全市场空跑（5400 次请求）压到 `probeCount` 次。
 *
 * @returns {{ advanced: boolean, checked: number, latest: number|null, samples: object[] }}
 */
export async function probeNewData(store, scope, { to, probeCount = 3 } = {}) {
  const states = scope
    .map((code) => ({ code, last: store.getSyncState(code)?.bars_last ?? 0 }))
    .sort((a, b) => b.last - a.last)
    .slice(0, probeCount)

  let latest = null
  const samples = []
  let ok = 0
  for (const { code, last } of states) {
    const beg = last ? shiftYmd(last, -5) : null
    const r = await rawKline(code, { beg: String(beg ?? to), end: String(to) }).catch(() => ({ ok: false, rows: [] }))
    const rows = r.rows ?? []
    if (r.ok) ok++
    const maxDate = rows.length ? rows[rows.length - 1].date : null
    if (maxDate !== null && (latest === null || maxDate > latest)) latest = maxDate
    samples.push({ code, last, maxDate })
  }
  // 只要有一只出了比本地更新的 bar，就认为市场有数据
  const advanced = samples.some((s) => s.maxDate !== null && s.maxDate > (s.last ?? 0))
  return { advanced, checked: states.length, succeeded: ok, latest, samples }
}

/**
 * 跑一次自动同步（不做定时，只做这一次）。
 *
 * 调用方负责把结果写回状态；这里只返回事实。
 *
 * @returns {Promise<object>} `{ outcome, ... }`
 *   outcome ∈ ok | noNewData | staleSource | noCodes | exceededCap | error | aborted | disabled
 */
export async function runAutoSync(runtime, state, { now = Date.now(), signal, probe = probeNewData, sync = syncBars } = {}) {
  if (!state.enabled) return { outcome: 'disabled', message: '自动同步未开启' }
  const store = runtime.store()
  const t0 = Date.now()

  const scope = resolveScope(store, state)
  if (!scope.length) {
    return { outcome: 'noCodes', scope: 0, ms: Date.now() - t0, message: '库里没有已同步的股票（先用 quant_data_sync 同步一次）' }
  }
  if (scope.length > state.maxCodes) {
    return {
      outcome: 'exceededCap', scope: scope.length, ms: Date.now() - t0,
      message: `待同步 ${scope.length} 只超过硬上限 ${state.maxCodes} 只；本次跳过（自动任务不弹窗，超限只能跳过并记录）`,
    }
  }

  const range = defaultRange(new Date(now))
  const to = ymdOf(now)
  const beforeMax = store.stats().barsRange?.b ?? null

  // ① 先探测，再铺开
  let p = null
  try { p = await probe(store, scope, { to, probeCount: state.probeCount }) } catch { /* 探测失败不致命，退化为直接铺开 */ }
  if (p && !p.advanced) {
    return {
      outcome: 'noNewData', scope: scope.length, probe: p, beforeMax, maxDate: beforeMax,
      ms: Date.now() - t0,
      message: `探测 ${p.checked} 只均无更新（最新 ${p.latest ?? '无'}），判定今日无新数据（非交易日或源站未出）`,
    }
  }

  // ② 增量铺开
  let r
  try {
    r = await sync(store, {
      codes: scope, from: range.from, to, resume: true,
      incremental: { overlapDays: state.overlapDays },
      withDividends: true, signal,
    })
  } catch (e) {
    return { outcome: 'error', scope: scope.length, probe: p, beforeMax, ms: Date.now() - t0, error: e?.message ?? String(e) }
  }
  if (r.aborted) return { outcome: 'aborted', scope: scope.length, probe: p, beforeMax, ms: Date.now() - t0, ...pick(r) }

  // ③ 校验库里最大日期**确实前进了** —— "跑了"不等于"成功了"
  const afterMax = store.stats().barsRange?.b ?? null
  const advanced = afterMax !== null && (beforeMax === null || afterMax > beforeMax)
  return {
    outcome: advanced ? 'ok' : 'staleSource',
    scope: scope.length, probe: p, beforeMax, maxDate: afterMax, advanced,
    ms: Date.now() - t0, ...pick(r),
    message: advanced ? undefined : `同步已执行但库内最新仍为 ${afterMax}（探测说有新数据），可能源站数据不完整`,
  }
}

const pick = (r) => ({
  done: r.done, skipped: r.skipped, failed: r.failed, bars: r.bars, events: r.events,
  errors: (r.errors ?? []).slice(0, 5),
})

// ── 把一次运行的结果并回状态 ────────────────────────────────────────────────

/** 纯函数：把运行结果折进状态，返回**新的**状态对象（便于单测） */
export function applyResult(state, result, now = Date.now()) {
  const today = ymdOf(now)
  const retryable = RETRYABLE.has(result.outcome)
  // 关键顺序：**先用"本次之前的重试次数"决定要不要排重试，再累加**。
  // 反过来写会让第一次失败就把额度用光（因为它把自己也算成了一次重试），
  // maxRetriesPerDay=1 会退化成"一次都不重试"。这是单测抓出来的。
  const prevRetries = state.retryDate === today ? (state.retryCount ?? 0) : 0

  const next = { ...state }
  next.lastAttemptAt = now
  next.lastAttemptDate = today
  next.lastRunAt = now
  next.runCount = (state.runCount ?? 0) + 1
  next.lastOutcome = result.outcome
  next.lastError = result.error ?? null
  next.lastBars = result.bars ?? null
  next.lastCodes = result.scope ?? null
  next.lastMs = result.ms ?? null
  next.skipReason = result.outcome === 'exceededCap' || result.outcome === 'noCodes' ? result.message ?? null : null
  next.retryDate = today
  // 只有"重试可能有用"的结果才消耗重试额度：否则一次 noCodes 会把当天真正的失败额度吃掉
  next.retryCount = retryable ? prevRetries + 1 : 0
  if (result.outcome === 'ok') {
    next.lastSuccessAt = now
    next.lastSuccessDate = today
  }
  next.nextDueAt = planNextDue({ ...next, retryCount: prevRetries }, now, result.outcome)
  return next
}

/** 重试有可能改变结果的那些结局 */
const RETRYABLE = new Set(['noNewData', 'staleSource', 'error', 'aborted'])

// ── 控制器（定时 + 手动，共用一把锁） ───────────────────────────────────────

/**
 * 建立自动同步控制器。
 *
 * **不会**在 `apply` 时同步跑网络请求：补跑也走定时器（延迟 0），
 * 否则 DSH 启动会被一次全市场同步卡住。
 *
 * 定时器不可用时（headless profile 的 `patchReload: startup` 不会自动挂 `timer`）
 * 返回 `timer: false` 但**仍然可用**：`quant_autosync {action:"run_now"}` 与
 * 状态读写都照常工作。这是刻意的降级，不是失败。
 */
export function createAutoSync(ctx, runtime, config = {}, deps = {}) {
  const report = { ok: true, enabled: false, timer: false, reason: null, nextDueAt: null }
  // **每次 arm 时重新解析**，而不是装载时抓一次：装载时仓库可能还不存在
  // （那时走的是 `no-store` 的早退分支，控制器是"无 timer"的），用户之后同步了数据、
  // 再开启自动同步——如果 timer 是装载时抓死的，定时就永远不会触发，用户只会看到
  // "我明明开了它却从来不动"。惰性解析把这个洞堵上。
  const getTimer = () => {
    const t = ctx.get?.('timer')
    return t && typeof t.timeout === 'function' ? t : null
  }
  report.timer = getTimer() !== null
  const run = deps.runAutoSync ?? runAutoSync

  // 部署层强制关闭：config.autoSync === false
  const deployment = config?.autoSync
  const forcedOff = deployment === false

  // **惰性**：仓库不存在且部署层也没要求开启 → 什么都不做，绝不因此建库
  if (!runtime.exists() && !(deployment && deployment.enabled)) {
    report.reason = 'no-store'
    const controller = makeController(runtime, getTimer, run)
    runtime.autoSync = controller
    return { ...report, controller }
  }

  const store = runtime.store()

  // 部署层首次开启 → 把配置固化进库（含授权记录）
  if (deployment && typeof deployment === 'object' && deployment.enabled && !store.getMeta(META_KEY)) {
    const s = { ...readState(store), ...normalizeAutoSync({ ...DEFAULT_AUTO_SYNC, ...deployment }), enabled: true, consentAt: Date.now(), consentBy: 'deployment:config' }
    s.nextDueAt = nextSlotAfter(Date.now(), s.atHour, s.atMinute)
    writeState(store, s)
  }

  const controller = makeController(runtime, getTimer, run)
  runtime.autoSync = controller        // 工具通过它拿控制器（手动路径在无 timer 时也照常可用）

  if (forcedOff) {
    const st = readState(store)
    if (st.enabled) { st.enabled = false; st.nextDueAt = null; writeState(store, st) }
    report.enabled = false
    report.reason = 'disabled-by-config'
    return { ...report, controller }
  }

  const initial = readState(store)
  report.enabled = initial.enabled
  report.nextDueAt = initial.nextDueAt

  if (!initial.enabled) { report.reason = 'not-enabled'; return { ...report, controller } }
  if (!report.timer) { report.reason = 'timer-unavailable'; return { ...report, controller } }

  // 补跑：`nextDueAt` 已经是过去时刻 → 立刻跑一次（延迟 0，不阻塞启动）
  const due = evaluateDue(initial, Date.now())
  controller.reschedule(due.due ? Date.now() : due.nextDueAt)
  report.reason = due.due ? 'catch-up' : 'armed'
  report.nextDueAt = due.nextDueAt
  return { ...report, controller }
}

function makeController(runtime, getTimer, run = runAutoSync) {
  let disposer = null
  let running = false
  let active = false       // 软停：不排下一次，但可被 reschedule 唤醒（用户重新开启）
  let disposed = false     // 硬停：插件卸载，不再接受任何唤醒

  const clear = () => { if (disposer) { try { disposer() } catch { /* 已触发 */ } disposer = null } }

  const arm = (atMs) => {
    clear()
    if (disposed || !active || atMs === null || atMs === undefined) return
    const timer = getTimer()
    if (!timer) return
    const delay = Math.max(0, Math.min(atMs - Date.now(), MAX_TIMER_DELAY))
    // 回调**返回** tick 的 promise：真实定时器会忽略返回值，但测试里就能 `await job.cb()`
    // 确定性地等到这次 tick 收尾（否则断言会和异步排程赛跑）。catch 只兜未处理拒绝。
    disposer = timer.timeout(() => tick().catch(() => { /* tick 内部已兜底 */ }), delay)
  }

  /** 跑一次并把结果写回状态；返回结果 */
  const runNow = async ({ reason = 'manual', signal } = {}) => {
    if (running) return { outcome: 'busy', message: '上一次自动同步还在运行' }
    running = true
    const now = Date.now()
    try {
      const store = runtime.store()
      let st = readState(store)
      if (!st.enabled && reason === 'manual') {
        // 手动补跑：即使没开启也允许跑一次（用的是同一条增量路径与硬上限）
        st = { ...st, enabled: true }
      }
      const result = await run(runtime, st, { now, signal })
      // 写回时**保留用户真实的开启状态**：手动补跑不应把"未开启"变成"已开启"
      const saved = applyResult({ ...st, enabled: readState(store).enabled }, result, Date.now())
      writeState(store, saved)
      return { ...result, nextDueAt: saved.nextDueAt, trigger: reason }
    } catch (e) {
      const store = runtime.store()
      const st = readState(store)
      const result = { outcome: 'error', error: e?.message ?? String(e) }
      const saved = applyResult(st, result, Date.now())
      try { writeState(store, saved) } catch { /* 连状态都写不进去时不再抛 */ }
      return { ...result, nextDueAt: saved.nextDueAt, trigger: reason }
    } finally {
      running = false
    }
  }

  const tick = async () => {
    if (disposed || !active) return
    const store = runtime.store()
    const st = readState(store)
    const due = evaluateDue(st, Date.now())
    if (!due.due) { arm(due.nextDueAt); return }
    const result = await runNow({ reason: due.reason })
    if (disposed || !active) return
    // 跑完再确认一次"还开着吗"：用户可能在这次运行期间关掉了自动同步
    // （那时 nextDueAt 已被写成 null，若还按 fallback 排下一次就等于关不掉）
    if (!readState(store).enabled) { active = false; clear(); return }
    arm(result.nextDueAt ?? nextSlotAfter(Date.now(), st.atHour, st.atMinute))
  }

  return {
    arm, tick, runNow,
    /** 每次读取都重新解析：timer 服务可能在装载之后才出现 */
    get hasTimer() { return getTimer() !== null },
    get running() { return running },
    get active() { return active },
    /** 软停：取消已排的执行，但状态与配置保留（用户关闭自动同步时用） */
    stop() { active = false; clear() },
    /** 重新排程（用户开启/改时刻时用）；`atMs` 省略则按落库状态决定 */
    reschedule(atMs = undefined) {
      if (disposed) return
      active = true
      if (atMs === undefined) {
        const st = readState(runtime.store())
        const due = evaluateDue(st, Date.now())
        atMs = due.due ? Date.now() : due.nextDueAt
      }
      arm(atMs)
    },
    /** 硬停：插件卸载 */
    dispose() { disposed = true; active = false; clear() },
    state: () => readState(runtime.store()),
  }
}

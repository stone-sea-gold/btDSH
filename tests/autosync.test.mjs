/**
 * P5 自动同步单测。
 *
 * 这个文件里最重要的一条是 **「定时任务在 DSH 重启后能正确恢复」**（P5 的门）。
 *
 * 它为什么值得单独一条：`setTimeout` 活不过进程重启，所以"重启后恢复"不可能靠
 * 定时器本身实现。唯一可靠的做法是把"下次该什么时候跑"落库，启动时读出来判断
 * 是否已经是过去时刻。测试就是模拟这件事——先写入一个**昨天的** nextDueAt
 * （等价于"进程在应跑时刻之前就退出了"），再走一遍启动路径，看它是否立刻排程。
 *
 * 运行: node --test tests/*.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRuntime } from '../lib/runtime.mjs'
import {
  META_KEY, DEFAULT_AUTO_SYNC, normalizeAutoSync, parseClock, slotAt, nextSlotAfter,
  isWeekendLocal, readState, writeState, evaluateDue, planNextDue, applyResult,
  resolveScope, probeNewData, runAutoSync, createAutoSync,
} from '../lib/data/autosync.mjs'
import { ymdOf, syncStatus } from '../lib/data/sync.mjs'
import { dayOrdinal, shiftYmd, weekdaysBetween, ordinalToYmd, isWeekend } from '../lib/data/codes.mjs'

// ── 脚手架 ──────────────────────────────────────────────────────────────────

function makeRuntime(prefix = 'dsh-quant-autosync-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const runtime = createRuntime({ dataDir: dir })
  return { runtime, dir, cleanup: () => { runtime.close(); rmSync(dir, { recursive: true, force: true }) } }
}

/** 假定时器：只记录排程，不真的等 */
function fakeTimer() {
  const jobs = []
  return {
    jobs,
    timeout(cb, ms) {
      const job = { cb, ms, cancelled: false }
      jobs.push(job)
      return () => { job.cancelled = true }
    },
    interval() { throw new Error('不该用到 interval') },
  }
}

const ctxWith = (timer) => ({ get: (n) => (n === 'timer' ? timer : undefined) })

/** 造 n 只已同步的股票，让 scope 非空 */
function seedCodes(store, n, { barsLast = 20260918 } = {}) {
  const rows = []
  for (let i = 0; i < n; i++) rows.push({ code: String(600000 + i), name: `S${i}`, market: 1, board: 'sh_main' })
  store.upsertCodes(rows)
  for (const r of rows) store.setSyncState(r.code, { barsLast, status: 'ok' })
  return rows.map((r) => r.code)
}

// ── 纯函数：时间 ────────────────────────────────────────────────────────────

test('自动同步：时刻解析与 slot 计算', () => {
  assert.deepEqual(parseClock('18:30'), { hour: 18, minute: 30 })
  assert.deepEqual(parseClock(' 9:05 '), { hour: 9, minute: 5 })
  assert.deepEqual(parseClock('09：05'), { hour: 9, minute: 5 }, '全角冒号也要认')
  assert.equal(parseClock('24:00'), null)
  assert.equal(parseClock('18:60'), null)
  assert.equal(parseClock('下午六点'), null)
  assert.equal(parseClock(null), null)

  const t = new Date(2026, 8, 23, 12, 0, 0).getTime()   // 2026-09-23 周三 12:00 本地
  assert.equal(slotAt(t, 18, 30), new Date(2026, 8, 23, 18, 30, 0).getTime())
  assert.equal(nextSlotAfter(t, 18, 30), new Date(2026, 8, 23, 18, 30, 0).getTime(), '当天还没到 → 就是当天')
  assert.equal(nextSlotAfter(t, 9, 0), new Date(2026, 8, 24, 9, 0, 0).getTime(), '当天已过 → 次日')
})

test('自动同步：下一个执行时刻跳过周末（周五晚 → 下周一）', () => {
  // 2026-09-25 是周五
  const fri = new Date(2026, 8, 25, 20, 0, 0).getTime()
  const next = nextSlotAfter(fri, 18, 30)
  const d = new Date(next)
  assert.equal(d.getDay(), 1, `应当排到周一，实际 ${d.getDay()}`)
  assert.equal(d.getDate(), 28)
  assert.equal(d.getHours(), 18)
  assert.equal(d.getMinutes(), 30)
  // 周六
  const sat = new Date(2026, 8, 26, 10, 0, 0).getTime()
  assert.equal(isWeekendLocal(sat), true)
  assert.equal(new Date(nextSlotAfter(sat, 18, 30)).getDay(), 1, '周六 → 周一')
})

// ── 纯函数：日期口径 ────────────────────────────────────────────────────────

test('日期工具：ordinal 往返、shiftYmd、工作日差、周末判定', () => {
  assert.equal(ordinalToYmd(dayOrdinal(20260923)), 20260923)
  assert.equal(shiftYmd(20260923, -10), 20260913)
  assert.equal(shiftYmd(20260901, -1), 20260831, '跨月')
  assert.equal(shiftYmd(20260101, -1), 20251231, '跨年')
  assert.equal(shiftYmd('bad', 1), null)

  // 2026-09-21 周一 → 2026-09-25 周五 = 4 个工作日，5 个自然日
  assert.equal(weekdaysBetween(20260925, 20260921), 4)
  assert.equal(weekdaysBetween(20260921, 20260925), -4, '方向要带符号')
  assert.equal(weekdaysBetween(20260926, 20260926), 0)
  // 周五 → 下周一 = 1 个工作日，3 个自然日。这正是"周末不该报过期"的根据
  assert.equal(weekdaysBetween(20260928, 20260925), 1)
  assert.equal(weekdaysBetween(20260928, 20260925) === 1, true)
  assert.equal(isWeekend(20260926), true)
  assert.equal(isWeekend(20260925), false)
  assert.equal(isWeekend(20260928), false)
})

test('新鲜度按工作日算：周一早上不会因为跨了周末而报"过期 3 天"', () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  // 2026-09-25 周五的数据，站在 2026-09-28 周一 09:00 看
  const monday = new Date(2026, 8, 28, 9, 0, 0).getTime()
  const rows = seedCodes(store, 1, { barsLast: 20260925 })
  store.upsertBars(rows[0], [{ date: 20260925, open: 10, high: 11, low: 9, close: 10.5, volume: 100, amount: 1000, pct: 0, turnover: 0 }])

  const s = syncStatus(store, { now: monday })
  assert.equal(s.lastDate, 20260925)
  assert.equal(s.freshness.calendarDays, 3, '自然日是 3 天')
  assert.equal(s.freshness.weekdays, 1, '工作日只有 1 天')
  assert.equal(s.stale, false, '阈值 5 个工作日 → 不该报过期')
  assert.equal(s.freshness.basis, 'weekdays')
  cleanup()
})

// ── 配置规范化 ──────────────────────────────────────────────────────────────

test('自动同步：配置规范化永不抛错，且把越界值夹回合法区间', () => {
  const d = normalizeAutoSync({})
  assert.equal(d.enabled, false, '默认必须是关闭')
  assert.equal(d.atHour, 18)
  assert.equal(d.atMinute, 30)
  assert.equal(d.codes, null)
  assert.equal(d.maxCodes, 3000)

  assert.equal(normalizeAutoSync({ enabled: 'yes' }).enabled, false, '只认真正的 true')
  assert.equal(normalizeAutoSync({ enabled: true }).enabled, true)
  assert.equal(normalizeAutoSync({ atHour: 99 }).atHour, 23, '夹回上限')
  assert.equal(normalizeAutoSync({ atHour: -5 }).atHour, 0)
  assert.equal(normalizeAutoSync({ atHour: 'x' }).atHour, 18, '非数字用默认')
  assert.equal(normalizeAutoSync({ atHour: 18.9 }).atHour, 18, '取整')
  assert.equal(normalizeAutoSync({ maxCodes: 0 }).maxCodes, 1)
  assert.equal(normalizeAutoSync({ maxCodes: 1e9 }).maxCodes, 100000)
  assert.equal(normalizeAutoSync({ retryDelayMin: 0 }).retryDelayMin, 5)
  assert.deepEqual(normalizeAutoSync({ codes: ['600519', '600519', ' 000001 '] }).codes, ['600519', '000001'], '去重去空白')
  assert.equal(normalizeAutoSync({ codes: [] }).codes, null, '空数组等于不指定')
  assert.equal(normalizeAutoSync(null).atHour, 18)
  assert.equal(normalizeAutoSync(undefined).maxCodes, 3000)
})

// ── 该不该跑 ────────────────────────────────────────────────────────────────

test('自动同步：evaluateDue 的判定完全基于落库的 nextDueAt', () => {
  const base = { ...DEFAULT_AUTO_SYNC, enabled: true, atHour: 18, atMinute: 30 }
  const wed = new Date(2026, 8, 23, 19, 0, 0).getTime()   // 周三 19:00，已过 18:30

  // 未开启 → 永远不跑
  assert.equal(evaluateDue({ ...base, enabled: false, nextDueAt: 0 }, wed).due, false)

  // 落库的 nextDueAt 在过去 → 该跑（这就是"补跑"）
  const past = evaluateDue({ ...base, nextDueAt: wed - 86400000 }, wed)
  assert.equal(past.due, true)
  assert.equal(past.reason, 'catch-up', '应跑时刻早于今天 0 点 → 是补跑')

  // 落库的 nextDueAt 就在今天已过的时刻 → 也是该跑，但算"按计划"
  const today = evaluateDue({ ...base, nextDueAt: slotAt(wed, 18, 30) }, wed)
  assert.equal(today.due, true)
  assert.equal(today.reason, 'scheduled')

  // 还没到 → 不跑，并把下次时刻带出来
  const future = slotAt(wed, 18, 30) + 3600000
  const waiting = evaluateDue({ ...base, nextDueAt: future }, wed)
  assert.equal(waiting.due, false)
  assert.equal(waiting.reason, 'waiting')
  assert.equal(waiting.nextDueAt, future)

  // 没有落库值（全新开启）时按今天/明天的 slot 推
  assert.equal(evaluateDue({ ...base, nextDueAt: null }, wed).due, true, '19:00 开启、18:30 已过 → 立刻跑一次')
  const morning = new Date(2026, 8, 23, 9, 0, 0).getTime()
  assert.equal(evaluateDue({ ...base, nextDueAt: null }, morning).due, false, '早上开启 → 等晚上')
})

test('自动同步：planNextDue 只对"重试可能有用"的结局安排重试', () => {
  const now = new Date(2026, 8, 23, 19, 0, 0).getTime()
  const st = { ...DEFAULT_AUTO_SYNC, enabled: true, retryDelayMin: 60, maxRetriesPerDay: 1, retryDate: null, retryCount: 0 }

  // 成功 → 下一个周期
  assert.equal(planNextDue(st, now, 'ok'), nextSlotAfter(now, st.atHour, st.atMinute))
  // 没拿到新数据 → 重试（源站可能只是还没出）
  assert.equal(planNextDue(st, now, 'noNewData'), now + 3600000)
  assert.equal(planNextDue(st, now, 'error'), now + 3600000)
  // 重试用完 → 等下一个周期，不再空转
  assert.equal(planNextDue({ ...st, retryDate: ymdOf(now), retryCount: 1 }, now, 'noNewData'), nextSlotAfter(now, st.atHour, st.atMinute))
  // 跨天后额度重置
  assert.equal(planNextDue({ ...st, retryDate: 20260922, retryCount: 9 }, now, 'noNewData'), now + 3600000)
  // 重试没用的结局 → 直接等下一个周期
  assert.equal(planNextDue(st, now, 'exceededCap'), nextSlotAfter(now, st.atHour, st.atMinute))
  assert.equal(planNextDue(st, now, 'noCodes'), nextSlotAfter(now, st.atHour, st.atMinute))
  // 关掉 → 不排
  assert.equal(planNextDue({ ...st, enabled: false }, now, 'ok'), null)
})

test('自动同步：applyResult 折叠运行结果，且 noCodes 不吃掉当天的重试额度', () => {
  const now = new Date(2026, 8, 23, 19, 0, 0).getTime()
  // 用**完整**状态（配置 + 运行态）而不是只拿配置默认值：运行态字段缺了会让断言失去意义
  const st = {
    ...DEFAULT_AUTO_SYNC, enabled: true, retryDelayMin: 60, maxRetriesPerDay: 1,
    retryCount: 0, retryDate: null, runCount: 0,
    lastOutcome: null, lastError: null, lastBars: null, lastCodes: null, lastMs: null,
    lastSuccessAt: null, lastSuccessDate: null, lastAttemptAt: null, lastAttemptDate: null,
    lastRunAt: null, skipReason: null, nextDueAt: null,
  }

  const ok = applyResult(st, { outcome: 'ok', bars: 120, scope: 50, ms: 900 }, now)
  assert.equal(ok.lastOutcome, 'ok')
  assert.equal(ok.lastSuccessDate, ymdOf(now))
  assert.equal(ok.lastBars, 120)
  assert.equal(ok.runCount, 1)
  assert.equal(ok.retryCount, 0)
  assert.equal(ok.nextDueAt, nextSlotAfter(now, 18, 30))

  const cap = applyResult(st, { outcome: 'exceededCap', message: '超上限', scope: 9999 }, now)
  assert.equal(cap.retryCount, 0, 'noCodes/exceededCap 不该消耗重试额度')
  assert.equal(cap.skipReason, '超上限')
  assert.equal(cap.lastSuccessDate, null, '没成功就不能记成功')

  const fail = applyResult(st, { outcome: 'error', error: 'boom' }, now)
  assert.equal(fail.retryCount, 1)
  assert.equal(fail.lastError, 'boom')
  assert.equal(fail.nextDueAt, now + 3600000, '失败要安排一次重试')

  // 纯函数：不能改动传入对象
  assert.equal(st.lastOutcome, null, 'applyResult 不得就地修改入参')
})

// ── 作用域与上限 ────────────────────────────────────────────────────────────

test('自动同步：范围 = 已授权范围 ∩ 库里真实存在的代码', () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  const codes = seedCodes(store, 3)

  assert.deepEqual(resolveScope(store, { codes: null }).sort(), codes.sort(), '未指定 = 库里全部')
  assert.deepEqual(resolveScope(store, { codes: ['600000', '999999'] }), ['600000'], '库里没有的代码被剔除')
  assert.deepEqual(resolveScope(store, { codes: ['999999'] }), [], '全都不在 → 空')
  cleanup()
})

test('自动同步：超出硬上限时跳过并记录，而不是硬跑', async () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  seedCodes(store, 5)
  let synced = false
  const r = await runAutoSync(runtime, { ...DEFAULT_AUTO_SYNC, enabled: true, maxCodes: 2 }, {
    sync: async () => { synced = true; return { done: 0 } },
    probe: async () => ({ advanced: true, checked: 3 }),
  })
  assert.equal(r.outcome, 'exceededCap')
  assert.equal(synced, false, '超限时一次网络请求都不该发')
  assert.match(r.message, /2/, '要说明上限是多少')
  cleanup()
})

test('自动同步：库里没有已同步的股票时给 noCodes，不报错', async () => {
  const { runtime, cleanup } = makeRuntime()
  runtime.store()
  const r = await runAutoSync(runtime, { ...DEFAULT_AUTO_SYNC, enabled: true }, { sync: async () => { throw new Error('不该调用') } })
  assert.equal(r.outcome, 'noCodes')
  assert.match(r.message, /quant_data_sync/)
  cleanup()
})

test('自动同步：未开启时 runAutoSync 直接返回 disabled', async () => {
  const { runtime, cleanup } = makeRuntime()
  runtime.store()
  const r = await runAutoSync(runtime, { ...DEFAULT_AUTO_SYNC, enabled: false }, {})
  assert.equal(r.outcome, 'disabled')
  cleanup()
})

// ── 探测：跑了 ≠ 成功了 ─────────────────────────────────────────────────────

test('自动同步：探测说没有新数据时，一次铺开请求都不发', async () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  seedCodes(store, 4)
  let syncCalls = 0
  const r = await runAutoSync(runtime, { ...DEFAULT_AUTO_SYNC, enabled: true }, {
    probe: async () => ({ advanced: false, checked: 3, latest: 20260918, samples: [] }),
    sync: async () => { syncCalls++; return { done: 4, bars: 0 } },
  })
  assert.equal(r.outcome, 'noNewData')
  assert.equal(syncCalls, 0, '判定无新数据后不该铺开')
  assert.match(r.message, /无新数据/)
  cleanup()
})

test('自动同步：铺开了但库内最大日期没前进 → staleSource（"跑了"不等于"成功了"）', async () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  const codes = seedCodes(store, 3)
  store.upsertBars(codes[0], [{ date: 20260918, open: 10, high: 11, low: 9, close: 10, volume: 1, amount: 1, pct: 0, turnover: 0 }])
  const r = await runAutoSync(runtime, { ...DEFAULT_AUTO_SYNC, enabled: true }, {
    probe: async () => ({ advanced: true, checked: 3, latest: 20260923 }),
    // 同步"成功"了，但一行都没写进去（源站给了空数据）
    sync: async () => ({ done: 3, skipped: 0, failed: 0, bars: 0, events: 0, errors: [] }),
  })
  assert.equal(r.outcome, 'staleSource')
  assert.equal(r.advanced, false)
  assert.equal(r.maxDate, 20260918)
  cleanup()
})

test('自动同步：库内最大日期确实前进了才算 ok', async () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  const codes = seedCodes(store, 3)
  store.upsertBars(codes[0], [{ date: 20260918, open: 10, high: 11, low: 9, close: 10, volume: 1, amount: 1, pct: 0, turnover: 0 }])
  const r = await runAutoSync(runtime, { ...DEFAULT_AUTO_SYNC, enabled: true }, {
    probe: async () => ({ advanced: true, checked: 3, latest: 20260923 }),
    sync: async (s, opts) => {
      // 校验：增量路径必须按股票各自算起点，而不是所有股票共用一个 from
      assert.ok(opts.incremental, '必须走增量路径，否则每天等于全量重拉')
      assert.equal(typeof opts.incremental.overlapDays, 'number')
      s.upsertBars(codes[0], [{ date: 20260923, open: 11, high: 12, low: 10, close: 11, volume: 1, amount: 1, pct: 0, turnover: 0 }])
      return { done: 3, skipped: 0, failed: 0, bars: 1, events: 0, errors: [] }
    },
  })
  assert.equal(r.outcome, 'ok')
  assert.equal(r.advanced, true)
  assert.equal(r.maxDate, 20260923)
  assert.equal(r.bars, 1)
  cleanup()
})

test('自动同步：同步过程抛错被记成 error，不把异常抛给调用方', async () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  seedCodes(store, 2)
  const r = await runAutoSync(runtime, { ...DEFAULT_AUTO_SYNC, enabled: true }, {
    probe: async () => ({ advanced: true, checked: 2 }),
    sync: async () => { throw new Error('connection reset') },
  })
  assert.equal(r.outcome, 'error')
  assert.match(r.error, /connection reset/)
  cleanup()
})

// ── 门：重启后补跑 ──────────────────────────────────────────────────────────

test('【P5 门】定时任务在"重启"后能补跑被错过的那一次', async () => {
  const { runtime, dir, cleanup } = makeRuntime()
  const store = runtime.store()
  seedCodes(store, 3)

  // 模拟：进程在昨天 18:30 之前就退出了，所以那一次没跑成。
  // 落库的 nextDueAt 因此停在了**过去**。
  const now = Date.now()
  const yesterdaySlot = now - 86400000
  writeState(store, {
    ...DEFAULT_AUTO_SYNC, enabled: true, nextDueAt: yesterdaySlot,
    consentAt: now - 2 * 86400000, consentBy: 'session-1',
  })

  // "重启"：换一个 runtime 句柄重新打开同一个库，再走一遍启动路径
  runtime.close()
  const rt2 = createRuntime({ dataDir: dir })
  assert.ok(rt2.exists(), '库还在')

  const timer = fakeTimer()
  const calls = []
  const report = createAutoSync(ctxWith(timer), rt2, {}, {
    runAutoSync: async (r, st) => { calls.push({ enabled: st.enabled }); return { outcome: 'ok', bars: 42, scope: 3, ms: 10 } },
  })

  assert.equal(report.enabled, true, '重启后要认出自动同步是开着的')
  assert.equal(report.timer, true)
  assert.equal(report.reason, 'catch-up', '被错过的那一次必须被识别为补跑')
  assert.equal(timer.jobs.length, 1, '必须排一次执行')
  assert.equal(timer.jobs[0].ms, 0, '补跑要立刻执行（延迟 0），而不是等到明天')

  // 触发它，看是否真的跑了，并把下次排程推到未来
  await timer.jobs[0].cb()
  assert.equal(calls.length, 1, '补跑必须真的执行')
  assert.equal(calls[0].enabled, true)

  const after = readState(rt2.store())
  assert.equal(after.lastOutcome, 'ok')
  assert.equal(after.lastSuccessDate, ymdOf(Date.now()), '成功日期按真实时钟记')
  assert.ok(after.nextDueAt > Date.now(), '跑完之后下次执行必须被推到未来，否则会死循环')
  assert.equal(timer.jobs.length, 2, '跑完要重新排程')
  assert.ok(timer.jobs[1].ms > 0)

  rt2.close()
  rmSync(dir, { recursive: true, force: true })
})

test('【P5 门】没有错过的那一次不会被补跑（重启不该造成多余的全市场同步）', () => {
  const { runtime, dir, cleanup } = makeRuntime()
  const store = runtime.store()
  seedCodes(store, 3)
  const now = Date.now()
  writeState(store, { ...DEFAULT_AUTO_SYNC, enabled: true, nextDueAt: now + 6 * 3600000 })

  const timer = fakeTimer()
  const report = createAutoSync(ctxWith(timer), runtime, {}, { runAutoSync: async () => ({ outcome: 'ok' }) })
  assert.equal(report.reason, 'armed')
  assert.equal(timer.jobs.length, 1)
  assert.ok(timer.jobs[0].ms > 0, '不该立刻跑')
  assert.ok(timer.jobs[0].ms <= 6 * 3600000 + 1000)
  cleanup()
})

test('自动同步：关掉之后重启不会自己跑起来', () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  seedCodes(store, 2)
  writeState(store, { ...DEFAULT_AUTO_SYNC, enabled: false, nextDueAt: Date.now() - 86400000 })
  const timer = fakeTimer()
  const report = createAutoSync(ctxWith(timer), runtime, {}, { runAutoSync: async () => ({ outcome: 'ok' }) })
  assert.equal(report.enabled, false)
  assert.equal(report.reason, 'not-enabled')
  assert.equal(timer.jobs.length, 0, '关着就不该排程')
  cleanup()
})

// ── 降级路径 ────────────────────────────────────────────────────────────────

test('自动同步：仓库不存在时不建库、不排程（惰性）', () => {
  const { runtime, dir, cleanup } = makeRuntime()
  assert.equal(runtime.exists(), false)
  const timer = fakeTimer()
  const report = createAutoSync(ctxWith(timer), runtime, {}, {})
  assert.equal(report.reason, 'no-store')
  assert.equal(report.timer, true, 'timer 可用只是没东西可同步')
  assert.equal(timer.jobs.length, 0)
  assert.equal(existsSync(join(dir, 'quant.db')), false, '装插件不该平白多出一个数据库')
  cleanup()
})

test('自动同步：没有 timer 服务时降级为"只能手动跑"，且不假装会定时', async () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  seedCodes(store, 2)
  writeState(store, { ...DEFAULT_AUTO_SYNC, enabled: true, nextDueAt: Date.now() - 1000 })

  const report = createAutoSync(ctxWith(undefined), runtime, {}, {
    runAutoSync: async () => ({ outcome: 'ok', bars: 1, scope: 2 }),
  })
  assert.equal(report.timer, false)
  assert.equal(report.reason, 'timer-unavailable', '必须如实说明定时不可用，不能假装会跑')
  assert.equal(report.enabled, true, '配置状态仍然是开启的')
  assert.ok(runtime.autoSync, '控制器必须存在，否则手动路径也没了')
  assert.equal(runtime.autoSync.hasTimer, false)

  // 手动路径照常可用
  const r = await runtime.autoSync.runNow({ reason: 'manual' })
  assert.equal(r.outcome, 'ok')
  assert.equal(r.trigger, 'manual')
  cleanup()
})

test('自动同步：stop / reschedule 是一对可逆操作（用户关掉再开不能失效）', async () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  seedCodes(store, 2)
  writeState(store, { ...DEFAULT_AUTO_SYNC, enabled: true, nextDueAt: Date.now() + 3600000 })
  const timer = fakeTimer()
  createAutoSync(ctxWith(timer), runtime, {}, { runAutoSync: async () => ({ outcome: 'ok' }) })
  assert.equal(timer.jobs.length, 1)

  runtime.autoSync.stop()
  assert.equal(runtime.autoSync.active, false)
  assert.equal(timer.jobs[0].cancelled, true, 'stop 必须取消已排的那次')

  runtime.autoSync.reschedule()
  assert.equal(runtime.autoSync.active, true)
  assert.equal(timer.jobs.length, 2, 'reschedule 必须重新排上')

  runtime.autoSync.dispose()
  assert.equal(timer.jobs[1].cancelled, true)
  runtime.autoSync.reschedule()
  assert.equal(timer.jobs.length, 2, 'dispose 之后 reschedule 不得再排（插件已卸载）')
  cleanup()
})

test('自动同步：装载时没有 timer，之后 timer 出现也能用（惰性解析，不是装载时抓死）', () => {
  const { runtime, cleanup } = makeRuntime()
  const timer = fakeTimer()
  let timerAvailable = false
  const ctx = { get: (n) => (n === 'timer' && timerAvailable ? timer : undefined) }

  // 装载时仓库不存在 → 走 no-store 早退分支，控制器是"无 timer"的
  const report = createAutoSync(ctx, runtime, {}, { runAutoSync: async () => ({ outcome: 'ok' }) })
  assert.equal(report.reason, 'no-store')
  assert.equal(runtime.autoSync.hasTimer, false)

  // 之后：用户同步了数据（库建出来了），并且 timer 服务也出现了
  runtime.store()
  timerAvailable = true
  assert.equal(runtime.autoSync.hasTimer, true, 'hasTimer 必须惰性解析；装载时抓死会让"开了却从来不动"')

  // 用户开启自动同步 → 必须真的排上程
  const st = readState(runtime.store())
  writeState(runtime.store(), { ...st, ...DEFAULT_AUTO_SYNC, enabled: true, nextDueAt: null })
  runtime.autoSync.reschedule(Date.now() + 3600000)
  assert.equal(timer.jobs.length, 1)
  assert.ok(timer.jobs[0].ms > 0)
  cleanup()
})

test('自动同步：并发保护 —— 上一次还在跑时不会叠第二次', async () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  seedCodes(store, 2)
  writeState(store, { ...DEFAULT_AUTO_SYNC, enabled: true, nextDueAt: Date.now() + 3600000 })
  let release
  const gate = new Promise((res) => { release = res })
  createAutoSync(ctxWith(fakeTimer()), runtime, {}, {
    runAutoSync: async () => { await gate; return { outcome: 'ok' } },
  })
  const first = runtime.autoSync.runNow()
  const second = await runtime.autoSync.runNow()
  assert.equal(second.outcome, 'busy')
  release()
  assert.equal((await first).outcome, 'ok')
  cleanup()
})

test('自动同步：部署层 config.autoSync=false 会强制关闭并清掉已排的程', () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  seedCodes(store, 2)
  writeState(store, { ...DEFAULT_AUTO_SYNC, enabled: true, nextDueAt: Date.now() - 1000 })
  const timer = fakeTimer()
  const report = createAutoSync(ctxWith(timer), runtime, { autoSync: false }, {})
  assert.equal(report.reason, 'disabled-by-config')
  assert.equal(report.enabled, false)
  assert.equal(timer.jobs.length, 0)
  assert.equal(readState(store).enabled, false, '落库状态也要跟着关掉，否则重启又活了')
  cleanup()
})

test('自动同步：部署层 config.autoSync 首次开启会固化配置与授权记录', () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  seedCodes(store, 2)
  const timer = fakeTimer()
  const report = createAutoSync(ctxWith(timer), runtime, { autoSync: { enabled: true, atHour: 17, atMinute: 5 } }, {})
  assert.equal(report.enabled, true)
  const st = readState(store)
  assert.equal(st.atHour, 17)
  assert.equal(st.atMinute, 5)
  assert.equal(st.consentBy, 'deployment:config')
  assert.ok(st.consentAt > 0)
  cleanup()
})

test('自动同步：运行期间用户关掉 → 不会再排下一次（否则等于关不掉）', async () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  seedCodes(store, 2)
  writeState(store, { ...readState(store), ...DEFAULT_AUTO_SYNC, enabled: true, nextDueAt: Date.now() - 1000 })
  const timer = fakeTimer()
  createAutoSync(ctxWith(timer), runtime, {}, {
    runAutoSync: async () => {
      // 模拟：这次运行还在跑的时候，用户在会话里说了「关闭自动同步」
      const st = readState(store)
      st.enabled = false
      st.nextDueAt = null
      writeState(store, st)
      return { outcome: 'ok', bars: 1, scope: 2 }
    },
  })
  assert.equal(timer.jobs.length, 1)
  await timer.jobs[0].cb()
  assert.equal(readState(store).enabled, false)
  assert.equal(runtime.autoSync.active, false, '控制器要跟着停下来')
  assert.equal(timer.jobs.length, 1, '关掉之后不该再排下一次')
  cleanup()
})

// ── 手动补跑不该改变授权状态 ────────────────────────────────────────────────

test('自动同步：手动补跑不会把"未开启"偷偷变成"已开启"', async () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  seedCodes(store, 2)
  writeState(store, { ...DEFAULT_AUTO_SYNC, enabled: false, nextDueAt: null })
  createAutoSync(ctxWith(fakeTimer()), runtime, {}, {
    runAutoSync: async (r, st) => ({ outcome: 'ok', bars: 7, scope: st.codes ? 0 : 2 }),
  })
  const r = await runtime.autoSync.runNow({ reason: 'manual' })
  assert.equal(r.outcome, 'ok')
  const st = readState(store)
  assert.equal(st.enabled, false, '补跑是一次性的，不能变成长期授权')
  assert.equal(st.nextDueAt, null, '没开启就不该排下一次')
  assert.equal(st.lastOutcome, 'ok', '但运行事实要记下来')
  cleanup()
})

// ── 探测函数本身 ────────────────────────────────────────────────────────────

test('自动同步：探测取 bars_last 最新的几只，判定"有没有比本地更新的 bar"', async () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  const codes = seedCodes(store, 5)
  // 只有最新那只往前挪一天
  store.setSyncState(codes[0], { barsLast: 20260922, status: 'ok' })

  const seen = []
  const p = await probeNewData(store, codes, { to: 20260923, probeCount: 2 })
  assert.equal(p.checked, 2, '只探 probeCount 只')
  assert.equal(p.samples[0].code, codes[0], '先探 bars_last 最新的那只（最可能是活跃的）')
  cleanup()
})

test('自动同步：runAutoSync 在没有注入 probe 时不会因为网络失败而崩', async () => {
  const { runtime, cleanup } = makeRuntime()
  const store = runtime.store()
  seedCodes(store, 1)
  // 不注入 probe，也不注入 sync → 真的会走网络。用一个必然失败/空的 code 让它快速返回。
  // 这里只断言"不抛异常、有合法 outcome"，不断言网络结果（那取决于外部环境）。
  const r = await runAutoSync(runtime, { ...DEFAULT_AUTO_SYNC, enabled: true, probeCount: 1, maxCodes: 1 }, {
    sync: async () => ({ done: 1, skipped: 0, failed: 0, bars: 0, events: 0, errors: [] }),
  })
  assert.ok(['noNewData', 'staleSource', 'ok', 'error'].includes(r.outcome), `意外 outcome=${r.outcome}`)
  cleanup()
})

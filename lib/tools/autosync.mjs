/**
 * 自动同步工具（1 个）。
 *
 * 它做的是**授权与状态**，不是同步本身：
 *   - `enable`  = 用户给出长期授权（决策 A：同意发生在配置时，之后每天不再问）
 *   - `disable` = 撤销授权
 *   - `get`     = 看当前状态、下次什么时候跑、上次结果
 *   - `run_now` = 用同一条增量路径手动补跑一次（不改变定时设置）
 *
 * 为什么 `enable` 需要 `confirm: true`：自动任务**没法弹窗问人**，所以"每天自动联网"
 * 这件事必须由用户当场点头，而不是由模型替他决定。护栏会先拦一次，工具这里再兜一层。
 */

import { tool, S, output, fail, fmt } from './kit.mjs'
import { provenance } from './strategy.mjs'
import {
  readState, writeState, normalizeAutoSync, parseClock,
  nextSlotAfter, evaluateDue, DEFAULT_AUTO_SYNC,
} from '../data/autosync.mjs'

const OUTCOME_TEXT = {
  ok: '成功（有新增数据）',
  noNewData: '无新数据（非交易日，或源站当天数据还没出）',
  staleSource: '执行了但库里没有前进（源站数据不完整）',
  noCodes: '库里没有已同步的股票',
  exceededCap: '超出硬上限，本次跳过',
  error: '出错',
  aborted: '被中断',
  disabled: '未开启',
  busy: '上一次还在运行',
}

const describeState = (st) => ({
  enabled: st.enabled,
  at: `${String(st.atHour).padStart(2, '0')}:${String(st.atMinute).padStart(2, '0')}`,
  scope: st.codes ? st.codes.length : null,
  scopeKind: st.codes ? 'explicit' : 'all-synced',
  maxCodes: st.maxCodes,
  retryDelayMin: st.retryDelayMin,
  overlapDays: st.overlapDays,
  nextDueAt: st.nextDueAt,
  consentAt: st.consentAt,
  consentBy: st.consentBy,
  lastAttemptAt: st.lastAttemptAt,
  lastAttemptDate: st.lastAttemptDate,
  lastSuccessAt: st.lastSuccessAt,
  lastSuccessDate: st.lastSuccessDate,
  lastOutcome: st.lastOutcome,
  lastError: st.lastError,
  lastBars: st.lastBars,
  lastCodes: st.lastCodes,
  lastMs: st.lastMs,
  skipReason: st.skipReason,
  runCount: st.runCount,
})

export function autosyncTools(runtime, hooks = {}) {
  /** 取控制器；插件没装上 timer 时也仍然有（手动路径照常可用） */
  const controller = () => runtime.autoSync ?? null

  return [
    tool({
      name: 'quant_autosync',
      description: [
        '配置**盘后定时增量同步**：每天在指定时间把本地已有的股票增量补到当天。',
        '  action=get      —— 看当前状态、下次执行时间、上次结果（默认）',
        '  action=enable   —— 开启（**需要 confirm: true**，这是一次长期授权）',
        '  action=disable  —— 关闭',
        '  action=run_now  —— 立刻按同一条增量路径补跑一次（不改定时设置）',
        '开启前必须向用户说明：① 每天自动联网同步、不再逐次询问；② DSH 没运行时不会执行（下次启动会补跑）；',
        '③ 只同步**本地已有的股票**，不会自动扩大到全市场；④ 超过硬上限会跳过并记录。',
        '**不要**在用户没明确要求时开启它。',
      ].join(' '),
      parameters: S.obj({
        action: S.enum(['get', 'enable', 'disable', 'run_now'], '要做什么（默认 get）'),
        at: S.str('每天的执行时刻，HH:MM 本地时间（默认 18:30；开启与修改都用它）'),
        codes: S.arr(S.str('股票代码'), '只同步这些股票（不传 = 库里已同步的全部）'),
        maxCodes: S.int('单次运行的股票数硬上限（默认 3000）'),
        retryDelayMin: S.int('没拿到新数据/失败后的重试间隔分钟（默认 60）'),
        confirm: S.bool('开启自动同步时必须为 true（表示用户已明确同意长期授权）'),
      }, []),
      outputSchema: output({
        state: { type: 'object', additionalProperties: true },
        nextDueAt: { type: 'integer' },
        nextDueText: { type: 'string' },
        timer: { type: 'boolean' },
        result: { type: 'object', additionalProperties: true },
        note: { type: 'string' },
      }, ['state']),
      timeoutMs: 30 * 60 * 1000,
      execute: async (args, exec) => {
        const action = args.action ?? 'get'
        if (!runtime.exists()) {
          return fail('NO_STORE', '本地还没有数据仓库',
            '先用 quant_data_sync 同步一次（至少 scope=codes + 一小批行情），再开启自动同步')
        }
        const store = runtime.store()
        const now = Date.now()

        if (action === 'get') {
          const st = readState(store)
          const due = evaluateDue(st, now)
          return {
            ok: true, state: describeState(st), nextDueAt: due.nextDueAt,
            nextDueText: due.nextDueAt ? new Date(due.nextDueAt).toISOString() : null,
            timer: !!controller()?.hasTimer,
            note: st.enabled ? undefined : '自动同步当前是关闭的',
          }
        }

        if (action === 'disable') {
          const st = readState(store)
          const was = st.enabled
          st.enabled = false
          st.nextDueAt = null
          writeState(store, st)
          controller()?.stop?.()
          return { ok: true, state: describeState(st), timer: !!controller()?.hasTimer, note: was ? '已关闭自动同步' : '本来就没开启' }
        }

        if (action === 'enable') {
          if (args.confirm !== true) {
            return fail('APPROVAL_REQUIRED',
              '开启自动同步是一次长期授权：之后每天收盘后会**自动联网同步**，不再逐次询问',
              '先向用户说明四件事（每天自动同步 / DSH 没运行则不执行但下次启动会补跑 / 只同步本地已有的股票 / 超上限会跳过），取得明确同意后带 confirm=true 重试')
          }
          const clock = args.at ? parseClock(args.at) : null
          if (args.at && !clock) return fail('BAD_TIME', `无法解析时刻「${args.at}」`, '用 HH:MM 格式，例如 18:30')

          const prev = readState(store)
          const cfg = normalizeAutoSync({
            ...DEFAULT_AUTO_SYNC, ...prev,
            enabled: true,
            ...(clock ? { atHour: clock.hour, atMinute: clock.minute } : {}),
            ...(args.codes ? { codes: args.codes } : {}),
            ...(args.maxCodes ? { maxCodes: args.maxCodes } : {}),
            ...(args.retryDelayMin ? { retryDelayMin: args.retryDelayMin } : {}),
          })
          const { sessionId } = provenance(exec)
          const st = {
            ...prev, ...cfg,
            consentAt: now, consentBy: sessionId ?? 'unknown-session',
            consentScope: cfg.codes ? `${cfg.codes.length} 只` : '库内已同步的全部',
            nextDueAt: null,
          }
          const due = evaluateDue(st, now)
          st.nextDueAt = due.due ? now : nextSlotAfter(now, st.atHour, st.atMinute)
          writeState(store, st)
          controller()?.reschedule?.(st.nextDueAt)
          return {
            ok: true, state: describeState(st), nextDueAt: st.nextDueAt,
            nextDueText: new Date(st.nextDueAt).toISOString(),
            timer: !!controller()?.hasTimer,
            note: controller()?.hasTimer
              ? undefined
              : '当前 DSH 进程没有 timer 服务（headless profile 常见），定时不会自动触发；仍可用 action=run_now 手动补跑，重启到带 timer 的进程后会按计划执行',
          }
        }

        // run_now
        const c = controller()
        if (!c) return fail('NO_CONTROLLER', '自动同步控制器未就绪（插件可能未正常加载）')
        const st = readState(store)
        const result = await c.runNow({ reason: 'manual' })
        const after = readState(store)
        return {
          ok: result.outcome === 'ok' || result.outcome === 'noNewData',
          state: describeState(after),
          result: {
            outcome: result.outcome,
            text: OUTCOME_TEXT[result.outcome] ?? result.outcome,
            scope: result.scope ?? null, bars: result.bars ?? null,
            done: result.done ?? null, failed: result.failed ?? null,
            ms: result.ms ?? null, maxDate: result.maxDate ?? null,
            probe: result.probe ? { advanced: result.probe.advanced, checked: result.probe.checked, latest: result.probe.latest } : null,
            message: result.message ?? null,
          },
          nextDueAt: after.nextDueAt,
          nextDueText: after.nextDueAt ? new Date(after.nextDueAt).toISOString() : null,
          timer: !!c.hasTimer,
          // 失败信封必须带 error（render 与 presentationMeta 都按 v.error.code 读）。
          // 踩过：run_now 落在 outcome=error（网络侧失败）时 ok=false 但 error 缺失，
          // render 直接读 v.error.code 抛 TypeError —— 整个工具调用失败还少一条人话。
          ...((result.outcome === 'ok' || result.outcome === 'noNewData') ? {} : {
            error: result.outcome === 'exceededCap'
              ? { code: 'EXCEEDED_CAP', message: result.message ?? '超出单次同步上限' }
              : { code: 'RUN_FAILED', message: result.message ?? OUTCOME_TEXT[result.outcome] ?? `本次自动同步未成功（${result.outcome}）` },
          }),
        }
      },
      presentationMeta: (a, v) => v.ok === false
        ? { kind: 'autoSync', ok: false, code: v.error?.code ?? 'ERROR', message: v.error?.message ?? '', hint: v.error?.hint }
        : {
            kind: 'autoSync', ok: v.ok !== false,
            action: a.action ?? 'get',
            state: v.state, nextDueAt: v.nextDueAt, timer: v.timer,
            result: v.result ?? null, note: v.note ?? null,
          },
      render: (a, v) => {
        if (v.ok === false) return `失败：${v.error.code} — ${v.error.message}${v.error.hint ? `\n${v.error.hint}` : ''}`
        const s = v.state
        const lines = []
        // `run_now` 时**结果放最前面**：那才是这次调用的目的，状态是背景信息
        if (v.result) {
          lines.push(`本次结果：${v.result.text}` +
            (v.result.scope ? `（${v.result.scope} 只` : '') +
            (v.result.bars ? `，新增 ${v.result.bars} 根 bar）` : v.result.scope ? '）' : ''))
          if (v.result.probe) lines.push(`  探测 ${v.result.probe.checked} 只，最新 ${fmt.date(v.result.probe.latest)}，${v.result.probe.advanced ? '有新数据' : '无新数据'}`)
          if (v.result.message) lines.push(`  ${v.result.message}`)
        }
        lines.push(`自动同步：${s.enabled ? `**已开启**（每天 ${s.at}，${s.scopeKind === 'explicit' ? `${s.scope} 只` : '库内已同步的全部'}，上限 ${s.maxCodes} 只）` : '未开启'}`)
        if (s.enabled && v.nextDueText) lines.push(`下次执行：${v.nextDueText}${v.timer ? '' : '（当前进程无 timer，需重启到带 timer 的进程）'}`)
        if (s.lastOutcome) {
          lines.push(`上次运行：${fmt.date(s.lastAttemptDate)} ${OUTCOME_TEXT[s.lastOutcome] ?? s.lastOutcome}` +
            (s.lastCodes ? `（${s.lastCodes} 只` : '') + (s.lastBars ? `，新增 ${s.lastBars} 根 bar）` : s.lastCodes ? '）' : '') +
            (s.lastSuccessDate ? ` | 上次成功 ${fmt.date(s.lastSuccessDate)}` : ''))
        }
        if (s.skipReason) lines.push(`跳过原因：${s.skipReason}`)
        if (s.lastError) lines.push(`上次错误：${s.lastError}`)
        if (v.note) lines.push(`说明：${v.note}`)
        if (a.action === 'enable') lines.push('已记录授权：' + (s.consentBy ? `由 ${s.consentBy} 于 ${new Date(s.consentAt).toISOString()}` : '—'))
        return lines.join('\n')
      },
    }),
  ]
}

/**
 * 仓库 / 行情 / 财务 / 日历工具（11 个）。
 *
 * 两类工具的区别必须讲清楚，否则模型会拿错：
 *   - **仓库类**（status/sync/cleanup/calendar）：读本地库，离线、快、覆盖已同步的范围
 *   - **实时类**（quote/kline/financial）：走网络，有速率限制与熔断，可能失败
 *
 * 行业与指数成分这两个工具依赖东财板块接口（P1 未单独验证过该 fs 语法），
 * 因此它们的 description 里明确写了"可能需要回退到 web_fetch"，不做静默降级。
 */

import { tool, S, output, nullable, fail, fmt } from './kit.mjs'
import { emQuote, emKline, emFundamentals, emDatacenter, emList, ALL_A_FS } from '../data/sources.mjs'
import { estimateSync, syncCodes, syncBars, syncStatus } from '../data/sync.mjs'
import { normalizeCode, boardOf, dayOrdinal, calendarDaysBetween } from '../data/codes.mjs'
import { evictPanels } from '../factors/panel.mjs'

/** 从本地 bars 里取交易日历（这就是"真实发生过的交易日"，比任何日历表都可靠） */
function tradingDates(store, from = 0, to = 99999999) {
  return store.raw.prepare('SELECT DISTINCT date FROM bars WHERE date BETWEEN ? AND ? ORDER BY date').all(from, to).map((r) => r.date)
}

export function dataTools(runtime, hooks = {}) {
  return [
    tool({
      name: 'quant_data_status',
      description: [
        '本地数据仓库的状态：覆盖的股票数、行情根数、复权事件数、日期区间、同步进度、新鲜度与自动同步。',
        '**回答任何量化问题前先看这个**：数据没同步或过期时，后面所有结论都不可信。',
        '`stale=true` 表示最新行情距今超过阈值（**按工作日算，跳过周末**；不识别节假日），应当提示用户先同步。',
        '`autoSync.enabled=true` 时数据会自己保持新鲜，`stale` 通常是暂时的；未开启时提醒用户可以用 quant_autosync 开启。',
      ].join(' '),
      parameters: S.obj({ staleDays: S.int('多少个工作日没更新算过期（默认 5）') }, []),
      outputSchema: output({
        ready: { type: 'boolean' }, stale: { type: 'boolean' },
        codes: { type: 'integer' }, bars: { type: 'integer' }, adjEvents: { type: 'integer' },
        range: { type: 'array', items: nullable({ type: 'integer' }) }, // 空仓库时是 [null, null]
        byStatus: { type: 'object', additionalProperties: true },
        pendingCount: { type: 'integer' }, uncovered: { type: 'integer' },
        dir: { type: 'string' },
        freshness: { type: 'object', additionalProperties: true },
        autoSync: { type: 'object', additionalProperties: true },
        panels: { type: 'array', items: { type: 'object', additionalProperties: true } },
        panelsBehind: { type: 'integer' },
      }, ['ready', 'stale', 'codes', 'bars']),
      execute: (args) => {
        if (!runtime.exists()) {
          return {
            ok: true, ready: false, stale: true, codes: 0, bars: 0, adjEvents: 0, range: [null, null],
            byStatus: {}, pendingCount: 0, uncovered: 0, dir: runtime.dir,
            freshness: { today: null, lastDate: null, calendarDays: null, weekdays: null, stale: true, basis: 'weekdays' },
            autoSync: { enabled: false, configured: false },
            hint: '仓库还不存在。用 quant_data_sync 先同步代码表与行情。',
          }
        }
        const store = runtime.store()
        const s = syncStatus(store, { staleDays: args.staleDays ?? 5 })
        // 面板新鲜度与行情新鲜度是两件事：同步新行情不会自动延伸已有面板。
        // 不暴露这一点，模型会在"选股为什么没覆盖最新日期"上反复碰壁。
        const panels = store.listPanels().map((p) => ({
          factorId: p.factor_id, rows: p.rows, firstDate: p.first_date, lastDate: p.last_date,
          behindDays: s.lastDate && p.last_date ? calendarDaysBetween(s.lastDate, p.last_date) : null,
        }))
        return {
          ok: true, ...s, dir: runtime.dir, panels,
          panelsBehind: panels.filter((p) => (p.behindDays ?? 0) > 0).length,
        }
      },
      presentationMeta: (a, v) => ({
        kind: 'dataStatus', ok: v.ok !== false,
        ready: v.ready, stale: v.stale, staleDays: v.staleDays,
        codes: v.codes, bars: v.bars, adjEvents: v.adjEvents, range: v.range,
        byStatus: v.byStatus, uncovered: v.uncovered, pendingCount: v.pendingCount,
        freshness: v.freshness ?? null,
        autoSync: v.autoSync ?? null,
        panels: (v.panels ?? []).slice(0, 12), panelsBehind: v.panelsBehind ?? 0,
        dir: v.dir,
      }),
      render: (a, v) => {
        if (v.ok === false) return `失败：${v.error.message}`
        if (!v.ready) return `仓库尚未就绪（${v.dir}）。${v.hint ?? '先同步数据。'}`
        const f = v.freshness ?? {}
        const auto = v.autoSync ?? {}
        const freshText = v.stale
          ? `⚠️ 已过期（距今 ${f.weekdays ?? '—'} 个工作日 / ${f.calendarDays ?? '—'} 个自然日，阈值 ${v.staleDays} 工作日）`
          : `（新鲜，距今 ${f.weekdays ?? '—'} 个工作日）`
        return `数据仓库：${v.codes} 只 / ${v.bars} 根 bar / ${v.adjEvents} 个复权事件\n` +
          `区间 ${fmt.date(v.range[0])} ~ ${fmt.date(v.range[1])}${freshText}\n` +
          `同步状态 ${Object.entries(v.byStatus).map(([k, n]) => `${k}:${n}`).join(' ')}` +
          (v.uncovered ? `，未覆盖 ${v.uncovered} 只` : '') +
          (v.pendingCount ? `，待续传 ${v.pendingCount} 只` : '') +
          `\n自动同步：${auto.enabled ? `已开启（每天 ${auto.at}，下次 ${auto.nextDueAt ? new Date(auto.nextDueAt).toISOString() : '—'}）` : '未开启'}` +
          (auto.enabled && auto.lastOutcome ? `，上次 ${auto.lastOutcome}（${fmt.date(auto.lastAttemptDate)}）` : '') +
          (v.stale && !auto.enabled ? `\n提示：可用 quant_autosync 开启盘后自动增量同步，之后数据会自己保持新鲜。` : '') +
          (v.panelsBehind ? `\n⚠️ 有 ${v.panelsBehind} 个因子面板落后于行情（同步新数据不会自动延伸面板）` : '')
      },
    }),

    tool({
      name: 'quant_data_sync',
      description: [
        '同步数据到本地仓库。三个 scope：',
        '  codes  —— 只同步代码表（快，秒级）',
        '  bars   —— 同步行情 + 复权事件（按股票数线性增长；全市场约 1 小时）',
        '  all    —— 代码表 + 行情',
        '支持**断点续传**：中断后再调用会跳过已完成的股票。',
        '规模较大时（>200 只）需要用户确认，调用前先看 `estimate`。',
        '**不要**在没有用户明确同意的情况下对全市场发起同步。',
      ].join(' '),
      parameters: S.obj({
        scope: S.enum(['codes', 'bars', 'all'], '同步范围'),
        codes: S.arr(S.str('股票代码'), '只同步这些股票（不传 = 库里全部；scope=codes 时忽略）'),
        from: S.int('起始日 YYYYMMDD（默认 10 年前）'),
        to: S.int('结束日 YYYYMMDD（默认今天）'),
        resume: S.bool('跳过已完成的股票（默认 true）'),
        estimateOnly: S.bool('只估算规模不实际同步（默认 false）'),
        withFundamentals: S.bool('同时同步基本面（默认 false，明显更慢）'),
        confirm: S.bool('规模超阈值时必须显式确认（向用户说明耗时并取得同意后传 true）'),
      }, ['scope']),
      outputSchema: output({
        estimate: { type: 'object', additionalProperties: true },
        codes: { type: 'integer' }, done: { type: 'integer' }, skipped: { type: 'integer' },
        failed: { type: 'integer' }, bars: { type: 'integer' }, events: { type: 'integer' },
        errors: { type: 'array', items: { type: 'object', additionalProperties: true } },
        ms: { type: 'integer' },
      }, ['estimate']),
      timeoutMs: 90 * 60 * 1000,
      execute: async (args) => {
        const store = runtime.store()
        const scope = args.scope ?? 'all'
        const est = estimateSync(store, { from: args.from, to: args.to, codes: args.codes ?? null })
        if (args.estimateOnly) return { ok: true, estimate: est, done: 0, skipped: 0, failed: 0, bars: 0, events: 0, errors: [] }

        // 规模护栏：大同步必须显式确认（由审批护栏在 pre-execute 拦截，这里再兜一层）
        if (est.needsApproval && args.confirm !== true) {
          return {
            ok: false,
            estimate: est,
            error: {
              code: 'APPROVAL_REQUIRED',
              message: est.reason,
              hint: '先向用户说明规模与耗时并取得同意，再带 confirm=true 重试；或先用 estimateOnly=true 查看估算。',
            },
          }
        }

        const t0 = Date.now()
        let out = { codes: 0, done: 0, skipped: 0, failed: 0, bars: 0, events: 0, errors: [] }
        if (scope === 'codes' || scope === 'all') {
          const r = await syncCodes(store)
          if (!r.ok) return { ok: false, estimate: est, error: r.error, ...out }
          out.codes = r.codes
        }
        if (scope === 'bars' || scope === 'all') {
          const codes = args.codes ?? (out.codes || store.codesList().length ? null : null)
          const r = await syncBars(store, {
            codes: args.codes ?? null, from: est.from, to: est.to,
            resume: args.resume !== false, withFundamentals: !!args.withFundamentals,
          })
          Object.assign(out, { done: r.done, skipped: r.skipped, failed: r.failed, bars: r.bars, events: r.events, errors: r.errors.slice(0, 20) })
          if (r.aborted) out.aborted = true
        }
        return { ok: out.failed === 0, estimate: est, ...out, ms: Date.now() - t0 }
      },
      presentationMeta: (a, v) => ({
        kind: 'dataSync', ok: v.ok !== false,
        estimate: v.estimate,
        // 显式的阶段，别让客户端从"ms 是不是 null"去猜：
        // `estimateOnly` 的调用根本没有 ms 字段，早期客户端因此把估算结果渲染成"同步中…"。
        // 这是真实浏览器验证抓出来的（见 spike/out/browser/）。
        phase: v.ok === false && v.error?.code === 'APPROVAL_REQUIRED' ? 'approval'
          : v.ms === undefined ? 'estimate' : 'done',
        approvalRequired: v.ok === false && v.error?.code === 'APPROVAL_REQUIRED',
        codes: v.codes ?? 0, done: v.done ?? 0, skipped: v.skipped ?? 0, failed: v.failed ?? 0,
        bars: v.bars ?? 0, events: v.events ?? 0,
        droppedNoPrevBar: v.droppedNoPrevBar ?? 0, fromTable: v.fromTable ?? 0,
        ms: v.ms ?? null, errors: (v.errors ?? []).slice(0, 5),
      }),
      render: (a, v) => {
        if (v.ok === false) return `需要确认：${v.error.message}\n${v.error.hint ?? ''}`
        if (v.ms === undefined) return `规模估算：${v.estimate.codes} 只 / 约 ${v.estimate.approxRequests} 次请求 / 约 ${v.estimate.approxMinutes} 分钟（${v.estimate.reason}）`
        return `同步完成（${(v.ms / 1000).toFixed(1)}s）：代码表 ${v.codes} 条，行情 ${v.done} 只新增 ${v.bars} 根 bar、${v.events} 个复权事件` +
          (v.skipped ? `，跳过 ${v.skipped} 只（已是最新）` : '') +
          (v.failed ? `，失败 ${v.failed} 只` : '') +
          (v.errors?.length ? `\n失败样例：${v.errors.slice(0, 3).map((e) => `${e.code}(${e.message})`).join(' ')}` : '')
      },
    }),

    tool({
      name: 'quant_data_cleanup',
      description: [
        '清理本地数据。默认只清理**可再生的**东西：因子面板缓存（下次会自动重建）。',
        '`scope=panels` 清面板；`scope=all` 会连行情一起清（**不可恢复，必须用户确认**）。',
        '`scope=preset` 只删本插件投递的「量化助手」preset 目录 —— **准备卸载插件之前**用它，',
        '因为 `dsh plugin remove` 不会启动 DSH，插件代码没有机会在卸载时执行清理（平台限制）。',
      ].join(' '),
      parameters: S.obj({
        scope: S.enum(['panels', 'all', 'preset'], '清理范围（默认 panels）'),
        keep: S.int('保留最近使用的几个面板（默认 0 = 全清）'),
        confirm: S.bool('scope=all 时必须显式确认'),
      }, []),
      outputSchema: output({
        scope: { type: 'string' }, evicted: { type: 'array', items: { type: 'string' } },
        before: { type: 'object', additionalProperties: true }, after: { type: 'object', additionalProperties: true },
      }, ['scope']),
      execute: (args) => {
        const scope = args.scope ?? 'panels'
        // scope=preset 不需要仓库存在（它删的是 preset 目录，不是数据）
        if (scope === 'preset') {
          const r = hooks.cleanupPreset ? hooks.cleanupPreset() : { removed: false, reason: 'unavailable' }
          return { ok: true, scope, evicted: r.removed ? [r.target] : [], before: {}, after: {}, preset: r }
        }
        if (!runtime.exists()) return fail('NO_STORE', '仓库不存在，无需清理')
        const store = runtime.store()
        const before = store.stats()
        if (scope === 'all') {
          if (args.confirm !== true) {
            return fail('APPROVAL_REQUIRED', `scope=all 会删除 ${before.bars} 根 bar 与 ${before.adjEvents} 个复权事件，且不可恢复`,
              '确认后带 confirm=true 重试；通常只需要 scope=panels')
          }
          store.raw.exec('DELETE FROM factor_panel; DELETE FROM factor_meta; DELETE FROM bars; DELETE FROM bars_hfq; DELETE FROM adj_events; DELETE FROM sync_state; DELETE FROM fundamentals')
          store.raw.exec('VACUUM')
        } else {
          const r = evictPanels(store, { keep: args.keep ?? 0 })
          store.raw.exec('VACUUM')
          return { ok: true, scope, evicted: r.evicted, before, after: store.stats() }
        }
        return { ok: true, scope, evicted: [], before, after: store.stats() }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.code} — ${v.error.message}${v.error.hint ? `\n${v.error.hint}` : ''}`
        : v.scope === 'preset'
          ? (v.preset?.removed ? `已删除 preset 目录：${v.preset.target}`
            : `未删除（${v.preset?.reason ?? '未知'}）—— 目录不存在、或元数据不属于本包（绝不碰别人的 preset）`)
          : `清理 ${v.scope} 完成：面板 ${v.before.panels ?? '?'} → ${v.after.panels ?? '?'}，库内 ${v.after.bars} 根 bar` +
            (v.evicted.length ? `\n已清理面板：${v.evicted.join(', ')}` : ''),
    }),

    tool({
      name: 'quant_quote',
      description: '实时行情快照（**走网络**，非本地库）。返回最新价、涨跌幅、成交量额、市值。可能因限流失败。',
      parameters: S.obj({ code: S.str('6 位股票代码，例如 600519') }, ['code']),
      outputSchema: output({
        code: { type: 'string' }, name: { type: 'string' }, price: { type: 'number' },
        pct: { type: 'number' }, open: { type: 'number' }, high: { type: 'number' }, low: { type: 'number' },
        volume: { type: 'number' }, amount: { type: 'number' },
        marketCap: { type: 'number' }, floatCap: { type: 'number' },
      }, ['code']),
      execute: async (args) => {
        const code = normalizeCode(args.code)
        const r = await emQuote(code)
        if (!r.ok) return fail('SOURCE_FAILED', `行情接口失败：${r.error?.message ?? '未知原因'}`, '可能是限流；稍后重试或改用本地 quant_kline_history')
        return { ok: true, ...r }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : `${v.name}（${v.code}）最新 ${fmt.num(v.price, 2)}  涨跌 ${fmt.pct(v.pct)}  高 ${fmt.num(v.high, 2)} 低 ${fmt.num(v.low, 2)}  成交额 ${fmt.money(v.amount)}  总市值 ${fmt.money(v.marketCap)}`,
    }),

    tool({
      name: 'quant_kline_history',
      description: [
        'K 线历史。**优先读本地库**（快、离线、含复权口径）；库里没有该股票或区间不足时才走网络。',
        '`adjust=raw` 不复权（执行真实性），`adj` 前复权（因子与收益计算用这个）。',
      ].join(' '),
      parameters: S.obj({
        code: S.str('6 位股票代码'),
        from: S.int('起始日 YYYYMMDD'),
        to: S.int('结束日 YYYYMMDD'),
        adjust: S.enum(['raw', 'adj'], '复权口径（默认 raw）'),
        limit: S.int('最多返回多少根（默认 120，从最新往回）'),
      }, ['code']),
      outputSchema: output({
        code: { type: 'string' }, source: { type: 'string' }, adjust: { type: 'string' },
        count: { type: 'integer' },
        bars: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }, ['code', 'count', 'bars']),
      execute: async (args) => {
        const code = normalizeCode(args.code)
        const store = runtime.exists() ? runtime.store() : null
        const limit = Math.min(args.limit ?? 120, 2000)
        const from = args.from ?? 0, to = args.to ?? 99999999
        const adjust = args.adjust ?? 'raw'
        if (store) {
          const view = adjust === 'adj' ? 'bars_adj' : 'bars'
          const rows = store.raw.prepare(
            `SELECT date, open, high, low, close, volume, amount FROM ${view}
             WHERE code=? AND date BETWEEN ? AND ? ORDER BY date DESC LIMIT ?`).all(code, from, to, limit).reverse()
          if (rows.length) return { ok: true, code, source: 'local', adjust, count: rows.length, bars: rows }
        }
        // 本地没有 → 走网络（不复权）
        const r = await emKline(code, { fqt: adjust === 'adj' ? 1 : 0, beg: String(from), end: String(to) })
        if (!r.ok || !r.rows.length) return fail('NO_DATA', `本地与网络都没有 ${code} 在该区间的 K 线`, '先跑 quant_data_sync 同步本地数据')
        const rows = r.rows.slice(-limit)
        return { ok: true, code, source: 'em-online', adjust, count: rows.length, bars: rows }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : `${v.code} ${v.adjust === 'adj' ? '前复权' : '不复权'} ${v.count} 根（来源 ${v.source}）\n` +
          `最新 ${v.bars.at(-1)?.date} 收 ${fmt.num(v.bars.at(-1)?.close, 2)}；最早 ${v.bars[0]?.date} 收 ${fmt.num(v.bars[0]?.close, 2)}`,
    }),

    tool({
      name: 'quant_financial_summary',
      description: [
        '基本面摘要：最新报告期的营收/净利/ROE/每股指标等。**走网络**（东财数据中心）。',
        '注意：基本面是**报告期快照 + 公告日生效**，不做财报重述回溯（见 DATA-SOURCES.md）。',
      ].join(' '),
      parameters: S.obj({
        code: S.str('6 位股票代码'),
        reportDate: S.str('报告期，例如 2024-12-31（不传 = 取该股已入库的最近一期）'),
      }, ['code']),
      outputSchema: output({
        code: { type: 'string' }, reportDate: { type: 'string' },
        rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }, ['code', 'rows']),
      execute: async (args) => {
        const code = normalizeCode(args.code)
        const store = runtime.exists() ? runtime.store() : null
        if (store && !args.reportDate) {
          const local = store.raw.prepare('SELECT * FROM fundamentals WHERE code=? ORDER BY report_date DESC LIMIT 1').get(code)
          if (local) return { ok: true, code, reportDate: local.report_date, source: 'local', rows: [local] }
        }
        if (!args.reportDate) return fail('NO_REPORT_DATE', '本地没有该股的基本面，需要指定 reportDate 才能联网查询')
        const r = await emFundamentals(args.reportDate)
        if (!r.ok) return fail('SOURCE_FAILED', `基本面接口失败：${r.error?.message ?? '未知原因'}`, '可能是限流；稍后重试')
        const rows = r.rows.filter((x) => normalizeCode(x.code) === code)
        if (!rows.length) return fail('NO_DATA', `${code} 在报告期 ${args.reportDate} 没有基本面记录`)
        return { ok: true, code, reportDate: args.reportDate, source: 'em-online', rows }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : `${v.code} 报告期 ${v.reportDate}（${v.source}）：\n` +
          v.rows.slice(0, 1).map((r) => Object.entries(r).filter(([, x]) => x !== null && x !== undefined).slice(0, 12).map(([k, x]) => `  ${k}=${x}`).join('\n')).join('\n'),
    }),

    tool({
      name: 'quant_quarterly_financials',
      description: '按报告期取**全市场**基本面（走网络，一次一期）。用于横截面的价值/质量类因子或筛选。',
      parameters: S.obj({
        reportDate: S.str('报告期，例如 2024-12-31'),
        limit: S.int('最多返回多少条（默认 100）'),
        save: S.bool('是否写入本地库（默认 false）'),
      }, ['reportDate']),
      outputSchema: output({
        reportDate: { type: 'string' }, total: { type: 'integer' }, saved: { type: 'integer' },
        rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }, ['reportDate', 'total', 'rows']),
      execute: async (args) => {
        const r = await emFundamentals(args.reportDate)
        if (!r.ok) return fail('SOURCE_FAILED', `基本面接口失败：${r.error?.message ?? '未知原因'}`, '可能是限流；稍后重试')
        let saved = 0
        if (args.save && runtime.exists()) { saved = runtime.store().upsertFundamentals(r.rows) }
        return { ok: true, reportDate: args.reportDate, total: r.rows.length, saved, rows: r.rows.slice(0, Math.min(args.limit ?? 100, 500)) }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}` : `报告期 ${v.reportDate} 共 ${v.total} 条${v.saved ? `，已入库 ${v.saved} 条` : ''}，返回 ${v.rows.length} 条`,
    }),

    tool({
      name: 'quant_industry_stocks',
      description: [
        '按行业板块取成分股（走网络，东财板块接口）。',
        '该接口的 fs 语法未在 P1 单独验证过，可能失败；失败时请改用 `web_fetch` 抓取（见 quant-sources 技能）。',
      ].join(' '),
      parameters: S.obj({
        industry: S.str('行业名关键词，例如 半导体 / 白酒'),
        limit: S.int('最多返回多少只（默认 100）'),
      }, ['industry']),
      outputSchema: output({
        industry: { type: 'string' }, board: { type: 'object', additionalProperties: true },
        count: { type: 'integer' }, stocks: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }, ['industry', 'count', 'stocks']),
      execute: async (args) => {
        // 行业板块列表：东财 fs=m:90+t:2
        const boards = await emList({ fs: 'm:90+t:2', fields: 'f12,f14', pageSize: 200, maxPages: 3 })
        if (!boards.ok || !boards.rows.length) {
          return fail('SOURCE_FAILED', '行业板块列表拉取失败（可能是限流或接口变动）', '改用 web_fetch 抓取，或先同步全市场后用其他字段筛选')
        }
        const kw = String(args.industry).toLowerCase()
        const hit = boards.rows.find((b) => (b.name ?? '').toLowerCase().includes(kw))
        if (!hit) {
          return fail('NOT_FOUND', `没有匹配「${args.industry}」的行业板块`,
            `可用板块示例：${boards.rows.slice(0, 20).map((b) => b.name).join('、')}`)
        }
        const members = await emList({ fs: `b:${hit.code}`, fields: 'f12,f14,f2,f3', pageSize: 200, maxPages: 10 })
        if (!members.ok) return fail('SOURCE_FAILED', `成分股拉取失败（板块 ${hit.name}）`)
        const limit = Math.min(args.limit ?? 100, 500)
        return {
          ok: true, industry: args.industry, board: { code: hit.code, name: hit.name },
          count: Math.min(members.rows.length, limit),
          stocks: members.rows.slice(0, limit).map((s) => ({ code: normalizeCode(s.code), name: s.name, price: s.price, pct: s.pct })),
        }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}${v.error.hint ? `\n${v.error.hint}` : ''}`
        : `行业「${v.board.name}」(${v.board.code}) 共 ${v.count} 只：${v.stocks.slice(0, 15).map((s) => s.code).join(' ')}${v.count > 15 ? ' …' : ''}`,
    }),

    tool({
      name: 'quant_index_constituents',
      description: [
        '取指数成分股（走网络）。同样依赖东财板块 fs 语法，未单独验证，可能失败。',
        'v1 的基准数据尚未接入指数行情；本工具只给成分名单，不给指数点位。',
      ].join(' '),
      parameters: S.obj({
        index: S.str('指数名或代码，例如 沪深300 / 000300'),
        limit: S.int('最多返回多少只（默认 100）'),
      }, ['index']),
      outputSchema: output({
        index: { type: 'string' }, count: { type: 'integer' },
        stocks: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }, ['index', 'count', 'stocks']),
      execute: async (args) => {
        // 常见指数在东财的板块代码（已公开的固定映射，不做动态发现以免引入不可验证的依赖）
        const KNOWN = {
          '000300': 'b:BK0500', '沪深300': 'b:BK0500', 'sh000300': 'b:BK0500',
          '000905': 'b:BK0501', '中证500': 'b:BK0501',
          '000001': 'b:BK0502', '上证指数': 'b:BK0502',
          '399001': 'b:BK0503', '深证成指': 'b:BK0503',
          '399006': 'b:BK0504', '创业板指': 'b:BK0504',
        }
        const key = String(args.index).trim().toLowerCase()
        const fs = KNOWN[key] ?? KNOWN[key.replace(/^(sh|sz)/, '')]
        if (!fs) {
          return fail('UNKNOWN_INDEX', `没有 ${args.index} 的已知板块映射`,
            `已知：${Object.keys(KNOWN).join('、')}。其他指数请用 web_fetch 抓取。`)
        }
        const r = await emList({ fs, fields: 'f12,f14,f2,f3', pageSize: 200, maxPages: 10 })
        if (!r.ok) return fail('SOURCE_FAILED', `成分股拉取失败（${args.index}）`, '可能是限流；稍后重试或改用 web_fetch')
        const limit = Math.min(args.limit ?? 100, 500)
        return {
          ok: true, index: args.index, count: Math.min(r.rows.length, limit),
          stocks: r.rows.slice(0, limit).map((s) => ({ code: normalizeCode(s.code), name: s.name, price: s.price, pct: s.pct })),
        }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}${v.error.hint ? `\n${v.error.hint}` : ''}`
        : `${v.index} 成分 ${v.count} 只：${v.stocks.slice(0, 15).map((s) => s.code).join(' ')}${v.count > 15 ? ' …' : ''}`,
    }),

    tool({
      name: 'quant_trading_calendar',
      description: [
        '交易日历。**从本地行情里推导**（实际发生过交易的日期），比任何外部日历表都可靠。',
        '仓库为空时返回空列表 —— 这不是错误，只是还没同步数据。',
      ].join(' '),
      parameters: S.obj({
        from: S.int('起始日 YYYYMMDD'),
        to: S.int('结束日 YYYYMMDD'),
        limit: S.int('最多返回多少天（默认 60，从区间末尾往回）'),
      }, []),
      outputSchema: output({
        count: { type: 'integer' }, dates: { type: 'array', items: { type: 'integer' } },
        // 仓库为空 / 区间内无数据时是 null —— 不声明可空会被宿主校验拦成 INVALID_TOOL_OUTPUT
        first: nullable({ type: 'integer' }), last: nullable({ type: 'integer' }),
      }, ['count', 'dates']),
      execute: (args) => {
        if (!runtime.exists()) return { ok: true, count: 0, dates: [], first: null, last: null }
        const all = tradingDates(runtime.store(), args.from ?? 0, args.to ?? 99999999)
        const limit = Math.min(args.limit ?? 60, 5000)
        return { ok: true, count: all.length, dates: all.slice(-limit), first: all[0] ?? null, last: all.at(-1) ?? null }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : v.count === 0 ? '本地没有交易日数据（仓库为空或区间内无数据）'
          : `共 ${v.count} 个交易日，${fmt.date(v.first)} ~ ${fmt.date(v.last)}；返回末尾 ${v.dates.length} 天`,
    }),

    tool({
      name: 'quant_resolve_date',
      description: [
        '把模糊的时间说法解析成具体交易日：`latest` 最新、`-20d` 往前 20 个交易日、',
        '`2024-01-01` 具体日期（自动对齐到当日或之前最近的交易日）、`ytd` 今年首个交易日。',
        '用于把用户说的"最近一个月""年初至今"落到可计算的区间上。',
      ].join(' '),
      parameters: S.obj({
        expr: S.str('时间说法，例如 latest / -20d / 2024-01-01 / ytd'),
        from: S.int('用于对齐的区间起点（可选）'),
      }, ['expr']),
      outputSchema: output({
        expr: { type: 'string' }, date: { type: 'integer' }, isTradingDay: { type: 'boolean' },
      }, ['expr', 'date']),
      execute: (args) => {
        if (!runtime.exists()) return fail('NO_STORE', '仓库不存在，无法解析交易日', '先跑 quant_data_sync')
        const store = runtime.store()
        const dates = tradingDates(store)
        if (!dates.length) return fail('NO_DATA', '本地没有交易日数据')
        const latest = dates.at(-1)
        const expr = String(args.expr).trim().toLowerCase()

        let target = null
        if (expr === 'latest' || expr === '最新' || expr === '今天' || expr === 'now') target = latest
        else if (expr === 'ytd' || expr === '年初至今') {
          const y = Math.floor(latest / 10000)
          target = dates.find((d) => Math.floor(d / 10000) === y) ?? dates[0]
        } else {
          const rel = /^-(\d+)d$/.exec(expr)
          if (rel) {
            const idx = Math.max(0, dates.length - 1 - Number(rel[1]))
            target = dates[idx]
          } else {
            const digits = expr.replace(/[^0-9]/g, '')
            if (digits.length === 8) {
              const want = Number(digits)
              if (dayOrdinal(want) === null) return fail('BAD_DATE', `${args.expr} 不是合法日期`)
              target = dates.filter((d) => d <= want).at(-1) ?? null
              if (target === null) return fail('OUT_OF_RANGE', `${args.expr} 早于本地数据起点 ${dates[0]}`)
            }
          }
        }
        if (target === null) {
          return fail('BAD_EXPR', `无法解析「${args.expr}」`,
            '支持：latest / -20d / ytd / YYYY-MM-DD 或 YYYYMMDD')
        }
        return { ok: true, expr: args.expr, date: target, isTradingDay: dates.includes(target) }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}${v.error.hint ? `\n${v.error.hint}` : ''}`
        : `「${v.expr}」→ ${fmt.date(v.date)}${v.isTradingDay ? '（交易日）' : '（非交易日，已对齐到之前最近交易日）'}`,
    }),
  ]
}

export { tradingDates }

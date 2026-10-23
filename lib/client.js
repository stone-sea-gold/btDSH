/**
 * dsh-quant-assistant — 浏览器半。
 *
 * 客户端契约与普通 ESM 不同（P0-G4 实测）：文件在 `window.__ModuleLoader__.load({id, factory})`
 * 里返回 `module.exports`；`require` 由模块系统解析（react 由内核提供）。
 * 这种格式可以手写，不依赖 DSH 单体仓库的构建管线。
 *
 * ## 数据怎么从宿主到卡片
 *
 * 客户端**没有**通用的 host RPC 通道（`harness.handle` / `host.call` 是动态 Cordis Package
 * 专有的，bundle 拿不到）。所以卡片的数据来自 **`block.meta`**：
 * 宿主侧工具声明 `output.presentationMeta(args, value)`，DSH 把它挂到 `tool/result` 事件的
 * `meta` 上，客户端从 `ToolResultNode.meta` 读。`content` 里只有渲染后的文本，没有结构。
 *
 * 这意味着：
 *   - 卡片是**工具结果的纯函数**：不订阅、不轮询、不持有状态
 *   - 加一张新卡片 = 宿主侧加 `presentationMeta` + 这里注册一个 keyed toolview
 *   - 设置页拿不到实时宿主状态（那需要 RPC），所以它只给**静态信息与操作指引**，不编数据
 *
 * ## 布局约束
 *
 * 所有卡片必须在 **320px** 宽度下不溢出：`width:100%` + `minWidth:0` + `flexWrap`，
 * 不写死像素宽度；SVG 用 `viewBox` + `width:100%` 自适应。指标块用 `flex: 1 1 72px`
 * 而不是固定宽度，窄屏时自动换行。
 */

window.__ModuleLoader__.load({
  id: 'dsh-quant-assistant',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const inject = ['slots', 'sessions']

    // ── 主题令牌（都要求明暗双态，直接引用变量即可自动跟随主题）──────────────
    const T = {
      bg: 'var(--dsw-alias-bg-layer-1)',
      bgNested: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      label: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      // A 股口径：涨用红、跌用绿
      up: 'var(--dsw-alias-state-error-primary)',
      down: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    }

    // ── 格式化 ──────────────────────────────────────────────────────────────
    const pct = (x, d) => (x === null || x === undefined || Number.isNaN(x) ? '—' : (x * 100).toFixed(d === undefined ? 2 : d) + '%')
    const num = (x, d) => (x === null || x === undefined || Number.isNaN(x) ? '—' : Number(x).toFixed(d === undefined ? 2 : d))
    const money = (x) => (x === null || x === undefined ? '—' : Math.round(x).toLocaleString('zh-CN'))
    const dstr = (x) => (x === null || x === undefined ? '—' : String(x).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'))
    const tone = (x) => (x === null || x === undefined ? T.label2 : x >= 0 ? T.up : T.down)

    /**
     * 颜色参数解析：既接受 `T.down` 这样的令牌变量，也接受 `'down'` 这样的语义名。
     *
     * 为什么要有这层：真实浏览器验证抓到过 `chip('已开启', 'down')` —— 传的是字符串字面量，
     * CSS 里 `color: down` 是非法值，于是**静默**回退成继承色，"已开启"看起来和普通文字一样。
     * 这种错误既不抛错也不报错，只有量计算样式才发现得了。
     * 与其靠人记得写 `T.`，不如让两种写法都正确。
     */
    const cssColor = (v) => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(T, v) ? T[v] : v)

    // ── 基础件 ──────────────────────────────────────────────────────────────
    const card = (children) => h('div', {
      style: {
        display: 'flex', flexDirection: 'column', gap: '8px',
        width: '100%', minWidth: 0, boxSizing: 'border-box',
        padding: '10px 12px', borderRadius: '10px',
        background: T.bg, border: '0.5px solid ' + T.border,
        color: T.label, fontSize: '13px', lineHeight: 1.5,
      },
    }, children)

    const row = (key, children) => h('div', {
      key,
      style: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'baseline', minWidth: 0 },
    }, children)

    /**
     * 一个指标块。
     *
     * `basis` 是**换行阈值**，不是宽度：`flex: 1 1 <basis>` 让它在宽屏铺满、
     * 窄屏按 basis 决定一行放几个。为什么这个参数必须可按卡片调：
     * 4 个指标时 72px 的 basis 在 320px 卡片上会挤成 **3+1**（第 4 个孤零零掉到下一行，
     * 左对齐在第一列下面，很难看）；换成 110px 就变成整齐的 **2×2**。
     * 而 3 个指标的卡片用 72px 恰好能一行放下 3 个，换成 110px 反而变成 2+1。
     * 所以 4 指标用 110、3 指标用 72 —— 这个差异是**看着截图**调出来的。
     */
    const metric = (label, value, color, basis) => h('div', {
      key: label,
      style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0, flex: `1 1 ${basis || 72}px` },
    }, [
      h('span', { key: 'l', style: { fontSize: '11px', color: T.label2 } }, label),
      h('span', { key: 'v', style: { fontSize: '14px', fontVariantNumeric: 'tabular-nums', color: cssColor(color) || T.label } }, value),
    ])

    const caption = (text, color) => h('div', {
      key: 'cap' + text,
      style: { fontSize: '11px', color: cssColor(color) || T.label2, wordBreak: 'break-word', minWidth: 0 },
    }, text)

    const chip = (text, color) => h('span', {
      key: 'chip' + text,
      style: {
        fontSize: '11px', padding: '1px 6px', borderRadius: '6px',
        border: '0.5px solid ' + T.border2, color: cssColor(color) || T.label2, whiteSpace: 'nowrap',
      },
    }, text)

    /** 可折叠明细：默认收起，避免卡片在小屏上被撑长 */
    const details = (key, summary, body) => h('details', { key, style: { minWidth: 0 } }, [
      h('summary', { key: 's', style: { cursor: 'pointer', fontSize: '12px', color: T.label2 } }, summary),
      h('div', { key: 'b', style: { marginTop: '6px', minWidth: 0 } }, body),
    ])

    // ── 净值曲线（手写 SVG，无第三方图表库）────────────────────────────────
    function navPath(points, w, hgt) {
      const navs = points.map((p) => p.nav)
      const lo = Math.min.apply(null, navs), hi = Math.max.apply(null, navs)
      const span = hi - lo || 1
      const step = points.length > 1 ? w / (points.length - 1) : w
      return points.map((p, i) => {
        const x = i * step
        const y = hgt - ((p.nav - lo) / span) * hgt
        return (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2)
      }).join(' ')
    }

    function NavChart(props) {
      const nav = props.nav || []
      if (nav.length < 2) return caption('（没有净值曲线）')
      const W = 300, H = 64
      const gain = nav[nav.length - 1].nav >= nav[0].nav
      const color = gain ? T.up : T.down
      const d = navPath(nav, W, H)
      const area = d + ' L' + W + ' ' + H + ' L0 ' + H + ' Z'
      return h('div', { style: { width: '100%', minWidth: 0 } }, [
        h('svg', {
          key: 'svg', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none',
          width: '100%', height: '64px', style: { display: 'block' },
          role: 'img', 'aria-label': '净值曲线',
        }, [
          h('path', { key: 'a', d: area, fill: color, opacity: 0.12, stroke: 'none' }),
          h('path', { key: 'l', d, fill: 'none', stroke: color, strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke' }),
        ]),
        h('div', {
          key: 'ax',
          style: { display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: T.label2, marginTop: '2px' },
        }, [h('span', { key: 'a' }, dstr(nav[0].date)), h('span', { key: 'b' }, dstr(nav[nav.length - 1].date))]),
      ])
    }

    // ── 卡片 1：回测结果 ────────────────────────────────────────────────────
    function BacktestCard(props) {
      const meta = props.block && props.block.meta
      if (!meta || meta.kind !== 'backtest') return null
      if (meta.ok === false) return card([h('strong', { key: 't' }, '回测失败'), caption(meta.message, T.up)])
      const m = meta.metrics || {}
      const b = m.benchmark
      return card([
        row('head', [
          h('strong', { key: 't', style: { minWidth: 0 } }, '回测 ' + meta.strategyId),
          chip(meta.backtestId),
        ]),
        caption(dstr(meta.range[0]) + ' ~ ' + dstr(meta.range[1]) + ' · ' + meta.days + ' 个交易日 · 调仓 ' + meta.rebalances + ' 次'),
        h(NavChart, { key: 'chart', nav: meta.nav }),
        row('m1', [
          metric('总收益', pct(m.totalReturn), tone(m.totalReturn), 110),
          metric('年化', pct(m.cagr), tone(m.cagr), 110),
          metric('夏普', num(m.sharpe), null, 110),
          metric('最大回撤', pct(m.maxDrawdown), T.down, 110),
        ]),
        row('m2', [
          metric('波动', pct(m.annualVol), null, 110),
          metric('Calmar', num(m.calmar), null, 110),
          metric('胜率', pct(m.winRate), null, 110),
          metric('年化换手', num(m.turnover, 1), null, 110),
        ]),
        b ? caption('基准 ' + pct(b.totalReturn) + ' · 超额 ' + pct(b.excessReturn) + ' · Beta ' + num(b.beta) + ' · IR ' + num(b.informationRatio)) : null,
        caption('成交 ' + m.trades + ' 笔 · 费用 佣金 ' + money(m.fees && m.fees.commission)
          + ' / 印花税 ' + money(m.fees && m.fees.stampDuty) + ' / 过户费 ' + money(m.fees && m.fees.transferFee)),
        (meta.byFactor && meta.byFactor.length > 1)
          ? details('byf', '分因子表现', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
            meta.byFactor.map((f) => h('div', { key: f.factorId, style: { display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12px' } }, [
              h('span', { key: 'n', style: { color: T.label2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, f.factorId),
              h('span', { key: 'v', style: { fontVariantNumeric: 'tabular-nums', color: tone(f.cagr) } }, pct(f.cagr)),
            ]))))
          : null,
        (meta.caveats && meta.caveats.length)
          ? details('cav', '口径声明（' + meta.caveats.length + ' 条）',
            h('ul', { style: { margin: 0, paddingLeft: '16px', fontSize: '11px', color: T.label2, lineHeight: 1.6 } },
              meta.caveats.map((c, i) => h('li', { key: i }, c))))
          : null,
      ])
    }

    // ── 卡片 2：数据状态 ────────────────────────────────────────────────────
    function DataStatusCard(props) {
      const meta = props.block && props.block.meta
      if (!meta || meta.kind !== 'dataStatus') return null
      if (!meta.ready) {
        return card([
          h('strong', { key: 't' }, '数据仓库尚未就绪'),
          caption(meta.dir || ''),
          caption('在会话里说「先同步代码表和行情」即可开始。'),
        ])
      }
      const f = meta.freshness || {}
      const auto = meta.autoSync || {}
      return card([
        row('head', [
          h('strong', { key: 't' }, '数据仓库'),
          meta.stale ? chip('已过期', T.warn) : chip('新鲜', T.down),
          auto.enabled ? chip('自动同步已开', T.down) : null,
          meta.panelsBehind ? chip(meta.panelsBehind + ' 个面板落后', T.warn) : null,
        ]),
        row('m', [
          metric('股票数', String(meta.codes)),
          metric('行情根数', money(meta.bars)),
          metric('复权事件', String(meta.adjEvents)),
        ]),
        caption('区间 ' + dstr(meta.range && meta.range[0]) + ' ~ ' + dstr(meta.range && meta.range[1])
          + (meta.uncovered ? ' · 未覆盖 ' + meta.uncovered + ' 只' : '')
          + (meta.pendingCount ? ' · 待续传 ' + meta.pendingCount + ' 只' : '')),
        caption('距今 ' + (f.weekdays === null || f.weekdays === undefined ? '—' : f.weekdays) + ' 个工作日'
          + (f.calendarDays === null || f.calendarDays === undefined ? '' : ' / ' + f.calendarDays + ' 个自然日')
          + '（阈值 ' + meta.staleDays + ' 个工作日；跳过周末，不识别节假日）'),
        auto.enabled
          ? caption('自动同步：每天 ' + auto.at + (auto.lastOutcome ? ' · 上次 ' + auto.lastOutcome + '（' + dstr(auto.lastAttemptDate) + '）' : ''))
          : (meta.stale ? caption('提示：可用 quant_autosync 开启盘后自动增量同步，之后数据会自己保持新鲜。', T.warn) : null),
        (meta.panels && meta.panels.length)
          ? details('pnl', '因子面板（' + meta.panels.length + '）',
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
              meta.panels.map((p) => h('div', { key: p.factorId, style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } }, [
                h('span', { key: 'n', style: { color: T.label2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, p.factorId),
                h('span', { key: 'v', style: { fontVariantNumeric: 'tabular-nums' } }, dstr(p.lastDate) + (p.behindDays ? ' (−' + p.behindDays + 'd)' : '')),
              ]))))
          : null,
        caption('数据全部保存在本地，不上传任何内容。'),
      ])
    }

    // ── 卡片 3：数据同步 ────────────────────────────────────────────────────
    function DataSyncCard(props) {
      const meta = props.block && props.block.meta
      if (!meta || meta.kind !== 'dataSync') return null
      const running = props.block && props.block.kind !== 'tool-result'
      if (running) {
        return card([h('strong', { key: 't' }, '同步中…'), caption('数据抓取与入库正在进行。')])
      }
      if (meta.approvalRequired || meta.phase === 'approval') {
        return card([
          h('strong', { key: 't' }, '同步需要确认'),
          caption('规模：' + meta.estimate.codes + ' 只 · 约 ' + meta.estimate.approxRequests + ' 次请求 · 约 ' + meta.estimate.approxMinutes + ' 分钟'),
          caption('这是一次重操作。同意后助手会带 confirm=true 重试。', T.warn),
        ])
      }
      // 估算态：`estimateOnly` 的调用**没有** ms 字段，早期版本用 `ms === null` 当"运行中"，
      // 于是估算结果被显示成"同步中…"（明明什么都没在跑）。这是真实浏览器验证抓出来的。
      if (meta.phase === 'estimate') {
        return card([
          h('strong', { key: 't' }, '规模估算（尚未同步）'),
          caption('规模：' + meta.estimate.codes + ' 只 · 约 ' + meta.estimate.approxRequests + ' 次请求 · 约 ' + meta.estimate.approxMinutes + ' 分钟'),
          caption(meta.estimate.reason || ''),
        ])
      }
      if (meta.ms === null || meta.ms === undefined) {
        return card([h('strong', { key: 't' }, '同步中…'), caption('数据抓取与入库正在进行。')])
      }
      return card([
        row('head', [
          h('strong', { key: 't' }, '同步完成'),
          chip((meta.ms / 1000).toFixed(1) + 's'),
          meta.failed ? chip('失败 ' + meta.failed, T.up) : chip('无失败', T.down),
        ]),
        row('m', [
          metric('行情', money(meta.bars) + ' 根'),
          metric('复权事件', String(meta.events)),
          metric('跳过', String(meta.skipped)),
        ]),
        (meta.fromTable || meta.droppedNoPrevBar)
          ? caption('离线事件表生效 ' + meta.fromTable + ' 条'
            + (meta.droppedNoPrevBar ? ' · 因缺前收盘丢弃 ' + meta.droppedNoPrevBar + ' 条' : ''))
          : null,
        (meta.errors && meta.errors.length)
          ? details('err', '失败明细（' + meta.errors.length + '）',
            h('ul', { style: { margin: 0, paddingLeft: '16px', fontSize: '11px', color: T.up } },
              meta.errors.map((e, i) => h('li', { key: i }, e.code + '：' + e.message))))
          : null,
        caption('同步可中断：再次调用会从断点续传。'),
      ])
    }

    // ── 卡片 4：选股结果 ────────────────────────────────────────────────────
    function SelectCard(props) {
      const meta = props.block && props.block.meta
      if (!meta || meta.kind !== 'select') return null
      if (meta.ok === false) return card([h('strong', { key: 't' }, '选股失败'), caption(meta.message, T.up)])
      const rej = Object.entries(meta.rejected || {})
      const label = { st: 'ST', suspended: '停牌', 'new-listing': '次新', 'unknown-code': '未知代码' }
      return card([
        row('head', [
          h('strong', { key: 't' }, '选股 · ' + dstr(meta.date)),
          chip(meta.path === 'panel' ? '面板' : '现场求值'),
        ]),
        meta.dateAdjusted ? caption('⚠️ ' + meta.dateAdjusted.reason, T.warn) : null,
        caption('股票池 ' + meta.universeSize + ' 只 → 通过 ' + meta.passedUniverse + ' 只'
          + (rej.length ? ' · 拒绝 ' + rej.map(([k, n]) => (label[k] || k) + '×' + n).join(' ') : '')),
        h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
          (meta.picks || []).slice(0, 10).map((p) => h('div', {
            key: p.code,
            style: { display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '12px', minWidth: 0 },
          }, [
            h('span', { key: 'r', style: { color: T.label2, width: '24px', flex: 'none', textAlign: 'right' } }, '#' + p.rank),
            h('span', { key: 'c', style: { fontVariantNumeric: 'tabular-nums', flex: 'none' } }, p.code),
            h('span', { key: 'n', style: { color: T.label2, flex: '1 1 40px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.name || ''),
            h('span', { key: 'v', style: { fontVariantNumeric: 'tabular-nums', flex: 'none' } }, num(p.value, 4)),
          ]))),
        caption('这是按因子排序的候选名单，不构成投资建议。'),
      ])
    }

    // ── 卡片 5：自动同步 ────────────────────────────────────────────────────
    // 结果类别 → 人话。宿主侧只给机器可读的 outcome，措辞留在这里（改文案不用动宿主）。
    const OUTCOME = {
      ok: ['有新增数据', 'down'],
      noNewData: ['无新数据（非交易日或源站未出）', null],
      staleSource: ['库里没有前进（源站数据不完整）', 'warn'],
      noCodes: ['库里没有已同步的股票', 'warn'],
      exceededCap: ['超出硬上限，本次跳过', 'warn'],
      error: ['出错', 'up'],
      aborted: ['被中断', 'warn'],
      disabled: ['未开启', null],
      busy: ['上一次还在运行', null],
    }

    function AutoSyncCard(props) {
      const meta = props.block && props.block.meta
      if (!meta || meta.kind !== 'autoSync') return null
      if (meta.ok === false) return card([h('strong', { key: 't' }, '自动同步失败'), caption(meta.message, T.up), meta.hint ? caption(meta.hint) : null])
      const s = meta.state || {}
      const r = meta.result
      const last = s.lastOutcome ? OUTCOME[s.lastOutcome] : null
      const nextText = meta.nextDueAt ? new Date(meta.nextDueAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : null
      return card([
        row('head', [
          h('strong', { key: 't' }, '自动同步'),
          s.enabled ? chip('已开启', T.down) : chip('未开启'),
          s.enabled && !meta.timer ? chip('当前进程无 timer', T.warn) : null,
        ]),
        s.enabled
          ? caption('每天 ' + s.at + ' 增量同步 · ' + (s.scopeKind === 'explicit' ? s.scope + ' 只（指定）' : '库内已同步的全部') + ' · 单次上限 ' + s.maxCodes + ' 只')
          : caption('开启后每天收盘后自动把本地已有股票增量补到当天；需要用户明确同意。'),
        nextText ? caption('下次执行 ' + nextText) : null,
        last ? row('m', [
          metric('上次结果', last[0], last[1] === 'down' ? T.down : last[1] === 'up' ? T.up : last[1] === 'warn' ? T.warn : null),
          metric('上次运行', dstr(s.lastAttemptDate)),
          metric('上次成功', dstr(s.lastSuccessDate)),
        ]) : null,
        r ? caption('本次：' + r.text + (r.scope ? ' · ' + r.scope + ' 只' : '') + (r.bars ? ' · 新增 ' + r.bars + ' 根 bar' : '')) : null,
        r && r.probe ? caption('探测 ' + r.probe.checked + ' 只，最新 ' + dstr(r.probe.latest) + '，' + (r.probe.advanced ? '有新数据' : '无新数据')) : null,
        r && r.message ? caption(r.message, T.warn) : null,
        s.skipReason ? caption('跳过原因：' + s.skipReason, T.warn) : null,
        s.lastError ? caption('上次错误：' + s.lastError, T.up) : null,
        s.consentAt ? caption('授权于 ' + new Date(s.consentAt).toISOString().slice(0, 10) + '（' + (s.consentBy || '—') + '）· 累计运行 ' + (s.runCount || 0) + ' 次') : null,
        meta.note ? caption(meta.note, T.warn) : null,
      ])
    }

    // ── 卡片 6：导出交付物 ──────────────────────────────────────────────────
    function ExportCard(props) {
      const meta = props.block && props.block.meta
      if (!meta || meta.kind !== 'export') return null
      if (meta.ok === false) return card([h('strong', { key: 't' }, '导出失败'), caption(meta.message, T.up), meta.hint ? caption(meta.hint) : null])
      const where = { workspace: '会话工作目录', 'data-dir': '数据目录', explicit: '指定目录', cwd: '进程当前目录' }[meta.where] || meta.where
      const kindText = { backtest: '回测报告', select: '选股名单', holdings: '持仓估值', panel: '因子面板', data_status: '数据状态' }[meta.exportKind] || meta.exportKind
      return card([
        row('head', [
          h('strong', { key: 't' }, '已导出 · ' + kindText),
          chip(meta.files.length + ' 个文件'),
        ]),
        h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 } },
          meta.files.map((f) => h('div', {
            key: f.path,
            style: { display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '12px', minWidth: 0 },
          }, [
            h('span', { key: 'n', style: { fontVariantNumeric: 'tabular-nums', flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.filename),
            h('span', { key: 's', style: { color: T.label2, flex: 'none', fontSize: '11px' } }, (f.bytes / 1024).toFixed(1) + ' KB'),
          ]))),
        caption('落点：' + where + ' · ' + meta.dir),
        caption('文件里已带口径声明与免责声明，可直接交给用户。'),
      ])
    }

    // ── 设置页 ──────────────────────────────────────────────────────────────
    function SettingsSection() {
      const box = { padding: '16px', lineHeight: 1.7, maxWidth: '640px', width: '100%', minWidth: 0, boxSizing: 'border-box', color: T.label }
      const para = { margin: '8px 0', color: T.label2 }
      const head = (text) => h('div', { key: 'h' + text, style: { marginTop: '14px', fontWeight: 600 } }, text)
      const code = {
        fontFamily: 'var(--dsw-font-markdown-code-block-small, monospace)', fontSize: '12px',
        background: T.bgNested, border: '0.5px solid ' + T.border, borderRadius: '6px',
        padding: '8px 10px', margin: '6px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }
      return h('div', { style: box }, [
        h('strong', { key: 't' }, 'dsh-quant-assistant'),
        h('p', { key: 'p1', style: para }, '量化能力已装好：31 个 quant_* 工具、审批护栏，以及「量化助手」preset（含四个技能）。'),

        head('数据位置'),
        h('p', { key: 'p2', style: para }, '全部数据保存在本地，不上传任何内容。默认路径：'),
        h('div', { key: 'c1', style: code }, '$DSH_HOME/quant/quant.db'),
        h('p', { key: 'p3', style: para }, '可用环境变量 DSH_QUANT_DATA_DIR 覆盖。内存受限的机器可设 DSH_QUANT_TEMP_STORE=file（峰值内存约降 65%，耗时 +18%）。'),

        head('保持数据新鲜'),
        h('p', { key: 'p4', style: para }, '在会话里说「开启每天收盘后自动同步数据」，助手会调用 quant_autosync。这是一次长期授权：开启后每天在指定时刻（默认 18:30）增量同步本地已有的股票，不再逐次询问。'),
        h('p', { key: 'p5', style: para }, '自动同步**默认关闭**。DSH 没在运行时不会执行，但下次启动会补跑被错过的那一次。想关掉随时说「关闭自动同步」。'),
        h('p', { key: 'p6', style: para }, '数据新鲜度按**工作日**计算（跳过周末，不识别节假日）；未同步到今天不一定是异常，先看自动同步的上次结果。'),

        head('导出交付物'),
        h('p', { key: 'p7', style: para }, '说「把这次回测导出成报告」，助手会调用 quant_export，把结果写成 Markdown / CSV 落到**会话工作目录**的 quant-exports/ 下，再声明为交付物。文件自带口径声明与免责声明。'),

        head('查看与清理数据'),
        h('p', { key: 'p8', style: para }, '在会话里说「看看数据状态」，助手会调用 quant_data_status，结果会在这里渲染成卡片（覆盖范围、新鲜度、面板落后情况）。'),
        h('p', { key: 'p9', style: para }, '清理也在会话里完成：说「清理因子面板」走 quant_data_cleanup；删除全部行情需要二次确认。清理行情**不会**关闭自动同步，也不会抹掉已有的授权记录。'),

        head('免责声明'),
        h('p', { key: 'p10', style: { margin: '8px 0', color: T.label, fontWeight: 600 } },
          '本工具只做历史数据的统计分析与回测，不提供投资建议、不预测股价、不推荐个股。'),
        h('p', { key: 'p11', style: para }, '回测结果是对历史的统计描述，包含已知的数据覆盖边界（见 quant-sources 技能），不构成对未来收益的任何承诺。'),

        head('已知限制'),
        h('ul', { key: 'ul', style: { margin: '6px 0', paddingLeft: '18px', color: T.label2, fontSize: '12px' } }, [
          h('li', { key: '1' }, '回测基准是区间内等权买入持有代理，v1 未接入指数行情'),
          h('li', { key: '2' }, 'ST 状态使用当前快照，非历史逐日状态'),
          h('li', { key: '3' }, '仓位与止损规则是声明性配置，不会自动下单'),
          h('li', { key: '4' }, '自动同步只跳过周末，不识别节假日；非交易日会空跑一次（探测阶段，代价很小）'),
        ]),
      ])
    }

    // ── 主区「回测」视图页 ──────────────────────────────────────────────────
    // `conversation.view` 是官方开放的 list slot（会话作用域），注册即多一个标签页。
    // 页面只取清单与选中项；报告本身用 iframe 指向 `/quant/report/<id>`：
    // 同一份 HTML 既能嵌在这里看，也能在新标签页直接打开（这就是可分享的深链）。
    const RUNS_API = '/quant/api/runs'
    const REPORT_API = '/quant/report/'

    // 工具条外观对齐 DSH 自身的控件：30px 高、9px 圆角、0.5px 描边、hover 用交互底色。
    // 内联 style 写不了 :hover/:focus-visible，所以这里注入一份**只属于本视图**的样式表，
    // 颜色全部走宿主的设计变量（浅色/深色主题自动跟随，不硬编码色值）。
    const VIEW_CSS_ID = 'dsh-quant-view-style'
    const VIEW_CSS = `
      .dq-toolbar{display:flex;align-items:center;gap:8px;padding:8px 14px;flex-wrap:wrap;row-gap:8px;
        border-bottom:0.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base)}
      .dq-field{display:inline-flex;align-items:center;gap:6px;min-width:0;height:30px}
      .dq-lab{display:inline-flex;align-items:center;height:30px;line-height:1;
        font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
      .dq-select{position:relative;display:inline-flex;align-items:center;min-width:0}
      /* 原生下拉：展开行为完全交给浏览器（点击、键盘、滚动都由它负责），
         只在支持 Customizable Select 的浏览器（Chrome 135+）里定制弹出层的皮肤。 */
      .dq-native{height:30px;box-sizing:border-box;padding:0 26px 0 10px;border-radius:9px;
        border:0.5px solid var(--dsw-alias-border-l2);
        background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
        font-size:13px;line-height:28px;vertical-align:middle;cursor:pointer;max-width:300px;
        transition:background .12s ease,border-color .12s ease}
      .dq-native:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
      .dq-native:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
      .dq-native:disabled{opacity:.45;cursor:default}
      .dq-native, .dq-native::picker(select){appearance:base-select}
      .dq-native::picker(select){margin-block:6px;padding:4px;border-radius:12px;
        border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);
        box-shadow:0 12px 32px rgba(0,0,0,.16),0 2px 8px rgba(0,0,0,.08)}
      .dq-native option{padding:7px 10px;border-radius:8px;font-size:13px;
        color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
      .dq-native option:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dq-native option:checked{color:var(--dsw-alias-state-business-primary)}
      .dq-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border-radius:9px;
        border:0.5px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);
        font-size:13px;line-height:1;cursor:pointer;text-decoration:none;white-space:nowrap;
        transition:background .12s ease,color .12s ease}
      .dq-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .dq-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
      .dq-btn.dq-accent{color:var(--dsw-alias-state-business-primary)}
      .dq-spacer{flex:1 1 auto;min-width:8px}
      .dq-meta{font-size:12px;color:var(--dsw-alias-label-tertiary);max-width:40ch;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dq-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;
        gap:10px;padding:32px 24px;text-align:center}
      .dq-empty-title{font-size:14px;color:var(--dsw-alias-label-primary)}
      .dq-empty-hint{font-size:13px;line-height:1.8;color:var(--dsw-alias-label-tertiary);max-width:52ch}
    `

    function ensureViewStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(VIEW_CSS_ID)) return
      const el = document.createElement('style')
      el.id = VIEW_CSS_ID
      el.textContent = VIEW_CSS
      document.head.appendChild(el)
    }

    // 图标：12px 线性图标，笔画 1.5，颜色随 currentColor（不引入图标字体或额外依赖）
    function icon(d, size = 12) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 12 12', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, h('path', { d }))
    }

    function workspaceLabel(w) {
      const base = String(w.path || '').split(/[\\/]/).filter(Boolean).pop()
      return base || w.path
    }

    // 行盒尺寸写死成常量：样式表万一没注入、或被宿主全局规则覆盖，内联样式仍能保证文字垂直居中
    const NATIVE_SELECT_STYLE = {
      height: '30px', lineHeight: '28px', padding: '0 26px 0 10px', verticalAlign: 'middle',
    }

    function OptionList(items, value) {
      return items.map((it) => h('option', { key: it.value, value: it.value, title: it.title }, it.label))
    }

    function BacktestView(props) {
      ensureViewStyle()
      const cwd = props?.cwd ?? null
      const [scope, setScope] = React.useState(cwd ?? '') // '' = 全部工作区
      const [nonce, setNonce] = React.useState(0)
      const [data, setData] = React.useState({ phase: 'loading', error: null, workspaces: [], runs: [] })
      const [selected, setSelected] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        setData((d) => ({ ...d, phase: 'loading', error: null }))
        const url = scope ? `${RUNS_API}?cwd=${encodeURIComponent(scope)}` : RUNS_API
        fetch(url, { headers: { accept: 'application/json' } })
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            return r.json()
          })
          .then((body) => {
            if (!alive) return
            const runs = Array.isArray(body.runs) ? body.runs : []
            setData({ phase: 'ready', error: null, workspaces: body.workspaces || [], runs })
            // 默认看最新一条（清单已按时间倒序），选中项失效时同样退回最新
            setSelected((cur) => (runs.some((x) => x.backtestId === cur) ? cur : (runs[0]?.backtestId ?? null)))
          })
          .catch((e) => {
            if (alive) setData({ phase: 'error', error: e?.message ?? String(e), workspaces: [], runs: [] })
          })
        return () => { alive = false }
      }, [scope, nonce])

      const run = data.runs.find((x) => x.backtestId === selected) ?? null
      const workspaces = data.workspaces

      const wsItems = [{ value: '', label: '全部工作区', title: undefined },
        ...workspaces.map((w) => ({ value: w.path, label: workspaceLabel(w), title: w.path }))]
      const runItems = data.runs.map((r) => ({
        value: r.backtestId,
        label: `${r.name} · ${new Date(r.createdAt || 0).toISOString().slice(0, 10)}`,
        title: r.description || r.name,
      }))

      const toolbar = h('div', { key: 'toolbar', className: 'dq-toolbar' }, [
        h('div', { key: 'ws', className: 'dq-field' }, [
          h('span', { key: 'l', className: 'dq-lab', style: { display: 'inline-flex', alignItems: 'center', height: '30px' } }, '工作区'),
          h('span', { key: 's', className: 'dq-select' }, [
            h('select', {
              key: 'sel', className: 'dq-native', value: scope, 'aria-label': '工作区',
              style: NATIVE_SELECT_STYLE,
              onChange: (e) => setScope(e.target.value),
            }, OptionList(wsItems, scope)),
          ]),
        ]),
        h('div', { key: 'run', className: 'dq-field' }, [
          h('span', { key: 'l', className: 'dq-lab', style: { display: 'inline-flex', alignItems: 'center', height: '30px' } }, '回测'),
          h('span', { key: 's', className: 'dq-select' }, [
            h('select', {
              key: 'sel', className: 'dq-native', value: selected ?? '', 'aria-label': '回测记录',
              style: NATIVE_SELECT_STYLE,
              disabled: data.runs.length === 0,
              onChange: (e) => setSelected(e.target.value || null),
            }, runItems.length
              ? OptionList(runItems, selected)
              : h('option', { key: 'e', value: '' }, data.phase === 'loading' ? '读取中…' : '暂无回测')),
          ]),
        ]),
        h('span', { key: 'spacer', className: 'dq-spacer' }),
        h('button', { key: 'refresh', type: 'button', className: 'dq-btn', title: '重新读取', onClick: () => setNonce((n) => n + 1) },
          [icon('M10.4 6a4.4 4.4 0 1 1-1.3-3.1M10.4 1.9v2.6H7.8', 12), '刷新']),
        run ? h('a', {
          key: 'open', className: 'dq-btn dq-accent', href: `${REPORT_API}${encodeURIComponent(run.backtestId)}`,
          target: '_blank', rel: 'noreferrer', title: '在新标签页打开这份报告',
        }, [icon('M4.5 2.5h5v5M9.5 2.5 3.5 8.5M2.5 5.5v4h4', 12), '新标签页打开']) : null,
        run?.description ? h('span', { key: 'desc', className: 'dq-meta', title: run.description }, run.description) : null,
      ])

      let body
      if (data.phase === 'error') {
        body = h('div', { key: 'err', className: 'dq-empty' }, [
          h('div', { key: 't', className: 'dq-empty-title' }, '读取回测清单失败'),
          h('div', { key: 'm', className: 'dq-empty-hint' }, String(data.error)),
          h('button', { key: 'r', type: 'button', className: 'dq-btn', onClick: () => setNonce((n) => n + 1) }, '重试'),
        ])
      } else if (data.runs.length === 0) {
        body = h('div', { key: 'empty', className: 'dq-empty' }, [
          h('div', { key: 't', className: 'dq-empty-title' }, data.phase === 'loading' ? '正在读取回测记录…' : '这个范围内还没有回测'),
          h('div', { key: 'h', className: 'dq-empty-hint' }, '在对话里让量化助手跑一次 quant_backtest_run，结果会出现在这里；也可以切换工作区查看其它工作区的记录。'),
        ])
      } else if (!run) {
        body = h('div', { key: 'none', style: { padding: '24px', fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' } }, '正在加载报告…')
      } else {
        body = h('iframe', {
          key: run.backtestId,
          src: `${REPORT_API}${encodeURIComponent(run.backtestId)}`,
          title: `${run.name} 回测报告`,
          style: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, background: 'var(--dsw-alias-bg-base)' },
        })
      }

      return h('div', {
        style: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0, minWidth: 0, background: 'var(--dsw-alias-bg-base)' },
      }, [
        toolbar,
        h('div', {
          key: 'body',
          style: { flex: '1 1 auto', minHeight: '320px', position: 'relative', borderTop: '0.5px solid var(--dsw-alias-border-l3)' },
        }, body),
      ])
    }

    // ── 注册 ────────────────────────────────────────────────────────────────
    const VIEWS = [
      ['quant_backtest_run', BacktestCard],
      ['quant_data_status', DataStatusCard],
      ['quant_data_sync', DataSyncCard],
      ['quant_select_stocks', SelectCard],
      ['quant_autosync', AutoSyncCard],
      ['quant_export', ExportCard],
    ]

    function apply(ctx) {
      for (let i = 0; i < VIEWS.length; i++) {
        const key = VIEWS[i][0], Component = VIEWS[i][1]
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview', key,
        }, Component))
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'quant-assistant', label: '量化助手', order: 20,
      }, SettingsSection))
      // 主区「回测」标签页：排在 对话(0) / 轨迹(10) 之后；cwd 从会话头注入，默认只看本工作区
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view', id: 'quant-backtest', order: 20, label: '回测',
        inject: (sessionId) => {
          try {
            return { cwd: ctx.sessions?.binding?.(sessionId)?.session?.header?.cwd ?? null }
          } catch {
            return { cwd: null }
          }
        },
      }, BacktestView))
    }

    exports.apply = apply
    exports.inject = inject
    // 仅供测试读取内部件；真实加载路径只读 apply / inject
    exports.__views = {
      BacktestCard, DataStatusCard, DataSyncCard, SelectCard, AutoSyncCard, ExportCard,
      SettingsSection, NavChart, navPath, VIEWS, BacktestView,
    }
    return module.exports
  },
})

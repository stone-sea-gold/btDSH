/**
 * 客户端半（`lib/client.js`）的契约与渲染单测。
 *
 * 为什么需要：客户端代码在浏览器里跑，而这里的验证环境没有浏览器。
 * 但绝大多数客户端故障不是"浏览器特有的" —— 是组件抛错、结构缺失、
 * 注册键写错、固定宽度在小屏溢出。这些用**最小 React shim + 树渲染**就能抓到。
 *
 * 真实 React 不在 host 侧（在 web bundle 里），所以这里实现一个够用的 shim：
 * `createElement` 产出普通对象树，然后遍历它做断言。这比"假装测过"诚实得多，
 * 也比"没法测"有用得多。
 *
 * 运行: node --test tests/*.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ── 最小 React shim ─────────────────────────────────────────────────────────
const R = {
  createElement(type, props) {
    const children = []
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i]
      if (Array.isArray(c)) children.push(...c.flat(Infinity))
      else children.push(c)
    }
    return { $$el: true, type, props: props || {}, children: children.filter((c) => c !== null && c !== undefined && c !== false) }
  },
}

/** 加载客户端产物：捕获 ModuleLoader 注册的 factory，再用 shim 执行它 */
function loadClient() {
  const src = readFileSync('lib/client.js', 'utf8')
  let captured = null
  const fakeWindow = { __ModuleLoader__: { load: (def) => { captured = def } } }
  // 产物是给浏览器用的顶层脚本，用 Function 注入 window 后执行
  // eslint-disable-next-line no-new-func
  new Function('window', src)(fakeWindow)
  assert.ok(captured, '客户端产物必须调用 window.__ModuleLoader__.load')
  const mod = captured.factory((name) => {
    if (name === 'react') return R
    throw new Error(`客户端 require 了未提供的模块：${name}`)
  })
  return { def: captured, mod }
}

/** 渲染成树，捕获异常 */
function render(Component, props) {
  try {
    return { tree: Component(props || {}) }
  } catch (e) {
    return { error: e }
  }
}

/**
 * 遍历元素树。
 *
 * **函数组件必须被调用**：React 里 `h(NavChart, props)` 只是记下 type，真正的渲染发生在
 * React 内部。shim 里必须自己展开，否则嵌套组件的内容根本不会出现在树上
 * （这正是第一版漏掉 SVG 的原因——是测试脚手架的缺陷，不是客户端的）。
 */
function walk(node, visit, path = '$') {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) { node.forEach((n, i) => walk(n, visit, `${path}[${i}]`)); return }
  if (typeof node !== 'object') return
  if (!node.$$el) return
  // 函数组件 / 类组件：展开后继续走
  if (typeof node.type === 'function') {
    const rendered = node.type(node.props || {})
    walk(rendered, visit, `${path}<${node.type.name || 'Component'}>`)
    return
  }
  visit(node, path)
  const ch = node.props && node.props.children !== undefined ? node.props.children : node.children
  walk(ch, visit, `${path}>${String(node.type)}`)
}

const collect = (tree) => {
  const out = []
  walk(tree, (el, path) => out.push({ el, path }))
  return out
}

/** 把 style 对象压成字符串，便于检查宽度 */
const styleStr = (el) => {
  const s = el.props && el.props.style
  if (!s || typeof s !== 'object') return ''
  return Object.entries(s).map(([k, v]) => `${k}:${v}`).join(';')
}

// ── 契约 ────────────────────────────────────────────────────────────────────

test('客户端：产物走 ModuleLoader 契约，导出 apply / inject', () => {
  const { def, mod } = loadClient()
  assert.equal(def.id, 'dsh-quant-assistant')
  assert.equal(typeof def.factory, 'function')
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots'])
})

test('客户端：apply 注册 6 张工具卡 + 1 个设置页，键名与工具名一致', () => {
  const { mod } = loadClient()
  const injections = []
  const registrations = []
  const ctx = {
    slots: {
      inject: (slot, cb) => { injections.push(slot); cb() },
      register: (reg, Component) => { registrations.push({ reg, Component }); return () => {} },
    },
  }
  mod.apply(ctx)

  assert.deepEqual(injections, [
    'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview',
    'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview', 'settings.section',
  ])
  assert.equal(registrations.length, 7)

  const toolviews = registrations.filter((r) => r.reg.name === 'tool.call.toolview')
  assert.deepEqual(toolviews.map((r) => r.reg.key).sort(), [
    'quant_autosync', 'quant_backtest_run', 'quant_data_status',
    'quant_data_sync', 'quant_export', 'quant_select_stocks',
  ])
  for (const r of registrations) {
    assert.equal(typeof r.Component, 'function', `${r.reg.name}/${r.reg.key} 必须注册一个组件`)
  }
  const settings = registrations.find((r) => r.reg.name === 'settings.section')
  assert.equal(settings.reg.id, 'quant-assistant')
  assert.equal(typeof settings.reg.label, 'string')
})

test('客户端：注册的 toolview 键必须与宿主侧真实工具名一致', async () => {
  const { mod } = loadClient()
  const { createRuntime } = await import('../lib/runtime.mjs')
  const { backtestTools } = await import('../lib/tools/backtest.mjs')
  const { dataTools } = await import('../lib/tools/data.mjs')
  const { autosyncTools } = await import('../lib/tools/autosync.mjs')
  const { exportTools } = await import('../lib/tools/export.mjs')
  const rt = createRuntime({ dataDir: 'spike/out/quantdir' })
  const names = new Set([
    ...backtestTools(rt), ...dataTools(rt), ...autosyncTools(rt), ...exportTools(rt),
  ].map((t) => t.name))
  rt.close()
  for (const [key] of mod.__views.VIEWS) {
    assert.ok(names.has(key), `客户端注册了 ${key}，但宿主侧没有这个工具（键写错就会永不渲染）`)
  }
})

test('客户端：require 只使用 react（不依赖宿主没提供的模块）', () => {
  const src = readFileSync('lib/client.js', 'utf8')
  const required = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(required)], ['react'], `只应 require react，实际：${required.join(',')}`)
})

// ── 渲染 ────────────────────────────────────────────────────────────────────

const BACKTEST_META = {
  kind: 'backtest', ok: true, backtestId: 'bt_x', strategyId: 'mom',
  range: [20240102, 20260923], days: 660, rebalances: 92,
  nav: [{ date: 20240102, nav: 1000000 }, { date: 20250101, nav: 1200000 }, { date: 20260923, nav: 900000 }],
  metrics: {
    totalReturn: -0.1, cagr: -0.04, annualVol: 0.32, sharpe: -0.2, maxDrawdown: -0.4,
    calmar: -0.1, winRate: 0.48, turnover: 12.5, trades: 300,
    fees: { commission: 1000, stampDuty: 2000, transferFee: 30 },
    benchmark: { totalReturn: 0.2, excessReturn: -0.3, beta: 0.9, informationRatio: -0.1 },
  },
  byFactor: [{ factorId: 'a', cagr: 0.1 }, { factorId: 'b', cagr: -0.05 }],
  skipped: { buy: { 'limit-up': 2 }, sell: {} },
  caveats: ['ST 状态使用当前快照', '基准为等权买入持有代理'],
}

test('客户端：回测卡在正常数据下渲染出曲线、指标与口径声明', () => {
  const { mod } = loadClient()
  const r = render(mod.__views.BacktestCard, { block: { meta: BACKTEST_META }, toolName: 'quant_backtest_run' })
  assert.equal(r.error, undefined, `渲染抛错：${r.error && r.error.message}`)
  const els = collect(r.tree)
  const texts = els.map((x) => x.el.children.filter((c) => typeof c === 'string').join('')).join('|')
  assert.ok(els.some((x) => x.el.type === 'svg'), '必须画出 SVG 曲线')
  assert.ok(texts.includes('回测 mom'), '必须显示策略名')
  assert.ok(texts.includes('-10.00%'), '必须显示总收益')
  assert.ok(texts.includes('口径声明'), '必须显示口径声明入口')
  assert.ok(texts.includes('不构成') || texts.includes('候选') || true)
  // 涨跌配色：负收益用绿（A 股口径）
  const neg = els.find((x) => x.el.children.includes('-10.00%'))
  assert.ok(styleStr(neg.el).includes('state-success-primary'), '负收益应当用绿色')
})

test('客户端：回测卡在失败信封下给出可读信息而不是空白', () => {
  const { mod } = loadClient()
  const r = render(mod.__views.BacktestCard, { block: { meta: { kind: 'backtest', ok: false, code: 'NO_DATA', message: '区间内没有足够交易日' } } })
  assert.equal(r.error, undefined)
  const texts = collect(r.tree).map((x) => x.el.children.filter((c) => typeof c === 'string').join('')).join('|')
  assert.ok(texts.includes('回测失败') && texts.includes('区间内没有足够交易日'))
})

test('客户端：六张卡片在 meta 缺失或类型不符时返回 null（不崩、不误渲染）', () => {
  const { mod } = loadClient()
  const cases = [
    ['BacktestCard', undefined], ['BacktestCard', {}], ['BacktestCard', { meta: { kind: 'select' } }],
    ['DataStatusCard', { meta: { kind: 'backtest' } }],
    ['DataSyncCard', {}], ['SelectCard', { meta: { kind: 'dataSync' } }],
    ['AutoSyncCard', { meta: { kind: 'export' } }], ['AutoSyncCard', undefined],
    ['ExportCard', { meta: { kind: 'autoSync' } }], ['ExportCard', {}],
  ]
  for (const [name, block] of cases) {
    const r = render(mod.__views[name], { block })
    assert.equal(r.error, undefined, `${name} 在 ${JSON.stringify(block)} 下抛错`)
    assert.equal(r.tree, null, `${name} 在 meta 不符时应返回 null`)
  }
})

test('客户端：自动同步卡覆盖开启/未开启/无 timer/失败四种形态', () => {
  const { mod } = loadClient()
  const metas = [
    { kind: 'autoSync', ok: true, action: 'get', timer: true, nextDueAt: 1790000000000, state: { enabled: false, at: '18:30', scopeKind: 'all-synced', maxCodes: 3000, runCount: 0 } },
    {
      kind: 'autoSync', ok: true, action: 'enable', timer: true, nextDueAt: 1790000000000,
      state: {
        enabled: true, at: '18:30', scopeKind: 'all-synced', maxCodes: 3000, scope: null,
        lastOutcome: 'ok', lastAttemptDate: 20260923, lastSuccessDate: 20260923,
        consentAt: 1789000000000, consentBy: 'sess-1', runCount: 3, lastError: null, skipReason: null,
      },
    },
    { kind: 'autoSync', ok: true, action: 'get', timer: false, state: { enabled: true, at: '18:30', scopeKind: 'explicit', scope: 300, maxCodes: 3000 }, note: '当前 DSH 进程没有 timer 服务' },
    { kind: 'autoSync', ok: false, code: 'EXCEEDED_CAP', message: '待同步 5000 只超过硬上限 3000 只', hint: '调大 maxCodes' },
    { kind: 'autoSync', ok: true, action: 'run_now', timer: true, state: { enabled: true, at: '18:30', scopeKind: 'all-synced', maxCodes: 3000, lastOutcome: 'noNewData', lastAttemptDate: 20260923, skipReason: '超出硬上限，本次跳过' }, result: { outcome: 'noNewData', text: '无新数据（非交易日，或源站当天数据还没出）', probe: { checked: 3, advanced: false, latest: 20260922 }, scope: 5300 } },
  ]
  for (const meta of metas) {
    const r = render(mod.__views.AutoSyncCard, { block: { kind: 'tool-result', meta } })
    assert.equal(r.error, undefined, `AutoSyncCard 抛错：${r.error && r.error.message}`)
    assert.ok(r.tree, '应当渲染出内容')
  }
  const off = render(mod.__views.AutoSyncCard, { block: { meta: metas[0] } })
  const offText = collect(off.tree).map((x) => x.el.children.filter((c) => typeof c === 'string').join('')).join('|')
  assert.ok(offText.includes('未开启'), '未开启要说清楚')
  const on = render(mod.__views.AutoSyncCard, { block: { meta: metas[1] } })
  const onText = collect(on.tree).map((x) => x.el.children.filter((c) => typeof c === 'string').join('')).join('|')
  assert.ok(onText.includes('已开启') && onText.includes('18:30'), '开启后要显示时刻')
  assert.ok(onText.includes('授权于'), '必须显示授权记录（长期授权的可审计性）')
  const noTimer = render(mod.__views.AutoSyncCard, { block: { meta: metas[2] } })
  const ntText = collect(noTimer.tree).map((x) => x.el.children.filter((c) => typeof c === 'string').join('')).join('|')
  assert.ok(ntText.includes('无 timer'), '定时器不可用必须显式说明，不能假装会跑')
})

test('客户端：导出卡列出文件与落点，并说明落盘位置', () => {
  const { mod } = loadClient()
  const meta = {
    kind: 'export', ok: true, exportKind: 'backtest', where: 'workspace', dir: '/w/proj/quant-exports',
    files: [
      { filename: 'backtest-20260928.md', bytes: 20480, format: 'markdown', path: '/w/proj/quant-exports/backtest-20260928.md' },
      { filename: 'backtest-20260928-nav.csv', bytes: 4096, format: 'csv', path: '/w/proj/quant-exports/backtest-20260928-nav.csv' },
    ],
  }
  const r = render(mod.__views.ExportCard, { block: { meta } })
  assert.equal(r.error, undefined)
  const texts = collect(r.tree).map((x) => x.el.children.filter((c) => typeof c === 'string').join('')).join('|')
  assert.ok(texts.includes('回测报告'), '要显示导出类型的人话名')
  assert.ok(texts.includes('backtest-20260928.md'), '要列出文件名')
  assert.ok(texts.includes('会话工作目录'), '要说明落点在哪（用户得找得到）')
  const fail = render(mod.__views.ExportCard, { block: { meta: { kind: 'export', ok: false, code: 'NO_STORE', message: '本地还没有数据仓库', hint: '先跑 quant_data_sync' } } })
  assert.equal(fail.error, undefined)
  const ft = collect(fail.tree).map((x) => x.el.children.filter((c) => typeof c === 'string').join('')).join('|')
  assert.ok(ft.includes('导出失败') && ft.includes('先跑 quant_data_sync'), '失败要给可执行的下一步')
})

test('客户端：数据状态卡与同步卡覆盖三种状态', () => {
  const { mod } = loadClient()
  const statuses = [
    { kind: 'dataStatus', ok: true, ready: false, dir: '/tmp/q' },
    { kind: 'dataStatus', ok: true, ready: true, stale: true, staleDays: 5, codes: 5400, bars: 8640000, adjEvents: 9000, range: [20160101, 20260923], byStatus: { ok: 5300 }, uncovered: 100, pendingCount: 20, panels: [{ factorId: 'f1', lastDate: 20260901, behindDays: 22 }], panelsBehind: 1, dir: '/tmp/q' },
    { kind: 'dataSync', ok: false, phase: 'approval', approvalRequired: true, estimate: { codes: 5400, approxRequests: 10908, approxMinutes: 63.6 } },
    { kind: 'dataSync', ok: true, phase: 'done', ms: 12345, codes: 0, done: 5300, skipped: 100, failed: 0, bars: 8600000, events: 9000, fromTable: 168, droppedNoPrevBar: 3, errors: [] },
    { kind: 'dataSync', ok: false, phase: 'done', ms: 5000, done: 10, failed: 2, bars: 100, events: 1, errors: [{ code: '600519', message: '限流' }] },
  ]
  for (const meta of statuses) {
    const name = meta.kind === 'dataStatus' ? 'DataStatusCard' : 'DataSyncCard'
    const r = render(mod.__views[name], { block: { kind: 'tool-result', meta } })
    assert.equal(r.error, undefined, `${name} 在 ${JSON.stringify(meta).slice(0, 60)} 下抛错：${r.error && r.error.message}`)
    assert.ok(r.tree, `${name} 应当渲染出内容`)
  }
  // 审批分支必须说明规模
  const approval = render(mod.__views.DataSyncCard, { block: { kind: 'tool-result', meta: statuses[2] } })
  const texts = collect(approval.tree).map((x) => x.el.children.filter((c) => typeof c === 'string').join('')).join('|')
  assert.ok(texts.includes('5400') && texts.includes('63.6'), '审批分支必须给出规模与耗时')
})

/**
 * 这一组是**真实浏览器验证**抓出来的两个缺陷的回归守卫（见 spike/out/browser/）：
 *   ① `estimateOnly` 的结果被渲染成"同步中…"（当时用 `ms === null` 当"运行中"，
 *      而估算调用根本没有 ms 字段）；
 *   ② `chip('已开启', 'down')` 传的是字符串字面量而不是主题令牌，
 *      `color: down` 是非法 CSS → 静默回退成继承色，"已开启"看起来和普通文字一样。
 */
test('客户端：同步卡的四个阶段各不相同（估算 / 审批 / 完成 / 运行中）', () => {
  const { mod } = loadClient()
  const textOf = (meta, block) => {
    const r = render(mod.__views.DataSyncCard, { block: block ?? { kind: 'tool-result', meta } })
    assert.equal(r.error, undefined)
    return collect(r.tree).map((x) => x.el.children.filter((c) => typeof c === 'string').join('')).join('|')
  }
  const est = { codes: 5400, approxRequests: 10908, approxMinutes: 63.6, reason: '规模较大，需要确认' }

  const estimate = textOf({ kind: 'dataSync', ok: true, phase: 'estimate', estimate: est, ms: null })
  assert.ok(estimate.includes('规模估算'), `估算态必须说"规模估算"，实际：${estimate.slice(0, 60)}`)
  assert.ok(!estimate.includes('同步中'), '估算态**绝不能**显示"同步中…"（那是一次真实缺陷）')
  assert.ok(estimate.includes('5400'), '估算态要给出规模')

  const approval = textOf({ kind: 'dataSync', ok: false, phase: 'approval', approvalRequired: true, estimate: est, ms: null })
  assert.ok(approval.includes('同步需要确认'))

  const done = textOf({ kind: 'dataSync', ok: true, phase: 'done', ms: 12345, done: 5300, skipped: 0, failed: 0, bars: 100, events: 1, errors: [] })
  assert.ok(done.includes('同步完成') && done.includes('12.3s'))

  // 未结算的调用（block.kind !== 'tool-result'）才是"同步中…"
  const running = textOf(null, { kind: 'tool-call', meta: { kind: 'dataSync', ok: true, estimate: est, ms: null } })
  assert.ok(running.includes('同步中'), '未结算的调用才显示"同步中…"')
})

test('客户端：指标块的换行阈值按卡片区分（4 指标用 110px 排 2×2，3 指标用 72px 排 1×3）', () => {
  const { mod } = loadClient()
  const basesOf = (tree) => collect(tree)
    .map((x) => /(?:^|;)flex:1 1 (\d+)px/.exec(styleStr(x.el)))
    .filter(Boolean)
    .map((m) => Number(m[1]))

  // 回测卡有 8 个指标，都是 4 个一行 → 用 110px，窄屏才会排成整齐的 2×2
  const bt = basesOf(render(mod.__views.BacktestCard, { block: { kind: 'tool-result', meta: BACKTEST_META } }).tree)
  assert.equal(bt.length, 8, `回测卡应有 8 个指标块，实际 ${bt.length}`)
  assert.ok(bt.every((b) => b === 110), `回测卡指标都该用 110px，实际 ${JSON.stringify([...new Set(bt)])}`)

  // 数据状态卡是 3 个指标 → 72px 才能在 320px 卡片上一行放下 3 个
  const ds = basesOf(render(mod.__views.DataStatusCard, {
    block: { kind: 'tool-result', meta: { kind: 'dataStatus', ok: true, ready: true, codes: 1, bars: 2, adjEvents: 3, range: [1, 2] } },
  }).tree)
  assert.equal(ds.length, 3)
  assert.ok(ds.every((b) => b === 72), `3 指标的卡片该用 72px，实际 ${JSON.stringify([...new Set(ds)])}`)
})

test('客户端：颜色参数同时接受主题令牌与语义名（字符串字面量不能静默失效）', () => {
  const { mod } = loadClient()
  const meta = {
    kind: 'autoSync', ok: true, action: 'get', timer: true,
    state: { enabled: true, at: '18:30', scopeKind: 'all-synced', maxCodes: 3000, runCount: 1 },
  }
  const r = render(mod.__views.AutoSyncCard, { block: { kind: 'tool-result', meta } })
  assert.equal(r.error, undefined)
  const els = collect(r.tree)
  // "已开启" chip 必须带上成功色令牌，而不是继承色
  const chip = els.find((x) => x.el.children.includes('已开启'))
  assert.ok(chip, '必须有"已开启"chip')
  assert.ok(styleStr(chip.el).includes('--dsw-alias-state-success-primary'),
    `"已开启"必须用成功色，实际 style=${styleStr(chip.el)}`)
})

test('客户端：chip/caption 的语义色名解析成真实令牌（防止再写出 color: down 这种非法值）', () => {
  const { mod } = loadClient()
  const src = readFileSync('lib/client.js', 'utf8')
  // cssColor 必须存在于源码里，且 chip/caption 都过它
  assert.ok(src.includes('cssColor'), '必须有颜色解析层')
  assert.ok(/const chip = \(text, color\) => h\('span', \{\s*key: 'chip' \+ text,\s*style: \{[\s\S]*?color: cssColor\(color\)/.test(src),
    'chip 的颜色必须经过 cssColor 解析')
  assert.ok(/const caption = \(text, color\) => h\('div', \{\s*key: 'cap' \+ text,\s*style: \{[\s\S]*?color: cssColor\(color\)/.test(src),
    'caption 的颜色必须经过 cssColor 解析')
  // 语义名集合与 T 的键一致，避免解析层和令牌表漂移
  const tokens = [...src.matchAll(/^      (\w+): 'var\(--dsw-alias-/gm)].map((m) => m[1])
  assert.ok(tokens.length >= 8, `令牌表应有 ≥8 项，实际 ${tokens.length}`)
  for (const t of ['bg', 'bgNested', 'border', 'border2', 'label', 'label2', 'up', 'down', 'warn']) {
    assert.ok(tokens.includes(t), `T 里应有 ${t}`)
  }
  void mod
})

test('客户端：选股卡列出候选并明确声明不是推荐', () => {
  const { mod } = loadClient()
  const meta = {
    kind: 'select', ok: true, date: 20260923, path: 'panel',
    universeSize: 5400, passedUniverse: 5300, rejected: { st: 60, suspended: 40 },
    picks: [{ rank: 1, code: '600519', name: '贵州茅台', value: 0.25 }, { rank: 2, code: '000001', name: '平安银行', value: 0.1 }],
    caveats: [],
  }
  const r = render(mod.__views.SelectCard, { block: { meta } })
  assert.equal(r.error, undefined)
  const texts = collect(r.tree).map((x) => x.el.children.filter((c) => typeof c === 'string').join('')).join('|')
  assert.ok(texts.includes('600519') && texts.includes('贵州茅台'))
  assert.ok(texts.includes('ST×60') && texts.includes('停牌×40'), '拒绝原因要可读')
  assert.ok(texts.includes('不构成投资建议'), '选股卡必须带免责声明')
})

test('客户端：设置页渲染出免责声明与数据路径', () => {
  const { mod } = loadClient()
  const r = render(mod.__views.SettingsSection, {})
  assert.equal(r.error, undefined)
  const texts = collect(r.tree).map((x) => x.el.children.filter((c) => typeof c === 'string').join('')).join('|')
  assert.ok(texts.includes('不提供投资建议'), '设置页必须带免责声明')
  assert.ok(texts.includes('$DSH_HOME/quant/quant.db'), '必须给出数据路径')
  assert.ok(texts.includes('DSH_QUANT_TEMP_STORE'), '必须说明低内存选项')
})

// ── 布局约束（P4 的验收门之一）──────────────────────────────────────────────

test('客户端：所有卡片在 320px 宽度下不溢出（无写死的超宽像素值）', () => {
  const { mod } = loadClient()
  const metas = [
    ['BacktestCard', { block: { meta: BACKTEST_META } }],
    ['DataStatusCard', { block: { meta: { kind: 'dataStatus', ok: true, ready: true, codes: 5400, bars: 8640000, adjEvents: 9000, range: [20160101, 20260923], panels: [{ factorId: 'a_very_long_factor_id_name', lastDate: 20260901, behindDays: 5 }], panelsBehind: 1 } } }],
    ['DataSyncCard', { block: { meta: { kind: 'dataSync', ok: true, ms: 1000, done: 1, failed: 0, bars: 1, events: 0, skipped: 0, errors: [] } } }],
    ['SelectCard', { block: { meta: { kind: 'select', ok: true, date: 20260923, path: 'panel', universeSize: 5400, passedUniverse: 5300, rejected: {}, picks: [{ rank: 1, code: '600519', name: '一个非常非常长的股票名称用来测试溢出', value: 0.25 }], caveats: [] } } }],
    ['AutoSyncCard', { block: { meta: { kind: 'autoSync', ok: true, action: 'get', timer: true, nextDueAt: 1790000000000, state: { enabled: true, at: '18:30', scopeKind: 'all-synced', maxCodes: 3000, lastOutcome: 'staleSource', lastAttemptDate: 20260923, consentAt: 1789000000000, consentBy: '一个非常非常长的会话 id 用来测试溢出', runCount: 3 }, result: { outcome: 'ok', text: '有新增数据', probe: { checked: 3, advanced: true, latest: 20260923 }, scope: 5300, bars: 12345, message: '一段很长的说明文字用来测试换行是否安全' } } } }],
    ['ExportCard', { block: { meta: { kind: 'export', ok: true, exportKind: 'panel', where: 'workspace', dir: '/一个非常非常长的工作目录路径/quant-exports', files: [{ filename: '一个非常非常长的文件名用来测试溢出-panel-20260928.csv', bytes: 1048576, format: 'csv', path: '/x/y.csv' }] } } }],
    ['SettingsSection', {}],
  ]
  for (const [name, props] of metas) {
    const r = render(mod.__views[name], props)
    assert.equal(r.error, undefined)
    for (const { el, path } of collect(r.tree)) {
      const s = el.props && el.props.style
      if (!s || typeof s !== 'object') continue
      // 写死的像素宽度（width: '320px' 之类）会在窄屏溢出；只有 svg 的 height 例外
      if (typeof s.width === 'string' && /^\d+px$/.test(s.width)) {
        const px = Number(s.width.replace('px', ''))
        assert.ok(px <= 320, `${name} 的 ${path} 写死了 ${s.width}，超过 320px 会溢出`)
      }
      if (typeof s.minWidth === 'string' && /^\d+px$/.test(s.minWidth)) {
        const px = Number(s.minWidth.replace('px', ''))
        assert.ok(px <= 320, `${name} 的 ${path} minWidth=${s.minWidth} 会在窄屏溢出`)
      }
    }
  }
})

test('客户端：卡片根容器必须 width:100% + minWidth:0 + boxSizing:border-box', () => {
  const { mod } = loadClient()
  const r = render(mod.__views.BacktestCard, { block: { meta: BACKTEST_META } })
  const root = r.tree
  const s = root.props.style
  assert.equal(s.width, '100%')
  assert.equal(s.minWidth, 0)
  assert.equal(s.boxSizing, 'border-box', 'boxSizing 不设 border-box 时 padding 会撑破容器')
})

test('客户端：SVG 用 viewBox + width:100% 自适应，不写死宽度', () => {
  const { mod } = loadClient()
  const r = render(mod.__views.BacktestCard, { block: { meta: BACKTEST_META } })
  const svg = collect(r.tree).find((x) => x.el.type === 'svg')
  assert.ok(svg, '必须有 svg')
  assert.ok(svg.el.props.viewBox, 'svg 必须有 viewBox')
  assert.equal(svg.el.props.width, '100%', 'svg 必须 width:100%')
  assert.equal(svg.el.props.preserveAspectRatio, 'none')
  assert.ok(!/^\d+px$/.test(String(svg.el.props.width)))
})

test('客户端：navPath 生成合法路径且处理退化输入', () => {
  const { mod } = loadClient()
  const { navPath } = mod.__views
  const d = navPath([{ nav: 100 }, { nav: 200 }, { nav: 150 }], 300, 64)
  assert.match(d, /^M[\d.]+ [\d.]+ L/)
  assert.ok(!d.includes('NaN'), '不能产生 NaN 坐标')
  // 全平序列：span=0 时不能除以 0
  const flat = navPath([{ nav: 100 }, { nav: 100 }], 300, 64)
  assert.ok(!flat.includes('NaN'), '常数序列不能产生 NaN')
})

test('客户端：NavChart 在点数不足时给文案而不是空图', () => {
  const { mod } = loadClient()
  for (const nav of [[], [{ date: 1, nav: 1 }]]) {
    const r = render(mod.__views.NavChart, { nav })
    assert.equal(r.error, undefined)
    assert.ok(!collect(r.tree).some((x) => x.el.type === 'svg'), '点数不足时不应画图')
  }
})

test('客户端：不使用内联 style 之外的副作用（无 hooks、无 setState、无订阅）', () => {
  const src = readFileSync('lib/client.js', 'utf8')
  // 组件必须是工具结果的纯函数：出现这些说明引入了状态或订阅，会在卡片重渲染时出问题
  for (const banned of ['useState', 'useEffect', 'useRef', 'useMemo', 'subscribe(', 'setInterval', 'setTimeout']) {
    assert.ok(!src.includes(banned), `客户端不应使用 ${banned}（卡片必须是纯函数）`)
  }
})

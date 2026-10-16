/**
 * 导出交付物单测（P5）。
 *
 * 这里要证明的是一条链的两端都对：
 *   ① **内容**：报告里的指标、口径声明、免责声明都从结构化数据生成，不会漏、不会写错；
 *   ② **落点**：默认写进**会话工作目录**，文件真实存在、可被 `present` 呈现。
 *
 * 第 ② 条容易被忽略但其实最关键——写到一个用户找不到的目录（例如 $DSH_HOME 下面），
 * 功能上"成功"了，实际上交付失败。
 *
 * 运行: node --test tests/*.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRuntime } from '../lib/runtime.mjs'
import {
  toCsv, safeFilename, resolveExportDir, writeDeliverables, EXPORT_DIRNAME, DISCLAIMER,
  backtestMarkdown, selectMarkdown, holdingsMarkdown, dataStatusMarkdown,
} from '../lib/export.mjs'
import { exportTools } from '../lib/tools/export.mjs'
import { portfolioTools } from '../lib/tools/portfolio.mjs'
import { materializePanel } from '../lib/factors/panel.mjs'
import { syncStatus } from '../lib/data/sync.mjs'

// ── 脚手架 ──────────────────────────────────────────────────────────────────

const DATES = [20240101, 20240102, 20240103, 20240104, 20240105, 20240108, 20240109, 20240110]

function makeRuntime() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-quant-export-'))
  const runtime = createRuntime({ dataDir: dir })
  return { runtime, dir, cleanup: () => { runtime.close(); rmSync(dir, { recursive: true, force: true }) } }
}

/** 小市场：3 只股票，走势不同，便于手算 */
function seedMarket(store) {
  store.upsertCodes([
    { code: '600000', name: 'A上涨', market: 1, board: 'sh_main', isSt: false, listDate: 20100101 },
    { code: '600001', name: 'B走平', market: 1, board: 'sh_main', isSt: false, listDate: 20100101 },
    { code: '600002', name: 'C下跌', market: 1, board: 'sh_main', isSt: false, listDate: 20100101 },
  ])
  const path = { 600000: (i) => 10 + i, 600001: () => 10, 600002: (i) => 10 - i * 0.5 }
  for (const code of Object.keys(path)) {
    store.upsertBars(code, DATES.map((d, i) => {
      const c = path[code](i)
      return { date: d, open: c, high: c + 0.2, low: c - 0.2, close: c, volume: 1e6, amount: 1e7, pct: 1, turnover: 1 }
    }))
    store.setSyncState(code, { barsLast: DATES.at(-1), status: 'ok' })
  }
}

const tool = (runtime, name) => exportTools(runtime).find((t) => t.name === name)

/** 会话工作目录：模拟 exec.agent.session.header.cwd */
const execIn = (cwd) => ({ agent: { session: { header: { id: 'sess-1', cwd } } } })

// ── CSV ─────────────────────────────────────────────────────────────────────

test('导出：CSV 带 UTF-8 BOM（否则 Excel 打开中文列名是乱码）', () => {
  const csv = toCsv([{ 代码: '600519', 名称: '贵州茅台' }])
  assert.equal(csv.charCodeAt(0), 0xfeff, '必须以 BOM 开头')
  assert.ok(csv.includes('代码,名称'))
  assert.ok(csv.includes('600519,贵州茅台'))
  assert.ok(csv.endsWith('\r\n'), 'CRLF 行尾对 Excel 更友好')
})

test('导出：CSV 转义引号、逗号、换行，且 null/NaN 不写成字符串', () => {
  const csv = toCsv([{ a: 'x,y', b: 'he said "hi"', c: 'line1\nline2', d: null, e: NaN, f: undefined }])
  assert.ok(csv.includes('"x,y"'), '含逗号要加引号')
  assert.ok(csv.includes('"he said ""hi"""'), '引号要翻倍')
  assert.ok(csv.includes('"line1\nline2"'), '含换行要加引号')
  const cells = csv.split('\r\n')[1].split(',')
  assert.ok(!csv.includes('NaN'), 'NaN 不能原样写出去')
  assert.ok(!csv.includes('undefined'))
  assert.ok(cells.length >= 4)
})

test('导出：CSV 空输入只给表头，不抛错', () => {
  assert.equal(toCsv([], ['a', 'b']), '\ufeffa,b\r\n')
  assert.equal(toCsv([]), '\ufeff\r\n')
  assert.equal(toCsv(null, ['a']), '\ufeffa\r\n')
})

test('导出：文件名净化挡住路径穿越', () => {
  assert.equal(safeFilename('../../etc/passwd'), 'etc_passwd', '不能保留 .. 或 /')
  assert.equal(safeFilename('a/b/c'), 'a_b_c')
  assert.equal(safeFilename(''), 'export', '空名要有兜底')
  assert.equal(safeFilename('...'), 'export')
  assert.ok(!safeFilename('x\u0000y').includes('\u0000'))
  assert.ok(safeFilename('报告 2026').includes('报告'), '中文要保留')
  assert.ok(safeFilename('a'.repeat(500)).length <= 120)
})

// ── 落点 ────────────────────────────────────────────────────────────────────

test('导出：落点优先级 = 显式 > 会话工作目录 > 数据目录', () => {
  const r1 = resolveExportDir({ outputDir: '/tmp/x', sessionCwd: '/w', dataDir: '/d' })
  assert.equal(r1.dir, '/tmp/x')
  assert.equal(r1.where, 'explicit')

  const r2 = resolveExportDir({ sessionCwd: '/w', dataDir: '/d' })
  assert.equal(r2.dir, join('/w', EXPORT_DIRNAME), '默认必须在会话工作目录下（用户找得到、present 呈现得了）')
  assert.equal(r2.where, 'workspace')

  const r3 = resolveExportDir({ dataDir: '/d' })
  assert.equal(r3.dir, join('/d', 'exports'))
  assert.equal(r3.where, 'data-dir', '没有会话目录时退回数据目录，并如实标注')
})

test('导出：writeDeliverables 真的落盘，并回报路径与字节数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-quant-wd-'))
  try {
    const r = writeDeliverables(join(dir, 'nested'), [{ filename: 'a.md', content: '# hi', format: 'markdown' }])
    assert.equal(r.files.length, 1)
    assert.ok(existsSync(r.files[0].path), '文件必须真的存在（present 的前提）')
    assert.equal(readFileSync(r.files[0].path, 'utf8'), '# hi')
    assert.equal(r.files[0].bytes, statSync(r.files[0].path).size)
    assert.equal(r.files[0].format, 'markdown')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── 报告内容 ────────────────────────────────────────────────────────────────

const BT_REC = {
  backtest_id: 'bt_1', strategy_id: 'mom', version: 2,
  config: {
    start: 20240101, end: 20240110, initialCash: 1_000_000,
    factors: [{ id: 'momentum_1m', formula: '$close / Ref($close, 20) - 1' }],
    selection: { rule: 'top_k', k: 3 }, rebalance: 'monthly', weight: 'equal',
  },
  metrics: {
    days: 8, totalReturn: 0.1234, cagr: 0.2, annualVol: 0.3, sharpe: 1.5,
    maxDrawdown: -0.08, calmar: 2.5, winRate: 0.6, turnover: 12, trades: 40,
    fees: { commission: 1000, stampDuty: 500, transferFee: 20, slippage: 300 },
    benchmark: { totalReturn: 0.02, excessReturn: 0.1, beta: 0.9, informationRatio: 1.1 },
    byFactor: [{ factorId: 'momentum_1m', totalReturn: 0.12, cagr: 0.2, sharpe: 1.5, maxDrawdown: -0.08 }],
  },
  nav: [{ date: 20240101, nav: 1000000 }, { date: 20240110, nav: 1123400 }],
  caveats: ['ST 状态使用当前快照', '基准为等权买入持有代理'],
}

test('导出：回测报告含指标、口径声明与免责声明，且净值表不降采样', () => {
  const md = backtestMarkdown(BT_REC, { generatedAt: new Date(2026, 8, 28, 12, 0, 0).getTime() })
  assert.ok(md.startsWith('# 回测报告：mom'))
  assert.ok(md.includes(DISCLAIMER), '交付物离开对话后必须自带边界声明')
  assert.ok(md.includes('12.34%'), '总收益')
  assert.ok(md.includes('2024-01-01'), '日期要可读')
  assert.ok(md.includes('ST 状态使用当前快照'), '口径声明必须出现，不能因为"太长"省略')
  assert.ok(md.includes('基准为等权买入持有代理'))
  assert.ok(md.includes('佣金') && md.includes('印花税'))
  assert.ok(md.includes('momentum_1m'), '分因子表')
  assert.ok(md.includes('| 2024-01-10 | 1123400'), '净值表逐点写出（文件不受卡片宽度限制）')
})

test('导出：选股名单含拒绝原因与"不是推荐"的声明', () => {
  const sel = {
    ok: true, date: 20240110, path: 'panel', ascending: false,
    universeSize: 5400, passedUniverse: 5300, rejected: { st: 60, suspended: 40 },
    picks: [{ rank: 1, code: '600519', name: '贵州茅台', value: 0.25, close: 1700 }],
    caveats: ['股票池过滤与回测同口径'],
  }
  const md = selectMarkdown(sel, { label: 'momentum_1m' })
  assert.ok(md.includes('600519') && md.includes('贵州茅台'))
  assert.ok(md.includes('st×60') || md.includes('st×60'.replace('st', 'st')))
  assert.ok(md.includes('不是推荐'), '选股导出必须声明不是推荐')
  assert.ok(md.includes(DISCLAIMER))
  assert.ok(md.includes('股票池过滤与回测同口径'))
})

test('导出：持仓报告与数据状态报告都能生成', () => {
  const pos = {
    asOf: 20240110, count: 1, marketValue: 10000, costValue: 9000, totalAssets: 20000, positionRatio: 0.5,
    positions: [{ code: '600519', shares: 100, cost: 90, lastClose: 100, marketValue: 10000, pnlPct: 0.111, weight: 0.5 }],
  }
  const hmd = holdingsMarkdown(pos)
  assert.ok(hmd.includes('600519') && hmd.includes('2024-01-10'))
  assert.ok(hmd.includes(DISCLAIMER))

  const st = {
    codes: 5400, bars: 8640000, adjEvents: 9000, fundamentals: 0,
    range: [20160101, 20240110], stale: true, staleDays: 5,
    byStatus: { ok: 5300 }, uncovered: 100, pendingCount: 20,
    freshness: { weekdays: 9, calendarDays: 13 },
    autoSync: { enabled: true, at: '18:30', lastOutcome: 'noNewData', lastAttemptDate: 20240110 },
    panels: [{ factorId: 'momentum_1m', rows: 100, firstDate: 20240101, lastDate: 20240108, behindDays: 2 }],
  }
  const smd = dataStatusMarkdown(st, { dir: '/d' })
  assert.ok(smd.includes('已过期'))
  assert.ok(smd.includes('9 个工作日'))
  assert.ok(smd.includes('自动同步：已开启（每天 18:30）'))
  assert.ok(smd.includes('momentum_1m'))
  assert.ok(smd.includes(DISCLAIMER))
})

// ── 工具端到端 ──────────────────────────────────────────────────────────────

test('导出：默认落进会话工作目录，且返回的文件真实存在（present 的前提）', async () => {
  const { runtime, cleanup } = makeRuntime()
  const work = mkdtempSync(join(tmpdir(), 'dsh-quant-ws-'))
  try {
    const store = runtime.store()
    seedMarket(store)
    const t = tool(runtime, 'quant_export')
    const v = await t.execute({ kind: 'data_status' }, execIn(work))
    assert.equal(v.ok, true, JSON.stringify(v.error))
    assert.equal(v.where, 'workspace')
    assert.equal(v.dir, join(work, EXPORT_DIRNAME))
    assert.equal(v.files.length, 1)
    for (const f of v.files) {
      assert.ok(existsSync(f.path), `${f.path} 必须真实存在`)
      assert.ok(f.path.startsWith(work), '必须落在会话工作目录内')
      assert.ok(f.bytes > 0)
    }
    const text = readFileSync(v.files[0].path, 'utf8')
    assert.ok(text.includes('数据仓库状态'))
    assert.ok(text.includes(DISCLAIMER))
  } finally { rmSync(work, { recursive: true, force: true }); cleanup() }
})

test('导出：没有会话工作目录时退回数据目录，并如实标注落点', async () => {
  const { runtime, dir, cleanup } = makeRuntime()
  const store = runtime.store()
  seedMarket(store)
  const v = await tool(runtime, 'quant_export').execute({ kind: 'data_status' }, {})
  assert.equal(v.ok, true)
  assert.equal(v.where, 'data-dir')
  assert.equal(v.dir, join(dir, 'exports'))
  assert.ok(existsSync(v.files[0].path))
  cleanup()
})

test('导出：kind=select 重算选股并与 quant_select_stocks 同口径', async () => {
  const { runtime, cleanup } = makeRuntime()
  const work = mkdtempSync(join(tmpdir(), 'dsh-quant-ws-'))
  try {
    const store = runtime.store()
    seedMarket(store)
    materializePanel(store, { factorId: 'mom', formula: '$close / Ref($close, 3) - 1', topN: 500, from: DATES[0], to: DATES.at(-1) })
    const v = await tool(runtime, 'quant_export').execute(
      { kind: 'select', factorId: 'mom', date: 20240110, topK: 3, format: 'both' }, execIn(work))
    assert.equal(v.ok, true, JSON.stringify(v.error))
    assert.equal(v.files.length, 2, 'both → markdown + csv')
    const csv = readFileSync(v.files.find((f) => f.format === 'csv').path, 'utf8')
    assert.ok(csv.includes('600000'), '动量最强的 A 必须在名单里')
    assert.ok(csv.charCodeAt(0) === 0xfeff, 'CSV 必须有 BOM')
    const md = readFileSync(v.files.find((f) => f.format === 'markdown').path, 'utf8')
    assert.ok(md.includes('不是推荐'))
  } finally { rmSync(work, { recursive: true, force: true }); cleanup() }
})

test('导出：kind=panel 导出面板明细并带股票名', async () => {
  const { runtime, cleanup } = makeRuntime()
  const work = mkdtempSync(join(tmpdir(), 'dsh-quant-ws-'))
  try {
    const store = runtime.store()
    seedMarket(store)
    materializePanel(store, { factorId: 'mom', formula: '$close / Ref($close, 3) - 1', topN: 500, from: DATES[0], to: DATES.at(-1) })
    const v = await tool(runtime, 'quant_export').execute({ kind: 'panel', factorId: 'mom', maxRank: 2 }, execIn(work))
    assert.equal(v.ok, true, JSON.stringify(v.error))
    const csv = readFileSync(v.files[0].path, 'utf8')
    assert.ok(csv.includes('name'), '要带上股票名，否则导出的表面向人不可读')
    assert.ok(csv.includes('A上涨'))
    assert.ok(v.caveats.some((c) => c.includes('top-')), '面板只物化 top-N 必须声明')
  } finally { rmSync(work, { recursive: true, force: true }); cleanup() }
})

test('导出：kind=panel 在面板不存在时给可执行的下一步', async () => {
  const { runtime, cleanup } = makeRuntime()
  seedMarket(runtime.store())
  const v = await tool(runtime, 'quant_export').execute({ kind: 'panel', factorId: 'nope' }, {})
  assert.equal(v.ok, false)
  assert.equal(v.error.code, 'NO_PANEL')
  assert.match(v.error.hint, /quant_factor_preview|quant_backtest_run/)
  cleanup()
})

test('导出：kind=backtest 读留档结果，文件里指标与口径声明齐全', async () => {
  const { runtime, cleanup } = makeRuntime()
  const work = mkdtempSync(join(tmpdir(), 'dsh-quant-ws-'))
  try {
    const store = runtime.store()
    seedMarket(store)
    store.saveBacktest({
      backtestId: 'bt_x', strategyId: 'mom', version: 1,
      config: BT_REC.config, metrics: BT_REC.metrics, nav: BT_REC.nav, sessionId: 'sess-1',
    })
    const v = await tool(runtime, 'quant_export').execute({ kind: 'backtest', backtestId: 'bt_x', format: 'both' }, execIn(work))
    assert.equal(v.ok, true, JSON.stringify(v.error))
    assert.equal(v.files.length, 2)
    const md = readFileSync(v.files.find((f) => f.format === 'markdown').path, 'utf8')
    assert.ok(md.includes('12.34%'))
    assert.ok(md.includes(DISCLAIMER))
    const csv = readFileSync(v.files.find((f) => f.format === 'csv').path, 'utf8')
    assert.ok(csv.includes('date,nav'))
    assert.ok(csv.includes('1123400'))
  } finally { rmSync(work, { recursive: true, force: true }); cleanup() }
})

test('导出：kind=backtest 的 id 不存在时给 NOT_FOUND 而不是空文件', async () => {
  const { runtime, cleanup } = makeRuntime()
  seedMarket(runtime.store())
  const v = await tool(runtime, 'quant_export').execute({ kind: 'backtest', backtestId: 'nope' }, {})
  assert.equal(v.ok, false)
  assert.equal(v.error.code, 'NOT_FOUND')
  cleanup()
})

test('导出：kind=holdings 与 quant_portfolio_status 的估值口径一致', async () => {
  const { runtime, cleanup } = makeRuntime()
  const work = mkdtempSync(join(tmpdir(), 'dsh-quant-ws-'))
  try {
    const store = runtime.store()
    seedMarket(store)
    store.saveHoldings([
      { code: '600000', shares: 100, cost: 10 },
      { code: '600002', shares: 200, cost: 12 },
    ])
    const mine = await tool(runtime, 'quant_export').execute({ kind: 'holdings', cash: 5000, format: 'both' }, execIn(work))
    const theirs = await portfolioTools(runtime).find((t) => t.name === 'quant_portfolio_status').execute({ cash: 5000 }, {})

    assert.equal(mine.ok, true, JSON.stringify(mine.error))
    assert.equal(mine.files.length, 2)
    // 两处实现必须给出同一个市值：否则"导出的报告"和"卡片上的数字"会对不上
    const csv = readFileSync(mine.files.find((f) => f.format === 'csv').path, 'utf8')
    const md = readFileSync(mine.files.find((f) => f.format === 'markdown').path, 'utf8')
    assert.ok(csv.includes('600000') && csv.includes('600002'))
    assert.equal(theirs.count, 2)
    // 报告里用的是千分位格式（toLocaleString），所以按同一种格式比对
    const money = (x) => Math.round(x).toLocaleString('zh-CN', { maximumFractionDigits: 0 })
    assert.ok(md.includes(money(theirs.marketValue)), `导出报告的市值应与工具一致（${theirs.marketValue}）`)
    assert.equal(mine.files.length, 2)
    // 明细逐行也要对得上，否则"总额对、明细错"这种问题不会被发现
    for (const p of theirs.positions) {
      assert.ok(csv.includes(p.code), `CSV 缺 ${p.code}`)
      assert.ok(csv.includes(String(p.shares)), `CSV 缺 ${p.code} 的股数`)
    }
  } finally { rmSync(work, { recursive: true, force: true }); cleanup() }
})

test('导出：持仓市值累加用未取整的值（逐行取整再相加会差几分钱）', async () => {
  const { runtime, cleanup } = makeRuntime()
  const work = mkdtempSync(join(tmpdir(), 'dsh-quant-ws-'))
  try {
    const store = runtime.store()
    // 两只股票各 1 股、收盘价 10.004：逐行取整 → 10.00 + 10.00 = 20.00；
    // 先相加再取整 → 20.008 → 20.01。两者必须与 quant_portfolio_status 一致。
    store.upsertCodes([
      { code: '600000', name: 'A', market: 1, board: 'sh_main', listDate: 20100101 },
      { code: '600001', name: 'B', market: 1, board: 'sh_main', listDate: 20100101 },
    ])
    for (const code of ['600000', '600001']) {
      store.upsertBars(code, [{ date: 20240110, open: 10.004, high: 10.004, low: 10.004, close: 10.004, volume: 1, amount: 1, pct: 0, turnover: 0 }])
      store.setSyncState(code, { barsLast: 20240110, status: 'ok' })
    }
    store.saveHoldings([{ code: '600000', shares: 1, cost: 10 }, { code: '600001', shares: 1, cost: 10 }])

    const theirs = await portfolioTools(runtime).find((t) => t.name === 'quant_portfolio_status').execute({}, {})
    const mine = await tool(runtime, 'quant_export').execute({ kind: 'holdings', format: 'markdown' }, execIn(work))
    assert.equal(mine.ok, true, JSON.stringify(mine.error))
    const md = readFileSync(mine.files[0].path, 'utf8')
    const money = (x) => Math.round(x).toLocaleString('zh-CN', { maximumFractionDigits: 0 })
    assert.ok(md.includes(money(theirs.marketValue)), `导出的市值必须与工具逐分一致（工具 ${theirs.marketValue}）`)
  } finally { rmSync(work, { recursive: true, force: true }); cleanup() }
})

test('导出：没有持仓时明确报错，不产出空文件', async () => {  const { runtime, cleanup } = makeRuntime()
  seedMarket(runtime.store())
  const v = await tool(runtime, 'quant_export').execute({ kind: 'holdings' }, {})
  assert.equal(v.ok, false)
  assert.equal(v.error.code, 'NO_HOLDINGS')
  assert.match(v.error.hint, /quant_save_holdings/)
  cleanup()
})

test('导出：仓库不存在时给 NO_STORE 而不是崩', async () => {
  const { runtime, cleanup } = makeRuntime()
  const v = await tool(runtime, 'quant_export').execute({ kind: 'data_status' }, {})
  assert.equal(v.ok, false)
  assert.equal(v.error.code, 'NO_STORE')
  cleanup()
})

test('导出：缺必填参数时给 MISSING_ARG，不猜', async () => {
  const { runtime, cleanup } = makeRuntime()
  seedMarket(runtime.store())
  for (const [args, code] of [[{ kind: 'backtest' }, 'MISSING_ARG'], [{ kind: 'panel' }, 'MISSING_ARG']]) {
    const v = await tool(runtime, 'quant_export').execute(args, {})
    assert.equal(v.ok, false, `${JSON.stringify(args)} 应当失败`)
    assert.equal(v.error.code, code)
  }
  cleanup()
})

test('导出：presentationMeta 是 lossless JSON，且带 present 需要的绝对路径', async () => {
  const { runtime, cleanup } = makeRuntime()
  const work = mkdtempSync(join(tmpdir(), 'dsh-quant-ws-'))
  try {
    seedMarket(runtime.store())
    const t = tool(runtime, 'quant_export')
    const v = await t.execute({ kind: 'data_status' }, execIn(work))
    const meta = t.output.presentationMeta({ kind: 'data_status' }, v)
    assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta, 'meta 必须是 lossless JSON')
    assert.equal(meta.kind, 'export')
    assert.equal(meta.exportKind, 'data_status')
    assert.ok(meta.files[0].path.startsWith('/'), 'present 需要绝对路径')
  } finally { rmSync(work, { recursive: true, force: true }); cleanup() }
})

test('导出：render 明确要求模型接着调用 present（否则用户拿不到交付物）', async () => {
  const { runtime, cleanup } = makeRuntime()
  const work = mkdtempSync(join(tmpdir(), 'dsh-quant-ws-'))
  try {
    seedMarket(runtime.store())
    const t = tool(runtime, 'quant_export')
    const v = await t.execute({ kind: 'data_status' }, execIn(work))
    const text = t.output.render({ kind: 'data_status' }, v)[0].text
    assert.ok(text.includes('present'), 'render 必须提示下一步调用 present')
    assert.ok(text.includes(v.files[0].path), 'render 要给出绝对路径')
  } finally { rmSync(work, { recursive: true, force: true }); cleanup() }
})

test('导出：data_status 导出复用 syncStatus，新鲜度口径与工具一致', async () => {
  const { runtime, cleanup } = makeRuntime()
  const work = mkdtempSync(join(tmpdir(), 'dsh-quant-ws-'))
  try {
    const store = runtime.store()
    seedMarket(store)
    const s = syncStatus(store, {})
    const v = await tool(runtime, 'quant_export').execute({ kind: 'data_status' }, execIn(work))
    const md = readFileSync(v.files[0].path, 'utf8')
    assert.ok(md.includes(String(s.codes)), '股票数要与 syncStatus 一致')
    assert.ok(md.includes(`${s.freshness.weekdays} 个工作日`), '工作日口径要一致')
  } finally { rmSync(work, { recursive: true, force: true }); cleanup() }
})

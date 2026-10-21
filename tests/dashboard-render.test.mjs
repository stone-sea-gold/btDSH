/**
 * 看板渲染器与导出接入。
 *
 * 守住四类容易在"本地看着没问题、发出去就坏"的地方：
 *   1. **契约**：render.mjs 只吃模型（不 import fs/store/工具层）——否则 Phase 2 换通道就得改渲染器
 *   2. **转义**：模型里的公式用户可以写 `</script>`，漏转义整页白屏
 *   3. **自包含**：产物里不能有任何外部请求（离线可用是验收标准）
 *   4. **体积**：7 年日频报告必须 < 900KB（内联 ECharts 664KB 之后的预算）
 *
 * 运行: node --test tests/dashboard-render.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

import { buildBacktestDashboard, buildCompareDashboard } from '../lib/dashboard/model.mjs'
import { renderDashboardHtml } from '../lib/dashboard/render.mjs'
import { loadDashboardAssets, _resetAssetCache, ECHARTS_PATH } from '../lib/dashboard/assets.mjs'
import { exportTools } from '../lib/tools/export.mjs'
import { createRuntime } from '../lib/runtime.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = loadDashboardAssets()

/** 造一段 n 个交易日的净值（跳周末），用于体积与渲染测试 */
function makeNav(n = 260) {
  const out = []
  let v = 1
  let d = Date.UTC(2018, 0, 1)
  while (out.length < n) {
    d += 86400000
    const dt = new Date(d)
    if (dt.getUTCDay() === 0 || dt.getUTCDay() === 6) continue
    v *= 1.0005
    out.push({
      date: Number(`${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`),
      nav: +v.toFixed(6),
    })
  }
  return out
}

function makeRecord({ nav = makeNav(), formula = '$close / Ref($close, 20) - 1' } = {}) {
  return {
    backtest_id: 'bt_render_001',
    strategy_id: 'demo_render',
    version: 1,
    config: {
      start: nav[0].date, end: nav.at(-1).date, initialCash: 1_000_000,
      factors: [{ id: 'momentum_1m', formula }],
      selection: { k: 20 }, rebalance: 'monthly', weight: 'equal', benchmarkCode: null,
    },
    metrics: {
      days: nav.length, totalReturn: 0.31, cagr: 0.12, annualVol: 0.2, sharpe: 0.7,
      maxDrawdown: -0.14, calmar: 0.86, winRate: 0.52, trades: 120, turnover: 3.1,
      fees: { commission: 800, stampDuty: 500, transferFee: 8, slippage: 1500 },
      byFactor: [{ factorId: 'momentum_1m', totalReturn: 0.31, cagr: 0.12, sharpe: 0.7, maxDrawdown: -0.14, trades: 120 }],
      caveats: ['自定义口径甲'], skipped: { buy: { limitUp: 3 }, sell: { limitDown: 1 } },
    },
    nav,
  }
}

const html = (record, opts = {}) =>
  renderDashboardHtml(buildBacktestDashboard(record, { generatedAt: 1700000000000, ...opts }), assets)

// ── 契约 ─────────────────────────────────────────────────────────────────────
test('契约：render.mjs 是纯渲染，不碰磁盘/仓库/工具层', () => {
  const src = readFileSync(join(ROOT, 'lib', 'dashboard', 'render.mjs'), 'utf8')
  const imports = [...src.matchAll(/^import\s.+from\s+'([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports, [], `render.mjs 不应有运行时 import，实际：${imports.join(', ')}`)
  // 只看代码，不看注释（注释里说明"不碰 store"不该被判违规）
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/require\(/.test(code), 'render.mjs 不应 require')
  assert.ok(!/from\s+'node:/.test(code), 'render.mjs 不应引入 node 内置模块')
  assert.ok(!/readFileSync\(/.test(code), 'render.mjs 不应读磁盘')
})

// ── 转义 ─────────────────────────────────────────────────────────────────────
test('转义：模型里的 </script> 不能提前闭合内联标签', () => {
  const evil = '</script><script>alert(1)</script>'
  const out = html(makeRecord({ formula: evil }))
  const m = /<script type="application\/json" id="dashboard-model">([\s\S]*?)<\/script>/.exec(out)
  assert.ok(m, '没找到内联模型')
  assert.ok(!m[1].includes('</script'), '内联 JSON 里残留了 </script')
  assert.deepEqual(JSON.parse(m[1]).runs[0].config.factors[0].formula, evil, '转义后仍应还原为原文')
})

test('转义：内联的 ECharts / 运行时脚本都被处理过', () => {
  const out = html(makeRecord())
  // 正常脚本内容里不应出现未转义的裸 `</script`
  const body = out.slice(out.indexOf('<script>'), out.lastIndexOf('</script>'))
  assert.ok(!/<\/script(?!>)/.test(body.replace(/<\/script>/g, '')), '存在未转义的 </script 变体')
})

// ── 自包含 ───────────────────────────────────────────────────────────────────
test('自包含：产物不引用任何外部资源（离线可开）', () => {
  const out = html(makeRecord())
  assert.ok(!/src\s*=\s*["']https?:/i.test(out), '出现外部 script/img 引用')
  assert.ok(!/href\s*=\s*["']https?:/i.test(out), '出现外部 link 引用')
  assert.ok(!/@import\s+url\(/i.test(out), 'CSS 里有外部 @import')
  assert.ok(out.includes('<style>'), '样式应内联')
})

test('自包含：模型可回解析且与输入一致（Phase 2 换通道时用的是同一份 schema）', () => {
  const record = makeRecord()
  const model = buildBacktestDashboard(record, { generatedAt: 1700000000000 })
  const out = renderDashboardHtml(model, assets)
  const m = /<script type="application\/json" id="dashboard-model">([\s\S]*?)<\/script>/.exec(out)
  assert.deepEqual(JSON.parse(m[1]), model)
  assert.equal(JSON.parse(m[1]).schemaVersion, 1)
})

// ── 内容 ─────────────────────────────────────────────────────────────────────
test('内容：八个区块的锚点齐全', () => {
  const out = html(makeRecord())
  for (const must of ['chart-nav', 'chart-dd', 'chart-yearly', '口径声明', '成本与可交易性', '回撤区间', '分年度']) {
    assert.ok(out.includes(must), `产物缺少区块：${must}`)
  }
  assert.ok(out.includes('theme-toggle'), '缺少明暗切换按钮')
  assert.ok(out.includes('导出 PNG'), '缺少图片导出按钮')
})

test('内容：单因子时不渲染分因子块（无对比价值）', () => {
  const u = runtimeUtil()
  // 分因子块由运行时按 byFactor 长度决定；单因子必须返回空串（整块不出）
  assert.equal(u.renderByFactor({ byFactor: [{ factorId: 'only_one', totalReturn: 0.31, cagr: 0.12 }] }), '')
  assert.equal(u.renderByFactor({ byFactor: [] }), '')
  const two = u.renderByFactor({
    byFactor: [
      { factorId: 'a', totalReturn: 0.1, cagr: 0.05, sharpe: 0.4, maxDrawdown: -0.2, trades: 10 },
      { factorId: 'b', totalReturn: 0.3, cagr: 0.15, sharpe: 0.8, maxDrawdown: -0.1, trades: 20 },
    ],
  })
  assert.ok(two.includes('<details'), '多因子应折叠展示')
  assert.ok(two.includes('最优 b 年化 15.00%'), '折叠态必须带一行结论')
  assert.ok(!two.includes('<details open'), '默认应折叠')
})

test('内容：不可交易被拒计数与口径声明都进入产物', () => {
  const out = html(makeRecord())
  assert.ok(out.includes('自定义口径甲'), '口径声明丢失')
  assert.ok(out.includes('被拒'), '不可交易统计丢失')
})

// ── 运行时纯逻辑（在 VM 里跑真实客户端脚本）────────────────────────────────
function loadRuntime() {
  const sandbox = { __DASHBOARD_AUTOSTART__: false, console }
  sandbox.window = sandbox
  sandbox.document = { getElementById: () => null }
  createContext(sandbox)
  runInContext(readFileSync(join(ROOT, 'lib', 'dashboard', 'client-runtime.js'), 'utf8'), sandbox)
  return sandbox
}
const runtimeUtil = () => loadRuntime().__dashUtil

test('分因子摘要：优先按年化，退化到总收益，再退化到只报数量', () => {
  const u = runtimeUtil()
  assert.equal(
    u.factorSummary([{ factorId: 'a', cagr: 0.05 }, { factorId: 'b', cagr: 0.123, totalReturn: 0.5 }]),
    '2 个因子已对比 · 最优 b 年化 12.30%',
  )
  assert.equal(
    u.factorSummary([{ factorId: 'x', cagr: null, totalReturn: 0.3 }, { factorId: 'y', cagr: null, totalReturn: 0.1 }]),
    '2 个因子已对比 · 最优 x 总收益 30.00%',
  )
  assert.equal(u.factorSummary([{ factorId: 'x', cagr: null, totalReturn: null }]), '1 个因子已对比')
})

test('格式化：null/NaN 显示为破折号而不是 0', () => {
  const u = runtimeUtil()
  assert.equal(u.fmt(null, 'pct'), '—')
  assert.equal(u.fmt(NaN, 'pct'), '—')
  assert.equal(u.fmt(0, 'pct'), '0.00%')
  assert.equal(u.ymd(20240102), '2024-01-02')
})

test('DOM 组装：单 run 分支结构完整，且不出现 undefined', () => {
  const u = runtimeUtil()
  const model = buildBacktestDashboard(makeRecord(), { generatedAt: 1700000000000 })
  const out = u.build(model)
  for (const must of ['demo_render', 'chart-nav', 'chart-dd', 'chart-yearly', '净值曲线', '成本与可交易性', 'theme-toggle']) {
    assert.ok(out.includes(must), `单 run 组装缺少：${must}`)
  }
  assert.ok(!out.includes('undefined'), '组装结果里出现 undefined，说明某处读到了不存在的字段')
  assert.ok(!out.includes('NaN'), '组装结果里出现 NaN')
})

test('DOM 组装：多 run 分支走对比表，不画分年度柱图，回撤表带 run 名', () => {
  const u = runtimeUtil()
  const a = makeRecord()
  const b = { ...makeRecord(), backtest_id: 'bt_render_002' }
  const model = buildCompareDashboard([a, b], { generatedAt: 1700000000000 })
  const out = u.build(model)
  assert.ok(out.includes('指标对比'), '多 run 应渲染指标对比表')
  assert.ok(!out.includes('chart-yearly'), '多 run 不渲染分年度柱图（yearlyOption 只接单 run）')
  assert.ok(out.includes('回撤区间 · '), '多 run 的回撤表需要标出 run 名')
  assert.ok(!out.includes('undefined'))
})

// ── 体积 ─────────────────────────────────────────────────────────────────────
test('体积：7 年日频报告 < 900KB', () => {
  const rec = makeRecord({ nav: makeNav(1750) })
  const bytes = Buffer.byteLength(html(rec))
  assert.ok(bytes < 900 * 1024, `体积超标：${(bytes / 1024).toFixed(0)}KB`)
  assert.ok(bytes > 600 * 1024, `体积异常偏小（可能没内联 ECharts）：${(bytes / 1024).toFixed(0)}KB`)
})

// ── 导出接入 ─────────────────────────────────────────────────────────────────
function tempRuntime() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-quant-dash-'))
  const runtime = createRuntime({ dataDir: dir })
  return { runtime, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('导出：format=html 产出单文件看板并登记为 html 交付物', async () => {
  const { runtime, dir, cleanup } = tempRuntime()
  try {
    const rec = makeRecord()
    runtime.store().saveBacktest({
      backtestId: 'bt_html_001', strategyId: 'demo_render', version: 1,
      config: rec.config, metrics: rec.metrics, nav: rec.nav, sessionId: null,
    })
    const tool = exportTools(runtime).find((t) => t.name === 'quant_export')
    const v = await tool.execute(
      { kind: 'backtest', backtestId: 'bt_html_001', format: 'html' },
      { agent: { session: { header: { cwd: dir } } } },
    )
    assert.equal(v.ok, true, `导出失败：${JSON.stringify(v.error)}`)
    assert.equal(v.files.length, 1)
    assert.equal(v.files[0].format, 'html')
    assert.ok(v.files[0].filename.endsWith('.html'))
    assert.equal(v.files[0].bytes, statSync(v.files[0].path).size)

    const text = readFileSync(v.files[0].path, 'utf8')
    assert.ok(text.includes('id="dashboard-model"'), '产物缺少内联模型')
    assert.ok(text.includes('echarts'), '产物没内联 ECharts')
    assert.ok(statSync(v.files[0].path).size > 600 * 1024)

    // 落点必须是会话工作目录（present 才拿得到）
    assert.equal(readdirSync(join(dir, 'quant-exports')).length, 1)
  } finally {
    cleanup()
  }
})

test('导出：format=html 只对 kind=backtest 有效，其他类型明确拒绝', async () => {
  const { runtime, cleanup } = tempRuntime()
  try {
    runtime.store() // 建库：真实场景里仓库一定存在，这里要验的是格式校验而不是 NO_STORE
    const tool = exportTools(runtime).find((t) => t.name === 'quant_export')
    const v = await tool.execute({ kind: 'select', format: 'html' }, {})
    assert.equal(v.ok, false)
    assert.equal(v.error.code, 'BAD_FORMAT')
    assert.match(v.error.hint, /markdown|csv/)
  } finally {
    cleanup()
  }
})

test('导出：净值曲线不足 2 点时给出 NO_NAV 而不是崩', async () => {
  const { runtime, dir, cleanup } = tempRuntime()
  try {
    runtime.store().saveBacktest({
      backtestId: 'bt_empty', strategyId: 'x', version: 1,
      config: { start: 20240101, end: 20240102, initialCash: 1e6, factors: [] },
      metrics: { days: 1 }, nav: [{ date: 20240102, nav: 1 }], sessionId: null,
    })
    const tool = exportTools(runtime).find((t) => t.name === 'quant_export')
    const v = await tool.execute(
      { kind: 'backtest', backtestId: 'bt_empty', format: 'html' },
      { agent: { session: { header: { cwd: dir } } } },
    )
    assert.equal(v.ok, false)
    assert.equal(v.error.code, 'NO_NAV')
  } finally {
    cleanup()
  }
})

test('资产：缓存生效且缺文件时报 NO_VENDOR 而不是静默', () => {
  _resetAssetCache()
  const a = loadDashboardAssets()
  assert.equal(a, loadDashboardAssets(), '第二次应命中缓存')
  assert.ok(statSync(ECHARTS_PATH).size > 500_000)
  assert.throws(
    () => renderDashboardHtml({ schemaVersion: 1, runs: [] }, { echartsJs: '', runtimeJs: 'x' }),
    (e) => e.code === 'NO_VENDOR',
  )
})

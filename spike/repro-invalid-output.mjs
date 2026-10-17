/**
 * INVALID_TOOL_OUTPUT 修复的**真校验器**全量对照。
 *
 * 背景：DSH 宿主会拿 output.schema 校验工具返回值，不过就抛 INVALID_TOOL_OUTPUT。
 * 曾有两个真实故障：
 *   1. quant_trading_calendar 空仓库返回 first/last: null，schema 却声明 integer；
 *   2. quant_factor_preview 空库走 fail() 信封，schema 却要求 formula/coverage/top。
 * tests/tools.test.mjs 里用复刻校验器兜底；这里用 **DSH 同款真校验器**
 * （@deepseek-ai/dsh-tools/lib/types/json-schema.js）把全部工具再对一遍：
 *   - assertSupportedJsonSchema：schema 本身必须在受支持子集内（注册层语义）
 *   - validateJsonSchemaValue：失败信封必须 0 违规；报错场景样例必须 0 违规
 *
 * 用法: node spike/repro-invalid-output.mjs   （依赖宿主安装树，找不到则跳过）
 */
import { mkdtempSync, rmSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DSH = process.env.DSH_PKGS ?? '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
let validator
try {
  validator = await import(pathToFileURL(join(DSH, 'dsh-tools/lib/types/json-schema.js')).href)
} catch (e) {
  console.log(`⚠️  跳过：宿主环境里找不到 dsh-tools（${e.message}）`)
  process.exit(0)
}
const { assertSupportedJsonSchema, validateJsonSchemaValue } = validator

const { createRuntime } = await import('../lib/runtime.mjs')
const { factorTools } = await import('../lib/tools/factor.mjs')
const { strategyTools } = await import('../lib/tools/strategy.mjs')
const { backtestTools } = await import('../lib/tools/backtest.mjs')
const { dataTools } = await import('../lib/tools/data.mjs')
const { portfolioTools } = await import('../lib/tools/portfolio.mjs')
const { autosyncTools } = await import('../lib/tools/autosync.mjs')
const { exportTools } = await import('../lib/tools/export.mjs')

// 带数据最好（p1 验证库在就拷进来），空仓库也能跑 —— 失败信封校验不依赖数据
const dir = mkdtempSync(join(tmpdir(), 'dsh-quant-repro-'))
if (existsSync('spike/out/p1-verify.db')) copyFileSync('spike/out/p1-verify.db', join(dir, 'quant.db'))
const runtime = createRuntime({ dataDir: dir })

const tools = [
  ...factorTools(runtime), ...strategyTools(runtime), ...backtestTools(runtime),
  ...dataTools(runtime), ...portfolioTools(runtime), ...autosyncTools(runtime),
  ...exportTools(runtime),
]
const byName = Object.fromEntries(tools.map((t) => [t.name, t]))

let bad = 0

// ── 1) 全部工具：schema 断言（注册层） + 失败信封值校验 ─────────────────────
for (const t of tools) {
  try {
    assertSupportedJsonSchema(t.output.schema)
  } catch (e) {
    bad++
    console.log(`❌ ${t.name}: schema 断言失败 —— ${e.message}`)
    continue
  }
  const v = validateJsonSchemaValue(t.output.schema, { ok: false, error: { code: 'X', message: '测试失败' } })
  if (v.length) {
    bad++
    console.log(`❌ ${t.name}: 失败信封被拒 —— ${v.join('; ')}`)
  }
}
console.log(`✅ 全部 ${tools.length} 个工具：schema 断言 + 失败信封值校验${bad ? '' : '通过'}`)

// ── 2) 两个真实故障场景：修复前逐字复现、修复后必须 0 违规 ──────────────────
const scenarios = [
  ['quant_trading_calendar', { ok: true, count: 0, dates: [], first: null, last: null },
    '修复前宿主报 "value.first" must be an integer; "value.last" must be an integer'],
  ['quant_factor_preview', { ok: false, error: { code: 'NO_DATA', message: '仓库里没有行情数据，先跑 quant_data_sync' } },
    '修复前宿主报 missing required property "value.formula"/"value.coverage"/"value.top"'],
  ['quant_factor_preview', {
    ok: true, formula: '$close / Ref($close, 20) - 1', date: 20240101,
    layers: 1, lookback: 20, coverage: 0.99, distinct: 100, stocks: 100, top: [],
  }, '成功载荷必须仍然合法'],
  ['quant_data_status', {
    ok: true, ready: false, stale: true, codes: 0, bars: 0, adjEvents: 0, range: [null, null],
    byStatus: {}, pendingCount: 0, uncovered: 0, dir: '/tmp/x',
    freshness: { today: null, lastDate: null, calendarDays: null, weekdays: null, stale: true, basis: 'weekdays' },
    autoSync: { enabled: false, configured: false },
  }, '空仓库返回值（range[null,null]）必须合法'],
  ['quant_factor_create', { ok: true, id: 'my_x', version: 1, layers: 2, fields: ['$close'], functions: ['Ref'], materialized: null },
    '默认不物化时 materialized=null 必须合法'],
  ['quant_portfolio_status', { ok: true, asOf: null, count: 0, marketValue: 0, costValue: 0, positions: [] },
    '空持仓时 asOf=null 必须合法'],
  ['quant_autosync', { ok: true, state: { enabled: false }, nextDueAt: null, nextDueText: null, timer: false },
    '未开启时 nextDueAt/nextDueText=null 必须合法'],
]
for (const [name, value, why] of scenarios) {
  const v = validateJsonSchemaValue(byName[name].output.schema, value)
  if (v.length) {
    bad++
    console.log(`❌ ${name}: ${why} —— 实际违规：${v.join('; ')}`)
  } else {
    console.log(`✅ ${name}: ${why}`)
  }
}

// ── 3) 保护意义保留：真违约仍要被拦 ─────────────────────────────────────────
const leaked = validateJsonSchemaValue(byName.quant_factor_preview.output.schema, { ok: true, formula: 'f', top: [] })
if (!leaked.length) {
  bad++
  console.log('❌ 保护弱化：成功值缺 required 业务字段竟然通过了')
} else {
  console.log(`✅ 保护保留：成功值缺业务字段仍被拦（${leaked.join('; ')}）`)
}

rmSync(dir, { recursive: true, force: true })
console.log(bad ? `\n❌ ${bad} 处未通过` : '\n✅ 全部通过')
process.exit(bad ? 1 : 0)

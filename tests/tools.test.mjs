/**
 * 工具面契约单测。
 *
 * 这里验的是**模型看不到但会直接导致注册失败/渲染崩溃**的东西：
 *   - DSH 的 JSON Schema 只支持一个**子集**（`format`/`minimum`/`pattern` 会被拒绝）。
 *     30 个工具手写 schema，靠人眼保证不越界是不现实的，必须机器检查。
 *   - DSH 宿主会拿 output.schema 校验工具的**实际返回值**，不过就抛
 *     INVALID_TOOL_OUTPUT —— 失败信封 `{ok:false, error}` 也要能过校验，
 *     否则每次预期失败都变成宿主级硬错误（实测踩过：quant_factor_preview
 *     空库时模型只看到 `missing required property "value.formula"`）。
 *   - `output.render` 必须存在、必须返回 `[{type:'text',text}]`。
 *   - 工具名唯一、带 `quant_` 前缀、不占用保留名 `run_code`。
 *   - 审批护栏的真值表。
 *
 * 运行: node --test tests/*.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../lib/runtime.mjs'
import { factorTools } from '../lib/tools/factor.mjs'
import { strategyTools } from '../lib/tools/strategy.mjs'
import { backtestTools } from '../lib/tools/backtest.mjs'
import { dataTools } from '../lib/tools/data.mjs'
import { portfolioTools } from '../lib/tools/portfolio.mjs'
import { autosyncTools } from '../lib/tools/autosync.mjs'
import { exportTools } from '../lib/tools/export.mjs'
import { GUARD_RULES } from '../lib/approval.mjs'
import { estimateSync } from '../lib/data/sync.mjs'
import { openStore } from '../lib/data/store.mjs'

// ── 与 DSH dsh-tools 的 checkSchemaNode 保持一致的子集定义 ──────────────────
const CONSTRAINT = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION = new Set(['description', 'title', 'default', 'examples'])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

/** 复刻 DSH 的 schema 校验，返回违规列表 */
function validateSchema(node, path = 'schema', seen = new Set()) {
  const bad = []
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return [`${path} 必须是 schema 对象`]
  if (seen.has(node)) return [`${path} 循环引用`]
  seen.add(node)
  for (const k of Object.keys(node)) {
    if (CONSTRAINT.has(k)) continue
    if (ANNOTATION.has(k)) continue
    bad.push(`${path}.${k} 不是受支持的关键字`)
  }
  if (node.description !== undefined && typeof node.description !== 'string') bad.push(`${path}.description 必须是字符串`)
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) { bad.push(`${path} 不能同时有 type 与 oneOf`); return bad }
  if (!hasType && !hasOneOf) {
    for (const k of ONE_OF_SIBLINGS) if (Object.hasOwn(node, k)) bad.push(`${path}.${k} 需要 type 或 oneOf`)
    return bad
  }
  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) bad.push(`${path}.oneOf 至少两个 schema`)
    else node.oneOf.forEach((s, i) => bad.push(...validateSchema(s, `${path}.oneOf[${i}]`, seen)))
    for (const k of ONE_OF_SIBLINGS) if (Object.hasOwn(node, k)) bad.push(`${path}.${k} 不能与 oneOf 并列`)
    return bad
  }
  if (!TYPES.has(node.type)) { bad.push(`${path}.type 非法：${JSON.stringify(node.type)}`); return bad }
  if (node.type === 'object') {
    if (node.properties !== undefined) {
      if (typeof node.properties !== 'object' || Array.isArray(node.properties)) bad.push(`${path}.properties 必须是对象`)
      else for (const [k, v] of Object.entries(node.properties)) bad.push(...validateSchema(v, `${path}.properties.${k}`, seen))
    }
    if (node.required !== undefined) {
      if (!Array.isArray(node.required) || node.required.some((x) => typeof x !== 'string')) bad.push(`${path}.required 必须是字符串数组`)
      else if (node.properties) for (const r of node.required) if (!Object.hasOwn(node.properties, r)) bad.push(`${path}.required 含未声明的字段 ${r}`)
    }
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean' && typeof node.additionalProperties !== 'object') {
      bad.push(`${path}.additionalProperties 必须是布尔或 schema`)
    }
  }
  if (node.type === 'array' && node.items !== undefined) bad.push(...validateSchema(node.items, `${path}.items`, seen))
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) bad.push(`${path}.enum 必须是非空数组`)
  return bad
}

// ── 值校验：复刻 DSH dsh-tools 对**返回值**的校验语义 ────────────────────────
// 项目零依赖，不能直接 import @deepseek-ai/dsh-tools；这里按它的 json-schema.js
// 复刻本项目 schema 实际用到的子集（type/oneOf/const/properties/required/
// additionalProperties/items/enum）。报错消息也按宿主格式生成，方便逐字对照。
// 真校验器的对照见 spike/repro-invalid-output.mjs。
function checkScalar(schema, value, path) {
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return [`"${path}" must be ${JSON.stringify(schema.const)}`]
  if (schema.enum !== undefined && !schema.enum.includes(value)) return [`"${path}" must be one of ${JSON.stringify(schema.enum)}`]
  return []
}

function validateValue(schema, value, path = 'value') {
  if (Object.hasOwn(schema, 'oneOf')) {
    const matched = schema.oneOf.filter((branch) => validateValue(branch, value, path).length === 0).length
    return matched === 1 ? [] : [`"${path}" must match exactly one oneOf branch (matched ${matched})`]
  }
  switch (schema.type) {
    case undefined:
      return []
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`"${path}" must be an object`]
      const bad = []
      for (const k of schema.required ?? []) {
        if (!Object.hasOwn(value, k) || value[k] === undefined) bad.push(`missing required property "${path}.${k}"`)
      }
      for (const [k, sub] of Object.entries(schema.properties ?? {})) {
        if (!Object.hasOwn(value, k) || value[k] === undefined) continue
        bad.push(...validateValue(sub, value[k], `${path}.${k}`))
      }
      if (schema.additionalProperties === false) {
        for (const k of Object.keys(value)) {
          if (!Object.hasOwn(schema.properties ?? {}, k)) bad.push(`"${path}.${k}" is not a declared property (additionalProperties: false)`)
        }
      }
      return bad
    }
    case 'array': {
      if (!Array.isArray(value)) return [`"${path}" must be an array`]
      return schema.items === undefined ? [] : value.flatMap((v, i) => validateValue(schema.items, v, `${path}[${i}]`))
    }
    case 'string':
      return typeof value === 'string' ? checkScalar(schema, value, path) : [`"${path}" must be a string`]
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? checkScalar(schema, value, path)
        : [`"${path}" must be a finite JSON number`]
    case 'integer':
      return Number.isInteger(value) ? checkScalar(schema, value, path) : [`"${path}" must be an integer`]
    case 'boolean':
      return typeof value === 'boolean' ? checkScalar(schema, value, path) : [`"${path}" must be a boolean`]
    case 'null':
      return value === null ? checkScalar(schema, value, path) : [`"${path}" must be null`]
    default:
      return []
  }
}

/** 造一个带数据的临时运行时（复用 P1 验证库） */
function makeRuntime() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-quant-test-'))
  if (existsSync('spike/out/p1-verify.db')) {
    mkdirSync(dir, { recursive: true })
    copyFileSync('spike/out/p1-verify.db', join(dir, 'quant.db'))
  }
  return { runtime: createRuntime({ dataDir: dir }), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function allTools(runtime) {
  return [
    ...factorTools(runtime), ...strategyTools(runtime), ...backtestTools(runtime),
    ...dataTools(runtime), ...portfolioTools(runtime),
    ...autosyncTools(runtime), ...exportTools(runtime),
  ]
}

test('工具面：31 个工具，名字唯一、带 quant_ 前缀、不占用保留名', () => {
  const { runtime, cleanup } = makeRuntime()
  const tools = allTools(runtime)
  assert.equal(tools.length, 31, '工具总数应为 31')
  const names = tools.map((t) => t.name)
  assert.equal(new Set(names).size, names.length, '工具名必须唯一')
  for (const n of names) {
    assert.match(n, /^quant_[a-z_]+$/, `${n} 必须是小写下划线的 quant_ 前缀`)
    assert.notEqual(n, 'run_code', 'run_code 是保留名')
  }
  cleanup()
})

test('工具面：每个 schema 都落在 DSH 支持的 JSON Schema 子集内', () => {
  const { runtime, cleanup } = makeRuntime()
  for (const t of allTools(runtime)) {
    const pBad = validateSchema(t.parameters, `${t.name}.parameters`)
    assert.deepEqual(pBad, [], `${t.name} 的 parameters 越界：${pBad.join('; ')}`)
    const oBad = validateSchema(t.output.schema, `${t.name}.output.schema`)
    assert.deepEqual(oBad, [], `${t.name} 的 output.schema 越界：${oBad.join('; ')}`)
  }
  cleanup()
})

test('工具面：失败信封必须能过 output.schema 校验（否则每次预期失败都变成宿主级 INVALID_TOOL_OUTPUT）', () => {
  const { runtime, cleanup } = makeRuntime()
  const envelope = { ok: false, error: { code: 'X', message: '测试失败' } }
  for (const t of allTools(runtime)) {
    const bad = validateValue(t.output.schema, envelope)
    assert.deepEqual(bad, [], `${t.name} 的 output.schema 拒绝失败信封：${bad.join('; ')}`)
  }
  cleanup()
})

test('工具面：回归 —— quant_trading_calendar 空仓库 / quant_factor_preview 空库的真实返回值必须合法', () => {
  const { runtime, cleanup } = makeRuntime()
  const byName = Object.fromEntries(allTools(runtime).map((t) => [t.name, t]))

  // 宿主报过："value.first" must be an integer; "value.last" must be an integer
  const cal = byName.quant_trading_calendar
  assert.deepEqual(
    validateValue(cal.output.schema, { ok: true, count: 0, dates: [], first: null, last: null }), [],
    'quant_trading_calendar 空仓库返回值必须合法',
  )

  // 宿主报过：missing required property "value.formula" / "value.coverage" / "value.top"
  const preview = byName.quant_factor_preview
  assert.deepEqual(
    validateValue(preview.output.schema, { ok: false, error: { code: 'NO_DATA', message: '仓库里没有行情数据，先跑 quant_data_sync' } }), [],
    'quant_factor_preview 的 NO_DATA 失败信封必须合法',
  )
  assert.deepEqual(
    validateValue(preview.output.schema, {
      ok: true, formula: '$close / Ref($close, 20) - 1', date: 20240101,
      layers: 1, lookback: 20, coverage: 0.99, distinct: 100, stocks: 100, top: [],
    }), [],
    'quant_factor_preview 成功载荷必须合法',
  )
  // 保护意义保留：成功值缺 required 业务字段仍要被拦（0 个分支匹配）
  const leaked = validateValue(preview.output.schema, { ok: true, formula: 'f', top: [] })
  assert.ok(leaked.length > 0, `成功值缺 coverage 必须被拦，实际：${JSON.stringify(leaked)}`)
  cleanup()
})

test('工具面：声明了类型的字段运行时返回 null 必须显式 nullable（逐点回归）', () => {
  const { runtime, cleanup } = makeRuntime()
  const byName = Object.fromEntries(allTools(runtime).map((t) => [t.name, t]))

  // 样例值直接摘自各工具 execute 的真实返回（空仓库 / 默认参数路径）
  const cases = [
    ['quant_data_status', {
      ok: true, ready: false, stale: true, codes: 0, bars: 0, adjEvents: 0, range: [null, null],
      byStatus: {}, pendingCount: 0, uncovered: 0, dir: '/tmp/x',
      freshness: { today: null, lastDate: null, calendarDays: null, weekdays: null, stale: true, basis: 'weekdays' },
      autoSync: { enabled: false, configured: false },
    }],
    ['quant_factor_create', { ok: true, id: 'my_x', version: 1, layers: 2, fields: ['$close'], functions: ['Ref'], materialized: null }],
    ['quant_portfolio_status', { ok: true, asOf: null, count: 0, marketValue: 0, costValue: 0, positions: [] }],
    ['quant_autosync', { ok: true, state: { enabled: false }, nextDueAt: null, nextDueText: null, timer: false }],
  ]
  for (const [name, value] of cases) {
    const bad = validateValue(byName[name].output.schema, value)
    assert.deepEqual(bad, [], `${name} 的真实返回值必须合法：${bad.join('; ')}`)
  }
  cleanup()
})

test('工具面：每个工具都有 description / render / execute，render 返回文本块', () => {
  const { runtime, cleanup } = makeRuntime()
  for (const t of allTools(runtime)) {
    assert.ok(typeof t.description === 'string' && t.description.length > 20, `${t.name} 的 description 太短`)
    assert.equal(typeof t.output.render, 'function', `${t.name} 缺少 render`)
    assert.equal(typeof t.execute, 'function', `${t.name} 缺少 execute`)
    // 用最小输入渲染一个失败信封，验证 render 不崩且形状正确
    const blocks = t.output.render({}, { ok: false, error: { code: 'X', message: '测试' } })
    assert.ok(Array.isArray(blocks) && blocks.length >= 1, `${t.name} 的 render 必须返回非空数组`)
    assert.equal(blocks[0].type, 'text', `${t.name} 的 render 首个块必须是 text`)
    assert.equal(typeof blocks[0].text, 'string', `${t.name} 的 render 文本必须是字符串`)
  }
  cleanup()
})

test('工具面：execute 抛异常时被包成失败信封，而不是把异常抛给模型', async () => {
  const { runtime, cleanup } = makeRuntime()
  // quant_kline_history 在仓库为空时会走网络；用一个必然失败的输入验证信封
  const t = dataTools(runtime).find((x) => x.name === 'quant_resolve_date')
  const v = await t.execute({ expr: '完全不合法' }, {})
  assert.equal(v.ok, false)
  assert.equal(typeof v.error.code, 'string')
  assert.equal(typeof v.error.message, 'string')
  cleanup()
})

test('审批护栏：真值表', () => {
  const sync = GUARD_RULES.quant_data_sync
  assert.equal(sync({ scope: 'codes' }), null, '代码表是秒级的，不拦')
  assert.equal(sync({ scope: 'all', estimateOnly: true }), null, '只估算不落地，不拦')
  assert.equal(sync({ scope: 'bars', codes: new Array(50).fill('600000') }), null, '小批量不拦')
  assert.equal(typeof sync({ scope: 'all' }), 'string', '全市场要拦')
  assert.equal(typeof sync({ scope: 'bars', codes: new Array(500).fill('600000') }), 'string', '大批量要拦')

  const bt = GUARD_RULES.quant_backtest_run
  assert.equal(bt({ config: { start: 20240101, end: 20260923 } }), null, '短区间不拦')
  assert.equal(typeof bt({ config: { start: 20150101, end: 20260923 } }), 'string', '长区间要拦')
  assert.equal(bt({ config: { start: 20150101, end: 20260923 }, confirm: true }), null, '确认后放行')
  assert.equal(bt({}), null, '缺参数交给工具自己报错')

  const opt = GUARD_RULES.quant_optimize_parameters
  assert.equal(opt({ space: { topK: [1, 2, 3] } }), null, '3 组不拦')
  // 6 × 3 × 2 × 3 = 108 组 > 100
  const bigSpace = { topK: [1, 2, 3, 4, 5, 6], rebalance: ['a', 'b', 'c'], weight: ['x', 'y'], buffer: [1, 2, 3] }
  assert.equal(typeof opt({ space: bigSpace }), 'string', '108 组要拦')
  assert.equal(opt({ space: bigSpace, confirm: true }), null, '确认后放行')

  const clean = GUARD_RULES.quant_data_cleanup
  assert.equal(clean({ scope: 'panels' }), null, '清面板不拦')
  assert.equal(typeof clean({ scope: 'all' }), 'string', '删库要拦')
  assert.equal(clean({ scope: 'all', confirm: true }), null, '确认后放行')

  const auto = GUARD_RULES.quant_autosync
  assert.equal(auto({ action: 'get' }), null, '看状态不拦')
  assert.equal(auto({ action: 'run_now' }), null, '手动补跑不拦（用的还是同一条增量路径与硬上限）')
  assert.equal(auto({ action: 'disable' }), null, '关闭不拦')
  assert.equal(typeof auto({ action: 'enable' }), 'string', '开启自动同步是长期授权，必须拦一次')
  assert.equal(auto({ action: 'enable', confirm: true }), null, '确认后放行')
  assert.equal(auto({}), null, '缺参数按默认 get 处理，不拦')

  assert.equal(GUARD_RULES.quant_factor_list, undefined, '普通工具没有护栏规则')
})

test('护栏拒绝理由必须包含"怎么继续"（不能只说不行）', () => {
  for (const [name, rule] of Object.entries(GUARD_RULES)) {
    const samples = name === 'quant_data_sync' ? [{ scope: 'all' }]
      : name === 'quant_backtest_run' ? [{ config: { start: 20100101, end: 20260101 } }]
        : name === 'quant_optimize_parameters' ? [{ space: { topK: new Array(200).fill(1) } }]
          : name === 'quant_autosync' ? [{ action: 'enable' }]
            : [{ scope: 'all' }]
    for (const s of samples) {
      const reason = rule(s)
      assert.equal(typeof reason, 'string', `${name} 应当拒绝`)
      assert.ok(/confirm=true|estimateOnly/.test(reason), `${name} 的拒绝理由必须给出继续的路径，实际：${reason}`)
    }
  }
})

test('同步估算：规模与审批标记随股票数增长', () => {
  const store = openStore(':memory:')
  const small = estimateSync(store, { from: 20240101, to: 20260923, codes: new Array(10).fill('600000') })
  const big = estimateSync(store, { from: 20240101, to: 20260923, codes: new Array(5400).fill('600000') })
  assert.equal(small.needsApproval, false, '10 只不需要审批')
  assert.equal(big.needsApproval, true, '5400 只需要审批')
  assert.ok(big.approxRequests > small.approxRequests)
  assert.ok(big.approxBars > small.approxBars)
  assert.ok(big.approxMinutes > 0)
  assert.ok(/确认/.test(big.reason), '审批理由要说明原因')
  store.close()
})

test('工具面：presentationMeta 必须是 lossless JSON（DSH 会做快照校验，含 undefined/函数会抛）', async () => {
  const { runtime, cleanup } = makeRuntime()
  const tools = allTools(runtime)
  const withMeta = tools.filter((t) => typeof t.output.presentationMeta === 'function')
  assert.ok(withMeta.length >= 4, `应有 ≥4 个工具声明 presentationMeta，实际 ${withMeta.length}`)

  // 每个声明了 meta 的工具，都要能在失败信封下产出可 JSON 化的结果
  for (const t of withMeta) {
    const meta = t.output.presentationMeta({}, { ok: false, error: { code: 'X', message: 'm' } })
    const round = JSON.parse(JSON.stringify(meta))
    assert.deepEqual(round, meta, `${t.name} 的 meta 不是 lossless JSON`)
    assert.equal(typeof meta.kind, 'string', `${t.name} 的 meta 必须有 kind 供客户端分派`)
  }
  cleanup()
})

test('工具面：presentationMeta 与客户端卡片的 kind 一一对应（端到端接线）', async () => {
  const { runtime, cleanup } = makeRuntime()
  const tools = allTools(runtime)
  const kinds = new Set(
    tools.filter((t) => typeof t.output.presentationMeta === 'function')
      .map((t) => t.output.presentationMeta({}, { ok: false, error: { code: 'X', message: 'm' } }).kind),
  )
  // 客户端 lib/client.js 里每个卡片都按 kind 分派；kind 写错卡片就永远不渲染
  const src = readFileSync('lib/client.js', 'utf8')
  for (const k of kinds) {
    assert.ok(src.includes(`kind: '${k}'`) || src.includes(`kind !== '${k}'`), `客户端没有处理 kind=${k}`)
  }
  cleanup()
})

test('工具面：回测结果里的净值曲线被降采样到 ≤140 点', async () => {
  const { runtime, cleanup } = makeRuntime()
  const t = backtestTools(runtime).find((x) => x.name === 'quant_backtest_run')
  const v = await t.execute({
    strategyId: 'dsp_test',
    config: {
      name: '降采样测试', factors: [{ id: 'momentum_1m', formula: '$close / Ref($close, 20) - 1' }],
      selection: { rule: 'top_k', k: 3 }, rebalance: 'monthly', weight: 'equal',
      start: 20190101, end: 20260923, initialCash: 1_000_000,
    },
    confirm: true,   // 7 年 > 5 年阈值，走一次确认路径
  }, {})
  assert.equal(v.ok, true, `回测失败：${JSON.stringify(v.error)}`)
  assert.ok(v.nav.length <= 140, `净值曲线应降采样到 ≤140 点，实际 ${v.nav.length}`)
  assert.ok(v.nav.length >= 2)
  assert.equal(v.nav[0].date, v.range[0], '首点必须是区间起点')
  assert.equal(v.nav[v.nav.length - 1].date, v.range[1], '末点必须是区间终点')
  const meta = t.output.presentationMeta({}, v)
  assert.ok(meta.nav.length <= 140)
  assert.ok(JSON.stringify(meta).length < 20000, `meta 过大（${JSON.stringify(meta).length} 字节）会撑大 tool/result 事件`)
  cleanup()
})

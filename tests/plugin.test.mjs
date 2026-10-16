/**
 * 插件入口契约单测。
 *
 * ## 为什么单独一个文件
 *
 * 这里守的是**整个包能不能被装上的那一条契约**，而且它是被真 Cordis 上下文抓出来的：
 *
 * > Cordis 把插件 `apply` 的**返回值当成 effect 解释** ——
 * > 函数=disposer / `null`=无 / 可迭代=一组 disposer /
 * > **其它对象 → 直接抛 `Invalid effect`**。
 *
 * 原来的 `apply` 返回诊断报告（一个普通对象），在手写假 ctx 下直接调 `apply(ctx, config)`
 * 时返回值没人管、一切正常；但 DSH loader 走的是 `ctx.plugin()`，于是**整个插件装不上**。
 * 所以拆成：`apply` 返回 void（Cordis 契约），`setup` 返回报告（测试与运维用）。
 *
 * 单测没有真 Cordis（它不在本包依赖里），所以这里只守"返回值形状"这一半；
 * 另一半（`ctx.plugin` 真的能装载）由 `spike/plugin-real-ctx-smoke.mjs` 在真上下文里跑。
 *
 * 运行: node --test tests/*.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import mod, { apply, setup, name, inject, isUninstalled } from '../lib/index.js'

/** 最小伪 ctx：够 setup 跑完就行 */
function makeCtx() {
  const registered = [], guards = [], effects = []
  return {
    registered, guards, effects,
    ctx: {
      get: (n) => (n === 'tools' ? {
        register: (d) => { registered.push(d.name); return () => {} },
        guard: (g) => { guards.push(g); return () => {} },
      } : undefined),
      effect: (fn, label) => { effects.push(label); fn() },
      logger: { info: () => {} },
    },
  }
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-quant-entry-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return { home, restore: () => { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; rmSync(home, { recursive: true, force: true }) } }
}

test('插件入口：apply 必须返回 void（返回对象会被 Cordis 当成非法 effect）', () => {
  const h = makeHome()
  try {
    const { ctx } = makeCtx()
    const ret = apply(ctx, { dataDir: join(h.home, 'data'), presetId: 'quant-entry-test', materializePreset: false })
    assert.equal(ret, undefined, 'apply 返回了非 void —— 真实 DSH 装载时会抛 Invalid effect')
  } finally { h.restore() }
})

test('插件入口：setup 返回诊断报告（apply 的返回值不能用来传报告）', () => {
  const h = makeHome()
  try {
    const { ctx, registered, guards, effects } = makeCtx()
    const report = setup(ctx, { dataDir: join(h.home, 'data'), presetId: 'quant-entry-test', materializePreset: false })
    assert.equal(typeof report, 'object')
    assert.equal(report.tools.count, 31, `工具数应为 31，实际 ${report.tools.count}`)
    assert.equal(report.tools.failed.length, 0)
    assert.equal(registered.length, 31)
    assert.equal(guards.length, 1)
    assert.equal(report.guards.ok, true)
    assert.equal(report.guards.rules.length, 5, '5 条护栏规则：同步/回测/扫参/删库/开启自动同步')
    assert.ok(effects.some((l) => l.includes('tool')))
    assert.ok(effects.some((l) => l.includes('guard')))
    assert.ok(effects.some((l) => l.includes('store')))
    assert.ok(effects.some((l) => l.includes('autosync')), '自动同步也要归还 effect')
    assert.equal(report.autoSync.enabled, false, '默认必须是关闭')
  } finally { h.restore() }
})

test('插件入口：默认导出是 { name, inject, apply }，且 report 可被序列化', () => {
  const h = makeHome()
  try {
    assert.equal(typeof mod.apply, 'function')
    assert.equal(mod.apply, apply)
    assert.equal(mod.name, 'quant-assistant')
    assert.deepEqual(mod.inject, ['tools'])
    assert.deepEqual(inject, ['tools'])
    assert.equal(name, 'quant-assistant')
    assert.equal(mod.setup, setup, '默认导出也要带上 setup，方便运维取报告')

    const { ctx } = makeCtx()
    const report = setup(ctx, { dataDir: join(h.home, 'data'), presetId: 'quant-entry-test', materializePreset: false })
    // live 控制器不可枚举：否则日志里序列化 report 会炸或写出巨大的对象
    assert.doesNotThrow(() => JSON.stringify(report))
    assert.equal(JSON.stringify(report).includes('"controller"'), false)
  } finally { h.restore() }
})

test('插件入口：setup 的每条 effect 都有可读标签（卸载排障要用）', () => {
  const h = makeHome()
  try {
    const { ctx, effects } = makeCtx()
    setup(ctx, { dataDir: join(h.home, 'data'), presetId: 'quant-entry-test' })
    assert.ok(effects.length >= 5, `effect 太少：${effects.join(',')}`)
    for (const l of effects) assert.match(String(l), /^quant-assistant: /, `effect 标签不规范：${l}`)
  } finally { h.restore() }
})

test('插件入口：卸载与关闭必须能区分（关闭不该删 preset）', () => {
  // 实测抓到的 bug：原实现无条件删 preset，于是**每次 DSH 正常关闭**都会把它删掉。
  // 判据是"profile 的 package.json 里还写着这个包 → 不是卸载"。
  const home = mkdtempSync(join(tmpdir(), 'dsh-quant-uninst-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const pj = (deps) => join(home, 'profiles', 't1', 'package.json')
    mkdirSync(join(home, 'profiles', 't1'), { recursive: true })
    const write = (o) => writeFileSync(pj(), JSON.stringify({ dependencies: o }, null, 2))

    write({ 'dsh-quant-assistant': 'link:../..' })
    assert.equal(isUninstalled('dsh-quant-assistant'), false, '还在依赖里 → 是关闭，不是卸载')

    write({ '别的插件': '*' })
    assert.equal(isUninstalled('dsh-quant-assistant'), true, '不在依赖里 → 是卸载')

    write({})
    assert.equal(isUninstalled('dsh-quant-assistant'), true, '依赖为空 → 是卸载')

    rmSync(join(home, 'profiles'), { recursive: true, force: true })
    assert.equal(isUninstalled('dsh-quant-assistant'), true, '无 profiles 目录 → 按卸载处理')

    // 坏文件不要让判定崩掉
    mkdirSync(join(home, 'profiles', 't1'), { recursive: true })
    writeFileSync(pj(), 'not-json')
    assert.doesNotThrow(() => isUninstalled('dsh-quant-assistant'), 'package.json 损坏时不得抛异常')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})

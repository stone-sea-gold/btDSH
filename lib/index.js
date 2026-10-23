/**
 * dsh-quant-assistant — 宿主半。
 *
 * 这个插件把本地 DSH 变成一个 A 股量化助手：因子检索 → 策略组合 → 可交易级回测 → 选股 → 仓位。
 * 全部本地运行，零原生依赖（纯 Node ≥22 + `node:sqlite`），不联网也能用已同步的数据。
 *
 * 组成（五块，互相独立、都可单独关掉）：
 *   1. **工具面** —— 31 个 `quant_*` 工具，注册进当前 realm 的 tools 服务
 *   2. **审批护栏** —— 对全市场同步 / 长区间回测 / 参数扫描 / 删库 / 开启自动同步做单调否决
 *   3. **preset 投递** —— 把包内的「量化助手」preset 物化到 `$DSH_HOME/.agent-presets/`
 *   4. **数据仓库** —— 惰性打开，第一次真正用到数据时才建库
 *   5. **盘后定时增量同步** —— 默认关闭；开启后每天增量补数据，重启能补跑（见 lib/data/autosync.mjs）
 *
 * 生命周期：所有注册都通过 `ctx.effect` / 服务返回的 disposer 归还，
 * 因此停用、升级或卸载都会干净移除；preset 目录只删**元数据匹配**的那一个。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRuntime } from './runtime.mjs'
import { registerAll } from './tools/kit.mjs'
import { factorTools } from './tools/factor.mjs'
import { strategyTools } from './tools/strategy.mjs'
import { backtestTools } from './tools/backtest.mjs'
import { dataTools } from './tools/data.mjs'
import { portfolioTools } from './tools/portfolio.mjs'
import { autosyncTools } from './tools/autosync.mjs'
import { exportTools } from './tools/export.mjs'
import { createAutoSync } from './data/autosync.mjs'
import { registerQuantRoutes } from './host/routes.mjs'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_NAME = 'dsh-quant-assistant'
const PKG_VERSION = readPkgVersion()

export const name = 'quant-assistant'
// tools 是硬依赖：没有它这个插件没有意义。Cordis 会在服务出现后再激活。
export const inject = ['tools']

function readPkgVersion() {
  try { return JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version ?? '0.0.0' }
  catch { return '0.0.0' }
}

/**
 * 收集全部工具定义（顺序无关，但按域分组便于阅读与排错）。
 *
 * `hooks.cleanupPreset` 是给 `quant_data_cleanup {scope:'preset'}` 用的：
 * 卸载前先把 preset 目录删掉。**为什么不能自动做** ——
 * `dsh plugin remove` 不启动 DSH，插件代码在卸载时没有机会执行（平台限制），
 * 所以只能由用户在卸载前显式触发，或在卸载后手工删。
 */
function allTools(runtime, hooks = {}) {
  return [
    ...factorTools(runtime),
    ...strategyTools(runtime),
    ...backtestTools(runtime),
    ...dataTools(runtime, hooks),
    ...portfolioTools(runtime),
    ...autosyncTools(runtime),
    ...exportTools(runtime),
  ]
}

// ── preset 投递 ─────────────────────────────────────────────────────────────
const PRESET_META = '.installed-by-dsh-quant.json'

/**
 * 这次 dispose 是不是**卸载**（而不是关闭）？
 *
 * 为什么必须分清：`ctx.effect` 的清理在**任何** unload 时都会跑，包括 DSH 正常关闭。
 * 原来的实现无条件删 preset，于是**每次重启都会先把 preset 删掉**，下次启动再重建。
 * 功能上自愈，但语义是错的 —— `unload ≠ uninstall`。
 * **实测**：向 `dsh web` 发 SIGTERM 后，`$DSH_HOME/.agent-presets/quant-assistant/` 被删空。
 *
 * 判据：profile 的 `package.json` 里还写着这个包 → 是关闭，保留；
 * 已经不写了 → 是卸载，清理。没有 profile 目录时按卸载处理（那是真的没装了）。
 */
export function isUninstalled(pkgName) {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '/tmp', '.dsh')
  const profiles = join(home, 'profiles')
  if (!existsSync(profiles)) return true
  for (const name of readdirSync(profiles)) {
    const pj = join(profiles, name, 'package.json')
    if (!existsSync(pj)) continue
    try {
      const deps = JSON.parse(readFileSync(pj, 'utf8')).dependencies ?? {}
      if (Object.prototype.hasOwnProperty.call(deps, pkgName)) return false
    } catch { /* 坏文件当作没写 */ }
  }
  return true
}

function presetRoot() {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '/tmp', '.dsh')
  return join(home, '.agent-presets')
}

/**
 * 把包内的 preset 物化到用户根。
 *
 * 幂等：版本没变且文件齐全就跳过；版本变了就整目录重写。
 * **第三方保护**：目标目录若存在但元数据不是本包写的，一律不动（绝不覆盖别人的 preset）。
 */
export function materializePreset(presetId, { version = PKG_VERSION, force = false } = {}) {
  const target = join(presetRoot(), presetId)
  const source = join(PKG_DIR, 'presets', 'quant-assistant')
  const metaPath = join(target, PRESET_META)

  if (!existsSync(source)) return { status: 'no-source', target }

  if (existsSync(metaPath) && !force) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      if (meta.package !== PKG_NAME) {
        return { status: 'foreign', target, owner: meta.package ?? 'unknown' }
      }
      if (meta.version === version) return { status: 'existing', target, version }
    } catch { /* 元数据损坏 → 重新物化 */ }
  } else if (existsSync(target) && !existsSync(metaPath)) {
    // 目录存在但没有我们的元数据 → 是别人的，不动
    return { status: 'foreign', target, owner: 'unknown (no metadata)' }
  }

  mkdirSync(target, { recursive: true })
  const copied = []
  const copyDir = (src, dst) => {
    mkdirSync(dst, { recursive: true })
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const s = join(src, entry.name), d = join(dst, entry.name)
      if (entry.isDirectory()) copyDir(s, d)
      else { copyFileSync(s, d); copied.push(d.slice(target.length + 1)) }
    }
  }
  copyDir(source, target)
  writeFileSync(metaPath, JSON.stringify({
    package: PKG_NAME, version, presetId,
    installedAt: new Date().toISOString(),
    files: copied.sort(),
  }, null, 2))
  return { status: 'created', target, version, files: copied.length }
}

/** 卸载清理：**只删元数据匹配本包的那一个目录** */
export function cleanupPreset(presetId) {
  const target = join(presetRoot(), presetId)
  const metaPath = join(target, PRESET_META)
  if (!existsSync(metaPath)) return { removed: false, reason: 'no-metadata' }
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (meta.package !== PKG_NAME) return { removed: false, reason: 'foreign', owner: meta.package }
    rmSync(target, { recursive: true, force: true })
    return { removed: true, target }
  } catch (e) {
    return { removed: false, reason: 'error', message: e?.message }
  }
}

/** preset 体检：装了吗、谁的、什么版本 */
export function presetStatus(presetId) {
  const target = join(presetRoot(), presetId)
  const metaPath = join(target, PRESET_META)
  if (!existsSync(target)) return { installed: false, target }
  let meta = null
  try { meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null } catch { /* ignore */ }
  return {
    installed: true, target, owned: meta?.package === PKG_NAME,
    owner: meta?.package ?? null, version: meta?.version ?? null,
    current: meta?.version === PKG_VERSION,
    files: existsSync(target) ? readdirSync(target) : [],
  }
}

// ── apply ───────────────────────────────────────────────────────────────────
/**
 * 装载插件并返回**诊断报告**。
 *
 * 注意这里与 `apply` 的分工，这不是风格问题而是 Cordis 的硬契约：
 * **插件 `apply` 的返回值会被当成 effect 解释**（函数=disposer / null=无 /
 * 可迭代=一组 disposer / **其它对象 → 直接抛 `Invalid effect`**）。
 * 所以 `apply` 必须返回 void，报告只能从 `setup` 里拿。
 *
 * 这条契约是**真 Cordis 上下文冒烟**抓出来的：用手写假 ctx 直接调 `apply(ctx, config)`
 * 时返回值没人管，一切正常；一旦走 `ctx.plugin()`（也就是 DSH loader 装载 bundle 行的真实路径），
 * 返回一个普通对象就会让**整个插件装不上**。
 *
 * @returns 诊断报告（仅供测试与运维；DSH 不使用它）
 */
export function setup(ctx, config = {}) {
  const presetId = config.presetId ?? 'quant-assistant'
  const runtime = createRuntime(config)
  const report = { tools: null, preset: null, autoSync: null, dataDir: runtime.dir, version: PKG_VERSION }

  // 1) 工具面
  const definitions = allTools(runtime, { cleanupPreset: () => cleanupPreset(presetId) })
  const reg = registerAll(ctx, definitions)
  report.tools = {
    ok: reg.ok,
    count: reg.registered.filter((x) => typeof x === 'string').length,
    failed: reg.registered.filter((x) => typeof x !== 'string'),
    reason: reg.reason,
  }
  for (const d of reg.disposers ?? []) ctx.effect(() => d, 'quant-assistant: tool')

  // 2) preset 投递（可关：config.materializePreset === false）
  if (config.materializePreset !== false) {
    try { report.preset = materializePreset(presetId, { force: !!config.forcePreset }) }
    catch (e) { report.preset = { status: 'error', message: e?.message } }
    // 卸载时清理（只删自己物化的那一个目录）；**关闭时不删**，见 isUninstalled
    ctx.effect(() => () => {
      if (!isUninstalled(PKG_NAME)) return
      try { cleanupPreset(presetId) } catch { /* noop */ }
    }, 'quant-assistant: preset cleanup')
  }

  // 3) 仓库句柄随插件一起释放
  ctx.effect(() => () => { try { runtime.close() } catch { /* noop */ } }, 'quant-assistant: store')

  // 4) 盘后定时增量同步（默认关闭；开启需要用户明确授权，见 lib/tools/autosync.mjs）
  //    放在工具注册之后：控制器挂到 `runtime.autoSync` 上，`quant_autosync` 在调用时才读它。
  try {
    const auto = createAutoSync(ctx, runtime, config)
    report.autoSync = { ok: auto.ok, enabled: auto.enabled, timer: auto.timer, reason: auto.reason, nextDueAt: auto.nextDueAt }
    // 活的控制器句柄，供冒烟/运维在不重建插件的情况下停排程与手动补跑。
    // **不可枚举**：report 有可能被日志序列化，live 对象不该混进去。
    Object.defineProperty(report.autoSync, 'controller', { value: auto.controller, enumerable: false })
    ctx.effect(() => () => { try { auto.controller.dispose() } catch { /* noop */ } }, 'quant-assistant: autosync')
  } catch (e) {
    // 定时同步起不来不应该让整个插件起不来：手动路径与状态读写仍然可用
    report.autoSync = { ok: false, reason: 'error', message: e?.message ?? String(e) }
  }

  // 5) 看板 HTTP 路由（宿主 web 服务存在时才注册；headless/CLI 会话里没有它，自动跳过）
  //    `/quant/api/runs` 供客户端列表，`/quant/report/<id>` 是可分享的报告页（深链）。
  ctx.inject(['webServer'], (webCtx) => {
    try {
      const dispose = registerQuantRoutes(webCtx, { runtime })
      webCtx.effect(() => dispose, 'quant-assistant: dashboard routes')
      report.routes = { ok: true }
    } catch (e) {
      report.routes = { ok: false, message: e?.message ?? String(e) }
    }
  })

  ctx.logger?.info?.(`[quant-assistant] v${PKG_VERSION} ready: ${report.tools.count} tools, dataDir=${runtime.dir}, preset=${report.preset?.status}, autoSync=${report.autoSync?.enabled ? 'on' : 'off'}`)
  return report
}

/** Cordis 插件入口。**必须返回 void** —— 返回值会被当成 effect，返回普通对象直接抛 `Invalid effect`。 */
export function apply(ctx, config = {}) {
  setup(ctx, config)
}

export default { name, inject, apply, setup }

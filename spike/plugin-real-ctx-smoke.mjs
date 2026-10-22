/**
 * 真实 Cordis 上下文冒烟。
 *
 * ## 它补的是哪一块
 *
 * `plugin-apply-smoke.mjs` 用的是**手写假 ctx**（`{ get, effect, logger }`）。
 * 那能验证"注册了几个工具、装了几个 effect"，但验证不了**真实服务契约**：
 *   - `ctx.get('timer')` 到底能不能拿到 `TimerService`？
 *   - `ctx.effect(fn, label)` 两参数形式在真 Cordis 里合法吗？
 *   - `inject: ['tools']` 的延迟激活真的会等 `tools` 出现吗？
 *   - 真实的 `timer.timeout()` 返回的 disposer 真的能取消定时器吗？
 *
 * 这些都是"假 ctx 永远抓不到、真环境里一跑就炸"的东西，所以单独跑一遍真上下文。
 *
 * ## 为什么不启动一个 DSH 进程
 *
 * 不需要：定时同步这一块依赖的只有 Cordis 的 `Context` + `timer` 服务，
 * 跟 web server / agent loop 无关。直接把这两个装进一个裸 Context 就够了，
 * 也就**不会碰到用户正在用的那个 GUI 进程**。
 *
 * 用法: node spike/plugin-real-ctx-smoke.mjs
 */

import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// cordis 不在本包的依赖里（它是宿主提供的），所以按绝对路径从 DSH 安装树里取。
// 取不到就**跳过**而不是失败：这个冒烟依赖宿主环境，不该在别的机器上变成假失败。
// 可以指向**任意一份** DSH 安装树里的 @deepseek-ai 目录 —— 这样同一个冒烟能跑跨版本兼容验证
// （例：DSH_PKGS=spike/out/dsh-compat/node_modules/@deepseek-ai 验 0.2.0-rc.2）
const DSH = process.env.DSH_PKGS ?? '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const load = async (p) => (await import(pathToFileURL(join(DSH, p)).href))

let pass = 0, fail = 0, skipped = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`✅ ${label}${detail ? `  ${detail}` : ''}`) }
  else { fail++; console.log(`❌ ${label}${detail ? `  ${detail}` : ''}`) }
}

let Context, Service, TimerService
try {
  ({ Context, Service } = await load('cordis/lib/index.js'))
  ;({ default: TimerService } = await load('cordis-plugin-timer/lib/index.js'))
} catch (e) {
  console.log(`⚠️  跳过：宿主环境里找不到 cordis（${e.message}）`)
  process.exit(0)
}

const { setup, apply, name, inject } = await import('../lib/index.js')
const { META_KEY, readState, writeState, DEFAULT_AUTO_SYNC } = await import('../lib/data/autosync.mjs')
const { createRuntime } = await import('../lib/runtime.mjs')

const HOME = mkdtempSync(join(tmpdir(), 'dsh-quant-realctx-'))
const DATA = join(HOME, 'quant-data')
console.log(`=== 真实 Cordis 上下文冒烟 ===\n    插件树 ${DSH}\n    数据   ${DATA}\n`)

// ── 1) 裸 Context + 真实 timer 服务 ─────────────────────────────────────────
const root = new Context()
root.plugin(TimerService)

// tools 服务用真的 Service 子类提供：这样 `inject: ['tools']` 的延迟激活路径是真的
const registered = []
class FakeTools extends Service {
  constructor(ctx) { super(ctx, 'tools') }
  register(def) { registered.push(def.name); return () => { const i = registered.indexOf(def.name); if (i >= 0) registered.splice(i, 1) } }
}
root.plugin(FakeTools)

await new Promise((r) => setTimeout(r, 50))
check('真实 Context 里 ctx.get("timer") 拿到 TimerService', root.get('timer')?.constructor?.name === 'TimerService', root.get('timer')?.constructor?.name)
check('timer 服务真的混入了 ctx.timeout', typeof root.timeout === 'function')

// ── 2) 惰性：仓库不存在时 apply 不建库 ──────────────────────────────────────
// 用 ctx.plugin 装载（而不是直接 apply(root)）：这才是 DSH loader 装载 bundle 行的方式，
// 插件因此拿到**自己的 fiber**，卸载时 effect 按 fiber 回收 —— 下面第 5 步要验的就是这条。
const config = { dataDir: DATA, presetId: 'quant-assistant', materializePreset: false }
let report = null
// 用真实的 `ctx.plugin` 装载（DSH loader 装载 bundle 行的路径）。注意包一层而不是直接用 apply：
// 我们需要 report，而**插件的 apply 必须返回 void**（返回对象会被 Cordis 当成非法 effect 直接抛错）。
const fiber = root.plugin({ name, inject, apply: (ctx, cfg) => { report = setup(ctx, cfg) } }, config)
await fiber
await new Promise((r) => setTimeout(r, 50))

check('apply 在真实 ctx 上跑通', report.tools?.count === 31, `count=${report.tools?.count} failed=${report.tools?.failed?.length}`)
check('31 个工具注册进真实 tools 服务', registered.length === 31, `实际 ${registered.length}`)
check('inject 只声明 tools', Array.isArray(inject) && inject.length === 1 && inject[0] === 'tools', JSON.stringify(inject))
check('插件名正确', name === 'quant-assistant')
check('真实 ctx 下也保持惰性（不建库）', !existsSync(join(DATA, 'quant.db')))
check('自动同步默认关闭', report.autoSync?.enabled === false, `reason=${report.autoSync?.reason}`)
check('报告里 timer 为 true（真实服务被认出来了）', report.autoSync?.timer === true)
check('report 可被序列化（live 控制器不可枚举）', (() => { try { JSON.stringify(report); return true } catch { return false } })())
await fiber.dispose()
check('卸载后工具被注销（fiber effect 归还）', registered.length === 0, `剩余 ${registered.length}`)

// ── 3) 真实定时器：补跑一次 ─────────────────────────────────────────────────
// 先手工造一个"有仓库 + 自动同步开着 + 上次该跑没跑"的现场
mkdirSync(DATA, { recursive: true })
const rt = createRuntime({ dataDir: DATA })
const store = rt.store()
store.upsertCodes([{ code: '600519', name: '贵州茅台', market: 1, board: 'sh_main' }])
store.setSyncState('600519', { barsLast: 20260918, status: 'ok' })
// codes 指向一个库里不存在的代码 → resolveScope 得到空集 → 立刻返回 noCodes，**不发任何网络请求**。
// 这样测的是"真实定时器有没有触发并跑完整条路径"，而不是网络。
writeState(store, {
  ...DEFAULT_AUTO_SYNC, enabled: true, codes: ['999999'], nextDueAt: Date.now() - 60000,
  consentAt: Date.now(), consentBy: 'smoke',
})
rt.close()

// 换一个 Context 重新装载，模拟"重启"（上一个 Context 里的排程已经没了）
const root2 = new Context()
root2.plugin(TimerService)
const registered2 = []
class FakeTools2 extends Service {
  constructor(ctx) { super(ctx, 'tools') }
  register(def) { registered2.push(def.name); return () => { const i = registered2.indexOf(def.name); if (i >= 0) registered2.splice(i, 1) } }
}
root2.plugin(FakeTools2)
await new Promise((r) => setTimeout(r, 30))

let report2 = null
const fiber2 = root2.plugin({ name, inject, apply: (ctx, cfg) => { report2 = setup(ctx, cfg) } }, config)
await fiber2

check('重启后认出自动同步是开着的', report2.autoSync?.enabled === true, `enabled=${report2.autoSync?.enabled}`)
check('重启后识别为补跑', report2.autoSync?.reason === 'catch-up', `reason=${report2.autoSync?.reason}`)
check('真实 timer 可用', report2.autoSync?.timer === true)

// 真实定时器延迟 0 → 让事件循环跑几轮
await new Promise((r) => setTimeout(r, 300))
const after = readState(createRuntime({ dataDir: DATA }).store())
check('补跑真的执行了（真实 setTimeout 触发）', after.lastOutcome === 'noCodes', `outcome=${after.lastOutcome}`)
check('补跑后下次排程被推到未来（不会死循环）', typeof after.nextDueAt === 'number' && after.nextDueAt > Date.now(), `nextDueAt=${after.nextDueAt}`)
check('授权记录被保留', after.consentBy === 'smoke')

// ── 4) 真实 disposer：停用后定时器真的被取消 ────────────────────────────────
const before = after.nextDueAt
const ctrl = report2.autoSync?.controller ?? null
if (ctrl) {
  ctrl.stop()
  check('stop() 之后 active 为 false', ctrl.active === false)
  const afterStop = readState(createRuntime({ dataDir: DATA }).store())
  check('stop() 不会篡改落库状态', afterStop.nextDueAt === before, '配置与状态保留，只是不再排程')
  ctrl.reschedule()
  check('reschedule() 能重新唤醒（用户关掉再开不能失效）', ctrl.active === true)
  ctrl.dispose()
  ctrl.reschedule()
  check('dispose() 之后 reschedule 不再排程', ctrl.active === false)
} else {
  skipped++
  console.log('⚠️  报告里没有 controller，跳过 disposer 检查')
}

// ── 5) 卸载：effect 归还 ────────────────────────────────────────────────────
await fiber2.dispose()
await new Promise((r) => setTimeout(r, 50))
check('卸载后工具被注销', registered2.length === 0, `剩余 ${registered2.length}`)

// ── 6) 回归守卫：默认导出能被 ctx.plugin 直接装载 ───────────────────────────
// 这一条是**真正的**防回归：Cordis 把插件 `apply` 的返回值当成 effect 解释，
// 返回一个普通对象会直接抛 `Invalid effect`，插件根本装不上。
// 手写假 ctx 直接调 apply(ctx, config) 时返回值没人管，所以永远抓不到这个错。
const root3 = new Context()
root3.plugin(TimerService)
class FakeTools3 extends Service {
  constructor(ctx) { super(ctx, 'tools') }
  register() { return () => {} }
}
root3.plugin(FakeTools3)
await new Promise((r) => setTimeout(r, 30))

let contractError = null
let contractActive = false
try {
  const mod = (await import('../lib/index.js')).default
  const f3 = root3.plugin(mod, { dataDir: join(HOME, 'contract'), presetId: 'quant-assistant', materializePreset: false })
  await f3
  await new Promise((r) => setTimeout(r, 30))
  contractActive = typeof f3.state === 'number'
  await f3.dispose()
} catch (e) { contractError = e }

check('默认导出的 { name, inject, apply } 能被 ctx.plugin 直接装载（apply 返回 void）',
  contractError === null, contractError ? contractError.message : '')
check('直接装载的 fiber 真的激活过', contractActive, `state=${contractActive}`)
check('apply 单独调用也返回 void', apply(root3, { dataDir: join(HOME, 'void'), materializePreset: false }) === undefined)

console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail}${skipped ? ` / 跳过 ${skipped}` : ''} ===`)
rmSync(HOME, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

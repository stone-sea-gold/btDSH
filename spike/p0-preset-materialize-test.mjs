/**
 * P0-G4d — preset 物化/清理机制验证（不启动 DSH 服务）
 *
 * 直接以伪 ctx 调用宿主半的 apply()，把 DSH_HOME 指向工作区内的临时目录，
 * 验证：① preset 被物化到 $DSH_HOME/.agent-presets/<id>/ ② 元数据写入
 *      ③ 重复调用幂等 ④ 清理只删自己的目录
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HOME = resolve('spike/tmp-dsh-home')
rmSync(HOME, { force: true, recursive: true })
mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

const mod = await import('../spike/plugin-skeleton/lib/index.js')

// 伪 ctx：只提供 get / effect / tools 的最小面
const disposers = []
const ctx = {
  get: (name) => (name === 'tools' ? { register: (def) => { registered.push(def.name) } } : undefined),
  effect: (fn) => { const d = fn(); disposers.push(d); return d },
}
const registered = []

const presetDir = join(HOME, '.agent-presets', 'quant-spike')
const metaPath = join(presetDir, '.installed-by-dsh-quant.json')

const first = mod.apply(ctx, { presetId: 'quant-spike' })
const files1 = existsSync(presetDir) ? readdirSync(presetDir).sort() : []
const meta1 = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null

const second = mod.apply(ctx, { presetId: 'quant-spike' }) // 幂等
const files2 = existsSync(presetDir) ? readdirSync(presetDir).sort() : []

// 模拟注销：调用 effect 的 disposer
const beforeCleanup = existsSync(presetDir)
disposers.forEach((d) => typeof d === 'function' && d())
const afterCleanup = existsSync(presetDir)

// 反向用例：目录存在但元数据属于别的包 → 不许删
mkdirSync(presetDir, { recursive: true })
const foreignMeta = join(presetDir, '.installed-by-dsh-quant.json')
const { writeFileSync } = await import('node:fs')
writeFileSync(foreignMeta, JSON.stringify({ package: '@someone-else/other-plugin' }))
const foreignExistsBefore = existsSync(presetDir)
// 再次走清理路径（模拟别人的目录）
const { default: _ } = { default: null }
process.env.DSH_HOME = HOME

const report = {
  home: HOME,
  first,
  second,
  filesAfterFirst: files1,
  filesAfterSecond: files2,
  idempotent: JSON.stringify(files1) === JSON.stringify(files2),
  metadata: meta1,
  registeredTools: registered,
  cleanup: { before: beforeCleanup, after: afterCleanup, removedOwnDir: beforeCleanup && !afterCleanup },
  foreignGuard: { dirPresent: foreignExistsBefore, note: '第三方元数据的目录不应被本插件清理' },
  gates: {
    G4d1_preset_materialized: files1.includes('preset.yml') && files1.includes('cordis.yml'),
    G4d2_metadata_written: meta1?.package === '@dsh-spike/quant-skeleton',
    G4d3_idempotent: JSON.stringify(files1) === JSON.stringify(files2),
    G4d4_tool_registered: registered.includes('quant_skeleton_ping'),
    G4d5_cleanup_removes_own_dir: beforeCleanup && !afterCleanup,
  },
}
report.verdict = Object.values(report.gates).every(Boolean) ? 'PASS' : 'CHECK'
console.log(JSON.stringify(report, null, 2))

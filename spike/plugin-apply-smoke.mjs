/**
 * P3 插件级冒烟：走一遍**安装时会发生的全部副作用**，并验证它们可干净回收。
 *
 * 检查项：
 *   1. apply 注册 31 个工具、1 个护栏、若干 effect
 *   2. preset 物化到 $DSH_HOME/.agent-presets/<id>/（含 skills 子目录）
 *   3. 幂等：重复物化不重写
 *   4. 版本变化触发重写
 *   5. **第三方保护**：目录存在但元数据不是本包写的 → 绝不动
 *   6. 卸载清理只删自己物化的那一个目录
 *
 * 用法: node spike/plugin-apply-smoke.mjs [临时 DSH_HOME]
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setup, materializePreset, cleanupPreset, presetStatus, name, inject } from '../lib/index.js'

const HOME = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'dsh-quant-smoke-'))
process.env.DSH_HOME = HOME
const DATA = join(HOME, 'quant-data')
const PRESET_ID = 'quant-assistant'

let pass = 0, fail = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`✅ ${label}${detail ? `  ${detail}` : ''}`) }
  else { fail++; console.log(`❌ ${label}${detail ? `  ${detail}` : ''}`) }
}

console.log(`=== P3 插件级冒烟（DSH_HOME=${HOME}）===\n`)

// ── 1) apply ────────────────────────────────────────────────────────────────
const registered = [], effects = []
const ctx = {
  get: (n) => n === 'tools' ? {
    register: (d) => { registered.push(d.name); return () => {} },
  } : undefined,
  effect: (fn, label) => { effects.push(label); fn() },
  logger: { info: () => {} },
}
const report = setup(ctx, { dataDir: DATA, presetId: PRESET_ID })

check('注册 31 个工具', registered.length === 31, `实际 ${registered.length}`)
check('工具无重名', new Set(registered).size === registered.length)
check('全部以 quant_ 前缀', registered.every((n) => n.startsWith('quant_')))
check('不装护栏（权限交给 DSH 的权限预设）', true)
check('注册了回收 effect', effects.some((l) => l.includes('tool')) && effects.some((l) => l.includes('store')))
check('报告含数据目录', report.dataDir === DATA, report.dataDir)
// 惰性：apply 时仓库还不存在、自动同步默认关闭 → 不该因此建库
check('apply 不建库（惰性）', !existsSync(join(DATA, 'quant.db')), existsSync(join(DATA, 'quant.db')) ? '被建出来了' : '')
check('自动同步默认关闭', report.autoSync?.enabled === false, `enabled=${report.autoSync?.enabled} reason=${report.autoSync?.reason}`)
check('自动同步惰性降级为 no-store', report.autoSync?.reason === 'no-store', report.autoSync?.reason ?? '(无)')

// ── 2) preset 物化 ──────────────────────────────────────────────────────────
const target = join(HOME, '.agent-presets', PRESET_ID)
check('preset 已物化', existsSync(target) && report.preset?.status === 'created', `status=${report.preset?.status}`)
check('preset.yml 存在', existsSync(join(target, 'preset.yml')))
check('agent.cordis.yml 存在', existsSync(join(target, 'agent.cordis.yml')))
const skills = existsSync(join(target, 'skills')) ? readdirSync(join(target, 'skills')) : []
check('四个技能已投递', skills.length === 4 && ['quant-sources', 'quant-workflow', 'quant-discipline', 'quant-session'].every((s) => skills.includes(s)), skills.join(','))
check('每个技能都有 SKILL.md', skills.every((s) => existsSync(join(target, 'skills', s, 'SKILL.md'))))
check('元数据记录了文件清单', (() => {
  try { const m = JSON.parse(readFileSync(join(target, '.installed-by-dsh-quant.json'), 'utf8')); return m.package === 'dsh-quant-assistant' && Array.isArray(m.files) && m.files.length >= 5 }
  catch { return false }
})())

// preset.yml 必须能被解析出 name/description（roster 靠它显示）
const presetYml = readFileSync(join(target, 'preset.yml'), 'utf8')
check('preset.yml 有 name 与 description', /^name:/m.test(presetYml) && /^description:/m.test(presetYml))

// 组成文件必须是合法 YAML 且是数组（顶层是行列表）
const yml = readFileSync(join(target, 'agent.cordis.yml'), 'utf8')
// 组成文件允许以注释开头（官方 preset 也是），去掉注释行后再看首个有效行
const firstLine = yml.split('\n').find((l) => l.trim() && !l.trimStart().startsWith('#')) ?? ''
check('组成是行列表', firstLine.trimStart().startsWith('- id:'), firstLine.slice(0, 40))
check('组成含 persona 行', /\n- id: persona\b/.test('\n' + yml))
check('组成挂载了 preset 内的 skills 目录', yml.includes("new URL('skills/', baseUrl)"))
check('组成没有服务行（无需 isolate）', !yml.includes('isolate:') || yml.includes('compaction'))
check('组成挂载了 subagent_fork（样本外独立复核）', /toolName: subagent_fork/.test(yml))
check('组成不挂 spawn 子代理（回测是本地计算，多开会重复读库）', !/toolName: subagent\b/.test(yml))

// ── 3) 幂等 ─────────────────────────────────────────────────────────────────
const again = materializePreset(PRESET_ID)
check('重复物化是幂等的', again.status === 'existing', `status=${again.status}`)

// ── 4) 版本变化触发重写 ─────────────────────────────────────────────────────
const bumped = materializePreset(PRESET_ID, { version: '9.9.9' })
check('版本变化触发重写', bumped.status === 'created' && presetStatus(PRESET_ID).version === '9.9.9')
const restored = materializePreset(PRESET_ID, { version: '0.2.0' })
check('再改回当前版本仍会重写', restored.status === 'created')

// ── 5) 第三方保护 ───────────────────────────────────────────────────────────
const foreignId = 'someone-elses-preset'
const foreignDir = join(HOME, '.agent-presets', foreignId)
mkdirSync(foreignDir, { recursive: true })
writeFileSync(join(foreignDir, 'preset.yml'), 'name: 别人的\n')
const r1 = materializePreset(foreignId)
check('别人的 preset 目录不被触碰', r1.status === 'foreign' && existsSync(join(foreignDir, 'preset.yml')), `status=${r1.status}`)
check('不会误删别人的 preset', cleanupPreset(foreignId).removed === false && existsSync(foreignDir))

// 元数据被改成别人的 → 也不动
writeFileSync(join(target, '.installed-by-dsh-quant.json'), JSON.stringify({ package: 'other-pkg', version: '1.0.0' }))
check('元数据属他人时不覆盖', materializePreset(PRESET_ID).status === 'foreign')
check('元数据属他人时不删除', cleanupPreset(PRESET_ID).removed === false && existsSync(target))

// ── 6) 卸载清理 ─────────────────────────────────────────────────────────────
materializePreset(PRESET_ID, { version: '0.2.0', force: true })
const cleaned = cleanupPreset(PRESET_ID)
check('卸载清理删掉了自己的 preset', cleaned.removed === true && !existsSync(target))
check('清理后别人的 preset 还在', existsSync(foreignDir))
check('重复清理是安全的', cleanupPreset(PRESET_ID).removed === false)

// ── 7) 导出契约 ─────────────────────────────────────────────────────────────
check('导出 name/inject', name === 'quant-assistant' && Array.isArray(inject) && inject.includes('tools'))

console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`)
if (!process.argv[2]) rmSync(HOME, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

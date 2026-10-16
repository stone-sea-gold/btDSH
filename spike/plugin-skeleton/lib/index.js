/**
 * P0-G4 spike — 宿主半。
 *
 * 验证三件事：
 *  1. bundle patch 插入的行能被 Loader 加载（apply 被调用）
 *  2. 能否在运行时注册一个模型可见工具
 *  3. 能否把包内的 preset 物化到 $DSH_HOME/.agent-presets/<id>/（这是最终方案的 preset 投递机制）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const name = 'quant-skeleton'
const inject = []

const TOOL_NAME = 'quant_skeleton_ping'

/** 物化 preset 到用户根（默认被 agent-presets 扫描），并写元数据用于卸载清理 */
function materializePreset(ctx, presetId) {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '/tmp', '.dsh')
  const target = join(home, '.agent-presets', presetId)
  const source = join(PKG_DIR, 'presets', 'quant')
  const metaPath = join(target, '.installed-by-dsh-quant.json')

  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      if (meta.package === '@dsh-spike/quant-skeleton') {
        console.log(`[quant-skeleton] preset already materialized at ${target} (v${meta.version})`)
        return { status: 'existing', target }
      }
    } catch { /* 元数据损坏 → 重新物化 */ }
  }

  mkdirSync(target, { recursive: true })
  for (const file of readdirSync(source)) {
    copyFileSync(join(source, file), join(target, file))
  }
  // skills 子目录
  const skillsSrc = join(source, 'skills')
  if (existsSync(skillsSrc)) {
    const skillsDst = join(target, 'skills')
    mkdirSync(skillsDst, { recursive: true })
    for (const file of readdirSync(skillsSrc)) copyFileSync(join(skillsSrc, file), join(skillsDst, file))
  }
  writeFileSync(metaPath, JSON.stringify({ package: '@dsh-spike/quant-skeleton', version: '0.0.1', installedAt: new Date().toISOString() }, null, 2))
  console.log(`[quant-skeleton] preset materialized -> ${target}`)
  return { status: 'created', target }
}

/** 注销时清理自己物化的 preset（只删元数据匹配的目录，绝不动别人的） */
function cleanupPreset(presetId) {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '/tmp', '.dsh')
  const target = join(home, '.agent-presets', presetId)
  const metaPath = join(target, '.installed-by-dsh-quant.json')
  if (!existsSync(metaPath)) return false
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (meta.package !== '@dsh-spike/quant-skeleton') return false
    rmSync(target, { recursive: true, force: true })
    return true
  } catch { return false }
}

function apply(ctx, config) {
  const presetId = config?.presetId ?? 'quant-spike'
  console.log(`[quant-skeleton] apply() called; config=${JSON.stringify(config)}`)

  // 1) 物化 preset
  let preset = { status: 'skipped' }
  try { preset = materializePreset(ctx, presetId) } catch (e) { console.error('[quant-skeleton] preset materialize failed:', e?.message) }

  // 2) 尝试注册模型可见工具（能拿到 tools 服务才行）
  const tools = ctx.get('tools')
  if (tools !== undefined) {
    try {
      tools.register({
        name: TOOL_NAME,
        description: 'P0 spike 探针：返回固定字符串，用于验证宿主插件包注册的工具确实进入模型工具面。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, msg: { type: 'string' } }, required: ['ok', 'msg'], additionalProperties: false },
          render: (_args, value) => [{ type: 'text', text: String(value?.msg ?? 'pong') }],
        },
        execute: async () => ({ ok: true, msg: 'pong from quant-skeleton' }),
      })
      console.log(`[quant-skeleton] registered tool ${TOOL_NAME}`)
    } catch (e) {
      console.error('[quant-skeleton] tool register failed:', e?.message)
    }
  } else {
    console.log('[quant-skeleton] tools service unavailable in this realm')
  }

  // 3) 暴露一个可观察的探针
  ctx.effect(() => () => { try { cleanupPreset(presetId) } catch { /* noop */ } }, 'quant-skeleton: cleanup')

  return { preset, toolName: TOOL_NAME }
}

export { name, inject, apply }
export default { name, inject, apply }

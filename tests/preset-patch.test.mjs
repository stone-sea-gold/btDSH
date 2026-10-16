/**
 * 预设声明 patch 的一致性单测。
 *
 * ## 守的是什么
 *
 * DSH 0.2.0 起预设不再是 `$DSH_HOME/.agent-presets/<id>/` 目录，而是组成里的**声明行**
 * （DSH 自带文档：*"Nothing reads that directory any more"*）。于是插件清单有了两个落点：
 *
 *   - `presets/quant-assistant/agent.cordis.yml`   —— 清单的**唯一来源**
 *   - `presets/quant-assistant.patch.yml`          —— 由它机械生成的声明行
 *
 * 手抄两份必然漂移：改了 agent.cordis.yml 忘了重新生成，装上去的 preset 就还是旧的
 * （或者干脆装不起来）。这里用"字节相等"把漂移变成红灯，而不是等用户装完发现不对。
 *
 * 另外守三条形状约束 —— 它们各自对应一个真实的失败模式：
 *   1. 技能目录必须**从已安装的包**解析：用 `baseUrl`（指向 preset 目录）在 0.2.0 上解析不到。
 *   2. 声明行必须出现在 `package.json` 的 `dsh.bundle.patch` 里：没列上就永远不生效。
 *   3. `config` 必须有 `id` 与 `plugins`：schema 里这两个是必填（其余 name/description/order 可选）。
 *
 * 运行: node --test tests/*.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildPatch } from '../scripts/build-preset-patch.mjs'

const PATCH = 'presets/quant-assistant.patch.yml'
const patchText = readFileSync(PATCH, 'utf8')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

test('预设声明 patch 与 agent.cordis.yml 逐字节同步（改了来源必须重新生成）', () => {
  assert.equal(
    patchText,
    buildPatch(),
    'patch 与来源不同步 —— 运行 `node scripts/build-preset-patch.mjs` 重新生成',
  )
})

test('技能目录从已安装的包解析，不用已失效的 preset 目录 baseUrl', () => {
  const skillLine = patchText.split('\n').find((l) => l.includes('customSkillDirs'))
  const exprLine = patchText.split('\n')[patchText.split('\n').indexOf(skillLine) + 1] ?? ''
  assert.match(exprLine, /createRequire\(baseUrl\)\.resolve\('dsh-quant-assistant\/package\.json'\)/,
    '技能目录必须用 createRequire(baseUrl).resolve(<本包>/package.json) 定位')
  assert.match(exprLine, /'presets', 'quant-assistant', 'skills'/, '技能目录要指到包内的 skills/')
  assert.doesNotMatch(patchText, /new URL\('skills\/', baseUrl\)/,
    '旧写法（依赖 preset 目录）必须已被替换')
})

test('声明行被 package.json 的 dsh.bundle.patch 列出（否则永远不生效）', () => {
  const patch = pkg.dsh?.bundle?.patch
  const list = Array.isArray(patch) ? patch : [patch]
  assert.ok(list.includes('./presets/quant-assistant.patch.yml'),
    `bundle.patch 必须列出预设声明文件，实际: ${JSON.stringify(patch)}`)
  assert.ok(list.includes('./cordis.patch.yml'), '宿主行 patch 也必须保留')
})

test('声明行形状正确：insert 一行 @deepseek-ai/dsh-agent-preset，config 带必填 id/plugins', () => {
  assert.match(patchText, /^- insert:$/m, '顶层必须是 insert 条目')
  assert.match(patchText, /^    - id: preset-quant-assistant$/m, '声明行 id 用 preset-<presetId>')
  assert.match(patchText, /^      name: '@deepseek-ai\/dsh-agent-preset'$/m, '声明行插件名固定')
  assert.match(patchText, /^        id: quant-assistant$/m, 'config.id 是 presetId')
  assert.match(patchText, /^        plugins:$/m, 'config.plugins 必填')
  assert.match(patchText, /^        name: 量化助手$/m, 'config.name 是界面显示名')
  // 预设里的 13 行插件：人格 + 提示词段 + 技能 + 工具 + 压缩
  const ids = [...patchText.matchAll(/^          - id: ([\w-]+)$/gm)].map((m) => m[1])
  assert.equal(ids.length, 13, `plugins 行数应为 13，实际 ${ids.length}: ${ids.join(',')}`)
  for (const must of ['persona', 'skill-filesystem', 'tool-skill', 'compaction']) {
    assert.ok(ids.includes(must), `plugins 缺少 ${must}`)
  }
})

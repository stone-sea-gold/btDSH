/**
 * 从 `presets/quant-assistant/agent.cordis.yml` 生成**预设声明 patch**。
 *
 * ## 为什么需要这个脚本
 *
 * DSH 0.2.0 起，用户预设不再是 `$DSH_HOME/.agent-presets/<id>/` 目录（DSH 自带文档原话：
 * "Nothing reads that directory any more"），而是组成里的**声明行**：
 *
 * ```yaml
 * - insert:
 *     - id: preset-<id>
 *       name: '@deepseek-ai/dsh-agent-preset'
 *       config: { id, name, description, order, plugins: [...] }
 * ```
 *
 * `plugins` 就是原来 `agent.cordis.yml` 的插件清单 —— 但技能目录不能再用 `baseUrl`
 * （那指向 preset 目录，已不存在），必须**从已安装的包解析**（官方 `presets/cordis.patch.yml`
 * 就是这么写的）。
 *
 * 于是同一份清单有了两个落点：`agent.cordis.yml`（旧机制/可读性）与
 * `presets/quant-assistant.patch.yml`（新机制的声明行）。**手抄两份必然漂移**，
 * 所以这里机械生成，并用 `--check` 在测试里守同步。
 *
 * 用法:
 *   node scripts/build-preset-patch.mjs          # 生成/覆盖 patch
 *   node scripts/build-preset-patch.mjs --check  # 只校验是否同步（不一致则退出码 1）
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'presets/quant-assistant/agent.cordis.yml')
const OUT = join(ROOT, 'presets/quant-assistant.patch.yml')

/** 包内技能目录：从**已安装的包**解析，而不是 preset 目录（后者已不被读取）。 */
export const SKILL_DIR_EXPR =
  "process.getBuiltinModule('node:path').join(" +
  "process.getBuiltinModule('node:path').dirname(" +
  "process.getBuiltinModule('node:module').createRequire(baseUrl)" +
  ".resolve('dsh-quant-assistant/package.json')), " +
  "'presets', 'quant-assistant', 'skills')"

/** 旧写法（依赖 preset 目录的 baseUrl）——生成时替换掉。 */
const LEGACY_SKILL_EXPR = "fileURLToPath(new URL('skills/', baseUrl))"

export const HEADER = `# 「量化助手」预设声明 —— **本文件由 scripts/build-preset-patch.mjs 生成，不要手改**。
#
# DSH 0.2.0 起预设走"声明行"机制：组成里插一行 \`@deepseek-ai/dsh-agent-preset\`，
# 它的 config.plugins 就是原来的 agent.cordis.yml。旧的 \`$DSH_HOME/.agent-presets/\`
# 目录**已经没有任何东西读取**（DSH 自带文档原话），所以只写目录是不够的。
#
# 插件清单的**唯一来源**是 presets/quant-assistant/agent.cordis.yml；
# 改完那边跑 \`node scripts/build-preset-patch.mjs\` 重新生成本文件。
# 两者不同步会被 tests/preset-patch.test.mjs 抓住。
`

/** 生成 patch 文本（纯函数，测试也用它）。 */
export function buildPatch({ srcPath = SRC } = {}) {
  const src = readFileSync(srcPath, 'utf8')

  // ① 技能目录：换成"从已安装的包解析"
  const lines = src.split('\n').map((line) => {
    if (!line.includes(LEGACY_SKILL_EXPR)) return line
    // 保留原有缩进与 `- !!js ` 前缀，只换表达式
    const indent = line.slice(0, line.length - line.trimStart().length)
    return `${indent}- !!js ${SKILL_DIR_EXPR}`
  })

  // ② 整体缩进 10 格，成为 config.plugins 的列表项
  const body = lines
    .map((line) => (line.trim() === '' ? '' : `          ${line}`))
    .join('\n')
    .replace(/\n+$/, '')

  // ③ 套上声明行
  return `${HEADER}- insert:
    - id: preset-quant-assistant
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: quant-assistant
        name: 量化助手
        description: A 股量化研究助手：因子检索、策略组合、可交易级回测、选股与仓位。全部本地运行，不提供投资建议。
        order: 20
        plugins:
${body}
`
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const check = process.argv.includes('--check')
  const next = buildPatch()
  let prev = null
  try { prev = readFileSync(OUT, 'utf8') } catch { /* 首次生成 */ }

  if (check) {
    if (prev === next) {
      console.log('✅ 预设声明 patch 与 agent.cordis.yml 同步')
      process.exit(0)
    }
    console.error('❌ 不同步：presets/quant-assistant.patch.yml 需要重新生成')
    console.error('   运行: node scripts/build-preset-patch.mjs')
    process.exit(1)
  }
  writeFileSync(OUT, next)
  console.log(`✅ 已生成 ${OUT.replace(ROOT + '/', '')}（${next.split('\n').length} 行）`)
}

#!/usr/bin/env node
/**
 * 把 ECharts 的 dist 产物 vendor 进本仓库。
 *
 * ## 为什么是 vendor 而不是依赖
 *
 * 导出的看板必须是**单个 HTML 文件**：双击即开、断网可用、能直接发给别人。
 * 所以 ECharts 必须内联进页面，而不是在运行时 `import 'echarts'`。
 * 运行时因此**零依赖、零联网**；本脚本只在维护者升级 ECharts 版本时跑一次，
 * 产物提交进仓库（`vendor/echarts/`），并由 `tests/vendor.test.mjs` 校验。
 *
 * ## 供应链约束
 *
 * `EXPECTED` 里钉死每个版本的 SHA-256。下载到的字节与它不一致就**直接失败**，
 * 不做"警告后继续"——vendor 的字节会进入用户拿到的 HTML，
 * 无声替换是这里唯一不可接受的失败方式。升级版本时必须人工审阅后更新此表。
 *
 * 用法：
 *   node scripts/vendor-echarts.mjs            # 下载并落地（需要网络）
 *   node scripts/vendor-echarts.mjs --check    # 只校验现有产物（离线，发布门禁用）
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, copyFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'vendor', 'echarts')
const MANIFEST = join(OUT_DIR, 'MANIFEST.json')
const DIST_FILE = 'echarts.common.min.js'

/**
 * 已审阅的版本 → 产物 SHA-256。
 *
 * 为什么选 common（664KB）而不是 full（1.0MB）或 simple（459KB）：
 *   - full 多出来的是地图/关系图/日历等我们不用的图表；
 *   - simple **实测连 Node SSR 都起不来**（缺渲染器），不可用；
 *   - common 实测覆盖 line / bar / legend / dataZoom / markArea / markLine / tooltip
 *     与 SVG 渲染器，正好是看板需要的全部。
 */
const KNOWN = {
  '5.6.0': '55974cf42cc160e6cf9099cd3ed8cdedfaa9779919fcee7e2272c85f6ca30e27',
}

/** 产物里必须存在的组件（升级版本后若有裁剪，看板会白图，所以写进清单并被测试校验） */
const VERIFIED = ['line', 'bar', 'legend', 'dataZoom', 'markArea', 'markLine', 'tooltip', 'svg-renderer', 'ssr']

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function readManifest() {
  try { return JSON.parse(readFileSync(MANIFEST, 'utf8')) } catch { return null }
}

function fail(msg) {
  process.stderr.write(`vendor-echarts: ${msg}\n`)
  process.exit(1)
}

/** 校验现有产物（离线）。测试与发布门禁都调用这条路径。 */
function check() {
  const manifest = readManifest()
  if (!manifest) fail(`缺少 ${MANIFEST}，先跑一次 node scripts/vendor-echarts.mjs`)
  const target = join(OUT_DIR, DIST_FILE)
  if (!existsSync(target)) fail(`缺少 ${target}`)

  const bytes = statSync(target).size
  const digest = sha256(readFileSync(target))
  const expected = KNOWN[manifest.version]
  if (!expected) fail(`版本 ${manifest.version} 不在已审阅清单 KNOWN 里`)
  if (digest !== expected) fail(`SHA-256 不匹配：期望 ${expected}，实际 ${digest}`)
  if (manifest.sha256 !== digest) fail(`MANIFEST.sha256 与文件不一致（清单被改过？）`)
  if (manifest.bytes !== bytes) fail(`MANIFEST.bytes 与文件不一致：清单 ${manifest.bytes} / 实际 ${bytes}`)

  for (const name of ['LICENSE', 'NOTICE', join('licenses', 'LICENSE-d3')]) {
    if (!existsSync(join(OUT_DIR, name))) fail(`缺少许可文件 vendor/echarts/${name}（Apache-2.0 合规必需）`)
  }
  process.stdout.write(`vendor-echarts: OK  ${manifest.version}  ${bytes} bytes  sha256=${digest.slice(0, 16)}…\n`)
}

function vendor() {
  const version = process.env.ECHARTS_VERSION ?? readManifest()?.version ?? '5.6.0'
  const expected = KNOWN[version]
  if (!expected) fail(`版本 ${version} 未在 KNOWN 中登记。升级时请先人工审阅产物，再把 SHA-256 写进 KNOWN。`)

  const tmp = mkdtempSync(join(tmpdir(), 'vendor-echarts-'))
  try {
    process.stdout.write(`vendor-echarts: 拉取 echarts@${version} …\n`)
    // 用 npm pack 而不是直接下载 dist 文件：拿到的是**发布包本身**，
    // 许可文件、NOTICE、licenses/ 都在一起，避免只是拿到一个孤立 js。
    execFileSync('npm', ['pack', `echarts@${version}`, '--pack-destination', tmp, '--silent'], { stdio: 'pipe' })
    const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'))
    if (!tgz) fail('npm pack 没有产出 tgz')
    execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp], { stdio: 'pipe' })

    const pkg = join(tmp, 'package')
    const dist = join(pkg, 'dist', DIST_FILE)
    if (!existsSync(dist)) fail(`发布包里没有 dist/${DIST_FILE}`)

    const buf = readFileSync(dist)
    const digest = sha256(buf)
    if (digest !== expected) {
      fail(`SHA-256 与已审阅清单不一致（供应链风险，拒绝落地）：\n  期望 ${expected}\n  实际 ${digest}`)
    }

    mkdirSync(join(OUT_DIR, 'licenses'), { recursive: true })
    writeFileSync(join(OUT_DIR, DIST_FILE), buf)
    // 本包是 "type": "module"，而 ECharts 的 dist 是 UMD。
    // 没有这个作用域内的 package.json，Node 会把 .js 当 ESM 解析，
    // UMD 于是只把 echarts 挂到 globalThis、module.exports 为空 ——
    // 测试里的 require() 会静默拿到空对象。声明该目录为 CommonJS 即可。
    writeFileSync(join(OUT_DIR, 'package.json'), JSON.stringify({
      private: true,
      type: 'commonjs',
      description: 'vendored Apache ECharts UMD 产物：仅供内联进看板 HTML 与测试加载，不是可发布的包',
    }, null, 2) + '\n')
    for (const name of ['LICENSE', 'NOTICE']) {
      const src = join(pkg, name)
      if (!existsSync(src)) fail(`发布包里缺少 ${name}（无法满足 Apache-2.0 的随分发要求）`)
      copyFileSync(src, join(OUT_DIR, name))
    }
    // ECharts 打包了 d3 的部分代码，发布包内自带其许可
    const d3 = join(pkg, 'licenses', 'LICENSE-d3')
    if (existsSync(d3)) copyFileSync(d3, join(OUT_DIR, 'licenses', 'LICENSE-d3'))

    const prev = readManifest()
    const manifest = {
      name: 'apache-echarts',
      version,
      dist: DIST_FILE,
      source: `https://registry.npmjs.org/echarts/-/echarts-${version}.tgz`,
      sha256: digest,
      bytes: buf.length,
      license: 'Apache-2.0',
      // 内容没变就保留原来的时间戳，让重跑脚本不产生无意义 diff
      firstVendoredAt: prev?.version === version && prev?.sha256 === digest ? prev.firstVendoredAt : new Date().toISOString(),
      verified: VERIFIED,
      note: '内联进看板 HTML；运行时零依赖、零联网。升级版本需人工审阅后更新 scripts/vendor-echarts.mjs 的 KNOWN 表。',
    }
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
    process.stdout.write(`vendor-echarts: 已落地 ${DIST_FILE}  ${buf.length} bytes\n`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv.includes('--check')) check()
else vendor()

/**
 * Vendored ECharts 的完整性与合规性。
 *
 * 这一层的价值不在"测 ECharts 能不能用"，而在于守住三个**只有在用户手里才会暴露**的故障：
 *   1. 产物被替换/半包 → 用户打开的看板白屏（供应链）
 *   2. `package.json.files` 漏了 `vendor` → npm 包装出来缺文件，本地一切正常
 *   3. 许可文件没随分发 → Apache-2.0 合规问题，且无法靠"看一下"发现
 *
 * 另外在 Node 里用**真实 vendored 文件**做一次 SSR 渲染：
 * 产物若被裁剪掉 dataZoom/markArea，看板会静默变成白图，这里能提前抓到。
 *
 * 运行: node --test tests/vendor.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = join(ROOT, 'vendor', 'echarts')
const require = createRequire(import.meta.url)

const manifest = JSON.parse(readFileSync(join(VENDOR, 'MANIFEST.json'), 'utf8'))
const distPath = join(VENDOR, manifest.dist)
const distBuf = readFileSync(distPath)

test('vendor：清单与产物字节一致（防半包/替换）', () => {
  assert.equal(manifest.name, 'apache-echarts')
  assert.equal(manifest.license, 'Apache-2.0')
  assert.equal(distBuf.length, manifest.bytes, '字节数与 MANIFEST 不符')
  const digest = createHash('sha256').update(distBuf).digest('hex')
  assert.equal(digest, manifest.sha256, 'SHA-256 与 MANIFEST 不符')
  assert.ok(statSync(distPath).size > 500_000, '产物过小，可能下载失败被截断')
})

test('vendor：--check 门禁通过（同时校验脚本内置的已审阅哈希表）', () => {
  const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'vendor-echarts.mjs'), '--check'], { encoding: 'utf8' })
  assert.match(out, /OK/)
})

test('vendor：许可与归属文件齐全（Apache-2.0 随分发要求）', () => {
  const files = ['LICENSE', 'NOTICE', manifest.dist, join('licenses', 'LICENSE-d3')]
  for (const f of files) assert.ok(existsSync(join(VENDOR, f)), `缺少 vendor/echarts/${f}`)
  assert.match(readFileSync(join(VENDOR, 'NOTICE'), 'utf8'), /Apache ECharts/, 'NOTICE 必须点名归属')
  assert.match(readFileSync(join(VENDOR, 'LICENSE'), 'utf8'), /Apache License/, 'LICENSE 必须是 Apache-2.0 全文')
})

test('vendor：npm 打包清单必须包含 vendor（本地跑得通、用户装完崩，是这里最容易漏的坑）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.files.includes('vendor'), 'package.json.files 缺少 "vendor"')
})

test('vendor：用真实产物加载并确认版本', () => {
  const echarts = require(distPath)
  assert.equal(echarts.version, manifest.version)
  assert.equal(typeof echarts.init, 'function')
})

test('vendor：产物在 Node SSR 下能画出看板所需的五类图元（覆盖被裁剪的风险）', () => {
  const echarts = require(distPath)
  const cases = {
    line: { xAxis: { type: 'category', data: ['a', 'b', 'c'] }, yAxis: { type: 'value' }, series: [{ type: 'line', data: [1, 3, 2] }] },
    bar: { xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [1, 2] }] },
    dataZoom: { xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value' }, dataZoom: [{ type: 'inside' }], series: [{ type: 'line', data: [1, 2] }] },
    markArea: {
      xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value' },
      series: [{ type: 'line', data: [1, 2], markArea: { data: [[{ xAxis: 'a' }, { xAxis: 'b' }]] } }],
    },
    tooltip: { xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value' }, tooltip: { trigger: 'axis' }, series: [{ type: 'line', data: [1, 2] }] },
  }
  for (const [name, option] of Object.entries(cases)) {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 320, height: 200 })
    try {
      chart.setOption(option)
      const svg = chart.renderToSVGString()
      assert.ok(svg.startsWith('<svg') && svg.length > 200, `${name} 没有产出有效 SVG`)
    } finally {
      chart.dispose()
    }
  }
})

test('vendor：内联进 HTML 前不得残留运行时外部请求', () => {
  const text = distBuf.toString('utf8')
  // 只允许许可/XML 命名空间这类字面量；出现 fetch/import 远端地址才可疑
  const remote = text.match(/https?:\/\/[^\s"')]+/g) ?? []
  const suspicious = remote.filter((u) => !/apache\.org|w3\.org|github\.com\/ecomfe|unpkg|npmjs/.test(u))
  assert.deepEqual(suspicious, [], `产物里出现了可疑外部地址：${suspicious.join(', ')}`)
})

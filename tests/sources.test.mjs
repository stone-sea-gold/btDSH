/**
 * 数据源适配层的确定性单测（不需要网络）。
 *
 * 这里守的是**分页**——它属于"错了也不会报错、只会静默少拿数据"的那一类。
 *
 * 实测抓到的缺陷（P6 验收标准 1 时暴露）：
 *   东财 `clist` 的 `pz` **上限是 100**，而 `emList` 的默认 `pageSize` 曾是 200。
 *   翻页的停止条件写的是"本页不足 pageSize 就是最后一页"，于是
 *   `diff.length (100) < pageSize (200)` **每页都成立** → 永远只拿第一页。
 *   后果：`syncCodes` 从来没拿到过全市场（一直是 100 只），
 *   `quant_index_constituents` 的沪深300 成分也一直只返回 100 只。
 *
 * 所以这里的断言是：**pz 必须被夹到上游上限，翻页必须以 total 为准**。
 *
 * 运行: node --test tests/*.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { emList, EM_LIST_MAX_PAGE_SIZE, ALL_A_FS, DELISTED_FS } from '../lib/data/sources.mjs'
import { resetCircuits } from '../lib/data/http.mjs'

/**
 * 装一个假的东财 clist：**复刻真实行为** —— `pz` 超过上限时只返回上限那么多行，
 * 且 `total` 仍然报真实总数。这正是把旧代码骗过去的那个组合。
 */
function stubClist({ total, cap = EM_LIST_MAX_PAGE_SIZE, byFs = null } = {}) {
  const calls = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = new URL(url)
    const pn = Number(u.searchParams.get('pn'))
    const pz = Number(u.searchParams.get('pz'))
    const fs = u.searchParams.get('fs')
    calls.push({ pn, pz, fs })
    const n = byFs ? (byFs[fs] ?? total) : total
    const eff = Math.min(pz, cap)
    const start = (pn - 1) * eff
    const len = Math.max(0, Math.min(eff, n - start))
    const diff = Array.from({ length: len }, (_, i) => {
      const idx = start + i
      return { f12: String(idx).padStart(6, '0'), f14: 'S' + idx, f13: 0 }
    })
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { total: n, diff } }) }
  }
  return { calls, restore: () => { globalThis.fetch = orig } }
}

test('emList：pz 被夹到上游上限（给更大只会静默少返回）', async () => {
  resetCircuits()
  const s = stubClist({ total: 250 })
  try {
    const r = await emList({ fs: ALL_A_FS, pageSize: 500 })
    assert.equal(r.total, 250)
    assert.ok(s.calls.length > 0)
    assert.ok(s.calls.every((c) => c.pz === EM_LIST_MAX_PAGE_SIZE),
      `请求里的 pz 必须是 ${EM_LIST_MAX_PAGE_SIZE}，实际 ${JSON.stringify([...new Set(s.calls.map((c) => c.pz))])}`)
  } finally { s.restore() }
})

test('emList：翻页以 total 为准，不会被"本页不足 pageSize"骗停在第一页', async () => {
  resetCircuits()
  // total 250、上游每页最多 100 → 必须翻 3 页拿满 250
  const s = stubClist({ total: 250 })
  try {
    // **故意传一个超过上限的 pageSize**：旧代码就是在这里停住的
    const r = await emList({ fs: ALL_A_FS, pageSize: 200 })
    assert.equal(r.rows.length, 250, `必须拿满 250 只，实际 ${r.rows.length}（旧 bug 会停在 100）`)
    assert.equal(s.calls.length, 3, `应当翻 3 页，实际 ${s.calls.length}`)
    assert.deepEqual(s.calls.map((c) => c.pn), [1, 2, 3])
    // 首尾都要在，确认不是只拿了前几页
    assert.equal(r.rows[0].code, '000000')
    assert.equal(r.rows.at(-1).code, '000249')
    // 代码不能重复
    assert.equal(new Set(r.rows.map((x) => x.code)).size, 250)
  } finally { s.restore() }
})

test('emList：总数正好是页大小整数倍时不会多翻一页', async () => {
  resetCircuits()
  const s = stubClist({ total: 200 })
  try {
    const r = await emList({ fs: ALL_A_FS })
    assert.equal(r.rows.length, 200)
    assert.equal(s.calls.length, 2, '刚好 2 页就该停，不该再请求第 3 页')
  } finally { s.restore() }
})

test('emList：返回空页时立即停止，不空转到 maxPages', async () => {
  resetCircuits()
  const s = stubClist({ total: 0 })
  try {
    const r = await emList({ fs: ALL_A_FS, maxPages: 50 })
    assert.equal(r.rows.length, 0)
    assert.equal(s.calls.length, 1, '空页就停，别把 maxPages 跑满')
    assert.equal(r.ok, false, '空结果 ok=false（调用方据此报 EMPTY_LIST）')
  } finally { s.restore() }
})

test('emList：maxPages 仍然是硬上限（不能无限翻）', async () => {
  resetCircuits()
  const s = stubClist({ total: 100000 })
  try {
    const r = await emList({ fs: ALL_A_FS, maxPages: 3 })
    assert.equal(s.calls.length, 3)
    assert.equal(r.rows.length, 300)
  } finally { s.restore() }
})

test('emList：不同 fs 各自翻页（板块成分与全市场同一条路径）', async () => {
  resetCircuits()
  // 复刻"沪深300 成分 300 只"：旧 bug 下只会拿到 100 只
  const s = stubClist({ total: 300, byFs: { 'b:BK0500': 300 } })
  try {
    const r = await emList({ fs: 'b:BK0500', fields: 'f12,f14', pageSize: 200, maxPages: 10 })
    assert.equal(r.rows.length, 300, `成分股必须拿满 300 只，实际 ${r.rows.length}`)
  } finally { s.restore() }
})

/**
 * 离线因子表（随包分发）的运行时加载与合并。
 *
 * 为什么需要它：P1 实测显示"正确复权"依赖腾讯 K 线内嵌事件（东财会漏记同日多笔分配），
 * 而腾讯可用性会在 0%~87% 之间漂移。离线表把**已校验的历史事件**固化下来，
 * 使历史回测不再依赖任何源站健康度；只有"包发布之后的新事件"才走运行时规则。
 *
 * 合并策略：**离线表优先**（它经过 oracle 校验），运行时事件仅用于补充表里没有的新日期。
 */

import { gunzipSync } from 'node:zlib'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DEFAULT_TABLE_PATH = join(PKG_DIR, 'data', 'factor-events.json.gz')

let cached = null

/**
 * 读取并解压离线因子表。
 * @returns {{ available: boolean, version?: number, generatedAt?: string, size?: number, map: Map<string, object> }}
 */
export function loadEventTable(path = DEFAULT_TABLE_PATH) {
  if (cached && cached.path === path) return cached.value
  const empty = { available: false, map: new Map(), path }
  if (!existsSync(path)) { cached = { path, value: empty }; return empty }
  try {
    const payload = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'))
    const map = new Map()
    const byCode = new Map()
    for (const [code, exDate, cash, bonus, transfer, src] of payload.events ?? []) {
      const ev = {
        code, exDate,
        cashPerShare: cash ?? 0, bonusPerShare: bonus ?? 0, transferPerShare: transfer ?? 0,
        source: 'offline-table', sourceCode: src,
      }
      map.set(`${code}|${exDate}`, ev)
      if (!byCode.has(code)) byCode.set(code, new Map())
      byCode.get(code).set(`${code}|${exDate}`, ev)
    }
    const value = { available: true, version: payload.version, generatedAt: payload.generatedAt, convention: payload.convention, size: map.size, map, byCode, path }
    cached = { path, value }
    return value
  } catch (e) {
    const value = { ...empty, error: String(e?.message ?? e) }
    cached = { path, value }
    return value
  }
}

export function resetEventTableCache() { cached = null }

/**
 * 把离线表并入运行时事件（**只处理指定代码**）：表优先，表里有而运行时没有的（历史事件）也补上。
 * @param {Array} runtimeEvents mergeDividendEvents 的输出
 * @param {object} table loadEventTable() 的返回值（需要 byCode）
 * @param {string} code 本次处理的股票代码（防止把别的股票的事件串进来）
 */
export function applyEventTable(runtimeEvents, table, code) {
  const scoped = table?.byCode?.get(code)
  if (!scoped || scoped.size === 0) return { events: runtimeEvents, fromTable: 0, overridden: 0, added: 0 }
  const byKey = new Map()
  for (const e of runtimeEvents) byKey.set(`${e.code}|${e.exDate}`, e)
  let fromTable = 0, overridden = 0, added = 0
  for (const [key, te] of scoped) {
    fromTable++
    const rt = byKey.get(key)
    if (rt) {
      const same = Math.abs((rt.cashPerShare ?? 0) - te.cashPerShare) < 1e-6 &&
        Math.abs((rt.bonusPerShare ?? 0) - te.bonusPerShare) < 1e-6 &&
        Math.abs((rt.transferPerShare ?? 0) - te.transferPerShare) < 1e-6
      if (!same) overridden++
      byKey.set(key, { ...te, plans: rt.plans ?? [], mergeMode: same ? rt.mergeMode : 'offline-table-override', candidates: null })
    } else {
      added++
      byKey.set(key, te)
    }
  }
  const events = [...byKey.values()].sort((a, b) => (a.code === b.code ? a.exDate - b.exDate : a.code.localeCompare(b.code)))
  return { events, fromTable, overridden, added }
}

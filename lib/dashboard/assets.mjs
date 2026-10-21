/**
 * 看板资产加载（磁盘 / 缓存）。
 *
 * 为什么要和 render.mjs 分开：渲染器要保持"只吃模型"的纯函数身份，
 * 一旦它 import fs，"换投递通道不动渲染器"的契约就破了。
 * 读盘、缓存、缺文件报错都收在这里。
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

export const ECHARTS_PATH = join(ROOT, 'vendor', 'echarts', 'echarts.common.min.js')
export const RUNTIME_PATH = join(HERE, 'client-runtime.js')

let cache = null

/**
 * 读出内联所需的两个资产。
 * 结果按进程缓存：一次导出多个报告时不重复读 664KB。
 */
export function loadDashboardAssets() {
  if (cache) return cache
  if (!existsSync(ECHARTS_PATH)) {
    const e = new Error('缺少 vendored ECharts 产物')
    e.code = 'NO_VENDOR'
    throw e
  }
  if (!existsSync(RUNTIME_PATH)) {
    const e = new Error('缺少客户端渲染脚本')
    e.code = 'NO_RUNTIME'
    throw e
  }
  cache = {
    echartsJs: readFileSync(ECHARTS_PATH, 'utf8'),
    runtimeJs: readFileSync(RUNTIME_PATH, 'utf8'),
  }
  return cache
}

/** 测试用：清掉缓存（改了资产文件的场景） */
export function _resetAssetCache() { cache = null }

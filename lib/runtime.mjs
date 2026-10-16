/**
 * 插件运行时：仓库句柄的生命周期。
 *
 * 数据目录的解析顺序（写死在这里，避免每个工具各解析一遍）：
 *   1. 插件行 config 的 `dataDir`
 *   2. 环境变量 `DSH_QUANT_DATA_DIR`
 *   3. `$DSH_HOME/quant/`（默认；DSH_HOME 未设时退回 `~/.dsh/quant/`）
 *
 * 仓库**惰性打开**：插件加载时不碰磁盘，第一次真正用到数据时才建库。
 * 这样"装了但没用量化"的用户不会平白多出一个数据库文件。
 */

import { mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { openStore } from './data/store.mjs'
import { ensureFactorAggregates } from './factors/aggregates.mjs'

export function resolveDataDir(config = {}) {
  if (config.dataDir) return resolve(config.dataDir)
  if (process.env.DSH_QUANT_DATA_DIR) return resolve(process.env.DSH_QUANT_DATA_DIR)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'quant')
}

/**
 * 创建运行时。返回的 `store()` 是**同一个连接**（node:sqlite 是同步 API，
 * 单连接即可；多开会带来 WAL 竞争而没有任何收益）。
 */
export function createRuntime(config = {}) {
  const dir = resolveDataDir(config)
  const dbPath = join(dir, 'quant.db')
  let handle = null
  let openedAt = null

  const store = () => {
    if (handle) return handle
    mkdirSync(dir, { recursive: true })
    handle = openStore(dbPath, { tempStore: config.tempStore ?? process.env.DSH_QUANT_TEMP_STORE ?? 'memory' })
    // 因子滑动聚合（Rank/IdxMax/IdxMin）注册是幂等的，但必须在同一连接上
    ensureFactorAggregates(handle)
    openedAt = Date.now()
    return handle
  }

  return {
    dir, dbPath,
    exists: () => existsSync(dbPath),
    store,
    /** 用完即关的包装（工具调用之间不保持打开，避免长时间占着 WAL） */
    withStore(fn) { return fn(store()) },
    info: () => ({
      dir, dbPath, exists: existsSync(dbPath),
      opened: handle !== null, openedAt,
      tempStore: config.tempStore ?? process.env.DSH_QUANT_TEMP_STORE ?? 'memory',
    }),
    close() { if (handle) { try { handle.close() } catch { /* 已关闭 */ } handle = null } },
  }
}

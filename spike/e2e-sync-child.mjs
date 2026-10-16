/**
 * 验收标准 3 · 场景 ④ 用的子进程：顺序同步一组代码，然后在被 SIGKILL 时"非自愿"中断。
 *
 * 为什么单独一个进程：中断恢复要测的是**进程被杀**这条真实路径（不是 `signal.aborted`
 * 的优雅退出）——杀完之后 `sync_state` 里已 ok 的股票必须在下一轮被跳过（增量重叠重试），
 * 未完成的继续补。这只有跨进程才测得出来。
 *
 * 用法: node spike/e2e-sync-child.mjs <数据目录> <代码表csv>
 */

import { createRuntime } from '../lib/runtime.mjs'
import { syncBars } from '../lib/data/sync.mjs'

const [dir, codesCsv, fromS, toS] = process.argv.slice(2)
const codes = codesCsv.split(',').map((s) => s.trim()).filter(Boolean)
const runtime = createRuntime({ dataDir: dir })
const store = runtime.store()

const res = await syncBars(store, {
  codes,
  from: Number(fromS), to: Number(toS),
  // 中断恢复要验证的是"跳过已 ok 的 + 续上没 ok 的"，所以显式打开增量（生产默认路径）
  incremental: { overlapDays: 10 },
  batchSize: 1, // 每只股票后都让出事件循环：给父进程留出观察窗口
})
console.log('[child] done:', JSON.stringify({ ok: res.ok, done: res.done, failed: res.failed, skipped: res.skipped, bars: res.bars }))
process.exit(0)

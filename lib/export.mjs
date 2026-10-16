/**
 * 结果导出（交付物）。
 *
 * ## 为什么要单独一层
 *
 * 模型的上下文会被压缩（`compaction-basic` + `tool-result-pruner` 在 8KB 处裁工具结果），
 * 所以"上一次回测的完整净值曲线"并不可靠——它随时可能被裁掉。
 * 把结果**落到文件**是唯一能让结论活过一次压缩的办法，也是"把交付物交给用户"的正规路径。
 *
 * ## 两条硬规则
 *
 * 1. **落盘在会话工作目录里**（`<cwd>/quant-exports/`），而不是数据目录。
 *    这样 `present` 能直接呈现，用户也能在项目里找到它；写到 `$DSH_HOME` 下面
 *    用户是找不到的。没有会话工作目录时（例如 headless）退回数据目录并**明确说明**。
 * 2. **CSV 带 UTF-8 BOM**。不带的话 Excel 打开中文列名是乱码——这是国内用户
 *    最高频的"导出坏了"投诉，代价只有一个字节。
 *
 * 本模块全部是纯函数 + 一个写文件的薄壳，因此可以直接单测。
 */

import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const EXPORT_DIRNAME = 'quant-exports'

/** 所有导出文件都带的声明头 —— 交付物离开对话后必须自带边界 */
export const DISCLAIMER = '本文件由 dsh-quant-assistant 生成，是对历史数据的统计描述，不构成投资建议，也不预测未来收益。'

// ── CSV ─────────────────────────────────────────────────────────────────────

function csvCell(v) {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 行数组（对象或数组）→ CSV 文本（含 BOM） */
export function toCsv(rows, columns = null) {
  const list = Array.isArray(rows) ? rows : []
  const cols = columns ?? (list.length ? Object.keys(list[0]) : [])
  const lines = [cols.map(csvCell).join(',')]
  for (const r of list) {
    if (Array.isArray(r)) lines.push(r.map(csvCell).join(','))
    else lines.push(cols.map((c) => csvCell(r?.[c])).join(','))
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n'
}

// ── Markdown 片段 ───────────────────────────────────────────────────────────

const ymd = (x) => (x === null || x === undefined ? '—' : String(x).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'))
const pct = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`)
const num = (x, d = 4) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : Number(x).toFixed(d))
const money = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : Number(x).toLocaleString('zh-CN', { maximumFractionDigits: 0 }))

/** 生成时间 + 免责声明（每个文件都要有） */
function head(title, generatedAt) {
  return [
    `# ${title}`,
    '',
    `> 生成时间：${new Date(generatedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    `> ${DISCLAIMER}`,
    '',
  ].join('\n')
}

function caveatsBlock(caveats) {
  if (!caveats?.length) return ''
  return `\n## 口径声明\n\n${caveats.map((c) => `- ${c}`).join('\n')}\n`
}

// ── 各类型报告 ──────────────────────────────────────────────────────────────

/** 回测 → Markdown（含完整净值表，不降采样：文件不受卡片宽度限制） */
export function backtestMarkdown(rec, { generatedAt = Date.now(), nav = null } = {}) {
  const m = rec.metrics ?? {}
  const cfg = rec.config ?? {}
  const navRows = nav ?? rec.nav ?? []
  const lines = [
    head(`回测报告：${rec.strategy_id ?? rec.strategyId ?? '—'}`, generatedAt),
    `- 回测 id：\`${rec.backtest_id ?? rec.backtestId ?? '—'}\``,
    `- 策略版本：v${rec.version ?? '—'}`,
    `- 区间：${ymd(cfg.start)} ~ ${ymd(cfg.end)}（${m.days ?? '—'} 个交易日）`,
    `- 初始资金：${money(cfg.initialCash ?? 1_000_000)}`,
    `- 因子：${(cfg.factors ?? []).map((f) => `\`${f.id}\``).join('、') || '—'}`,
    `- 选股：topK=${cfg.selection?.k ?? '—'}，调仓 ${cfg.rebalance ?? '—'}，权重 ${cfg.weight ?? '—'}`,
    '',
    '## 绩效指标',
    '',
    '| 指标 | 值 |',
    '|---|---|',
    `| 总收益 | ${pct(m.totalReturn)} |`,
    `| 年化收益 | ${pct(m.cagr)} |`,
    `| 年化波动 | ${pct(m.annualVol)} |`,
    `| 夏普 | ${num(m.sharpe)} |`,
    `| 最大回撤 | ${pct(m.maxDrawdown)} |`,
    `| Calmar | ${num(m.calmar)} |`,
    `| 胜率 | ${pct(m.winRate)} |`,
    `| 年化换手 | ${num(m.turnover, 2)} |`,
    `| 成交笔数 | ${m.trades ?? '—'} |`,
  ]
  if (m.benchmark) {
    lines.push(
      '', '## 基准对比', '',
      '| 指标 | 值 |', '|---|---|',
      `| 基准收益 | ${pct(m.benchmark.totalReturn)} |`,
      `| 超额收益 | ${pct(m.benchmark.excessReturn)} |`,
      `| Beta | ${num(m.benchmark.beta)} |`,
      `| 信息比率 | ${num(m.benchmark.informationRatio)} |`,
    )
  }
  if (m.fees) {
    lines.push(
      '', '## 费用拆分', '',
      '| 项目 | 金额 |', '|---|---|',
      `| 佣金 | ${money(m.fees.commission)} |`,
      `| 印花税 | ${money(m.fees.stampDuty)} |`,
      `| 过户费 | ${money(m.fees.transferFee)} |`,
      `| 滑点 | ${money(m.fees.slippage)} |`,
    )
  }
  if (Array.isArray(m.byFactor) && m.byFactor.length) {
    lines.push('', '## 分因子', '', '| 因子 | 总收益 | 年化 | 夏普 | 最大回撤 |', '|---|---|---|---|---|')
    for (const f of m.byFactor) lines.push(`| ${f.factorId} | ${pct(f.totalReturn)} | ${pct(f.cagr)} | ${num(f.sharpe)} | ${pct(f.maxDrawdown)} |`)
  }
  lines.push(caveatsBlock(rec.caveats))
  if (navRows.length) {
    lines.push('', `## 净值曲线（${navRows.length} 点）`, '', '| 日期 | 净值 |', '|---|---|')
    for (const p of navRows) lines.push(`| ${ymd(p.date)} | ${num(p.nav, 6)} |`)
  }
  lines.push('')
  return lines.join('\n')
}

/** 选股结果 → Markdown */
export function selectMarkdown(sel, { generatedAt = Date.now(), label = null } = {}) {
  const lines = [
    head(`选股结果${label ? `：${label}` : ''}`, generatedAt),
    `- 信号日：${ymd(sel.date)}（路径 ${sel.path === 'panel' ? '已物化面板' : '现场求值'}）`,
    `- 排序：因子值${sel.ascending ? '最小' : '最大'}优先`,
    `- 股票池：${sel.universeSize ?? '—'} 只 → 通过 ${sel.passedUniverse ?? '—'} 只`,
    `- 拒绝原因：${Object.entries(sel.rejected ?? {}).map(([k, n]) => `${k}×${n}`).join('、') || '无'}`,
    '',
    '## 候选名单',
    '',
    '> 这是**按因子排序的结果**，不是推荐，也不构成投资建议。',
    '',
    '| 名次 | 代码 | 名称 | 因子值 | 收盘价 |',
    '|---|---|---|---|---|',
  ]
  for (const p of sel.picks ?? []) {
    lines.push(`| ${p.rank} | ${p.code} | ${p.name ?? '—'} | ${num(p.value, 6)} | ${num(p.close, 2)} |`)
  }
  if (sel.dateAdjusted) lines.push('', `> ⚠️ ${sel.dateAdjusted.reason}`)
  lines.push(caveatsBlock(sel.caveats), '')
  return lines.join('\n')
}

/** 持仓估值 → Markdown */
export function holdingsMarkdown(pos, { generatedAt = Date.now() } = {}) {
  const lines = [
    head('持仓估值', generatedAt),
    `- 行情截至：${ymd(pos.asOf)}${pos.asOf ? '（本地库最新收盘价；数据可能滞后）' : ''}`,
    `- 持仓 ${pos.count ?? 0} 只，市值 ${money(pos.marketValue)}，成本 ${money(pos.costValue)}`,
  ]
  if (pos.totalAssets !== undefined) lines.push(`- 总资产 ${money(pos.totalAssets)}，仓位 ${pct(pos.positionRatio)}`)
  lines.push('', '| 代码 | 股数 | 成本 | 现价 | 市值 | 盈亏 | 权重 |', '|---|---|---|---|---|---|---|')
  for (const p of pos.positions ?? []) {
    lines.push(`| ${p.code} | ${p.shares} | ${num(p.cost, 3)} | ${num(p.lastClose, 2)} | ${money(p.marketValue)} | ${pct(p.pnlPct)} | ${pct(p.weight)} |`)
  }
  // 免责声明已在 head() 里给过，这里不重复（同一句话出现两遍会显得像模板噪音）
  lines.push('')
  return lines.join('\n')
}

/** 数据仓库状态 → Markdown */
export function dataStatusMarkdown(s, { generatedAt = Date.now(), dir = null } = {}) {
  const f = s.freshness ?? {}
  const a = s.autoSync ?? {}
  const lines = [
    head('数据仓库状态', generatedAt),
    `- 数据目录：\`${dir ?? s.dir ?? '—'}\``,
    `- 覆盖：${s.codes ?? 0} 只 / ${s.bars ?? 0} 根 bar / ${s.adjEvents ?? 0} 个复权事件 / ${s.fundamentals ?? 0} 条基本面`,
    `- 区间：${ymd(s.range?.[0])} ~ ${ymd(s.range?.[1])}`,
    `- 新鲜度：${s.stale ? '**已过期**' : '新鲜'}（距今 ${f.weekdays ?? '—'} 个工作日 / ${f.calendarDays ?? '—'} 个自然日，阈值 ${s.staleDays ?? '—'} 工作日）`,
    `- 同步状态：${Object.entries(s.byStatus ?? {}).map(([k, n]) => `${k}:${n}`).join(' ') || '—'}${s.uncovered ? `，未覆盖 ${s.uncovered} 只` : ''}${s.pendingCount ? `，待续传 ${s.pendingCount} 只` : ''}`,
    `- 自动同步：${a.enabled ? `已开启（每天 ${a.at}）` : '未开启'}${a.lastOutcome ? `，上次结果 ${a.lastOutcome}（${ymd(a.lastAttemptDate)}）` : ''}`,
  ]
  if (s.panels?.length) {
    lines.push('', '## 因子面板', '', '| 因子 | 行数 | 起始 | 截止 | 落后行情 |', '|---|---|---|---|---|')
    for (const p of s.panels) lines.push(`| ${p.factorId} | ${p.rows} | ${ymd(p.firstDate)} | ${ymd(p.lastDate)} | ${p.behindDays ?? '—'} 天 |`)
  }
  // 免责声明已在 head() 里给过，这里不重复（同一句话出现两遍会显得像模板噪音）
  lines.push('')
  return lines.join('\n')
}

// ── 落盘 ────────────────────────────────────────────────────────────────────

/**
 * 决定导出目录。
 *
 * 优先级：调用方显式 `outputDir` → **会话工作目录**下的 `quant-exports/` → 数据目录下的 `exports/`。
 * 中间那一档是默认值，因为它是唯一既能被 `present` 呈现、用户又能自己找到的位置。
 */
export function resolveExportDir({ outputDir = null, sessionCwd = null, dataDir = null } = {}) {
  if (outputDir) return { dir: resolve(outputDir), where: 'explicit' }
  if (sessionCwd) return { dir: join(resolve(sessionCwd), EXPORT_DIRNAME), where: 'workspace' }
  if (dataDir) return { dir: join(resolve(dataDir), 'exports'), where: 'data-dir' }
  return { dir: resolve(process.cwd(), EXPORT_DIRNAME), where: 'cwd' }
}

/** 文件名净化：只留安全字符，避免路径穿越 */
export function safeFilename(name, fallback = 'export') {
  const s = String(name ?? '').trim().replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').replace(/^[._]+/, '').slice(0, 120)
  return s || fallback
}

/**
 * 写出一组交付物。
 *
 * @param {string} dir 目标目录（由 resolveExportDir 决定）
 * @param {Array<{filename: string, content: string}>} files
 * @returns {{dir: string, files: Array<{path, filename, bytes, format}>}}
 */
export function writeDeliverables(dir, files) {
  mkdirSync(dir, { recursive: true })
  const written = []
  for (const f of files) {
    const filename = safeFilename(f.filename, 'export.txt')
    const path = join(dir, filename)
    writeFileSync(path, f.content, 'utf8')
    written.push({ path, filename, bytes: statSync(path).size, format: f.format ?? (filename.endsWith('.csv') ? 'csv' : 'markdown') })
  }
  return { dir, files: written }
}

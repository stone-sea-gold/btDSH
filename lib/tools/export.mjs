/**
 * 导出工具（1 个）：把结果落成文件交付物。
 *
 * 为什么必须有这一层，而不是让模型自己 `write`：
 *   1. **口径一致**：报告里的指标、声明、拒绝原因都从同一份结构化数据生成，
 *      不会因为模型转述而漏掉 `caveats` 或写错数字。
 *   2. **压缩免疫**：工具结果会在 8KB 处被裁剪，模型手里未必还有完整净值曲线；
 *      落盘的文件是完整的。
 *   3. **落点正确**：默认写进**会话工作目录**的 `quant-exports/`，这样 `present`
 *      能直接呈现、用户也能在项目里找到。写到数据目录用户是找不到的。
 */

import { tool, S, output, fail } from './kit.mjs'
import { selectStocks } from '../factors/select.mjs'
import { syncStatus } from '../data/sync.mjs'
import {
  backtestMarkdown, selectMarkdown, holdingsMarkdown, dataStatusMarkdown,
  toCsv, resolveExportDir, writeDeliverables, DISCLAIMER,
} from '../export.mjs'

const KINDS = ['backtest', 'select', 'holdings', 'panel', 'data_status']

export function exportTools(runtime) {
  return [
    tool({
      name: 'quant_export',
      description: [
        '把结果导出成文件交付物（Markdown / CSV），默认写到**会话工作目录**的 `quant-exports/`。',
        `kind：backtest（回测报告，需 backtestId）| select（选股名单，参数同 quant_select_stocks）| holdings（持仓估值）| panel（因子面板明细，需 factorId）| data_status（数据仓库状态）。`,
        '导出成功后**必须**紧接着调用 `present` 把这些文件声明为交付物——只把路径写在回复里不算交付。',
        '文件里已经带了口径声明与免责声明，不需要你再去补。',
      ].join(' '),
      parameters: S.obj({
        kind: S.enum(KINDS, '导出什么'),
        backtestId: S.str('kind=backtest 时的回测 id'),
        factorId: S.str('kind=panel 时的因子 id；kind=select 时可选（有面板走面板路径）'),
        formula: S.str('kind=select 且没有面板时的 DSL 公式'),
        date: S.int('kind=select 的信号日 YYYYMMDD（默认最新交易日）；kind=panel 的起始日'),
        to: S.int('kind=panel 的结束日 YYYYMMDD'),
        topK: S.int('kind=select 取前几名（默认 20）'),
        ascending: S.bool('kind=select 取因子值最小（默认 false）'),
        maxRank: S.int('kind=panel 只导出前几名（默认全部）'),
        format: S.enum(['markdown', 'csv', 'both'], '输出格式（默认 markdown；panel/holdings 默认 csv）'),
        outputDir: S.str('输出目录（默认 <会话工作目录>/quant-exports）'),
        filename: S.str('文件名主干（不含扩展名；默认按类型与日期生成）'),
        cash: S.num('kind=holdings 时的现金（可选，用于算总资产与仓位）'),
      }, ['kind']),
      outputSchema: output({
        kind: { type: 'string' }, dir: { type: 'string' }, where: { type: 'string' },
        files: { type: 'array', items: { type: 'object', additionalProperties: true } },
        caveats: { type: 'array', items: { type: 'string' } },
      }, ['kind', 'files']),
      execute: (args, exec) => {
        if (!runtime.exists()) return fail('NO_STORE', '本地还没有数据仓库，没有可导出的内容', '先跑 quant_data_sync')
        const store = runtime.store()
        const kind = args.kind
        const sessionCwd = exec?.agent?.session?.header?.cwd ?? null
        const { dir, where } = resolveExportDir({ outputDir: args.outputDir ?? null, sessionCwd, dataDir: runtime.dir })
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
        const base = args.filename ? String(args.filename) : `${kind}-${stamp}`
        const files = []

        if (kind === 'backtest') {
          if (!args.backtestId) return fail('MISSING_ARG', 'kind=backtest 需要 backtestId')
          const rec = store.getBacktest(String(args.backtestId))
          if (!rec) return fail('NOT_FOUND', `回测 ${args.backtestId} 不存在`, '用 quant_backtest_run 跑一次，或 quant_backtest_get 确认 id')
          const md = backtestMarkdown(rec)
          files.push({ filename: `${base}.md`, content: md, format: 'markdown' })
          if (args.format === 'csv' || args.format === 'both') {
            files.push({ filename: `${base}-nav.csv`, content: toCsv(rec.nav ?? [], ['date', 'nav']), format: 'csv' })
          }
          const r = writeDeliverables(dir, files)
          return { ok: true, kind, dir: r.dir, where, files: r.files, caveats: rec.caveats ?? [] }
        }

        if (kind === 'select') {
          const sel = selectStocks(store, {
            factorId: args.factorId ?? null, formula: args.formula ?? null,
            date: args.date ?? null, topK: args.topK ?? 20, ascending: !!args.ascending,
            universe: { excludeST: true, minListDays: 60 },
          })
          if (!sel.ok) return sel
          files.push({ filename: `${base}.md`, content: selectMarkdown(sel, { label: args.factorId ?? args.formula ?? null }), format: 'markdown' })
          if (args.format === 'csv' || args.format === 'both') {
            files.push({
              filename: `${base}.csv`,
              content: toCsv((sel.picks ?? []).map((p) => ({ rank: p.rank, code: p.code, name: p.name ?? '', value: p.value, close: p.close }))),
              format: 'csv',
            })
          }
          const r = writeDeliverables(dir, files)
          return { ok: true, kind, dir: r.dir, where, files: r.files, caveats: sel.caveats ?? [] }
        }

        if (kind === 'holdings') {
          const holdings = store.listHoldings()
          if (!holdings.length) return fail('NO_HOLDINGS', '还没有保存持仓', '先用 quant_save_holdings 录入')
          // 与 quant_portfolio_status 同口径：直接用工具层的估值逻辑，避免两处算法漂移
          const pos = valueFor(runtime, holdings, args.cash)
          files.push({ filename: `${base}.md`, content: holdingsMarkdown(pos), format: 'markdown' })
          if (args.format === 'csv' || args.format === 'both' || args.format === undefined) {
            files.push({ filename: `${base}.csv`, content: toCsv(pos.positions), format: 'csv' })
          }
          const r = writeDeliverables(dir, files)
          return { ok: true, kind, dir: r.dir, where, files: r.files }
        }

        if (kind === 'panel') {
          if (!args.factorId) return fail('MISSING_ARG', 'kind=panel 需要 factorId')
          const fid = String(args.factorId)
          const meta = store.panelMeta(fid)
          if (!meta) return fail('NO_PANEL', `因子 ${fid} 还没有物化面板`, '先跑 quant_factor_preview 或 quant_backtest_run 物化它')
          const rows = store.panelRows(fid, {
            from: args.date ?? 0, to: args.to ?? 99999999,
            maxRank: args.maxRank ?? 1e9,
          })
          const names = new Map(store.codesList().map((c) => [c.code, c.name]))
          const csv = toCsv(rows.map((r) => ({ date: r.date, rank: r.rank, code: r.code, name: names.get(r.code) ?? '', value: r.value })))
          files.push({ filename: `${base}.csv`, content: csv, format: 'csv' })
          const r = writeDeliverables(dir, files)
          return {
            ok: true, kind, dir: r.dir, where, files: r.files,
            caveats: [`面板只物化了 top-${meta.top_n} 名，不是全市场截面`, '因子值算在复权价上'],
          }
        }

        // data_status
        const s = syncStatus(store, {})
        files.push({ filename: `${base}.md`, content: dataStatusMarkdown(s, { dir: runtime.dir }), format: 'markdown' })
        const r = writeDeliverables(dir, files)
        return { ok: true, kind, dir: r.dir, where, files: r.files }
      },
      presentationMeta: (a, v) => v.ok === false
        ? { kind: 'export', ok: false, code: v.error?.code ?? 'ERROR', message: v.error?.message ?? '', hint: v.error?.hint }
        : {
            kind: 'export', ok: true, exportKind: v.kind, dir: v.dir, where: v.where,
            files: (v.files ?? []).map((f) => ({ filename: f.filename, bytes: f.bytes, format: f.format, path: f.path })),
          },
      render: (a, v) => {
        if (v.ok === false) return `失败：${v.error.code} — ${v.error.message}${v.error.hint ? `\n${v.error.hint}` : ''}`
        const where = { workspace: '会话工作目录', 'data-dir': '数据目录（当前会话没有工作目录）', explicit: '指定目录', cwd: '进程当前目录' }[v.where] ?? v.where
        return [
          `已导出 ${v.kind}（${v.files.length} 个文件，落点：${where}）`,
          ...v.files.map((f) => `  ${f.path}  ${(f.bytes / 1024).toFixed(1)} KB`),
          `**下一步必须调用 present**，files 传上面这些绝对路径，否则用户拿不到交付物。`,
        ].join('\n')
      },
    }),
  ]
}

/**
 * 持仓估值（与 `quant_portfolio_status` 同口径）。
 *
 * 直接复用工具模块里的实现会形成循环 import（portfolio.mjs ↔ export.mjs），
 * 所以这里用同一套 SQL 口径重算一遍，并在单测里对着 portfolio 工具的结果核对。
 *
 * **累加必须用未取整的值，最后才取整**：逐行先 `toFixed(2)` 再相加，
 * 与"先相加再取整"会差几分钱 —— 那样导出的报告和卡片上的数字就对不上了。
 */
function valueFor(runtime, holdings, cash) {
  const store = runtime.store()
  const positions = []
  let marketValue = 0, costValue = 0, asOf = null
  for (const h of holdings) {
    const row = store.raw.prepare('SELECT date, close FROM bars WHERE code=? ORDER BY date DESC LIMIT 1').get(h.code)
    const lastClose = row?.close ?? null
    const mv = lastClose === null ? null : lastClose * h.shares
    if (row?.date && (asOf === null || row.date > asOf)) asOf = row.date
    if (mv !== null) marketValue += mv
    if (h.cost !== null && h.cost !== undefined) costValue += h.cost * h.shares
    positions.push({
      code: h.code, shares: h.shares, cost: h.cost ?? null, lastClose,
      marketValue: mv === null ? null : +mv.toFixed(2),
      pnl: lastClose !== null && h.cost ? +((lastClose - h.cost) * h.shares).toFixed(2) : null,
      pnlPct: lastClose !== null && h.cost ? +(lastClose / h.cost - 1).toFixed(6) : null,
      asOf: row?.date ?? null, weight: null,
    })
  }
  const cashN = Number.isFinite(cash) ? cash : null
  const totalAssets = cashN === null ? marketValue : cashN + marketValue
  for (const p of positions) p.weight = totalAssets > 0 && p.marketValue !== null ? +(p.marketValue / totalAssets).toFixed(6) : null
  return {
    asOf, count: positions.length, marketValue: +marketValue.toFixed(2), costValue: +costValue.toFixed(2),
    totalAssets: +totalAssets.toFixed(2),
    positionRatio: totalAssets > 0 ? +(marketValue / totalAssets).toFixed(6) : null,
    positions,
  }
}

export { DISCLAIMER }

/**
 * 因子域工具（4 个）：检索、预览、创建。
 *
 * 内置因子目录随包发布（`data/factors.json`，109 条，全部可被 DSL 编译 —— 有 P2 实测背书）。
 * 自定义因子一律**先编译再入库**：编译不过的公式不进目录，避免模型造出一个永远算不出来的因子。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tool, S, output, fail, fmt } from './kit.mjs'
import { compileFactor, validate, FIELDS, FUNCTIONS } from '../factors/dsl.mjs'
import { materializePanel, panelHealth, DEFAULT_TOP_N } from '../factors/panel.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CATALOG_PATH = join(HERE, '..', '..', 'data', 'factors.json')

let catalogCache = null
/** 内置因子目录（惰性读取一次） */
export function builtinFactors() {
  if (catalogCache) return catalogCache
  try {
    catalogCache = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')).factors ?? []
  } catch { catalogCache = [] }
  return catalogCache
}

/** 目录 + 用户自建（存在 meta 表里）合并 */
function allFactors(store) {
  const builtin = builtinFactors()
  let custom = []
  try {
    custom = store.raw.prepare("SELECT * FROM meta WHERE key LIKE 'factor:%'").all()
      .map((r) => { try { return JSON.parse(r.value) } catch { return null } })
      .filter(Boolean)
  } catch { /* meta 表不存在时忽略 */ }
  return [...builtin, ...custom]
}

export function factorTools(runtime) {
  return [
    tool({
      name: 'quant_factor_list',
      description: [
        '列出可用的量化因子（内置 109 条 + 用户自建）。可按分类过滤。',
        '返回 id / 名称 / 分类 / 公式。公式是 DSL 写法：字段用 `$close` 这种形式，',
        '支持 Ref/Mean/Std/Max/Min/Corr/Slope/Rsquare/Resi/Quantile/Rank/IdxMax/IdxMin/Ret/Abs/Log。',
      ].join(' '),
      parameters: S.obj({
        category: S.enum(['momentum', 'value', 'quality', 'volatility', 'size', 'liquidity', 'growth', 'technical'], '只看某一分类'),
        limit: S.int('最多返回多少条（默认 50）'),
      }, []),
      outputSchema: output({
        total: { type: 'integer' }, count: { type: 'integer' },
        byCategory: { type: 'object', additionalProperties: true },
        factors: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }, ['total', 'count', 'factors']),
      execute: (args) => {
        const all = allFactors(runtime.store())
        const filtered = args.category ? all.filter((f) => f.category === args.category) : all
        const limit = Math.min(args.limit ?? 50, 200)
        const byCategory = {}
        for (const f of all) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1
        return {
          ok: true, total: all.length, count: Math.min(filtered.length, limit), byCategory,
          factors: filtered.slice(0, limit).map((f) => ({ id: f.id, name: f.name, category: f.category, formula: f.formula })),
        }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : `${v.total} 条因子（${Object.entries(v.byCategory).map(([k, n]) => `${k}:${n}`).join(' ')}），返回 ${v.count} 条\n` +
          v.factors.map((f) => `- ${f.id} ${f.name} [${f.category}]  ${f.formula}`).join('\n'),
    }),

    tool({
      name: 'quant_factor_search',
      description: [
        '按关键词检索因子：匹配 id / 名称 / 描述 / 标签 / 公式。',
        '用于把用户的一句话（如"最近涨得稳的"）落到具体因子上。',
        '返回结果按匹配强度排序，并给出每条因子的公式便于核对口径。',
      ].join(' '),
      parameters: S.obj({
        query: S.str('关键词，例如 动量 / 波动 / 换手 / 反转 / RSI'),
        limit: S.int('最多返回多少条（默认 10）'),
      }, ['query']),
      outputSchema: output({
        query: { type: 'string' }, count: { type: 'integer' },
        matches: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }, ['query', 'count', 'matches']),
      execute: (args) => {
        const q = String(args.query ?? '').trim().toLowerCase()
        if (!q) return fail('EMPTY_QUERY', '关键词不能为空')
        const terms = q.split(/\s+/).filter(Boolean)
        const scored = []
        for (const f of allFactors(runtime.store())) {
          const hay = [f.id, f.name, f.description, f.category, (f.tags ?? []).join(' '), f.formula].join(' ').toLowerCase()
          let score = 0
          for (const t of terms) {
            if (!hay.includes(t)) { score = -1; break }
            if (f.id.toLowerCase().includes(t)) score += 4
            else if (f.name?.toLowerCase().includes(t)) score += 3
            else if ((f.tags ?? []).join(' ').toLowerCase().includes(t)) score += 2
            else score += 1
          }
          if (score > 0) scored.push({ ...f, score })
        }
        scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        const matches = scored.slice(0, Math.min(args.limit ?? 10, 50))
          .map(({ score, ...f }) => ({ id: f.id, name: f.name, category: f.category, formula: f.formula, description: f.description }))
        return { ok: true, query: args.query, count: matches.length, matches }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : (v.count === 0 ? `没有匹配「${v.query}」的因子` : v.matches.map((f) => `- ${f.id} ${f.name}：${f.description ?? ''}\n  ${f.formula}`).join('\n')),
    }),

    tool({
      name: 'quant_factor_preview',
      description: [
        '在真实数据上试算一个因子公式，返回最近若干交易日的截面值与前几名股票。',
        '**这是写因子公式后的必做一步**：公式能被编译不等于算得出有意义的值。',
        '返回里带 `coverage`（非空值比例）与 `distinct`（不同值个数），',
        'coverage 过低或 distinct 过小都说明公式在数据上退化了。',
      ].join(' '),
      parameters: S.obj({
        formula: S.str('DSL 公式，例如 $close / Ref($close, 20) - 1'),
        date: S.int('信号日 YYYYMMDD（默认最新交易日）'),
        topN: S.int('展示前多少名（默认 10）'),
      }, ['formula']),
      outputSchema: output({
        formula: { type: 'string' }, date: { type: 'integer' },
        layers: { type: 'integer' }, lookback: { type: 'integer' },
        coverage: { type: 'number' }, distinct: { type: 'integer' }, stocks: { type: 'integer' },
        top: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }, ['formula', 'coverage', 'top']),
      execute: (args) => {
        const store = runtime.store()
        const c = compileFactor(args.formula, { source: 'bars_adj', fieldMap: { turnover_rate: 'turnover' } })
        if (!c.ok) return fail(c.error.code, c.error.message, '用 quant_factor_list 看可用字段与函数')
        const date = args.date ?? store.raw.prepare('SELECT max(date) d FROM bars').get()?.d
        if (!date) return fail('NO_DATA', '仓库里没有行情数据，先跑 quant_data_sync')

        // 只取信号日截面：把源裁到每股最后 lookback+1 行，避免为一天算全历史
        const k = (c.meta.lookback ?? 0) + 1
        const trimmed = `(SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY code ORDER BY date DESC) AS __rn
                          FROM bars_adj WHERE date <= ${Number(date)}) WHERE __rn <= ${k})`
        const c2 = compileFactor(args.formula, { source: trimmed, fieldMap: { turnover_rate: 'turnover' } })
        if (!c2.ok) return fail(c2.error.code, c2.error.message)
        const rows = store.raw.prepare(`SELECT code, value FROM (${c2.sql}) WHERE date = ? AND value IS NOT NULL ORDER BY value DESC`).all(date)
        const all = store.raw.prepare(`SELECT count(*) c FROM (${c2.sql}) WHERE date = ?`).get(date)?.c ?? 0
        const distinct = new Set(rows.map((r) => r.value)).size
        return {
          ok: true, formula: args.formula, date,
          layers: c.meta.layerCount, lookback: c.meta.lookback ?? 0,
          coverage: all > 0 ? +(rows.length / all).toFixed(4) : 0,
          distinct, stocks: rows.length,
          top: rows.slice(0, Math.min(args.topN ?? 10, 50)).map((r, i) => ({ rank: i + 1, code: r.code, value: r.value })),
        }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : `因子 ${v.formula}\n信号日 ${fmt.date(v.date)} | 层数 ${v.layers} | 回看 ${v.lookback} 行\n` +
          `覆盖 ${(v.coverage * 100).toFixed(1)}%（${v.stocks} 只）| 不同取值 ${v.distinct} 个\n` +
          v.top.map((t) => `  #${t.rank} ${t.code} = ${fmt.num(t.value, 6)}`).join('\n') +
          (v.coverage < 0.5 ? '\n⚠️ 覆盖率偏低：公式可能在多数股票上无定义' : '') +
          (v.distinct <= 3 && v.stocks > 10 ? '\n⚠️ 取值种类过少：公式可能退化成了常数/布尔' : ''),
    }),

    tool({
      name: 'quant_factor_create',
      description: [
        '保存一个自定义因子。**公式会先被编译校验，编译不过不会入库**。',
        '保存后即可用于选股、回测与面板物化。id 建议用英文小写下划线。',
        '可选 `materialize=true` 立刻物化面板（耗时与股票数成正比，全市场约 1–2 分钟）。',
      ].join(' '),
      parameters: S.obj({
        id: S.str('因子 id（英文小写下划线，例如 my_momentum_10）'),
        name: S.str('显示名'),
        formula: S.str('DSL 公式'),
        description: S.str('一句话说明这个因子在赌什么'),
        category: S.enum(['momentum', 'value', 'quality', 'volatility', 'size', 'liquidity', 'growth', 'technical', 'custom'], '分类'),
        materialize: S.bool('是否立刻物化面板（默认 false）'),
        topN: S.int('物化面板的排名深度（默认 500）'),
      }, ['id', 'formula']),
      outputSchema: output({
        id: { type: 'string' }, version: { type: 'integer' }, layers: { type: 'integer' },
        fields: { type: 'array', items: { type: 'string' } },
        functions: { type: 'array', items: { type: 'string' } },
        materialized: { type: 'object', additionalProperties: true },
      }, ['id']),
      execute: (args) => {
        const store = runtime.store()
        const id = String(args.id).trim()
        if (!/^[a-z][a-z0-9_]{1,40}$/.test(id)) return fail('BAD_ID', 'id 必须是英文小写字母开头、只含小写字母数字下划线，长度 2–41')
        const c = compileFactor(args.formula, { source: 'bars_adj', fieldMap: { turnover_rate: 'turnover' } })
        if (!c.ok) return fail(c.error.code, c.error.message, `可用字段：${FIELDS.join(', ')}；可用函数：${Object.keys(FUNCTIONS).join(', ')}`)
        const meta = {
          id, name: args.name ?? id, description: args.description ?? null,
          category: args.category ?? 'custom', formula: args.formula, tags: [], custom: true,
          layers: c.meta.layerCount, lookback: c.meta.lookback ?? 0,
          createdAt: new Date().toISOString(),
        }
        store.raw.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(`factor:${id}`, JSON.stringify(meta))

        let materialized = null
        if (args.materialize) {
          const r = materializePanel(store, { factorId: id, formula: args.formula, topN: args.topN ?? DEFAULT_TOP_N })
          materialized = r.ok ? { rows: r.rows, ms: r.ms, lastDate: r.lastDate } : { error: r.error }
        }
        return {
          ok: true, id, version: 1, layers: c.meta.layerCount,
          fields: c.meta.fields, functions: c.meta.functions, materialized,
        }
      },
      render: (a, v) => v.ok === false ? `失败：${v.error.message}`
        : `已保存因子 ${v.id}（${v.layers} 层，字段 ${v.fields.join('/') || '无'}）` +
          (v.materialized ? (v.materialized.error ? `\n⚠️ 物化失败：${v.materialized.error.message}` : `\n面板已物化：${v.materialized.rows} 行，${v.materialized.ms}ms`) : ''),
    }),
  ]
}

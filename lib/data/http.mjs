/**
 * 带内容校验、重试与观测的 HTTP 层。
 *
 * P0 实测结论（决定了本文件的存在）：
 *  - 失败是**连接级随机**（UND_ERR_SOCKET / ECONNRESET），不是 429；
 *    同一 URL 连续失败 3 次后第 4 次成功，与查询内容无关。
 *  - 只看 HTTP 状态码会误判：东财某些主机对 kline 返回 200 + 空 data。
 *  → 因此必须「校验内容」+「多次重试 + 退避」，而不是「换主机」。
 */

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export const DEFAULT_REFERER = 'https://quote.eastmoney.com/'

/** 全局请求观测（供 quant_data_status 与日志使用） */
export const httpStats = {
  requests: 0,
  attempts: 0,
  failures: 0,
  skippedByCircuit: 0,
  byHost: new Map(),
}

/**
 * 熔断器：P1 实测东财 push2* 家族在密集请求后会**持续**拒绝（0/5 成功），
 * 继续硬重试只会浪费时间并加重封禁。连续失败到阈值后冷却一段时间，期间直接跳过。
 */
const circuit = new Map() // host → { fails, openUntil }
export const CIRCUIT = { threshold: 8, cooldownMs: 120_000 }

function hostOf(url) {
  try { return new URL(url).host } catch { return 'unknown' }
}

function circuitOpen(host) {
  const c = circuit.get(host)
  return c !== undefined && c.openUntil > Date.now()
}

function noteSuccess(host) {
  circuit.set(host, { fails: 0, openUntil: 0 })
}

function noteFailure(host) {
  const c = circuit.get(host) ?? { fails: 0, openUntil: 0 }
  c.fails++
  if (c.fails >= CIRCUIT.threshold) {
    c.openUntil = Date.now() + CIRCUIT.cooldownMs
    c.fails = 0
  }
  circuit.set(host, c)
}

export function circuitState() {
  return Object.fromEntries([...circuit.entries()].map(([h, c]) => [h, { open: c.openUntil > Date.now(), openForMs: Math.max(0, c.openUntil - Date.now()) }]))
}

export function resetCircuits() {
  circuit.clear()
}

function noteHost(url, ok) {
  let host = 'unknown'
  try { host = new URL(url).host } catch { /* noop */ }
  const rec = httpStats.byHost.get(host) ?? { ok: 0, fail: 0 }
  if (ok) rec.ok++
  else rec.fail++
  httpStats.byHost.set(host, rec)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 取 JSON：网络错误或 `validate(json) === false` 都算一次失败并重试。
 * @returns {Promise<{ok: boolean, json?: any, attempts: number, ms: number, error?: string}>}
 */
export async function fetchJson(url, {
  referer = DEFAULT_REFERER,
  tries = 8,
  timeoutMs = 15000,
  validate = undefined,
  baseBackoffMs = 250,
} = {}) {
  const t0 = Date.now()
  let lastError = 'unknown'
  httpStats.requests++
  const host = hostOf(url)

  for (let attempt = 1; attempt <= tries; attempt++) {
    if (circuitOpen(host)) {
      httpStats.skippedByCircuit++
      lastError = 'circuit-open'
      break
    }
    httpStats.attempts++
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: referer }, signal: ctrl.signal })
      const text = await res.text()
      if (!res.ok) {
        lastError = `http ${res.status}`
      } else {
        let json
        try { json = JSON.parse(text) } catch { json = undefined; lastError = 'non-json' }
        if (json !== undefined) {
          if (validate === undefined || validate(json)) {
            noteHost(url, true)
            noteSuccess(host)
            return { ok: true, json, attempts: attempt, ms: Date.now() - t0 }
          }
          lastError = 'content-validation-failed'
        }
      }
    } catch (e) {
      lastError = String(e?.cause?.code ?? e?.message ?? e)
    } finally {
      clearTimeout(timer)
    }
    noteHost(url, false)
    noteFailure(host)
    httpStats.failures++
    if (attempt < tries) await sleep(baseBackoffMs + attempt * 150)
  }
  return { ok: false, attempts: tries, ms: Date.now() - t0, error: lastError }
}

/** 有限并发映射，避免把源站打爆（P0：并发 4–8 已足够，再高吞吐不涨） */
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length)
  let idx = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (idx < items.length) {
      const i = idx++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

export function httpSummary() {
  return {
    requests: httpStats.requests,
    attempts: httpStats.attempts,
    failures: httpStats.failures,
    skippedByCircuit: httpStats.skippedByCircuit,
    circuit: circuitState(),
    byHost: Object.fromEntries([...httpStats.byHost.entries()].map(([h, v]) => [h, { ...v, successRate: +(v.ok / (v.ok + v.fail || 1)).toFixed(3) }])),
  }
}

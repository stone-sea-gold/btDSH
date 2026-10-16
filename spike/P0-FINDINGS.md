# P0 可行性 spike — 实测结论（FINDINGS）

> 日期：2026-09-23 · 执行环境：Node v24.19.0 / SQLite 3.53.3 / DSH 0.1.5-rc.1
> 脚本与原始输出：`spike/*.mjs`、`spike/out/*.json`
> **四个门：G1 通过（含 3 处设计修正）· G2 通过（含限速结论）· G3 通过 · G4 通过**

---

## G1 数据可得性

### 1.1 行情（日线）— 主机回退是必需的，不是优化

| 源 | 路径 | 单次成功率 | p50 延迟 | 备注 |
|---|---|---|---|---|
| `push2his.eastmoney.com/api/qt/stock/kline/get` | 日线全历史 | **91.7%**（11/12） | 115 ms | 单次返回全历史（`dktotal` 给出总根数） |
| `push2.eastmoney.com/api/qt/stock/kline/get` | — | **0%** | — | **HTTP 200 但 `data` 为空**：该主机不提供 kline |
| `web.ifzq.gtimg.cn/appstock/app/fqkline/get`（腾讯） | 日线 | 91.7% | 177 ms | **单次区间有上限**（≤2 年 / count≤800），必须分段；`day`/`qfqday`/`hfqday` 三套序列 |
| `q.stock.sohu.com/hisHq`（搜狐） | 日线 | 91.7% | 116 ms | 可作二级兜底 |
| `hq.sinajs.cn`（新浪） | 实时 | 403 | — | 需正确 Referer，本轮未深挖 |
| `api.money.126.net`（网易） | 实时 | 连接失败 | — | 放弃 |

**教训（写进代码规范）**：只看 HTTP 状态码会误判——`push2` 对 kline 返回 200 + 空数据。
适配层必须**校验内容**（`data.klines` 非空）才算成功。

**失败形态**：全部为连接级 `UND_ERR_SOCKET` / `ECONNRESET`（`curl -4`/`-6` 同样 000），**不是 429**。
东财 DNS 轮询到多个边缘节点，部分节点直接 RST；同一主机在不同时刻成功率会漂移。
**结论：必须"主机级重试 + 跨厂商回退"，目标有效成功率 ≥99.9%。**

### 1.2 全域 / ST / 退市

- 全市场代码表：`push2.eastmoney.com/api/qt/clist/get`，`fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048`
  → `total` 5919（含退市整理）；去掉尾部板块得 5561；`f13` 给出市场号，可直接拼 `secid`。
- **ST/退市可用名称识别**：样本中命中 `*ST美丽 / ST星源 / 国华退 / 新都退` 等 → `ST` 过滤可实现。
- **退市股历史可取**：`600001`（2009 年退市）取到 **390 根**（2008–2009）→ **幸存者偏差可消除**。
  另有退市板块 `fs=m:0+s:3`，`total` 304。

### 1.3 基本面（批量 + PIT）

`datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD`（业绩报表）：

- 按报告期一次拿全市场：`pages: 24 × 500`（≈1.17 万条）
- **`NOTICE_DATE` 覆盖率 100%**，FY2024 的公告日区间 `2025-02-12 ~ 2025-12-31` → **PIT 对齐可用**
- 字段：`BASIC_EPS / WEIGHTAVG_ROE / YSTZ / SJLTZ / BPS / XSMLL / TOTAL_OPERATE_INCOME`
- 延迟 ~700–1000 ms，**稳定性明显优于 push2 系**（本轮从未失败）

### 1.4 分红送转（复权因子链的正确来源）

`RPT_SHAREBONUS_DET`：`pages 1226 / count 3676`（按报告期）
字段含 **`EX_DIVIDEND_DATE`（除权日）、`EQUITY_RECORD_DATE`、`PRETAX_BONUS_RMB`（每股税前现金）、`BONUS_RATIO`（送股）、`IT_RATIO`（转增）、`ASSIGN_PROGRESS`（实施分配）、`TOTAL_SHARES`**
→ 可据此**自行推导复权因子链**（AIFUND5 的做法），并与官方涨跌幅对账。

### 1.5 ⚠️ 设计修正一：厂商的"前复权 ÷ 不复权"不是复权因子链

实测（4 只股票 × 2020–2024 × 1212 根）：

| 比值 | 跳变数 | 单调 |
|---|---|---|
| 腾讯 `hfqday ÷ day` | 1204 / 1212 | ✗ |
| 腾讯 `qfqday ÷ day` | 1204 / 1212 | ✗ |

**结论**：不能靠"两次请求相除"得到因子链（厂商对各字段的复权处理与舍入不一致，且 qfq 本身随时间重算）。
**采用方案**：
1. **存不复权原始价**（执行真实性：涨跌停/停牌/价格）；
2. **存后复权收盘价或由分红事件推导的因子**（收益连续性）；
3. 因子链**由 `RPT_SHAREBONUS_DET` 事件推导**，并用官方 `涨跌幅` 字段做回归对账。

---

## G2 限速与并发

| 并发 | 请求数 | 原始成功率 | 吞吐 |
|---|---|---|---|
| 4 | 32 | 81.3% | 10.1 req/s |
| 8 | 32 | 81.3% | 20.3 req/s |
| 16 | 32 | 81.3% | 22.5 req/s |

- 上述"失败"含**真实无数据**的样本（样本里混有退市/停牌代码），故按源统计更准：**各源单次约 92%**。
- **未观测到 429/限流页**；失败一律是连接级 RST，且**提高并发不改善成功率**（8→16 吞吐仅 +11%）。
- **默认策略**：并发 4–8、每请求 3 次重试（退避 250/500/1000 ms）、主机与厂商双回退、失败计入 `sync_state` 下轮重试。
- 首次全市场拉取（约 5400 只）：按 4–8 并发 ≈ **4–8 分钟**（与预估一致），必须走"预估 + 审批 + 后台分批"。

---

## G3 全市场规模性能（**PASS**）

最终设计：`bars`（不复权）+ `adj_events`（事件表）+ `factor_panel`（**top-N + 预计算 rank**）。

| 步骤 | v1（逐日因子表 + 查询时排名） | v2（事件表 + 物化排名，全量面板） | **v3（+ top-N=500）** | 门 |
|---|---|---|---|---|
| 写入 864 万根 bar | 20.6 s | 同 | 同 | ✓ |
| 复权因子存储 | 864 万行 / 37.5 s | 5.67 万行 / 98 ms | 同 | ✓ |
| 建索引（bars date,code） | 12.8 s | 13.3–40.5 s | 40.5 s（受并发 I/O 影响） | — |
| **物化（含 rank）** | 16.3 s（无 rank） | 68.5 s / 853 万行 | **36.9 s / 79 万行** | ✓ ≤60 s |
| **物化后回测 Top50** | 19.1 s | 1.43 s | **0.47 s** | ✓ ≤2 s |
| 10 组 top_k 扫描 | — | 18.5 s | **6.7 s**（0.67 s/组） | ✓ |
| 实时算对照 | 59.3 s | 54.1 s | 56.4 s（**121×**） | ✓ |
| 库体积 | 1706 MB | 1158 MB | **801.9 MB** | ✓ ≤1536 MB |
| 峰值 RSS | 971 MB | 770 MB | 770 MB | ✓ ≤1536 MB |

**两条设计修正（都是本次 spike 发现的）**：
1. **面板必须连 rank 一起物化**，且只需物化到最大 `top_k` 深度（默认 500）——回测阶段只剩 `WHERE rank<=k` 的过滤。
2. **复权因子必须是事件表**（每股票每年 1–2 行），而非逐日一行：全市场 5.67 万行 vs 864 万行。

**SQLite 运行参数必须显式设置**（默认值不可用）：
```
PRAGMA journal_mode=WAL; synchronous=NORMAL; cache_size=-262144;
PRAGMA temp_store=memory; mmap_size=268435456;
```
> 实测：`temp_store` 未显式设置时，全市场规模会尝试溢写到临时文件；在受限环境下直接 `unable to open database file`。

**已知的性能取舍**：`top-N=500` 意味着面板不含全市场完整截面，因此 v1 不做 IC/IR 与分层回测（与既定范围一致）。若将来要研究套件，需另建全量面板表。

---

## G4 安装 / 组成 / 卸载（**PASS**）

用最小骨架 `spike/plugin-skeleton/`（`dsh.bundle` + `dsh.client` + 包内 preset）实测：

| 步骤 | 结果 |
|---|---|
| `dsh plugin --profile qspike add <本地路径>` | ✅ 初始化 profile、pnpm 链接、**自动 reconcile** |
| `dsh.profile.bundles` | ✅ 变为 `["@deepseek-ai/dsh-base", "@dsh-spike/quant-skeleton"]` |
| `dsh --profile qspike --dump-config` | ✅ 组成树出现独立段 `# == @dsh-spike/quant-skeleton` |
| `dsh plugin --profile qspike remove <包>` | ✅ 依赖移除、**bundles 自动恢复为 `[dsh-base]`**、组成树 0 处残留 |
| preset 物化（伪 ctx 直接调 apply） | ✅ 物化到 `$DSH_HOME/.agent-presets/<id>/`、元数据写入、**幂等**、清理只删自己目录 |
| 工具注册（宿主半） | ✅ `quant_skeleton_ping` 注册成功 |

### ⚠️ 设计修正二：patch 文件的插入语义

- `- id: <已有行>` = **覆盖**该行整个 config；**行不存在直接报错** `patch: entry "x" not found`
- **插入新行必须写成 `- insert:` 块**（`dsh-base` 自身即用此形式）

```yaml
# 正确（第三方插件的唯一合法形态）
- insert:
    - id: quant-skeleton
      name: '@dsh-spike/quant-skeleton'
      config: { ... }
```

**这反而是好消息**：patch 机制天然让第三方插件"只能新增、不能改共享行"，与我们定的保守礼仪完全一致，不需要额外自律。

### 客户端半的真实契约（**格式已确认，浏览器渲染待验证**）

客户端产物**不是普通 ESM**，而是 ModuleLoader 包装的 CJS 工厂：

```js
window.__ModuleLoader__.load({
  id: '@scope/pkg',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports
    const React = require('react')
    const inject = ['slots']
    function apply(ctx) { /* ctx.slots.inject / register */ }
    exports.apply = apply; exports.inject = inject
    return module.exports
  },
})
```

- 裸 `require` 由客户端模块系统解析（`react` 等由内核提供）。
- **结论：可以手写，不依赖 DSH 单体仓库的构建管线**；需要 JSX/图表库时自己加一步 esbuild 产出该格式即可。
- **残余风险**：本轮未启动 DSH 实例，**浏览器端实际渲染尚未验证**（为避免与用户当前 3080 GUI 冲突）。P1 应在隔离实例（独立 `DSH_HOME` + 独立端口）上补验。

---

## 对设计文档的修正清单

| 文档位置 | 修正 |
|---|---|
| ARCHITECTURE §1.2/§1.4 | patch 插入必须用 `- insert:`；`- id:` 是覆盖语义 |
| ARCHITECTURE §3.1 | 日线主源为 `push2his`（`push2` 不提供 kline）；腾讯/搜狐为一等回退；成功判定必须校验内容 |
| ARCHITECTURE §3.2 | 复权因子链改由 `RPT_SHAREBONUS_DET` 事件推导；**禁止**用厂商 qfq/raw 比值 |
| ARCHITECTURE §4 | `adj_events` 事件表；`factor_panel` 为 top-N + 预计算 rank；显式 PRAGMA |
| ARCHITECTURE §6.4 | 客户端半为 ModuleLoader 格式（可手写） |
| PLAN §P1/P2 | P1 增加分红事件推导与对账；P2 面板按 top-N 物化 |
| PLAN 风险表 | "东财限流"从推测升级为**已实测**：连接级 RST、非 429、需主机级回退 |

## 遗留待办（进入 P1 前）

1. **浏览器端渲染验证**（隔离实例上）。
2. 复权因子链的**公式实现与对账**：用分红事件推导 + 官方涨跌幅回归（P1 第一件事）。
3. 交易日历来源：由指数日线推导（本轮未单独验证，风险低）。
4. `top-N` 默认值的最终确定（当前 500；取决于用户典型 `top_k`）。

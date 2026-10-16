# dsh-quant — 架构设计（ARCHITECTURE）

> 一个 npm 包，把本地 DSH 一键转化为 A 股量化助手。
> 本文是实现依据；阶段、验收标准与风险见 [PLAN.md](./PLAN.md)。

## 0. 一句话

**纯 Node（无 Python、无原生依赖、无外部服务）的自包含 DSH 插件包**：装完后新建会话里出现「量化助手」preset，具备因子检索、策略构建、可交易级回测、选股、仓位检查、止损、参数优化、行情财务与数据仓库能力；新闻/研报/资金流等抓取类能力以 skill + `web_fetch` 形式交付，不做成工具。

## 1. 交付形态与生命周期

### 1.1 安装

```bash
dsh plugin --profile web add <包名>
```

`dsh plugin` 是 pnpm 转发器（`lib/plugin-*.js`）：在 `~/.dsh/profiles/web/` 执行 pnpm，然后**按已安装状态 reconcile `dsh.profile.bundles`** —— 任何声明了 `dsh.bundle.patch` 的依赖被追加进插件层栈，卸载时自动退出。用户无需编辑任何配置文件。

### 1.2 组成顺序（决定了"我们能不能覆盖用户"）

```
package.json 的每个 bundle patch  →  profile 的 cordis.patch.yml  →  --patch 覆盖层
                                  ↑ 我们的 patch 在这里            ↑ 用户永远最后生效
```

- 用户写的行覆盖我们；用户没写过的行，我们写什么就是什么 —— 这是风险源，见 §1.4。
- **patch 行语义（P0 实测）**：
  - `- id: <已有行>` = **覆盖**该行整个 config；行不存在会直接报错 `patch: entry "x" not found`。
  - **插入新行必须写成 `- insert:` 块**（`dsh-base` 自身即用此形式）。
  - 即：第三方插件天然**只能新增、不能改共享行**，与 §1.4 的礼仪要求自动一致。

### 1.3 preset 的投递

`agent-presets` 服务的 `roots` **只**来自行 config（settings 覆盖不了），所以两条路：

| 路线 | 做法 | 代价 |
|---|---|---|
| **采用：物化用户根** | 首次激活时把包内 `presets/quant/` 写到 `$DSH_HOME/.agent-presets/quant/`（默认被扫描） | 卸载后留失效目录 → 必须提供"卸载并清理" |
| 否决：patch 共享行 | patch `agent-presets` 的 `roots` 加一个指向包内的根 | 与另一个 patch 同一行的插件**互斥**；DSH 给该行加新 key 时会漂移 |

物化时写入 `.installed-by-dsh-quant.json` 元数据（包名 + 版本 + 安装时间），设置页据此提供「卸载并清理」，并且**只在元数据匹配时才删除目录**，绝不动用户的其它 preset。

### 1.4 好公民规则（硬性）

1. **只 insert 自己的行 id**：`quant-store` / `quant-tools` / `quant-jobs` / `quant-ui`（+ client 行），且必须写在 `- insert:` 块里。任何共享行（`agent-presets`、`tools`、`webserver`、`agent-loop`…）一律不 patch。
2. **工具名统一 `quant_` 前缀**：工具名是全局 key，避免与 DSH 内置或其它插件撞名。
3. **HTTP 路由用专属前缀** `/quant-api/*`，`kind: 'prefix'`；**绝不注册 `registerFallback`**（只有一个座位，已被 SPA 占用）；`(kind, path)` 重复会抛，故前缀必须独有。
4. **本地数据带 schema 版本**，启动时校验并迁移；迁移失败不阻塞启动，只降级为只读并提示。
5. **卸载默认保留数据**（用户资产），清理是显式二次确认的动作。

## 2. 运行环境

| 项 | 要求 | 依据 |
|---|---|---|
| Node | **≥ 22** | 与 DSH 对齐；DSH 自身使用 `node:sqlite`（`dsh-session-query-sqlite`）并注明"推迟 import 以让 Node 22 启动保持安静" |
| 存储 | `node:sqlite`（内置） | 已实测 `DatabaseSync`/`StatementSync` 可用；SQLite 3.53.3 |
| HTTP | 全局 `fetch` | 已实测可用 |
| 原生依赖 | **零** | 保证跨平台安装不失败 |
| 外部服务 | **零** | 无需用户自备后端 |

## 3. 数据层

### 3.1 数据源（全部 keyless HTTP，已实测）

| 用途 | 端点 | 实测（P0） |
|---|---|---|
| **日线（主源）** | `push2his.eastmoney.com/api/qt/stock/kline/get`（`klt`、`fqt`） | **单次成功率 91.7%**、p50 115ms；一次返回全历史；含 OHLCV + 振幅 + **官方涨跌幅（不复权口径）** + 换手率 |
| **日线（原始价回退，P1 新增）** | `money.finance.sina.com.cn/.../CN_MarketData.getKLineData`（新浪） | **与 BaoStock `adjustflag=3` 逐位一致**（600519 1474.500/1460.010 等）；单次 2500 根；`volume` 单位是**股**；无 amount/pct |
| 日线（复权序列） | 腾讯 `fqkline`（`day`=前复权、`hfqday`）/ 东财 `fqt=1,2` | ⚠️ **仅可用于仲裁，不可作为因子来源**（比值非分段常数，抖动 ±0.05%~1.6%） |
| 日线（回退 2） | `q.stock.sohu.com/hisHq`（搜狐） | 前复权；可作二级兜底 |
| 实时行情 | `push2.eastmoney.com/api/qt/stock/get` | 可用 |
| 列表/板块/成分/排序 | `push2.eastmoney.com/api/qt/clist/get`（`fs`、`fid`） | 全市场 `total` 5561–5919；`f13` 给市场号可拼 `secid`；ST/退市可按名称识别 |
| **基本面（按报告期）** | `datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD` | 24 页 × 500 ≈ 1.17 万条；**`NOTICE_DATE` 覆盖 100%**；EPS/ROE/YSTZ/SJLTZ/BPS/XSMLL 齐全；稳定性优于 push2 系 |
| **分红送转（复权因子来源）** | 同上 `reportName=RPT_SHAREBONUS_DET` | 含 `EX_DIVIDEND_DATE` / `EQUITY_RECORD_DATE` / `PRETAX_BONUS_RMB` / `BONUS_RATIO` / `IT_RATIO` / `ASSIGN_PROGRESS` → **可自行推导因子链** |
| 退市股历史 | 主源 kline（按 `secid`） | `600001`（2009 退市）取到 **390 根**（2008–2009）→ **可消除幸存者偏差** |

> ⚠️ **成功判定必须校验内容，不能看状态码**：`push2.eastmoney.com` 对 kline 路径返回 **HTTP 200 + 空 `data`**（该主机不提供 kline）。失败形态是连接级 `UND_ERR_SOCKET`/`ECONNRESET`（`curl -4/-6` 亦 000），**不是 429**；东财 DNS 轮询到多个边缘节点，部分节点直接 RST。
> **适配层要求**：内容校验 → 主机级重试（3 次，退避 250/500/1000ms）→ 跨厂商回退；并发默认 4–8。

### 3.2 口径（对齐 AIFUND5 的纪律）

- **只存不复权原始价** + **独立复权因子表**。前复权价每次分红都重算全历史 → 回测不可复现；不复权价是各源一致的客观事实。
- ⚠️ **禁止用"厂商前复权 ÷ 不复权"推导因子链**（P0/P1 实测：东财 qfq/hfq 非除权日抖动 ±0.5%，腾讯 ±0.05%~1.6%，比值本应分段常数）。
- **因子链由复权事件推导（P1 定稿）**：
  1. 事件源 = **腾讯 K 线内嵌元数据 ∪ 东财分红表**（东财会漏记同日多笔分配：300750 2024-04-30 只记 2.011，漏 3.017）；
  2. 合并规则：同日两源取值**相同** → 同一笔取其一；**不同** → 两笔相加；
  3. 参考价 `ref = round((前收 − Σ每股现金) / (1 + Σ送股 + Σ转增), 2)`，**四舍五入到分**；
  4. 同日歧义时用 **hfq 当日隐含跳变**在 `{em, tx, sum}` 中仲裁（3/3 案例与交易所参考价一致）；
  5. 校验：`spike/oracle-baostock.py` 用 BaoStock 官方 `pctChg` 独立比对（健康三源下 12/15 只 ≤0.005pp）。
- ⚠️ **东财 `pct` 是不复权口径**（P1 实测 4 例精确吻合，含 10 转 4.8 的 -31.88%），只能校验原始价序列，**不能**校验复权收益。
- `volume` 一律按 **股**、`amount` 按 **元**；入库前归一（源站单位不一致且静默）。
- **涨跌幅用复权口径计算**，并与同响应中的官方 `涨跌幅` 字段对账（回归测试的基线，见 §8）。
- **PIT 基本面**：以 `NOTICE_DATE` 为生效时点，绝不用 `REPORTDATE` 直接当可得时点。
- **停牌**：当日无成交（`volume=0`）或 K 线缺失 → 标记不可成交，回测中持仓按最后收盘价估值、不可买入/卖出。
- **涨跌停**：由前收盘价 × 板块涨跌幅上限（主板 10%、创业板/科创板 20%、ST 5%）判定；涨停不可买、跌停不可卖。
- **上市/退市**：以 K 线首末交易日为准构建**逐日可交易股票池**；ST 状态按名称前缀与 `f14` 字段维护（历史区间后期可迭代为逐日快照）。

### 3.3 增量同步

- 每只股票记录 `bars_last`；同步只拉缺失区间；单只失败不中断整轮，只记入 `sync_state` 下轮重试。
- **两种增量语义要分清**：
  - **断点续传**（`resume`）：跳过"已经覆盖到 `to`"的股票，用于**一次性大批量**中断后继续；
  - **每日增量**（`incremental: {overlapDays}`，P5）：起点**按股票各自算**
    （`bars_last − overlapDays`），用于"每天补 1 个交易日"。
    两者必须分开：每天自动跑一次时若所有股票共用一个 10 年区间，就等于每天全量重拉。
- **全市场首次拉取 = 预估 → 审批 → 后台分批**：工具先返回预估（只数 × 预计耗时 × 预计请求数），
  经审批后执行，带断点续传、可中断、限速可配；完成后写入「数据截至」。
- 交易日历：**从本地行情里推导**（实际发生过交易的日期），比任何外部日历表都可靠。
- 盘后定时增量同步见 §6.5。

## 4. 存储设计

单库 `node:sqlite`（路径可配，默认 `$DSH_HOME/quant/quant.db`；**惰性打开**，
第一次真正用到数据时才建库）。当前 `SCHEMA_VERSION = 4`。

```sql
codes(code PK, name, market, board, list_date, delist_date, is_st, updated_at)
bars(code, date, open, high, low, close, volume, amount, PRIMARY KEY(code,date))   -- 原始价
adj_events(code, date, factor, PRIMARY KEY(code,date))                              -- 复权因子（事件表：仅除权日一行）
fundamentals(code, report_date, notice_date, eps, bps, roe, revenue_ttm,
             net_profit_ttm, equity, total_assets, cost_ttm, total_share, PRIMARY KEY(code,report_date))
factor_panel(factor_id, date, rank, code, value, PRIMARY KEY(factor_id,date,rank))  -- top-N + 预计算排名
strategies(id PK, name, config_json, version, parent_id, session_id, turn_seq,
           agent_summary, created_at)
strategy_tags(strategy_id, tag)
backtests(id PK, strategy_id, params_json, metrics_json, curve_json, created_at)
factors(id PK, name, category, formula, params_json, is_builtin, source,
        tokens, created_at)                                                        -- tokens = 中文 bigram
factor_search(factors)  -- FTS5 虚表（unicode61，tokens 列存 bigram）
strategy_search(strategies)
sync_state(code PK, last_date, status, error, updated_at)
meta(key PK, value)  -- schema_version、autosync（自动同步的配置 + 运行态 + 授权记录）、factor:<id>
```

**为什么自动同步的状态放在 `meta` 而不是新开一张表**：它是进程重启后**唯一的记忆**
（`nextDueAt`），而 `meta` 已经是 schema 版本号的落点，语义一致（少量、点查、无需索引）。
也正因为它在 `meta` 里，`quant_data_cleanup {scope:'all'}` 清行情时**不会**顺手抹掉
"用户曾经同意每天自动同步"这件事 —— 那是一次授权的撤销，不该由清理动作代劳。

索引：`bars(date, code)`、`adj_events(code, date)`、`fundamentals(code, notice_date)`；`factor_panel` 以 `(factor_id, date, rank)` 为主键聚簇，回测按 `rank<=k` 直接走主键区间扫描。

### 4.1 检索：中文 bigram + FTS5

**已实测的坑**：`fts5(tokenize='trigram')` 对**两字中文查询直接返回空**（trigram 需 ≥3 字符）。

**采用方案**：把名称 + 描述 + 标签**自己切成 bigram** 灌进 `unicode61` FTS5 的 `tokens` 列，查询同样切 bigram 并用 `OR` 连接，`bm25()` 排序，再叠分类/标签/区间结构化过滤。

已实测："动量 / 价值 / 防守 / 反转 / 动量反转" 全部命中且排序合理。零依赖、离线、确定性、可解释。

**不引入 embedding**：DSH 的 `llm` 服务没有 embedding 接口（只有 `stream`/`listModels`/`pricing`），网关多半也没有 `/embeddings`；引入本地模型违背"零额外运行时"。

### 4.2 因子面板（性能架构的核心）

**实测依据（P0，磁盘库 + WAL + 全市场规模 5400×1600 = 864 万根 bar）**：

| 方案 | 复权因子存储 | 物化耗时 | 物化后回测 Top50 | 10 组 top_k 扫描 | 库体积 | 峰值 RSS |
|---|---|---|---|---|---|---|
| v1 逐日因子表 + 查询时排名 | 864 万行 / 37.5 s | 16.3 s（无 rank） | 19.1 s | — | 1706 MB | 971 MB |
| v2 事件表 + 物化排名（全量面板） | 5.67 万行 / 98 ms | 68.5 s | 1.43 s | 18.5 s | 1158 MB | 770 MB |
| **v3 事件表 + 物化排名 + top-N(500)** | **5.67 万行 / 98 ms** | **36.9 s** | **0.47 s** | **6.7 s** | **802 MB** | **770 MB** |
| 对照：完全不物化、每次实时算 | — | — | 56.4 s（**121×**） | 不可用 | — | — |

**采用方案（v3 形态）：按需物化 top-N + LRU 淘汰**
- 面板存 **top-N（默认 500）** 的 `(date, rank, code, value)`，**rank 在物化时算好**（`row_number()`，不能用 `rank()`——并列会撞主键）。
- 只物化"被保存策略引用过"的因子（典型 3–10 个）；单因子 79 万行、约 37 s、约 100 MB。
- 回测 = `WHERE factor_id=? AND rank<=k AND date BETWEEN ?` + join bars → **0.5 s**；参数扫描 **0.67 s/组**。
- 增量同步后只补新交易日；公式改动按 `factor_id + formula_hash` 失效重算；超上限按 LRU 淘汰。
- **取舍**：top-N 面板不含全市场完整截面，故 v1 不做 IC/IR 与分层回测（与既定范围一致）。

**SQLite 运行参数**（必须在连接上显式设置，不能依赖默认）：
```
temp_store = memory      -- 只读沙箱/受限环境下的溢写会直接失败（已实测：unable to open database file）
cache_size = 大值         -- 默认 2MB 太小，会频繁溢写
journal_mode = WAL       -- 常规安装下提升并发读
```

## 5. 因子 DSL

### 5.1 语法面（由 AIFUND5 的 109 个因子实测反推）

**16 个函数**：`Ref(46) Mean(28) Max(14) Std(11) Min(8) Corr(5) Slope(4) Ret(3) Rsquare(3) IdxMax(3) IdxMin(3) Abs(3) Quantile(2) Rank(2) Resi(2) Log(1)`
**15 个字段**：`close open high low volume turnover_rate` + `eps beps revenue_ttm net_profit_ttm equity total_assets cost_ttm total_market_value total_share`
**分类**：technical 52 / momentum 25 / volatility 13 / liquidity 11 / value 3 / quality 3 / size 1 / growth 1（共 109，全部有 formula；其中 9 个依赖基本面）

语法与 AIFUND5 几乎同构，可直接兼容 `$close / Ref($close, 20) - 1` 这类写法 → **109 个因子逐条翻译即可**，无需重写。

### 5.2 安全模型（本插件唯一的 LLM→执行器通道）

- 词法/语法分析 → **AST** → 白名单校验 → **分层编译为 SQL**。
- 字段白名单（18 个）、函数白名单（16 个）、窗口长度必须为 **1..250 的整数字面量**。
- 拒绝：未知标识符、未知函数、参数个数不符、窗口越界或非字面量、任何非表达式字符（分号/子查询/写操作）。
- 因子对用户可读、可审计、可 diff。
- 校验失败 → 返回结构化错误给模型重试，**不落库、不执行**。

### 5.3 实现现状（P2 已落地 `lib/factors/dsl.mjs`）

- **分层编译是必需的**：SQLite 不允许窗口函数直接嵌套（`avg(lag(x,1) over w) over w` 非法），
  而真实因子大量嵌套。编译器为每个需要物化的子表达式新增一层 CTE（实测 `rsi_like_6` 需 2 层）。
- **窗口子句必须带括号**（`OVER (PARTITION BY … )`）：嵌在大表达式里时，不带括号会让
  `ORDER BY date - 1` 被解析成排序表达式（实测踩过，报 `near "BY"`）。
- 支持比较运算符（`Ref($close,1) < $close` 在真实因子中存在；SQLite 布尔表达式即 0/1）。
- 语义约定：`Max(x, n)` 为滚动窗口（n 为 1..250 整数）；`Max(x, 0)` 为**逐元素**重载
  （AIFUND5 公式集里两种语义都存在）；`Std` 用**样本标准差**（ddof=1，与 pandas 默认一致）。
- **实测覆盖率**：109 个内置因子 **109 个可编译（100%）、0 报错、0 不支持**。
- **执行正确性（跨实现对照）**：`spike/oracle-factors.py` 直接调用 **qlib 自带的 Cython 实现**
  （`qlib/data/_libs/rolling.pyx` 的 `rolling_slope/rsquare/resi`）与 pandas 的
  `rolling.rank/quantile/apply(argmax)` 生成真值，`spike/verify-factors.mjs` 与 SQL 产物逐点比对：
  **3 只股票 × 17 条因子 = 106,263 个非空点，0 不一致**；
  `IdxMax / IdxMin / Rank / Quantile` 逐位相等，回归类最大归一化偏差 `4.9e-9`。
  另有可手算单测 `tests/factors.test.mjs`（线性序列斜率/残差、并列名次、预热窗口、NULL 保护）。
- 安全边界用例 6/6 全部拒绝（未知字段/未知函数/窗口越界/窗口非字面量/注入/参数个数）。

#### 5.3.1 七个"难函数"的实现路线

| 函数 | 路线 | 关键点 |
|---|---|---|
| `Quantile(x,n,q)` | 内置窗口聚合 `percentile_cont(x,q) OVER (...)` | pandas `rolling.quantile` 默认线性插值 = 连续型分位，口径天然一致；q 必须是 0..1 字面量 |
| `Slope/Rsquare/Resi` | 纯窗口求和（多 2 层 CTE） | 用全局行号 `__idx` 把 `Σ i·yᵢ` 化为 `W − (t − (N−1)/2)·S`；`slope = (W − (t−(N−1)/2)S)·12/(N(N²−1))` |
| `IdxMax/IdxMin` | 自定义滑动聚合 `q_idxmax/q_idxmin`（单调队列） | 返回**最左极值的绝对行号**，SQL 侧换算为"距最老行第几位"（qlib 的 `argmax+1`） |
| `Rank(x,n)` | 自定义滑动聚合 `q_rank`（有序数组 + 二分） | pandas 平均名次口径：`(count(<v)+count(≤v)+1)/2 / count`；用"行号最大者"认定当前行，不依赖 step/inverse 调用次序 |

- **为什么不用相关子查询**：`Rank/IdxMax/IdxMin` 需要"把窗口内的值与**当前行**的值比较"，
  纯 SQL 无法表达（窗口函数参数按框架行求值），只能 O(行数×窗口) 硬算；
  全市场 864 万行 × 60 窗口 ≈ 5 亿次探测，会直接毁掉 P0 的性能预算。
- `node:sqlite` 的 `db.aggregate()` 提供 `step` + `inverse` 后就是**真正的滑动窗口聚合**
  （离开的行调 inverse、进入的行调 step、`result` 只做 O(log N)/O(1) 查询），
  实测生命周期：每分区一次 `start`，之后每行 `inverse*` → `step` → `result`。
- **诚实降级**：`Slope/Rsquare/Resi` 在窗口内出现 NULL 时返回 NULL 而不是给错值——
  qlib 的位置语义按**非空值计龄**，含 NULL 时 x 位置不连续，公式不再等价。
- **性能优化**：编译器额外产出 `lookback = Σ(nᵢ−1)`（保守上界）。
  临时选股据此把源数据裁到**每只股票最后 lookback+1 行**，窗口层只处理 ~K×股票数 行而非全历史。

#### 5.3.2 全市场规模实测（`spike/p2-perf.mjs`，5400 只 × 1600 日 = 864 万行）

| 公式 | 层数 | 物化 | 相对基线 | 备注 |
|---|---|---|---|---|
| `Mean($close,20)` | 0 | 60.6s | 1.00× | 基线（单窗口聚合） |
| `Quantile($close,20,0.8)` | 0 | 53.3s | 0.88× | 内置 `percentile_cont`，不慢于基线 |
| `Corr($close,$volume,20)` | 0 | 61.0s | 1.01× | 既有函数 |
| `IdxMax($high,60)` | 1 | 74.8s | 1.23× | 单调队列聚合 |
| `Slope($close,20)` | 1 | 77.4s | 1.28× | 5 个窗口聚合同遍 |
| `Resi($close,20)` | 1 | 79.9s | 1.32× | 同上 |
| `Rank($close,20)` | 1 | 84.8s | 1.40× | 有序数组 + 二分 |
| `Rsquare($close,20)` | 1 | 103.3s | 1.70× | 最贵（多一个 `Σy²` 聚合） |

- **必须看相对值**：本轮基线自己就测到 60.6s（P0 同数据曾测到 36.9s），
  连既有的 `Corr` 也 61.0s。60s 绝对门限是机器相关的，**相对基线的倍率才是可比口径**。
- **一处实测得到的优化**：最初 `Slope/Rsquare/Resi` 为 `x*x`、`__idx*x` 各开一层 CTE，
  `IdxMax/IdxMin` 也为聚合结果开了一层。**每层 CTE 都是对全表的一次物化**，在 864 万行下这是最贵的部分。
  改为把乘积直接内联进 `sum(...) OVER (...)`、并利用 `NULL − idx + cnt = NULL` 省掉 IdxMax 的那层后：
  `IdxMax(60)` 113.3s → 74.8s（−34%），层数分布 `{0:79,1:12,2:9,3:9}` → `{0:79,1:27,2:3}`，最大深度 3 → 2。

### 5.4 验收门：与外部实现对照（P2 已落地）

**为什么需要**：单测与因子 oracle 证明的是**因子值**正确，抓不到"内部自洽但整体口径偏离"这一类错误。
验收门的产出不是"看起来差不多"，而是**一份差异清单**：每条差异要么对齐口径消除，要么量化归因。
完整报告见 `spike/GATE-FINDINGS.md`。

**三层阶梯**（每层抓不同的东西）：

| 层 | 比什么 | 判定 |
|---|---|---|
| Rung 0 数据口径 | 交易日集合 / 复权口径 / 逐日收益率 | 11/12 只只差一个常数（离散度 ≤4e-7） |
| Rung 1 因子横截面 | qlib 表达式引擎 vs 我的 DSL | 11/12 条语义级残差 2.5e-8~7.8e-8 |
| Rung 3 全账务 | qlib executor vs 我的引擎 | 逐日持仓一致 646/659 = 98.0% |

**Rung 1 的两级分解**（关键设计）：把 **qlib 的价格**喂进**我的算法**（语义级）与把**我的价格**喂进同一算法
（数据级）分开比。这样"因子值不一样"能归到具体一边，而不是笼统地说"两边不一样"。
判据用**过原点最小二乘**拟合每股常数 k 再取归一化残差 —— 直接比 `t/m` 会在因子值穿过 0 时把比值炸到 ±∞，
把"完全一致"误判成巨大偏差（实测踩过）。

**已知精度地板**：qlib 的 bin 是 **float32**（相对精度 ~1e-7）。对近并列值会翻转次序，
使 `Rank/IdxMax` 这类依赖次序的因子差一个位次。因此 1e-6 是这条门实际可用的分辨率下限。

**绕开 AIFUND5 的 BacktestEngine**：该引擎当时硬编码 `Alpha158 + LinearModel`，用户编译出的
`alpha_expression` 从未进入回测（详见 GATE-FINDINGS §4.1）。要对照的是**执行与账务语义**，
而 qlib 的 executor 才是这套语义的定义者，故直接用 `backtest_daily` + `TopkDropoutStrategy`。

**踩过的坑（都已固化进脚本注释）**：
- qlib 的日频 executor **自带一天滞后**，再 shift 信号会双重滞后（持仓永远差一天）
- 信号必须裁到**两边交集股票池**，否则策略会选池外股票却永远成交不了（静默不交易）
- `pd.Timestamp(20240102)` 把整数当**纳秒**解析成 1970 年 → 信号取不到，静默不交易
- qlib 的 `report['return']` **不含费用**，其 risk 统计是毛收益口径；account 变化 = `return − cost`

#### 5.3.3 内存：`temp_store` 的取舍（实测）

窗口函数/排序的临时 b-tree 由 `temp_store` 决定落点，这是全市场重因子 RSS 的主要来源：

| `temp_store` | 耗时 | 峰值 RSS |
|---|---|---|
| `memory`（默认） | 193.6s | 1622MB |
| `file` | 228.4s | **560MB（−65%）** |

- `file` **必须有可写的临时目录**，否则 SQLite 直接报 `unable to open database file`
  （受限环境里系统 `/tmp` 常常不可写——这正是 PRAGMA 里默认用 `memory` 的原因）。
- 因此 `openStore(path, { tempStore })` 在 `file` 模式下会自己在仓库同级建 `.sqlite-tmp/` 并设置 `SQLITE_TMPDIR`；
  建不出来就安全退回内存模式。低内存机器/容器可用 `DSH_QUANT_TEMP_STORE=file` 全局切换。
- 连续物化多个全市场重因子时 RSS 会累积（实测 8 个因子后 2.7GB）→ 面板 LRU（`evictPanels`）
  与 `tempStore=file` 是两条互补的缓解手段。

## 6. 能力面：工具 vs 技能

**实测**：DSH 的 `web_fetch` 可以直接打金融 JSON 接口（已验证拉通东财"银行板块按涨幅排序"）。因此抓取类能力**不做工具**，改为技能。

### 6.1 工具（31 个，统一 `quant_` 前缀）

| 域 | 工具 |
|---|---|
| 因子（4） | `quant_factor_list` `quant_factor_search` `quant_factor_preview` `quant_factor_create` |
| 策略（6） | `quant_strategy_compose` `quant_strategy_save` `quant_strategy_load` `quant_strategy_list` `quant_strategy_search` `quant_strategy_versions`（含 compare） |
| 回测（3） | `quant_backtest_run`（止损作为参数） `quant_backtest_analyze` `quant_backtest_get` |
| 选股（1） | `quant_select_stocks` |
| 仓位（3） | `quant_save_holdings` `quant_portfolio_status` `quant_save_position_rules` |
| 优化（1） | `quant_optimize_parameters`（网格 + 随机） |
| 日历（2） | `quant_trading_calendar` `quant_resolve_date` |
| 行情财务（6） | `quant_quote` `quant_kline_history` `quant_financial_summary` `quant_quarterly_financials` `quant_industry_stocks` `quant_index_constituents` |
| 仓库（3） | `quant_data_status`（覆盖 / 新鲜度 / 自动同步） `quant_data_sync`（预估+审批+断点） `quant_data_cleanup` |
| **自动同步（1）** | `quant_autosync`（get / enable / disable / run_now） |
| **导出（1）** | `quant_export`（backtest / select / holdings / panel / data_status） |

**v1 明确不做**：贝叶斯优化、IC/IR 与分层回测等研究套件、新闻/研报/资金流专用工具、PTC 批量编排。

### 6.1.1 工具面的实现契约（P3 实测）

**注册方式**：`ctx.tools.register(definition)` 接受**普通对象**，第三方包不需要 import
DSH 内部模块。definition 形状：

```js
{ name, description, parameters, output: { schema, render }, execute, timeoutMs? }
```

**两个硬约束**（违反直接抛错，已由单测逐个校验全部 31 个工具）：

1. **JSON Schema 只支持子集**：`type / oneOf / properties / required / additionalProperties /
   items / enum / const` + 注解（`description / title / default / examples`）。
   `format`、`minimum`、`pattern` 一律被拒 —— 约束必须写进 description 或运行时校验。
2. **`output.render` 必须存在且是函数**，返回 `[{ type: 'text', text }]`。
   `run_code` 是保留名，不能注册也不能遮蔽。

**统一信封**：所有工具返回 `{ ok, ... }`。可预期的失败（数据缺失、参数不合法）走
`ok:false` + `{code, message, hint?}`；异常由工厂捕获并转成同样的信封。
模型看到的是**稳定形状**，而不是一堆各不相同的异常文本。

**插件 `apply` 必须返回 void（P5 实测，装不上级别的坑）**：

Cordis 把插件 `apply` 的**返回值当成 effect 解释** —— 函数 = disposer、`null` = 无、
可迭代 = 一组 disposer、**其它对象 → 直接抛 `Invalid effect`**。
所以 `lib/index.js` 拆成两半：`apply(ctx, config)` 返回 void（Cordis 契约），
`setup(ctx, config)` 返回诊断报告（测试与运维用）。

为什么这个坑特别值得记下来：**手写假 ctx 直接调 `apply(ctx, config)` 时返回值没人管，
一切正常**；只有走 `ctx.plugin()`（也就是 DSH loader 装载 bundle 行的真实路径）才会炸，
而且是**整个插件装不上**。所以补了 `spike/plugin-real-ctx-smoke.mjs`：
在真实 `Context` + 真实 `TimerService` 里用 `ctx.plugin()` 装载一遍。

**为什么 `quant_strategy_compose` 与 `save` 分开**：compose 是纯函数（可反复试算、不落库），
save 才写盘。这样"用户拒绝保存"是一条真实存在的分支，而不是靠模型自觉。

### 6.1.2 审批护栏（P3 实测）

`tools.guard(fn)` 是**单调否决**：返回字符串即拒绝，且没有任何 guard 能推翻另一个 guard 的拒绝。
插件拿不到交互式确认通道，所以机制是"**拒绝 + 给出明确的复述路径**"，
而不是假装弹窗等确认：

1. 模型调用高风险工具 → 护栏拒绝，说明为什么拒、需要向用户确认什么
2. 模型向用户说明 → 用户同意 → 带 `confirm: true` 重试

**不记住上次批准**：那会让批准脱离具体参数。用户同意的是"这次全市场同步"，
不是"以后任何全市场同步"。护栏每次按**当次参数**判断。

**护栏自身出错时放行** —— 宁可少拦一次，也不能因为护栏 bug 让所有调用失败。

**唯一的例外是"开启自动同步"**（P5）：它拦的不是"这一次很重"，而是
"**以后每天都会发生、而且没人再问**"。自动任务没有弹窗通道，所以同意必须在**配置时**
取得 —— 护栏就是那道必须过的门。见 §6.5。

### 6.1.3 preset 投递与生命周期（P3 实测）

- 包内 preset 物化到 `$DSH_HOME/.agent-presets/<presetId>/`，含 `preset.yml`、
  `agent.cordis.yml`（**注意文件名**：不是 `cordis.yml`）与 `skills/`
- preset 内的技能用 `skill-filesystem` 的 `customSkillDirs` 挂载，
  `baseUrl` 是 preset 自己的目录
- 元数据 `.installed-by-dsh-quant.json` 记录包名与版本：
  **幂等**（版本没变就跳过）、**版本变化触发重写**、**第三方保护**
  （目录存在但元数据不是本包写的 → 绝不触碰，卸载也绝不删除）
- 所有注册通过 `ctx.effect` 归还，停用/升级/卸载都能干净回收

### 6.2 技能（skills）

四个技能随 preset 走（`customSkillDirs` 指向 preset 自己的 `skills/`）：

| 技能 | 内容 |
|---|---|
| `quant-sources` | 财联社快讯 / 东财全球资讯 / 公告 / 研报 / 估值 / 北向 / 资金流 / 龙虎榜 / 解禁 / 融资融券 / 大宗 / 股东户数 / 分红 的**端点速查 + `web_fetch` 用法 + 字段含义**，以及八条数据覆盖边界与复权口径 |
| `quant-workflow` | 标准流程（数据状态 → 因子检索 → 策略确认 → 回测 → 报告）与四条分支：**数据过期/自动同步**、用户拒绝保存、审批护栏拦截、结果导出交付 |
| `quant-discipline` | 禁止编造因子 ID、禁止跳过参数确认、必须披露数据覆盖与局限、风险提示话术、合规边界 |
| `quant-session`（P5） | **会话机制**：`goal`（长任务的判据写法与纪律）、`subagent_fork`（样本外独立复核，必须在看到答案前分叉）、压缩（工具结果在 8KB 处被裁剪，要引用的结论先落盘） |

### 6.3 preset「量化助手」

- 人格 + 工作流纪律 + 工具域 + 技能目录。
- 工作流纪律从 `system.md` 迁移并改写为 DSH 语境（原版"必须确认参数/禁止编造因子 ID"仍然保留）。
- 默认隔离：量化工具只在该 preset 的会话可见；设置页提供「全局生效」开关（注册到全局 `tools` 层）。
- **物化到用户根**（§1.3），随包升级可覆盖自己的目录。

### 6.4 UI（最小可信集）

| 落点 | 内容 |
|---|---|
| `tool.call.toolview` key=`quant_backtest_run` | 回测结果卡：手写 SVG 净值曲线 + 8 项指标 + 基准对比 + 分因子 + **可折叠口径声明** |
| key=`quant_data_status` | 数据状态卡：覆盖/新鲜度（工作日口径）/自动同步状态/面板落后 + 可折叠面板列表 |
| key=`quant_data_sync` | 数据同步卡：完成态（耗时/根数/事件/失败明细）与**审批态**（规模与耗时） |
| key=`quant_select_stocks` | 选股结果卡：候选名单 + 拒绝原因计数 + 免责声明 |
| key=`quant_autosync`（P5） | 自动同步卡：开关、时刻、下次执行、上次结果、**授权记录**、无 timer 时的降级说明 |
| key=`quant_export`（P5） | 导出卡：文件清单 + 字节数 + **落点**（会话工作目录 / 数据目录） |
| `settings.section` | 数据路径、低内存选项、保持数据新鲜、导出交付物、查看/清理指引、免责声明、已知限制 |

不做常驻面板、不做会话视图（v1.1 再评估）。

**客户端产物的真实契约（P0 实测）**：不是普通 ESM，而是 ModuleLoader 包装的 CJS 工厂 ——
`window.__ModuleLoader__.load({ id, factory: (require) => module.exports })`，模块导出 Cordis 插件的 `{ apply, inject }`；裸 `require("react")` 等由客户端模块系统解析。
→ **可以手写，不依赖 DSH 单体仓库的构建管线**；需要 JSX/图表库时自建一步 esbuild 产出该格式。

### 6.4.1 UI 的数据通道（P4 实测，决定了整个客户端的设计）

**客户端没有通用的 host RPC 通道。** `harness.handle` / `host.call` 是**动态 Cordis Package 专有**的
（Package 有宿主可绑定的身份）；bundle 客户端只能拿到 `layout / locale / sessions / slots / theme /
timer / uiWorkspace / workspaces` 这几个服务，没有"调用宿主"这一项。

唯一能把**结构化数据**从宿主送到 UI 的通道是 **`block.meta`**：

```
宿主工具声明 output.presentationMeta(args, value)
  → DSH 挂到 tool/result 事件的 meta（要过 lossless-JSON 快照校验）
  → 客户端 ToolResultNode.meta
  → tool.call.toolview 卡片读 props.block.meta
```

注意 `content` 里**只有渲染后的文本**，没有结构 —— 想画图就必须走 meta。

由此推出的三条设计约束：

1. **卡片是工具结果的纯函数**：不订阅、不轮询、不持有状态、不用 hooks
   （有单测禁止 `useState/useEffect/subscribe/setInterval` 出现在客户端）
2. **加一张卡片 = 宿主侧加 `presentationMeta` + 客户端注册一个 keyed toolview**，没有第三条路
3. **设置页拿不到实时宿主状态**（那需要 RPC）。因此它只给静态信息与操作指引，
   **不编数据** —— 想看状态就在会话里说"看看数据状态"，结果由 `quant_data_status` 的卡片呈现

**`presentationMeta` 的净化是强制的**：一个 `undefined` 就会让 DSH 抛
`output.presentationMeta returned non-lossless JSON`，**整次工具调用失败**。
实测 `quant_data_status` 就踩过这个坑，因此净化放在工具工厂层（`jsonSafe`）而不是各工具自己记得。

### 6.4.2 布局与验证（P4）

- **320px 约束**：卡片根容器 `width:100% + minWidth:0 + boxSizing:border-box`；
  指标块用 `flex: 1 1 72px` 而非固定宽度；SVG 用 `viewBox + width:100%` 自适应。
  有单测遍历渲染树，断言不存在写死的 >320px 宽度
- **验证方式**：真实 React 不在 host 侧（在 web bundle 里），所以用**最小 React shim**
  （`createElement` 产普通对象树 + 遍历时展开函数组件）渲染每张卡片，断言：
  不抛错、关键结构存在（svg / 指标 / 免责声明）、`meta` 缺失或类型不符时返回 `null` 而不是误渲染、
  涨跌配色符合 A 股口径、`navPath` 对常数序列不产生 NaN
- **残余风险（已补验）**：P4 时仍未在真实浏览器里跑过（本机 3080 是用户的实时 GUI，不宜占用）。
  后来用**隔离实例**补上了，见 §6.4.3。

### 6.4.3 真实浏览器验证（隔离实例，P4 补验）

**做法**：起一个独立 `DSH_HOME` + `--port 0` 的实例（不占用用户端口），装一个**只用于验证**的
客户端插件（`spike/out/browser/quant-card-harness`），它 `require('dsh-quant-assistant')` 拿到
真实组件，渲染进 `shell.overlay`，输入是**真调用宿主工具采到的 `presentationMeta`**。
于是拿到真 React + 真主题 CSS + 真布局引擎。断言式脚本 `verify-cards.mjs` 25 条，失败非 0 退出。

**为什么 harness 要绕这一圈**：想直接 `require` 组件可以，但 `react-dom` 拿不到
（React 是平台 seed word，没有可 fetch 的 URL），所以必须让**宿主**渲染；
自己搭 harness 页面则要重新打包 React 且拿不到 DSH 的主题 CSS。

**结果**：320/360/1280px × 16 用例全部无横向溢出；10 个主题令牌全部解析；
A 股配色正确；SVG 曲线与 `<details>` 折叠在真浏览器里都正常；无控制台 error。

**它抓到了 2 个 shim 永远抓不到的缺陷**（都是既不抛错也不告警的那类）：

| 缺陷 | 为什么 shim 抓不到 | 修复 |
|---|---|---|
| `chip('已开启', 'down')` 传字符串而非令牌，`color: down` 是非法 CSS → **静默**回退成继承色 | shim 只遍历元素树，不解析 CSS，`style.color` 里躺着 `'down'` 也看不出问题 | 加 `cssColor()` 解析层（令牌变量与语义名都正确）；加单测断言"已开启"必须带成功色令牌 |
| 同步卡把"规模估算"渲染成"同步中…"（`estimateOnly` 没有 `ms` 字段，卡片却拿 `ms === null` 当"运行中"） | shim 能渲染，但它不判断"这句话说得对不对" | 宿主 meta 增加显式 `phase`，卡片按 phase 分派；加单测锁住四个阶段各不相同 |

**顺带纠正了验证脚本自己的一个误判**：量 `<details>` 折叠必须量 **`<details>` 自身** ——
内容 `div` 折叠时仍保留布局盒，量它会得出"点开前后都是 70px"，从而误判成"折叠坏了"。

**第二轮：能看图之后又抓到 2 个。** 第一次跑这个验证时 `read_image` 被拒绝，
我据此写下"本模型读不了图片" —— **那是错的**。真实原因是**当前模型路由在配置里
没声明 `input: [text, image]`**：`dsh-tool-fs:972` 读的是
`llm.resolveModelInfo(provider, model).inputModalities`，即**路由的能力声明**；
该 provider 由 `dsh-llm-pi-ai` 服务，模型条目没有 `input` 字段，
解析链（`:682`）落到 `DEFAULT_INPUT = ["text"]`（`:906`）。
而 DSH 自带的 `dsh-llm-deepseek` 目录里，名字就叫 **DeepSeek-V41-Flash** 的那条写着
`inputModalities: ['text','image']`，只是属于另一个 provider。补上声明后立刻可用。
**教训：不要把一次工具拒绝推断成自己的能力结论 —— 拒绝的理由可能是配置、路由或版本。**

能看图之后重看截图，抓到两个**纯断言抓不到**的问题：

1. **回测卡 4 个指标在 320px 下挤成 3+1**（第 4 个孤零零掉到下一行、左对齐在第一列下面）。
   它**不溢出**，所以溢出断言全绿 —— "没溢出但很难看"是断言盲区。
   修复：`metric()` 增加换行阈值参数，4 指标用 `1 1 110px` → 整齐 2×2；3 指标仍用 72px
   （换成 110px 会从 1×3 退化成 2+1）。并加断言锁住换行分布。
2. **截图文件名是错的** —— 验证脚本按**数组下标**取卡片截图，而 `CASES` 里插入新用例
   会让下标整体错位，`single-export.png` 里其实是 AutoSync 卡。改成按 `data-case` 名字取。
   **这个 bug 只有看图才发现**：文件名与内容对不上，任何断言都不会报错。

**这一节的方法论意义**：分层验证不是"多跑几遍"，而是**每层抓不同的东西**。
shim 抓结构与契约，真浏览器抓渲染与样式，真 Cordis 上下文（§6.1.1）抓装载与生命周期，
**人眼抓"说得对不对/难不难看"** —— 四类缺陷分别只在各自那一层暴露，缺一层就会漏。
自动化能把"对不对"变成断言，但"难不难看"和"名字有没有撒谎"目前还得看图。

### 6.5 盘后定时增量同步（P5 落地，`lib/data/autosync.mjs`）

这一节是 P5 的核心，因为"每天自动跑一次"有四个容易做错的地方，每一个都对应一条设计约束。

**① 增量，而不是每天重拉全市场。**
每天真正新增的只有 1 个交易日。所以 `syncBars` 增加了 `incremental: {overlapDays}`：
起点**按股票各自算**（`sync_state.bars_last − overlapDays`），而不是所有股票共用一个 10 年区间。
不这么做的话，"每天跑一次"和"每天全量同步一次"没有任何区别，功能就没有意义。
重叠是为了兜住源站迟到的修正。

**② 重启后要能补跑 —— 这就是 P5 的门。**
`setTimeout` 活不过进程重启，所以"下次该什么时候跑"必须**落库**
（`meta.autosync.nextDueAt`；`meta` 表已是 schema 版本号的落点，语义一致）。
启动时读出来：如果它已经是过去时刻，说明这次被错过了 → **立刻补跑（延迟 0）**。
判定完全基于落库值，因此"补跑"不是特例分支，而是同一个 `evaluateDue` 的自然结果。
补跑走定时器（延迟 0）而不是在 `apply` 里同步跑 —— 否则 DSH 启动会被一次全市场同步卡住。

**③ 跑了 ≠ 成功了。**
任务执行完不代表数据更新了。所以**先探测再铺开**：只探 `probeCount`（默认 3）只
`bars_last` 最新的股票，都没出新高就判定 `noNewData`，一次请求都不铺开
（这把非交易日的全市场空跑从 5400 次请求压到 3 次）；铺开之后再校验库内最大日期
**确实前进了**，否则记 `staleSource`。两者都只重试一次（`maxRetriesPerDay`），然后等下一个周期 ——
不无限重试。

**④ 授权发生在配置时，而不是运行时。**
自动任务没有弹窗通道，所以"开启"这个动作本身就是同意（记录 `consentAt` / `consentBy`），
之后每次运行不再问。护栏先拦一次（§6.1.2），工具再兜一层。运行时仍有**硬上限**
（`maxCodes`，默认 3000）：超了**跳过并记录**，而不是硬跑。

**降级是明确的，不是静默的。**

| 情况 | 行为 |
|---|---|
| `timer` 服务不存在（headless profile 的 `patchReload: startup` 不会自动挂它） | `reason: 'timer-unavailable'`，配置状态保持开启，**手动补跑与状态读写照常可用**；工具与卡片如实说明"当前进程无 timer" |
| `timer` 服务**稍后**才出现 | 可正常工作：timer 在**每次排程时重新解析**，而不是装载时抓一次。抓死的话，"先装插件 → 再同步数据 → 再开启自动同步"这条最常见的新手路径会变成"开了却从来不动" |
| 仓库不存在 | `reason: 'no-store'`，**不建库、不排程**（保持"装了但没用量化就不会平白多出数据库"的惰性） |
| 部署层 `autoSync: false` | 强制关闭，并把落库状态也关掉（否则重启又活了） |
| 部署层 `autoSync: {enabled: true}` | 首次加载固化进库，`consentBy: 'deployment:config'` |

**新鲜度用工作日，不用自然日。** 自然日口径会让每个周一早上都报"过期 3 天"，
那是噪声不是信号。`syncStatus` 同时返回两者，`stale` 用工作日判定。
已知近似：**不识别节假日**（不维护交易所日历），长假仍会算成若干工作日 —— 这是声明，不是疏漏。

**清理不清授权。** `quant_data_cleanup {scope:'all'}` 删的是行情表，**不动 `meta`**：
撤销一次长期授权不该由"清理数据"代劳。

### 6.6 结果导出（P5 落地，`lib/export.mjs`）

**为什么不让模型自己 `write`：**

1. **口径一致** —— 报告里的指标、`caveats`、拒绝原因都从同一份结构化数据生成，
   不会因为模型转述而漏掉声明或写错数字
2. **压缩免疫** —— 工具结果在 8KB 处被裁剪（见 §6.2 的 `quant-session`），
   模型手里未必还有完整净值曲线；文件是完整的
3. **落点正确** —— 默认写进**会话工作目录**的 `quant-exports/`（`exec.agent.session.header.cwd`），
   这样 `present` 能直接呈现、用户也能在项目里找到。写到 `$DSH_HOME` 下面用户是找不到的 ——
   功能上"成功"了，实际上交付失败

两条硬规则：**CSV 带 UTF-8 BOM**（不带的话 Excel 打开中文列名是乱码，
这是国内用户最高频的"导出坏了"投诉，代价只有一个字节）；
**文件名净化挡住路径穿越**（`safeFilename` 只留安全字符）。

导出后**必须**接着调用 `present` —— 工具的 `render` 会把这句话直接写进结果，
只把路径写在回复里不算交付。

## 7. DSH 原生强化（v1 范围）· ✅ 已落地

| 强化 | 实现 | 状态 |
|---|---|---|
| **盘后定时增量同步 + 新鲜度提示** | `lib/data/autosync.mjs` + `quant_autosync` + `timer` 服务；新鲜度进 `quant_data_status` | ✅ §6.5；门（重启后补跑）由 `tests/autosync.test.mjs` 覆盖 |
| **昂贵操作审批护栏** | `tools.guard()` 单调否决 + 明确的复述路径；开启自动同步是唯一的"长期授权"类护栏 | ✅ §6.1.2 |
| **结果导出交付物** | `lib/export.mjs` + `quant_export`（Markdown/CSV）+ 落进会话工作目录 | ✅ §6.6 |
| **文档化 DSH 已有能力** | `quant-session` 技能：`goal` 的判据写法、`subagent_fork` 用于**样本外独立复核**（必须在看到答案前分叉）、压缩的代价与"先落盘再依赖" | ✅ preset 另挂 `subagent_fork` 工具行 |

**明确不做**：PTC 批量编排（`DSH_TOOLS_MODE` 是**进程级**开关，会影响用户所有会话，第三方插件不得改）。

**为什么 preset 只挂 `subagent_fork` 而不挂 `subagent`（spawn）**：量化回测是本地 CPU/磁盘密集计算，
多开子会话不会更快，而且每个子会话都要重复读同一份数据仓库（并发写只会互相干扰）。
fork 的价值不在并行，而在**独立性** —— 它继承历史到分叉点，因此可以做到"没看过样本内答案"的复核。

## 8. 回测引擎（可交易级）

| 规则 | 约定 |
|---|---|
| 成交时点 | 信号 T 日收盘计算，**T+1 开盘成交**（可配 T+1 收盘） |
| 不可成交 | 涨停不买、跌停不卖、停牌不交易（持仓按最后收盘估值） |
| 股票池 | 逐日可交易池：剔除 ST、停牌、上市不满 60 交易日；含已退市股票的历史区间 |
| 费用 | 佣金（默认万 2.5，双边，最低 5 元可配）、印花税（卖出千 1）、过户费、滑点（默认 0.1%） |
| 权重 | 等权（v1）、市值加权、因子加权 |
| 调仓 | 日 / 周 / 月；`top_k` 选股 + 可配缓冲（避免边界抖动） |
| 基准 | 默认中证全指，可切沪深 300 / 中证 500 |
| 指标 | 总收益、年化、波动、夏普、最大回撤、Calmar、胜率、换手、相对基准超额与信息比率 |
| 输出 | 净值曲线（逐日）、持仓快照、逐笔交易、指标 JSON |

**止损**（作为回测参数，v1 支持六类中的纯逻辑项）：固定、追踪、最大回撤熔断、时间、盈利回撤；ATR 止损依赖 ATR 计算（可加）。

### 8.1 实现现状（P2 已落地 `lib/backtest/`）

- **三层结构**：① 信号层只读已物化的 `factor_panel`（不在回测时算因子）；② 组合层在调仓日展开目标权重（等权 / 因子加权 + 缓冲）；③ `PortfolioBook` 逐日账务状态机。
- **价格空间 = 复权价**（分红送转已隐含，无需逐笔公司行为记账），**原始价仅用于可交易性判定**（涨跌停/停牌）。
- **因子必须算在复权价上**：通过 `bars_adj` 视图（累计因子用单次窗口扫描 `exp(sum(ln(factor)))` 算出，避免 bars×events 笛卡尔代价）；否则动量类因子在除权日会产生假信号。
- **整手规则**：部分卖出向下取整到整手，**清仓允许零股**（A 股规则）。
- **确定性单测 8/8**（`tests/backtest.test.mjs`）：费用/整手/T+1 可手算复现、T+1 成交后 NAV 与手算一致、涨停拒买、停牌不成交。
- **端到端不变式 6/6**（`spike/p2-smoke.mjs`）：NAV 恒等、无同日买卖、整手、无超卖、无 NaN、印花税仅卖出。
- 基准未接指数数据时使用**区间内等权买入持有代理**，并在结果的 `caveats` 中显式声明。

## 9. 合规

- preset 人格写死边界：**不构成投资建议、不预测股价、不荐股**；必须披露数据来源与局限（幸存者偏差已消除，但回测 ≠ 未来）。
- 数据与策略**全部本地**，不上传。
- 请求限速 + 缓存 + 尊重源站；文档注明数据来源为公开接口。
- 设置页展示免责声明与数据来源清单。

## 10. 与原 AIFUND5 的映射（57 → 30 + 3 技能）

| AIFUND5（57 工具 / 14 域） | 本插件 |
|---|---|
| 因子 2 / 策略 1 / 回测 2 / 存储 8 / 选股 1 / 仓位 3 / 止损 3 / 优化 1 / 日历 4 | 合并为 21 个 `quant_*` 工具（`backtest_run` 吸收止损；`data_coverage` 并入 `data_status`） |
| 行情 7 + 数据仓库 2 | 合并为 9 个工具（导出 Qlib 已无意义 → 删除） |
| 研报估值 4 + 资金信号 12 + 新闻公告 7 = 23 | **移出工具面** → `quant-sources` 技能 + `web_fetch` |
| LangGraph ReAct 循环 / SSE 协议 / SessionStore / chatStore | **删除** → 由 DSH 原生 agent loop 与会话持久化承担 |
| ChromaDB 向量检索 | **替换** → 中文 bigram + FTS5 |
| qlib 回测 | **替换** → 自研可交易级引擎 + 东财官方涨跌幅对账 |
| baostock/pytdx | **替换** → 东财 keyless HTTP |
| 9 个基本面因子"不可用" | **补齐** → 批量基本面 + `NOTICE_DATE` PIT |
| "当前沪深300成分股"（自认幸存者偏差） | **修正** → 全市场含退市股的逐日可交易池 |

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 东财接口改版/加签 | 数据中断（静默失效最危险） | 适配层隔离 + 字段校验（缺字段即报错不静默）+ 多源回退 + 缓存兜底 |
| 限流/封 IP | 同步失败 | 限速可配 + 并发上限 + 断点续传 + 退避重试 |
| 全市场规模性能 | 回测慢/内存高 | 因子面板物化 + 索引 + `temp_store`/`cache_size` 显式配置 + 分批查询 |
| 共享行 schema 漂移 | 升级 DSH 后插件失效 | 保守 patch（不碰共享行）+ 启动时探测版本与行结构 |
| 停牌/涨跌停/ST 历史字段不全 | 回测失真 | P0 门 1 先验证；缺失字段的区间显式降级并在结果中声明 |
| 卸载残留 | 用户环境变脏 | 元数据 + 设置页「卸载并清理」+ 文档 |
| 合规 | 社区/法律风险 | §9 |

## 12. 待定项（需产品决策）

1. **包名与 scope**（如 `@scope/dsh-quant`）与 **preset 显示名**（如「量化助手」）。
2. 默认股票池/成交时点/基准已给默认值（§8），待确认。
3. 界面语言：中文优先（后续接 DSH locale）。

---
name: quant-workflow
description: 量化任务的标准流程：一句话 → 因子检索 → 策略确认 → 回测 → 报告。含数据过期/自动同步、用户拒绝保存、审批护栏、结果导出四条分支的具体处理方式。做任何量化任务前读它。
---

# 标准工作流

## 0. 先看数据状态（不可跳过）

```
quant_data_status
```

- `ready: false` → 仓库还没建。告诉用户需要先同步，并给出规模估算：
  `quant_data_sync {scope: "codes"}` 先拉代码表（秒级），再按需拉行情。
- `stale: true` → 行情过期。**先提示用户**，问是否要同步；不要拿过期数据硬算后
  把结论当现状。
- 一切正常 → 继续。

新鲜度按**工作日**算（跳过周末，不识别节假日）。周一早上看到「距今 1 个工作日」是正常的，
不是过期。

**永远不要**在没有用户明确同意的情况下对全市场发起同步。

### 分支：数据过期

按顺序处理：

1. **先看 `autoSync.enabled`。**
   - 已开启 → 说明"自动同步已开着，上次结果是 X（日期 Y）"。
     如果上次是 `noNewData`，那多半是**非交易日**或源站还没出数据，**不是故障**，如实说明即可。
     如果上次是 `error` / `staleSource`，说明可能源站有问题，建议手动补一次。
   - 未开启 → 见第 2 步。
2. **建议开启自动同步**（一句话说清代价，然后问）：

   > 你的数据停在 X，今天已经过了几个交易日。要不要开启**盘后自动增量同步**？
   > 开启后每天收盘后（默认 18:30）会自动把本地已有的这些股票补到当天，
   > 不再每次问你；DSH 没运行时不会执行，但下次启动会补跑被错过的那一次。
   > 只同步本地已有的股票，不会自动扩大到全市场。

3. **只有用户明确同意后**才调用（护栏会先拦一次，这是设计）：

   ```
   quant_autosync {action: "enable", at: "18:30", confirm: true}
   ```

   `confirm: true` 表示"用户已明确同意长期授权"，**不是**一个可以随手带的开关。
   用户没点头就带上它，等于替他做了长期决定。

   想先跑一次看看：`quant_autosync {action: "run_now"}`（用同一条增量路径，不改定时设置）。

4. 用户想关：`quant_autosync {action: "disable"}`。

## 1. 把一句话落到因子上

用户说"最近涨得稳的""低估值高分红的"，用：

```
quant_factor_search {query: "动量 波动"}
```

拿到候选后，**把公式念给用户听**，例如：

> 我理解你说的是「20 日动量」：`$close / Ref($close, 20) - 1`，
> 即今天的收盘价比 20 个交易日前高多少。是这个意思吗？

需要新因子时用 `quant_factor_create` —— 它会先编译校验，**编译不过不会入库**。
写完务必用 `quant_factor_preview` 试算：

- `coverage` 过低（< 50%）→ 公式在多数股票上无定义，多半写错了
- `distinct` 过小（如只有 2–3 种取值）→ 公式退化成了常数或布尔

## 2. 组合策略并确认

```
quant_strategy_compose {factorIds: ["momentum_1m"], topK: 20, rebalance: "monthly"}
```

它返回 `ready` / `errors` / `warnings`。**把 warnings 转述给用户**，
然后复述一遍完整方案（因子、选股规则、调仓频率、股票池、区间、初始资金），
**得到确认后**再：

```
quant_strategy_save {strategyId: "mom_monthly", config: <compose 的 config>}
```

### 分支：用户拒绝保存

`compose` 与 `save` 分开就是为了这个。用户说"先别存"时：
- **不要**保存，也不要偷偷用别的 id 存
- 仍然可以直接跑回测（`quant_backtest_run` 的 `config` 参数接受未保存的配置），
  但**必须**告诉用户这次结果不会留档
- 用户改主意后再 `save`

## 3. 回测

```
quant_backtest_run {strategyId: "mom_monthly"}
```

会先把因子物化成面板（幂等，已有则跳过），再逐日模拟。口径：

- **T 日收盘出信号、T+1 开盘成交**
- 涨停不买、跌停不卖、停牌不交易（用**不复权原始价**判定）
- T+1 制度、100 股整手、佣金（最低 5 元）/印花税（仅卖出）/过户费/滑点

### 分支：审批护栏拒绝

高风险操作会被护栏拦下，返回 `APPROVAL_REQUIRED`：

| 触发条件 | 工具 |
|---|---|
| 全市场同步（> 200 只或未指定列表） | `quant_data_sync` |
| 回测区间 > 5 年 | `quant_backtest_run` |
| 参数组合 > 100 组 | `quant_optimize_parameters` |
| 删除全部行情 | `quant_data_cleanup {scope:"all"}` |
| **开启自动同步（长期授权）** | `quant_autosync {action:"enable"}` |

正确处理：**向用户说明规模与耗时**，取得同意后带 `confirm: true` 重试。
错误处理：绕过护栏、不说明就重试、或者假装没被拦。

### 分支：结果分析

```
quant_backtest_analyze {backtestId: "..."}
```

给出分年度收益、最大回撤区间、费用占比。用户问"什么时候亏的""费用吃了多少"时用它。

**必须转述 `caveats`**（引擎产出的口径声明）。它包含：
ST 用当前快照、上市天数用自然日近似、日频无法表达盘中路径、
停牌持仓按最后已知价估值、基准是等权买入持有代理（未接指数）。

## 4. 选股

```
quant_select_stocks {factorId: "momentum_1m", topK: 20}
```

输出是**按因子排序的候选名单**，不是推荐。股票池过滤与回测同口径，
并逐条给出拒绝原因计数（`{st: 12, suspended: 3, "new-listing": 5}`）。

有面板走面板路径（快），没有则现场求值（只取信号日截面，不落库）。
反复查询同一个因子时，建议先物化面板。

## 5. 参数优化（谨慎使用）

```
quant_optimize_parameters {strategyId: "mom_monthly", space: {topK: [10,20,50], rebalance: ["weekly","monthly"]}}
```

**这是样本内择优，天然带选择偏差。** 报告时必须同时说明：
- 返回里的 `caveats` 要转述
- 建议用户用另一段区间复核（样本外）
- 不要把"最优参数"说成"最好的参数"

## 6. 报告与交付

**先落盘，再说话。** 用 `quant_export` 把结果写成文件：

```
quant_export {kind: "backtest", backtestId: "bt_xxx", format: "both"}
```

| kind | 要什么 | 产出 |
|---|---|---|
| `backtest` | `backtestId` | Markdown 报告（指标 + 费用 + 分因子 + 口径声明 + 完整净值表）；`format:"both"` 另给净值 CSV |
| `select` | 与 `quant_select_stocks` 同参数 | 候选名单 Markdown/CSV（带拒绝原因与"不是推荐"声明） |
| `holdings` | 可选 `cash` | 持仓估值 Markdown/CSV |
| `panel` | `factorId` | 因子面板明细 CSV（带股票名） |
| `data_status` | — | 数据仓库状态 Markdown |

默认落在**会话工作目录**的 `quant-exports/` 下——用户找得到，`present` 也呈现得了。
文件里已经带了口径声明与免责声明，不需要你再补。

**导出成功后必须紧接着调用 `present`**，把返回的绝对路径传进去：

```
present {files: [{path: "/.../quant-exports/backtest-20260928.md", description: "回测报告"}]}
```

只把路径写在回复里**不算交付**。

### 为什么要落盘

长会话里工具结果会被压缩裁剪（`compaction-tool-result-pruner` 在 8KB 处裁）。
回测的完整净值曲线、因子明细表都远超这个阈值 —— **它们随时可能从上下文里消失**。

所以：任何你打算在后面引用的结果，先 `quant_export` 落盘。
之后即使被压缩，也还能用 `quant_backtest_get` 重新取回，或直接读文件。

**绝不要凭记忆重述一个已经不在上下文里的数字。** 不确定就重新取。

报告里必须包含：区间、口径、指标、**caveats**、以及"这不是投资建议"的声明
（前四项 `quant_export` 已经写好了）。

## 常见错误

| 症状 | 原因 | 处理 |
|---|---|---|
| `NO_DATA` | 仓库为空或区间内无数据 | 先 `quant_data_status`，再决定是否同步 |
| `APPROVAL_REQUIRED` | 触发了护栏 | 向用户说明后带 `confirm: true` 重试 |
| `TOPK_EXCEEDS_PANEL` | topK > 面板深度 | 提高 `topN` 重新物化 |
| `PANEL_FAILED` | 因子公式编译不过 | 用 `quant_factor_preview` 定位 |
| 回测开头一段无值 | 因子回看期长于可用数据 | 把 `start` 往后推，或声明这段为空 |
| `SOURCE_FAILED` | 网络接口限流/熔断 | 稍后重试；或改用本地数据 |
| `NO_PANEL`（导出时） | 该因子还没物化 | 先 `quant_factor_preview` 或跑一次回测 |
| `NO_HOLDINGS`（导出时） | 还没录入持仓 | 先 `quant_save_holdings` |

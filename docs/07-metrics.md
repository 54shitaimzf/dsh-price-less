# 07 · 度量账本

> 域定义：**一切机制的钱与效果账**——字段定义、单价、成本恒等式、回放管道、报表模板。
> 账本纪律：改动前后留快照、配对差值（Δ = 臂 − 基线）汇报、禁止单次运行结论。
> 历史快照存档（只增不改）= [ledger-history.md](ledger-history.md)；实验协议 = [08](08-experiment.md)。

## 0. 它解决什么问题（人话版）

每个机制上线前都要先回答两个问题：**它值多少钱（省了多少）**、**它有没有帮倒忙（误剪/
误判/质量掉了没）**。没有账本，这两问全靠感觉；账本口径不统一，跑十次也拼不出结论。
这篇就是账本的标准：字段从哪算（全部可从会话日志回放，无需重跑）、钱怎么拆（成本恒等式）、
报表长什么样。配套纪律在 [08](08-experiment.md)：只信配对差值，预注册再开跑。

## 0.5 指标一览（六族）

| 族 | 字段 |
|---|---|
| 通用（回放） | `roundsPerTask` · `tokensPerRound` · `toolCallsPerTask` · `compoundedVolume` · `reDiscoveryTokens` · `costPerSuccessfulTask` |
| 判别 | `segmentsPerSession` · `taskSwitchRate` · `judgeCount` · `judgeErrorRate` · `judgeCacheHitRate` · `judgeLatencyMs` · `judgeLLMUsage` · `judgeCtxTokens`（卷宗体积）· `judgeVerdictDist{action\|pureQ\|verifyQ}` · `l0CaptureRate` · `tableHitRate`（对表命中）· `judgeEffort{requested,sent}`（推理档，缺省=跟随） |

> **判别失败码（U8/U10，2026-09-10）**：`judge-error{code}` 现在可辨——`CE_JUDGE_NO_ROUTE`
> （会话首条消息无路由 = 未配置且尚无 `request/header`，**按设计跳过判别**，非故障）、
> `CE_LLM_TIMEOUT`（硬超时打断，`CE_LLM_TIMEOUT_MS`：判/★/init 60s、压缩 180s）、
> `CE_LLM_UNAVAILABLE`（服务缺失）。旧实现一律塌成 `CE_JUDGE_FAIL`，失败原因不可分。
> `judgeVerdictDist` 只统计白名单 class（`DOSSIER_CLASSES`，U13.4：未知 class 不再产 `NaN`）。
| 断面（星标） | `optimizePromptTokens{in,out}`（含 reasoning，usage 分列）· `verdictBackfill{count,conflicts}` · `shearAtStar{pairs,tokens}` · `metaStrippedLines`（元注释剥离）· `optimizeEffort{requested,sent}` · `previewCacheHits`（结果复用命中，零调用）· `explorationAvoided`（星标后探索类调用配对 Δ）· `rerunAfterCut` |
| 剪切 | `cutEvents{kind}` · `cutTokensSaved` · `cutBreakCost` · `cutMisfireDetected` · `questionBacklogDepth` · `toolPruneByClass` · `shearDecision{cut|hold|keep}`（`entrySkipListing` 分列）· `tableRepair{Count,Tokens}` · `repairCoverage` · `rereadAfterRepair` |
| 压缩 | `digestBytes` · `digestEntryCount` · `digestTokens` · `gistBytes` · `stepCount` · `stepTokens` · `factLeaks` · `quotaDrops` · `errorDrops` · `factRejects` · `dupDrops` · `hotTailPointers` · `hotTailLocated` · `hotTailUnlocated` · `fetchCapped` · `archiveOverCap` · `archiveTruncate{count,tokens}` · `compressionCallCount` · `compressionCacheHitRate` · `extraSearchCalls` · `hotTailTokens` · `hotTailDeclaredUnits` · `hotTailStopReason{budget|list-end}` · `hotTailSource{model|positional-fallback}` · `hotTailFloorFilled` · `pressureFireCount` · `pressureTriggerWireTokens` · `pressureChainDepth` · `pressureBreakerTrips` · `compressionLayer{boundary|pressure}` · `hardTruncateCount` |
| 缓存/守卫 | `cacheReadTokens`（标准 usage 路径 + 别名兜底）· `cacheHitInputTokens{cold|hot}` · `prefixRebuildCount` · `prefixRebuildTokens` · `prefixRebuildCause{shear|compaction|note|skill|frame}` · `violationRate` · `restoreDegraded` |

全部字段可从会话 JSONL 回放计算（`sourceEventSeqs` 溯源 + `compaction/prune` 影子价），
无需重跑。

> **`compress-run` 的 skipped 归因（U9/U11.8，2026-09-10 起扩容）**：`reason` ∈
> `llm-unavailable`（瞬态，不封禁）· `range-empty`（**U11.8 新增**：区间/表面定位失败，
> 每段每进程节流一条，仅可观测、**不封禁**）· `no-units` · `parse`/`schema` ·
> `shrink`/`storage`/`txn-*`（三者 + parse/schema 计入 **可重试**，预算 `RETRY_BUDGET=2`）。
> 已归档判定键 = `${scopedTaskId}:${segmentStartSeq ?? ''}`（**U9 段锚**）——旧事实无
> `segmentStartSeq` 时保守沿用旧键。压力路径同带段锚（`layer:'pressure'` 不参与归档判定）。
>
> **U17④ 压缩进度事实（`compact-progress`，2026-09-11）**：`phase{start|end}` · `mode{boundary|pressure}` ·
> `startSeq`/`endSeq`（被压区间）· `elapsedMs`（仅 `end`；**这就是"慢在哪"的直接读数**——真机 A/F2 实测
> 单次调用阻塞 **62.6s**）。颗粒度 = **一次模型调用**（不是一次压缩尝试）：长尾只有模型调用，且
> start/end 在同一 `try/finally` 里成对 ⇒ 异常/任意早退都不留未闭合 `start`。**缓存命中不发**（零调用
> ⇒ 零进度，04 §6）。宿主无消费者之外的用途：浏览器侧 `conversation.input.dock` 的进度条按
> "最后一条是 start" 渲染"压缩中…"，`end` 到达即消失（客户端纯核 `client/compaction-progress.ts`）。

## 1. 关键字段语义

- `compoundedVolume`：历史工具结果被之后每轮反复重读的浪费量（复利）——剪切/压缩的
  主靶。
- `explorationAvoided`：星标后探索类工具调用（glob/grep/read 试错）速率相对星标前基线
  的配对下降——执行路线确定化的直接读数。
- `verdictBackfill.conflicts`：星标回填与既有自动裁决的冲突数——同源不漂移的审计位。
- `cutMisfireDetected` / `rerunAfterCut` / `rereadAfterRepair`：三族误伤信号（重问被剪内容 /
  剪后重跑 / 修复后重读）——阈值修正依据，误判不静默。
- `hotTailSource`：热尾来自模型申报还是位置兜底——材料基准有效性的读数。
- **U15 申报归因**（`compress-run`）：`droppedHotTailBadDecl` / `droppedHotTailUnknownUnit` = 热尾申报
  被拒的两类原因（形状非法 / ID 不在清单）。**必须分列**：`assemble-run.dropReasons` 看到的已是
  门禁过滤后的数组（恒 0），只记 `droppedHotTail` 合并数则"热尾为何退化为位置兜底"在账本上不可诊断
  （真机 `session-ed9fe428`：compress-run 记 10 / assemble-run 记 0，真因是 `unitId` 被方括号包裹）。
- **F10 摘要面**：`gistBytes/stepCount/stepTokens` = 总述与分步规模；`factLeaks` = 摘要中的
  事实泄漏命中数（应为 0；>0 = 提示词/产物需要收敛）；`quotaDrops` = 配额不足被丢弃条数
  （F10：不再产空指针条目）；`errorDrops` = 错误单元不进热尾的丢弃数；`factRejects` = `fact`
  非原文子串被丢弃数（自造事实信号）；`dupDrops` = 重复 unitId 去重数；`hotTailPointers` = 热尾条数。
- **F9 档案面**：`archiveOverCap` = 最新单条自身超帽次数；`fetchCapped` = 申报洪泛被 maxFetchUnits
  截断的坐标数。（`refCount/refDrops/pathBytesSaved/pathTableEntries` 随 F10 契约 v3 退役。）
- **v4 定位面**：`hotTailLocated` = 带定位标注（`路径@vN:lines`）的热尾条目数——`pointerOverheadTokens`
  预留的实际使用者；`hotTailUnlocated` = 既不自证位置、又无坐标可标注的条目数——**可能诱发 grep 的条目**
  （热尾内容够不够用的直接读数，配 `extraSearchCalls` 判「要不要给路径」）。
- `extraSearchCalls`（压缩族）：压缩事件（装配 / 成功压缩）之后 `EXTRA_SEARCH_WINDOW=30` 次工具调用里，
  签名（工具名 + 参数）在压缩前已出现过的调用数——「丢了内容 → 重新找」的读数。跳过/失败压缩不算边界
  （没丢内容就没有重新找）；窗口重叠按首个边界归并。**归因诊断，不入质量判定**（[08](08-experiment.md)）。
- `pressureChainDepth` / `pressureBreakerTrips`：压力链长与断路器——背stop 健康度。
- `prefixRebuildCause`：前缀断裂的归因枚举——缓存纪律的账面。

## 2. 固定单价表（对比用，改价不改口径）

| 项 | 记账 |
|---|---|
| 输入（缓存命中） | provider usage 的 cached 口径 × 折扣单价 |
| 输入（未命中） | 全价单价 |
| 输出 / 思考 | 输出单价（usage 分列） |
| 辅助调用（判别/断面/压缩） | 按 purpose 分账（`llm.stream` usage 回执） |

单价数据源 = 版本化定价表（datasets/）；缺失单价不猜价，记 null。

## 3. 成本分解恒等式（每任务）

```
costPerTask = 执行(主模型) + 判别(judge*) + 断面(optimize*) + 压缩(compress*)
            + 剪除断裂重价(cutBreakCost + prefixRebuildTokens×全价)
成功口径 = costPerSuccessfulTask（质量门通过者）
```

省 = （基线执行 − 臂执行） − 新增机制成本 − 断裂重价。**断裂重价必须入账**——
它是最容易被漏记的隐性成本（缓存纪律 [06 §2](06-cache.md)）。

## 4. 复利量（隐藏杀手）

`compoundedVolume` 随轮次非线性增长：第 k 轮的历史体积被第 k+1…n 轮反复计费
（缓存命中按折扣、未命中按全价）。四层防御的全部理由 = 把复利基底压小；
报表必须同时给"当轮 token"与"累计复利"两列。

## 5. 回放管道

```
会话 JSONL → fold（事件序重放）
  → 段状态机 / 卷宗版本链 / 剪除账（sourceEventSeqs + prune 影子价）
  → usage 聚合（assistant/message + llm purpose 回执）
  → 07 字段全表 → 报表
```

同输入同账（纯函数断言）；KV 损毁不影响回放（[09 §1](09-state.md) 双源）。
事实源抽象：facts = 会话 ignorable 事件 ∨ KV 事实镜像（通道契约 [12 §2–§3](12-platform-capabilities.md)）——
同一 fold、同输入同账，通道存在与否两种环境的账本口径一致。

## 6. 报表模板（每次改动前后各一份）

```text
== batch <id> · arm <name> · <date> ==
质量门：完成率 / 盲评（先过门）
成本：costPerSuccessfulTask（冷/热分列）+ 恒等式分解
机制：本批改动族字段（账本快照前后差 Δ；同任务重跑可选，不设实验臂门槛）
断裂：prefixRebuild* / cutBreakCost
误伤：cutMisfireDetected / rerunAfterCut / rereadAfterRepair
结论：仅信可回放账本对比，阈值先登记后读数
```

## 7. 验收标准

- [ ] 全部字段可离线回放重算（回放器纯函数断言）；
- [ ] 缓存观测字段不缺位（标准 usage 路径 + 别名兜底测试）；
- [ ] 断裂重价入恒等式（漏记 = 报表校验红）；
- [ ] 每次机制改动前后有快照（存档纪律），新旧口径不混用。

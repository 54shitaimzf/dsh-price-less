# 07 · 度量账本

> 一切改动的裁判。字段定义、来源事件、口径、固定单价与报表模板都在这里。
> 原则：**先立度量，后改代码**；任何改动必须能在账本上被观测（AGENTS.md 强制）。
> 阅读指引：**先看 §0.5（当前已落地指标一览）**——这是插件真正在产出的度量；
> 其余章节为本账本的历史快照与蓝图字段。

## 0. 它解决什么问题（人话版）

这套插件每加一件事，都可能让 token 变多或变少，但不量一下根本不知道到底是省了还是亏了、值不值。那份"没跑实验就拍脑袋说省了"的改动，很容易把自己骗过去——今天看着省了，哪天模型一升级可能又变贵。所以规矩是**先立度量，后改代码**（AGENTS.md 强制）：先把"要观测什么、从哪算、单价多少、报表长什么样"全部定义好，任何改动都必须能在账本上被看到才算数。做法是：把所有字段定义成**能由会话日志回放计算**的（不用重跑实验），配一组**固定单价**（统一用一处价格折算，保证横向可比），改一次前后各出一份报表。收益是每次改动都有据可依、能横向比较；代价只是一层前置功夫，而且很小——全靠日志回放，不用额外重跑。注意这里只管"能测、可比"，**真实账单另列一行**（与官方现价对齐），两者分开报。

## 0.5 当前已落地指标一览（v0.8.0）

> 以下指标由**已落地代码**直接产出：判别器台账（`src/discriminator/journal.ts` 统计 +
> `trace.ts` 记录）+ 投影侧回放（`src/task/projection.ts`）。观测三通道：
> ① 进程内 `JudgeJournal.statsNow()`；② 持久日志行 `context-economy: judge record <json>`
> （grep 回放）；③ 事件 `judge-recorded`/`judge-error`/`judge-verdict`（log-only）。
> 项目自身副作用（token/成本）由第 1 节通用字段从会话日志回放计算。

| 指标 | 含义（一句话） | 代码落点 | 观测方式 |
|---|---|---|---|
| `judgeCount` | 判别记录总数（同消息幂等去重） | `journal.ts` `stats.judged` | statsNow() / 日志行计数 |
| `judgeErrorRate` | 带错误链的判别占比（errors÷judged） | `record.errors.length` | statsNow() / `judge-error` 事件 |
| `judgeCacheHitRate` | L1 缓存命中占比（防重放效率） | `stats.cacheHits` | statsNow() |
| `judgeLatencyMs` | 单次 LLM 判别端到端耗时 | `record.llm.latencyMs` | 日志行 |
| `judgeLLMUsage` | 判别调用的 input/output/reasoning/cacheRead token | `record.llm.usage` | 日志行（成本折算 + §1 单价） |
| `judgeCostUsd` | 单次判别成本（USD；单价表 `DISC_PRICING`，缺失单价不猜价） | `record.cost`（`estimateJudgeCost`） | 日志行 / 落盘账本 |
| `judgeNewTaskRate` | 判定 new-task 的占比（边界候选率） | `stats.newTasks` | statsNow() |
| `semanticBoundaries` | 语义票**实际转正**为边界数（verdict=new-task 且被投影合议切分；v0.8.0） | 投影 fold（段起点 + verdict 事件对齐） | 会话日志回放重建 |
| `l0CaptureRate` | L0 免费通道拦截占比（省掉的 LLM 调用） | `stats.l0` | statsNow() |
| `l0Leak` | L0-continue 误拦翻转的比例（**必须 = 0**，基线 phase-a-l0.md） | 需要 GT 的回放审计 | 对照 Phase B 数据集 |
| `segmentsPerSession` | 每会话 task 段数（段状态机规模） | 投影 fold `state.tasks` | 会话日志回放重建 |
| `taskSwitchRate` | 段边界事件占用户消息比例 | `task-boundary` 事件 | 事件回放 |
| `taskDefinitionBytes` | task 定义（锚文本等）字节总和 | `TaskRecord.anchorText` | 回放统计 |

**压缩域增量（v0.5，task 分划档）**——由新组件直接产出：

| 指标 | 含义（一句话） | 代码落点 | 观测方式 |
|---|---|---|---|
| `digestBytes` | 摘要区/单 task digest 字节 | `digest-schema::digestByteLength` | 单测 + 回放 |
| `digestEntryCount` | 已归档 per-task digest 条目数 | `digest-store::load().size` | 落盘账本 |
| `compressionCallCount` | 摘要器 LLM 调用数（跨会话/复压复用后） | summarizer 调用（缓存命中降为 0） | `compaction/summary` usage |
| `compressionCacheHitRate` | digest 缓存命中占比 | `DigestCache::stats().hitRate` | 缓存统计 |
| `reDiscoveryRate` / `extraSearchCalls` | 重发现占比/额外搜索调用数（下游因摘要缺失多花的搜索） | 保真 harness `compaction_fidelity.mjs` | 回放比对 |
| `digestCoverage` | 摘要对"重发现拦截器"事实的覆盖比例 | 保真 harness | 回放比对 |
| `recencyZoneRetainRate` | 近因尾内闭合任务被逐字保留的比例 | `range-task-partitioned` | 回放断言 |

> 改造协议（宪法）：**任何改动前后各出一份以上快照**（判别器侧 = statsNow + 日志行抽样 +
> 落盘账本 `~/.dsh/context-economy/judge-records.jsonl`（含 usage/cost，**可回放**——恢复契约 docs/12 §2）；
> 投影侧 = 回放脚本；配对 Δ = 臂 − 基线，禁止单次运行结论——见 §18 预注册验收）。
> 输入/输出原始日志（渲染后 prompt 与模型输出）受 `discriminator.debugIo` 控制，写
> `judge-io.jsonl`（默认关——原文量大；实时排障时开）。

## 1. 字段定义与来源（完整表：通用 + 设计蓝图域；全部可从会话日志回放计算，无需重跑）

每个字段都有三件事：叫什么、是什么意思、从哪条日志算出来。全部都能靠会话日志回放重建，不用重新跑一次实验。

| 字段 | 定义 | 来源事件 |
|---|---|---|
| `roundsPerTask` | 每个任务里模型被调用的轮数（也就是 step 数）。 | `step/start` / `step/end` |
| `tokensPerRound` | 每一轮里输入和输出 token 的分解明细。 | `assistant/message`(usage) + `request/header` |
| `freshInputTokens` | 没有命中缓存的输入 token 数。 | usage 反推（DeepSeek `prompt_tokens` 需减去缓存部分） |
| `cacheHitInputTokens` | 命中缓存的输入 token 数。 | `prompt_cache_hit_tokens`（DeepSeek 口径） |
| `outputTokens` | 可见输出 token 数。 | usage |
| `reasoningTokens` | 思考（reasoning）token 数，是最贵的单项。 | usage（v4-flash 系） |
| `toolCallsPerTask` | 每个任务里的工具调用总数。 | `tool/call` |
| `parallelRate` | 并行调用占比：同一轮里发生多次调用的占比。 | `assistant/message` 内 tool-call 块计数 |
| `reDiscoveryTokens` | 重发现成本：文件读取类工具（read/ls/grep/glob）的输入+输出 token。 | `tool/call` + `tool/result` |
| `compoundedVolume` | 复利量：每轮输入里"历史工具结果"被反复重读的累计 token。 | 回放累加 |
| `anchorBytes` / `anchorHits` | 锚定段的字节数 / 同版本锚定段被复用的次数。 | `anchor/created`（提示词产品域） |
| `intentEmphasisHit` | Intent 节命中率：模板命中且意图段被模型采纳的比例。 | `anchor/created` + 采纳观测（docs/04 §6，回放） |
| `templateHitRate` | 模板命中率：同类请求命中缓存模板的比例。 | 模板命中记录（docs/04 §4，回放） |
| `wastedToolRounds` | 浪费的轮数：探索/试错/查找/返工等非必要轮（见 §3 恒等式）。 | 回放（恒等式分解） |
| `filePagesPerRead` | 每次 read 平均读取的页数，衡量页式治理的生效度。 | `tool/call`(read) + `file-stream/paged` |
| `fileBytesInjected` | 每轮实际注入的文件字节数（治理之后）。 | 工具结果回放（按 tool 名分组统计，脚本见 `analysis/`） |
| `fileReReadBytes` | 未治理时的重复读取浪费量（对照组）。 | 回放按 (path, 版本) 去重差值 |
| `fileBytesSavings` | 页式/快照相对全量读取省下的字节数。 | 对照全量基线 |
| `injectedBytesInjected` / `injectedBytesUsed` | 自动引入的注入字节数 / 被模型实际使用的字节数（命中率 = used÷injected）。 | `file-stream/injected`（文件与寻址域，docs/15 §2） |
| `pipelineInvokeRate` / `pipelineFallbackRate` / `pipelineSuccessRate` | 管道被采用的比例 / 门控回退的比例 / 成功比例（采用层闭环）。 | `pipeline/*` + `pipeline/fallback` |
| `templateEmbedRate` | 命中"管道任务模板"的任务比例（可见的采用层）。 | 模板命中事件 |
| `parallelWidth` / `ownershipMissRate` / `handoffWaitTurns` | 实际并行宽度 / 归属失败率 / 等待交付物耗费的轮次。 | `pipeline/dispatch`、`pipeline/merge` |
| `violationRate` | 每千轮里守卫抓到违例的次数。 | `guard/violation` |
| `restoreDegraded` | 恢复降级计数，按域/原因细分。 | `restore/degraded` |
| `mappingHit` / `mappingFindTurns` / `mappingStaleRate` | 映射命中率 / 命中后 read 首跳成功的轮数 / 映射失效（stale）比例。 | `mapping/updated`、`mapping/stale` |
| `firstTurnSuccess` | 首轮就通过验收的比例。 | 提示词产品域 + 验收事件 |
| `costPerSuccessfulTask` | 每个成功任务的成本（通过质量门后才用）。 | 上述合计 ÷ 成功数 |

## 2. 固定单价表（对比用，改价不改口径）

**固定单价 = 统一用这一处价格折算，保证横向可比；真实账单另列一行**（与官方现价对齐）。这里给的是示例价，以官方价格页为准；只要口径不变，价格随官方波动也不影响对比。

| 项 | 单价（示例，以官方价格页为准） |
|---|---|
| 输入未命中 | 2 元 / M token |
| 输入命中 | 0.2 元 / M token（DeepSeek 约 1/10） |
| 输出 | 6 元 / M token |
| 思考 | 按输出口径计 |

> 纪律：实验报告用固定单价折算（可横向比较）；真实账单另列一行（与官方现价对齐）。

## 3. 成本分解恒等式（每任务）

**恒等式 = 成本 = 各组成部分之和，每一项都能从日志算出来。** 每任务的总成本是每轮各项之和。

```
cost(task) = Σ_rounds [
    freshInput × P_miss + cacheHit × P_hit + output × P_out + reasoning × P_reason
]
rounds = 必要依赖链 + 浪费轮（探索/试错/查找/返工）   ← 本套件主攻对象
```

看懂这个公式的关键是：一轮的 token 被拆成四部分——没命中的新算部分（fresh）、命中缓存的旧部分（cacheHit）、模型输出的部分（output）、以及思考的部分（reasoning），各自乘上单价再加总。而轮数被拆成"必要依赖链"加"浪费轮"——后者正是本套件主攻的对象，把浪费轮压下去就是省钱。

## 4. 复利量（本套件的"隐藏杀手"）

```
compoundedVolume = Σ_rounds (历史工具结果在后续轮次中被重读的 token)
```

复利（compoundedVolume）= 历史工具结果被之后每一轮反复重读的浪费量。一个 5k 的工具结果喂给之后每一轮 → 10 轮任务多付 ~45k 输入。`compoundedVolume` 下降 = 压缩域（压缩/剪枝）在生效的直接证据。

## 5. 回放管道

**回放器 = 按事件顺序重建每轮请求与用量，从日志重算所有指标。usage 分摊 = 把一次请求的 token 用量拆成：没命中的新算部分 / 命中部分 / 输出部分 / 思考部分。**

```text
会话日志（事件溯源）
  → 回放器：按 seq 顺序重建每轮请求信封（system+tools+messages）
  → 分摊 usage：fresh / hit / output / reasoning
  → 聚合为 task 行（按 task 边界事件切分）
  → 落盘 JSONL：$DSH_HOME/.context-economy/ledger/<sessionId>.jsonl
```

## 6. 报表模板（每次改动前后各一份）

```text
[arm]  baseline | full            Δ(baseline→full)
roundsPerTask        6.2            3.1        -50%
costPerSuccessful     ¥3.41          ¥1.72      -49%
firstTurnSuccess      58%            84%        +26pp
reDiscoveryTokens     12.4k          2.1k       -83%
compoundedVolume      43k            11k        -74%
cacheHitRate(热)       87%            91%        +4pp
```

> 规则的输出格式即 [docs/08](08-experiment.md) 实验报告的输入。

注意模板里"冷/热"要分开报：冷（清缓存后首跑）与热（连续跑）各一列，**永不合一**——挤到一起就没法说明到底谁是缓存带来的、谁是机制带来的。

## 7. 验收标准

- [ ] 回放器可从任意会话日志独立重算全部字段；
- [ ] 每次改动提交附前后各一份报表；
- [ ] 冷/热缓存两列分开，永不合一。

## 8. 账本快照 v0.1.0-s3：语义票（embedding 为主）对照实验

> 改动：新增 `SemanticVoteProvider` 接口 + `SemanticVoteTable` 运行时通道 + `embeddingTier:'local'`
> 档（Qwen3-Embedding-0.6B @ Ollama，见 docs/11 §9）。**本实验只测判定质量（P/R/F1）**：
> 语义票不进入请求字节，token/成本指标不受此改动影响（无增无减，不另报）。
> 评分口径：严格模式——边界 seq 映射到 turn/end 索引精确比对（无容差）。
> 数据：归档会话 dsp-14b / dsp-c388 / card-b5f9（用户意图标定 GT）；GT 边界数 5/2/7。

| arm（判定器） | 会话 | TP | FP | FN | P | R | F1 |
|---|---|---|---|---|---|---|---|
| 基线·机械 v2（off） | card-b5f9 | 1 | 1 | 6 | 50.0% | 14.3% | 22.2% |
| | dsp-14b | 1 | 5 | 4 | 16.7% | 20.0% | 18.2% |
| | dsp-c388 | 1 | 2 | 1 | 33.3% | 50.0% | 40.0% |
| | **合计** | **3** | **8** | **11** | **27.3%** | **21.4%** | **24.0%** |
| 语义票 on@0.5（embedding 为主） | card-b5f9 | 4 | 17 | 3 | 19.0% | 57.1% | 28.6% |
| | dsp-14b | 3 | 41 | 2 | 6.8% | 60.0% | 12.2% |
| | dsp-c388 | 1 | 16 | 1 | 5.9% | 50.0% | 10.5% |
| | **合计** | **8** | **74** | **6** | **9.8%** | **57.1%** | **16.7%** |

**Δ（on@0.5 − 基线）**：TP +5，FP +66，FN −5；**P −17.5pp，R +35.7pp，F1 −7.3pp**。

**可分离性诊断（决定性证据）**：票 = cosine(当前用户消息, 当前 task 宣言锚)：

| 探针 | 会话 | 边界 turn（n=…）mean | 任务内 turn mean | 判定 |
|---|---|---|---|---|
| 宣言锚 | dsp-14b | 0.534 (n=4) | 0.505 (n=99) | 重叠、方向反 |
| 宣言锚 | card-b5f9 | 0.636 (n=6) | 0.508 (n=29) | 重叠、方向反 |
| 步进锚（vs 上一消息） | dsp-14b | 0.487 (n=4) | 0.574 (n=96) | 方向对、分布重叠 |
| 步进锚 | card-b5f9 | 0.550 (n=6) | 0.512 (n=29) | 弱方向、分布重叠 |

**结论（账本式）**：原始余弦语义票对"任务换向"判别**无有效分离度**——召回提升以 precision 崩塌为代价，总 F1 −7.3pp。
默认档保持 `embeddingTier:'off'`（机械基线 F1 24% 优于语义票 16.7%）。下一步探针见 docs/11 §9.

## 9. 账本快照 v0.2.0-s4：四类判别器参数测算（训练集选参 → 新数据验证）

> 改动性质：判别器架构研究（"先分类再归属"：四类话语角色 T=独立任务 / A=附属修复 / D=方向修正 / Q=澄清征询）。
> 本快照只记录**判定质量**（分类混淆矩阵 + 归属 P/R/F1）；判别不产生请求字节，token/成本指标无变化，不另报。
> 口径：归属 = 消息级"新任务倾向"分数 ≥ τ；双真值（labelT=话语角色标注；gt=归档会话人工切分）。
> 数据：train=dsp-14b+dsp-c388（130 条，标注 6T/8A/24D/92Q）；**valid=card-b5f9（35 条，6T/17A/2D/10Q，与训练句零交集——新数据）**。
> 模型：插件内 granite-97m-r2（q8, CLS+norm），原型 v2 语用化（12/11/11/12 句，仅出自 train）。
> 脚本：判别器线（`embed_cls_eval.mjs` 等）已随 v0.2.0-s6 实验清理归档，本快照保留其判定质量结果，作为判别器路线的历史参考。

### 9.1 四类分类混淆（train，argmax；偏乐观——原型含 train 原句）

| 标注↓\预测→ | T | A | D | Q | 说明 |
|---|---|---|---|---|---|
| T (6) | 6 | 0 | 0 | 0 | **T 域内可辨** |
| A (8) | 0 | 7–8 | 1 | 0 | A 域内基本可辨 |
| D (24) | 5–6 | 3–5 | 12–14 | 2–3 | D 约半 |
| Q (92) | 22–26 | 16–22 | 15–21 | 26–32 | **Q 回流严重（~30%）** |

### 9.2 归属判定（valid=新数据，双真值，最优 τ 行）

| arm | τ | 真值 | TP | FP | FN | P | R | F1 |
|---|---|---|---|---|---|---|---|---|
| 参考·旧机械 v2（§8） | — | gt | 1 | 1 | 6 | 50.0% | 14.3% | **22.2%** |
| 新机械臂（规则链+文件簇, no-em） | 0.25 | labelT | 2 | 0 | 4 | 100% | 33.3% | **50.0%** |
| | 0.25 | gt | 1 | 1 | 6 | 50.0% | 14.3% | 22.2% |
| 融合臂（vote/e70, 域外自适应） | 0.25 | labelT | 3 | 3 | 3 | 50.0% | 50.0% | **50.0%** |
| | 0.25 | gt | 3 | 3 | 4 | 50.0% | 42.9% | 46.2% |
| 融合臂（同上） | 0.30 | gt | 3 | 1 | 4 | 75.0% | 42.9% | **54.5%** |

### 9.3 五轮实验规律（决定性的，不是调参噪音）

1. **q8 语义检索对"语用类别"只有弱判别力**：消息级类内余弦 0.7635 vs 类间 0.7419（gap 0.022）；原型级 0.7778 vs 0.7387（gap 0.039）。绝对分数（0.70–0.79 区间）完全不可信，**必须用相对差归一化**（softmax 温度 0.015）——未归一化时 pC 恒负、全 arm 归零（v2 实证）。
2. **跨话题域失效是刚性的**：train（DSH 域）e=0.7 可达 F1 0.8；同一配置换到 valid（游戏 UI 域）全崩（detected=∅）。**域外探测**（原型检索最高相似度 conf < 0.775 → e×0.25、权重转机械/文件簇）修复了它——这是"embedding 为核"在真实部署下的必备守卫。
3. **原型语用化有效**（v4→v5）：同参 FP 6→3，valid F1 0.40→0.50——原型句应聚焦话语角色标记（祈使/否定/疑问/修补），而非话题内容。
4. **四类 argmax 分类不可直接用于归属**（Q 类回流 30%+）；归属抽取**连续倾向分数**（P_cls = 0.6T−0.5A−0.4D−0.2Q，疑问强度 q 打折扣）。
5. **机械语用规则最可靠**：纯机械臂 P=100%（无 FP）；embedding 主要补召回、代价是 FP。融合后 valid P=R=0.5。
6. **win=2 跨轮二次确认离线增益 ≈ 0**（win1≈win2）：离线只有消息序列、缺事件流（tool/call、文件操作、task 锚演化）；"多次多轮测算"的完整验证必须在生产 fold 上实测，离线结论仅为"待定档机制值得保留、参数需实测"。

### 9.4 推荐集成参数（生效于实现时）

- 策略：`max`（整条消息 direct 检索 + 子句匹配双通道，softmax 温度 0.015 相对差归一）；
- 权重：`{e:0.45–0.55, f:0.2, m:0.25–0.35}`，**域外探测** conf<0.775 → e×0.25（权重转机械+文件簇）；
- 裁决分三档而非单阈值：score ≥ 0.35 开边界 / ≤ −0.1 附属（当前任务续）/ 中间 → attributionWindow 待定累积；
- **P 优先**：错开边界（拆断任务链）危害 > 漏开边界，阈值宁可偏保守，召回由多轮待定补。

---

## 10. 账本快照 v0.2.0-s5：结构性重构（无行为改变，无 Δ）

> 本快照记录一次**纯结构性重构**：职责解耦（拆出 `votes/{table,artifact}.ts`、`task/driver.ts`、`task/compaction.ts`）
> 与 harness 契约对齐（`init(_header)`、`todo/write` 类型合并、`compactRegion`/`compactIfNeeded` 按
> `CompactionAgentContext` 类型化）。**不改变任何判定逻辑、配置字段、事件名、状态 schema、`stateVersion`**，
> 因此所有度量口径与数值结果**不变** —— 按 AGENTS.md「改动必须可被账本观测」，这里记录为「无 Δ 的结构性改动」：
>
> - 行为等价：投影 fold、判界、范围选择、压缩触发逻辑逐一未动（纯文件搬家）。
> - 编译产物 `lib/` 同步更新；typecheck 0 错；75 项 vitest 全通过（66 存量 + 9 新增，新增仅覆盖拆出模块的
>   幂等/归因语义）。
> - 修正的 harness 契约属**类型/装配层面**（修复 new-g harness 的 `todo/write` 事件所有权迁移，与 `init` 契约形参）；
>   不改判定结果，故不产生字节/成本差异，不另报 token 指标。
> - **结论**：无 Δ（`roundsPerTask`/`taskSwitchRate`/`taskDefinitionBytes` 等一切度量不变）。

---

## 11. 账本快照 v0.2.0-s6：实验实现清理（无行为改变，无 Δ）

> 本快照记录一次**实验实现清理**：删除被 probe19–21 判定为"最不适合此目的"的判别器线（训练后
> LDA/白化 + 四类判别器 probe5–18，含 `embed_probe*`/`embed_cls_*`/`embed_denoise_*` 脚本、
> `probe5–18` 报告、`agent_*`/`dataset_adapter`/`extract_corpus`/`make_intent_ladder` 语料构造脚本、
> `prototypes*.json`、`_ds_task/`、以及仅服务判别器线的外部语料缓存 superdialseg/mwoz22/sds/mwoz）。
>
> **保留的"有优势变体"证据**（probe19/20/21 结论：机械触发为主线、原始嵌入只配语义复核）：
> `reports/probe19.md`、`probe20.md`、`probe21.md` + 对应可复现脚本 `scripts/embed_probe20.mjs`、
> `embed_probe21.mjs` + 真值语料 `datasets/claudeset_shard.jsonl`（真实 claudeset 会话，p14 首条带 GT 手标）。
> 判死判别器线的结论以 `probe19.md` 保留（其 LDA 生成脚本与 `agent_corpus` 一并归档）。
>
> - **行为等价**：本次只删实验脚本/报告/语料缓存/探查目录，**不改任何 src/ 判定逻辑、配置字段、
>   事件名、状态 schema、`stateVersion`**；typecheck 0 错、75 项 vitest 全通过、`lib/` 未重建（无源码改动）。
> - **可复现性**：保留的 probe20/21 脚本仅依赖 `claudeset_shard.jsonl`（已保留），均实测 EXIT 0 并复现
>   判定结论（机械 recall 0.725）。
> - **结论**：无 Δ（清理只影响实验工件，不进运行时字节/成本路径）。

---

## 12. 账本快照 v0.2.0-s7：embedding 降级（边界语义票移除 + 去重荷）

> 本快照记录一次**能力降级 + 去重**：边界语义票全套移除（探针 probe19–21 判死"embedding 用于任务边界"，
> 机械触发既是主力也够用），embedding 降级为 `EmbeddingPort` 零成本空壳（为映射检索留门），
> `models/`+`vendor/` 运行时不再随包（约省 198MB）。
>
> - **判定逻辑**：投影 fold 改为固定纯机械 `decideBoundary`（等价旧 'off' 档行为——探针结论下
>   embedding 不参与边界，判定结果**不变**）。`stateVersion=3` 未变（状态字段无改动）。
> - **配置字段**：移除 `embeddingTier`/`taskEmbeddingThreshold`/`embeddingModel`/`embeddingEndpoint`/
>   `embeddingModelDir`/`embeddingVendorDir`（不再需要；`CONFIG_DEFAULTS`/`cordis.patch.yml` 同步）。
> - **删除模块**：`src/votes/`（table+artifact）、`embedding.ts` 投票/provider/端口实现、`makeVotes`、
>   `tests/votes-table.spec.ts`、`tests/embedding.spec.ts`（仅余 cosine/契约）、`scripts/setup_vendor.ps1`、
>   `scripts/embed_smoke.mjs`、`models/`、`vendor/`。
> - **保留**：`embedding.ts` 的 `EmbeddingPort` 接口 + `cosineSimilarity`（映射检索留门）；
>   边界语义投票逻辑自仓储释放。
> - **验证**：typecheck 0 错；vitest 全通过（按砍后 suite 数）；无 harness 挂载（本地审查）。
> - **度量**：边界语义票不进入请求字节，token/成本指标不受影响（无 Δ）；`roundsPerTask`/`taskSwitchRate`
>   /`taskDefinitionBytes` 在纯机械（默认 off 档）下不变。

---

## 13. 账本快照 v0.2.0-s8：机械判别建模升级探针（probe22/23 —— 判定结果：不达标，但证据入库）

> 本快照记录一次**离线建模探针**（不改变生产 src/ 判定逻辑，无运行时 Δ）：
> 按用户要求"提高粒度、多组参数组合寻找最优、综合对照各个优化选项"，
> 在 21 个已标会话（claudeset 英文 14 + 本地 DSH 中英 7，24 总库含 3 holdout）上做了
> **机械判别器的全面建模升级实验**：F1–F9 梯度特征（双语 correction/lexical、连续化簇转移、
> todo 比、词面衔接凹陷、liveness/escape 类别、run-length 软先验、语用、工具形态）+
> 臂 M0–M7（基线/连续线性/衔接/存活/软先验/级联/硬间隔对照/零新特征参数化）+
> LOSO 参数搜索（θ∈[0.3,1.6]，权重网格 + 坐标微调，固定种子 20260829）。
>
> **结果（预注册门槛：recall≥0.70 ∧ 每误切孤儿≤0.85 ∧ 单意图误开≤50%）——全部臂未达标**：
> - 最优臂 M7（旧信号族参数化 + θ）LOSO 均值 recall 0.302 / 每误切孤儿 1.014 / 单意图误开 9.5%（U −7.548）；
>   生产 M0 基线 recall **0.012**（英文/法文语料几乎不开火——信号词典中文-only，实测确认）。
> - **根因（量化）**：翻转点词面覆盖率仅 **26.6%**（64 flip 中 17 个有 lexical/corr 标记，73.4% 无任何词面标记）——
>   词面机械的 recall 硬上限约 0.27；词面 Jaccard（f6Anchor/f6Prev）对 flip/non-flip 几乎不可分
>   （mean 0.052/0.035 与 0.040/0.080，无信号优势）；θ 密度扫描下不存在同时满足三门槛的工作点。
>   **任何机械工作点都不优于"不切割"（U 参照 −192）**。
> - **工程正收益**：①粒度化 + 双语词表使 θ 稳定区间由 0.05 宽（[0.20,0.25]）扩到 0.55 宽（[0.20,0.75]），
>   "阈值需逐会话手调"直接缓解；②转储/目标类别（F5）在 M3/M6 配置中作为**负权重**起效（降低误切孤儿
>   M3 0.326 < M0 0.838——少量转储辅助判定有效）；③带 French 词表修了 claudeset 语料完全不可用问题。
> - **保真度注记（重要）**：probe19/20/21 的"机械 0.725"来自一个**未入库的词面 θ 模型**（生成脚本已删），
>   不是生产 `decideBoundary`；本次 M0 以生产代码原样回放为正确基线（recall 0.016）。结论修正：
>   embedding 是否无必要，须在"生产机械基线"上重新评估（以往对比对象不同）。
> - **审计不变**：`src/` 零改动（判定逻辑、配置、schema、`stateVersion=3` 均未动）；纯 scripts/ + reports/
>   + tests/ 新增；typecheck 0 错；vitest 70 项全通过（51 存量 + 19 新增 mech-features 特征契约）。
> - **入库工件**：`scripts/mech_replay.mjs`、`mech_features.mjs`、`mech_arms.mjs`、`mech_eval.mjs`、
>   `mech_diag.mjs`、`mech_probe22.mjs`、`mech_probe23.mjs`；`datasets/labels/{claudeset,claudeset-ext,
>   local-dsh,local-ext,local-holdout,current-session}.json`（原 `EVAL` 迁出为 A 源）；`reports/
>   probe22.md`、`probe22-diagnostics.md`、`probe22-fidelity-note.md`、`probe23.md`。
> - **度量**：不进入运行时字节路径（无 Δ）；`roundsPerTask`/`taskSwitchRate`/`taskDefinitionBytes` 不变。
> - **待决事项（留给下一步）**：本探针结论"纯机械无法达标"与 probe19–21 的"embedding 无必要"存在前提冲突
>   （对面比较的是不同代际的机械），因此**"生产机械基线 vs embedding 复核"的配对实验被重新激活**；
>   在决定"是否给边界再加语义层"之前，先跑该配对（回退链第 4 步），本探针不动生产。

---

## 14. 账本快照 v0.2.0-s9：v3 乘法指标 + 全组合重跑（probe24 —— 指标升级与再选参）

> 背景：用户指出 §13 指标可被"刷密度"（recall@±2 在切 83 刀/169U 时随机命中率 96.8%、
> 每误切孤儿是反单调均值、U 的 b=0.5 梯度把搜索引向密度甜点）。本快照记录**指标重建 + 全组合重跑**。

> **v3 指标（reports/mech-metric-scenarios.md，合成情形验证后定参）**：
> score_s = R·P·A；R=k/n（匹配翻转/翻转），P=k/m（匹配/切割），A=(1/n)Σw(l̂)；
> l̂=(cut−flip)/max(N/n,1)（段单位标准化距离）；w=γ^max(0,−l̂)·β^max(0,l̂)（早切略优 Δ=0.1）；
> 漏→ε；匹配半径 c·s。参数经 8 类合成情形 × 81 组合网格锁定：**γ=0.9, β=0.8, ε=0.05, c=0.2**
> （全部断言通过集合内的预注册值；ε/c 另有灵敏度理由：ε=0.1 让"单发正中"反超"全场扫"、c=0.5 让 1/4 段偏差拿 0.945 分）。
> 聚合=几何均值（raw=0 → LOG_ZERO=−6）；基线强制并列 no-cut/fire-all/rand-k/perf-exact。

> **probe24 重跑结果（LOSO 同一 21 折，选择目标=新指标 meanLog + 单意图门≤50%）**：
> - 臂排名：**M7 −2.077**（单意图 28.6% ✓ 门内）> M5 −2.572（42.9% ✓）> M6 −2.652（42.9% ✓）>
>   M4 −2.688（57.1% ✗）> M3 −3.973 > M2 −4.492 > M1 −4.200 > M0 −5.372 ≈ no-cut(−6)（生产惰性实锤）。
> - 基线：no-cut −6 / rand-k −3.46 / **fire-all −2.59** / perf 0.00。M7 超额 = +0.52 log vs fire-all（≈1.7× raw）、
>   **+1.39 log vs rand-k（≈4× raw）**——新指标下机械臂首次出现"显著高于退化基线"的读数。
> - **预算@GT oracle 上限（能力诊断，用 GT 选位）**：M7 只发 n 刀 → meanLog **−0.735（raw≈0.48）**
>   （自然输出 72 刀仅 0.15 raw）。**机械分数面的真实判别力存在，但被自身密度拖垮**——
>   "后验聚簇/预算门"策略的理论收益 ≈ 3.2×，这是 §14 之后最值得做的机制实验。
> - holdout 单跑：门内最优 M4（−1.388，单意图 0%）与 M3（−1.695，0%）；M7/M6 分别 100%/100% 误开单意图
>   ——train 折 28.6% 的门通过率未泛化到 holdout 单意图（门在 7 个负样本上噪声大，诚实记录）。
> - 旧指标对照：M7 LOSO recall 0.302→0.557（v3 选出的配置更"勤"，θ=0.7 且 cluster 权重 1.0）；旧 U 全部为负不变。

> **手工验收（用户要求，全部通过）**：perf-exact raw==1.0 于 21 会话全过；no-cut==0 / fire-all 组件等式全过；
> 组件界全过；随机基线三种子互异；两个真实会话逐步核算（A 本对话 M7：w(+2)=0.9725、w(−3)=0.9804、
> A=0.9945、raw=0.15194；B mails M4：A=0.3640、raw=0.07280）逐项与脚本一致。
> 过程中的两类修复入库：验证逻辑 null 误判（no-cut"坏 7"实为单意图）；oracle 预算列 NaN（aggregateV3 收到裸数）。

> **审计不变**：`src/` 零改动（判定逻辑、配置、schema、`stateVersion=3` 均未动）；typecheck 0 错。
> 新增工件：`scripts/mech_metric.mjs`（共享指标核心）、`mech_metric_scenarios.mjs`（合成验证，重构为导入核心）、
> `mech_probe24.mjs`；`reports/mech-metric-scenarios.md`、`probe24.md`、`probe24-foldcache.json`（搜索缓存，可重跑）。
> **度量**：不进入运行时字节路径（无 Δ）。

> **待决事项（延续 §13 + 新）**：①"生产机械基线 vs embedding 复核"配对实验仍在队列（回退链第 4 步）；
> ②预算 oracle 揭示的"稀疏开火 3.2× 收益"→ 后验聚簇/预算门机制的 probe25 候选；③ v3 指标可作 probe25 的验收口径。

---

## 15. 账本快照 v0.2.0-s10：刀税（λ）定标 + 真实语料全网格（probe25 —— 结论：税必要，验收口径定为 λ=0.5/LZ=−4）

> 背景：用户指出"多刀惩罚太小"（72 刀 vs 预算 11 刀的 3.2× 分差）。机制归因 = P=k/m 双曲线边际 +
> LOG_ZERO=−6 地板让搜索被"怕漏成零"推着往密度走。本快照记录**刀税定标与真实语料验证**。

> **合成锚（S9/S10 新增场景，reports/mech-metric-scenarios.md）**：
> 强度锚（m=2n ≤ perf×0.35，m=3n ≤ perf×0.15）把 λ 下限钉在 **0.4**；方向锚（6:1 不翻转，
> "全中+3空刀"不得劣于"漏2翻转"）把上限钉在 **0.85**。**λ=0（现版）违反强度锚——用户判断成立**。
> 几何：raw(λ) = R·P·A·exp(−λ·max(0,m−n)/n)。

> **真实语料全网格（probe25：候选池固定 + 单趟回放缓存组件 + 5λ × 2LZ 即时重排序）**：
> - 税确实改变行为：M7 的 m/n 中位 3.25→1.25（λ0→0.5）、多刀占比 79%→21%、P 0.24→0.30、
>   单意图误开率下降（M4 57%→29%）；代价 = meanLog −2.06→−3.53、零会话 1→4——稀疏后词面
>   不可见翻转（73.4%）匹配不到，R 0.83→0.51。
> - **税后（λ≥0.4）无臂超过 fire-all（−2.59）**：诚实解读 = 密度红利被剥除后纯机械连"全场扫"都
>   打不过——这正是"多刀惩罚太小"批评的量化后果；M4/M5/M6/M7 在 λ=0.4 收敛到 −2.7~−3.6 带内
>   （0.3 log 内），特征族差异被刀税抹平，真实区分度只剩信号覆盖。
> - LZ=−4（更软地板）全面优于 −6（+0.3~0.7 log）——原 −6 地板过狠，是密度偏置的一部分。
> - 验收口径选定：**λ=0.5, LZ=−4**（合成锚区间内；m/n 收敛 ~1.25；holdout 复核同口径）。
> - 单意图守门仍缺失（冠军配置 holdout 双单意图 100% 误开）——独立问题，留给守门机制。

> **验收**：λ 因子逐步核算（本对话 M7 演示配置：D(0.5)=e^(−0.5×78/11)=0.0289，raw 0.12338→0.00356、
> log −5.638）与脚本一致；perf/no-cut/fire-all 不变量同 §14。
> **审计不变**：`src/` 零改动；新增 `scripts/mech_probe25.mjs`、`scripts/mech_metric.mjs`（λ 参数）、
> `reports/probe25.md`、`reports/probe25-poolcache.json`；typecheck 0 错。无运行时 Δ。

---

## 16. 账本快照 v0.3.0：机械判定层整体退役（决策 + 执行记录，新方案：判别器）

> 背景：probe22–25 累计结论——**任何机械臂在诚实口径（λ=0.5/LZ=−4）下不达标且不超 fire-all**；
> 词面覆盖率 26.6%（73.4% 翻转纯语义，机械结构上不可见）；单意图误开 holdout 100%。用户决策：
> **删除全部机械优化，彻底重构**——任务边界改为判别器（语义判定）承担：
> 用户消息为唯一边界源、L0 三层（延续词/发起句式/结构事件）快速路径 + LLM 判别、段状态机、
> L1 精确键缓存、schema 强制输出。执行分两步：本快照 = 机械层退役 + Phase A（L0 规则语料验证）。

> **退役对象（src 全清，无痕）**：
> - `src/task/boundary.ts` → 删除，替换为 `src/task/explicit.ts`（仅保留显式 `/task` 指令 =
>   回退链第 1 步"用户可控指令"，与 `userMessageText` 文本提取供判别器组装；T1 信号
>   合议/分数表/阈值/词汇意图词/簇迁移/todo 完成信号全部删除）；
> - 投影 fold（projection.ts）：删除信号收集（pendingEvidence）、簇迁移目录评估、turn 作用域
>   合议（decideBoundary）；段边界只来自显式指令（判别器接口待接入）；tool/todo/turn 事件
>   不再参与判定（返回同一引用）；
> - 事件载荷（events.ts/graph-hook/orchestrator）：TaskBoundarySignal 移除 kind/evidence
>   机械证据字段，只留边界事实 taskId；
> - 状态形状：pendingEvidence/seenDirs/pendingDir/pendingDirCount/lastUserMsg 移除；
>   TaskRecord 去 kind/evidence；**stateVersion 3 → 4**（旧 checkpoint 失效，ver 门）；
> - 测试：tests/boundary.spec.ts → tests/explicit.spec.ts（T0 + 文本提取）；
>   projection.spec.ts 删除 T1 信号/簇迁移/合议用例，新增"机械措辞不再触发边界"回归断言；
>   compaction-fold.spec.ts 状态形状同步 v4。**52/52 通过，构建通过**。

> **保留资产（非机械、继续服役）**：压缩域（compaction/driver/range）、事件总线
> （task-boundary/task-compacted）、段头锚（anchorText = 段头用户消息原文，判别锚静态基准）、
> M0 惰性哲学（判别失败回退 continue，无动作）、v3 指标（判别器验证配对 Δ 口径）、
> scripts/reports/datasets 全部验证工件（Phase A/B 基线来源），机械探针脚本保留为历史证据。

> **审计（本次有 src 改动）**：`src/` 变更如上；`stateVersion=3` → `4`；typecheck 0 错；
> 构建通过；unit 52/52。目录：`src/task/{boundary.ts→explicit.ts}`、`tests/{boundary→explicit}.spec.ts`。

> **Phase A（下一步，docs/07 §17 播报）**：L0 规则（延续词/发起句式）在 21+2 真实会话上统计
> ——拦截率、翻转泄漏（GT 翻转被 L0-continue 拦截必须=0）、L0-new_task 一致率、单意图误开。
> 达标门槛（预注册）：翻转泄漏 0；L0-new_task 标注一致率 >95%；单意图误开 <10%。

---

## 17. 账本快照 v0.3.0：Phase A 播报（L0 规则语料验证——句式假设被证伪，语义判定确证为主路径）

> 预注册门限（docs/07 §16）：翻转泄漏=0；L0-new_task 一致率>95%；单意图误开<10%。
> 运行：`node scripts/phase_a_l0.mjs`（101 条用户消息空间：21 会话 + 当前会话，u≥1 共 1107 条；
> GT 翻转 75 个，均不来自 u=0）。

> **结果（reports/phase-a-l0.md）**：
> - 翻转泄漏 = **0（PASS）**：L0-continue（延续词整体匹配）没有误伤任何翻转；
> - L0 总拦截率 **1.2%**（continue 1.0% / new_task 0.2%）——真实语料的延续与翻转消息几乎
>   全是长语义文本，不是两字词；
> - **L0-new_task 句式匹配：0/75 抓中、精度 0.0%、单意图误开 1 条（FAIL）**——"帮忙/帮我…"
>   前缀在单意图会话内同任务反复出现（74a1b607 u=5），且真实翻转形态全无发起句式。

> **取证（翻转形态抽样，12 条）**：法文否定切换（"non enleve ces service"、"laissons tomber
> tout ca on va utiliser le meme service"）、新主题引入（"a quoi sert …"、"il faut migrer les mails"）、
> 粘日志报错（docker/redis 栈）、超长 CI 脚本。**无可枚举句式——与旧机械 26.6% 词面覆盖
> 同源教训：语义翻转只能语义判。**

> **决策与结论**：
> ① L0-new_task 句式匹配**不进生产**（证伪，且"帮我…"前缀已被证明不可作高置信信号）；
> ② L0-continue **保留**为极窄免费通道（安全、零成本、1% 价值）；
> ③ 确定性边界通道收敛为：显式 `/task`（回退链第 1 步，用户可控）+ L0b 结构事件
>   （plan/todo/goal 状态迁移，本语料无 plan 状态故未统计——harness 状态侧，确定性不依赖语料）；
> ④ **98.8% 用户消息必须语义判定 → 判别器 LLM 是唯一主路径，成本账 = ~600 token/消息；
>    Phase B（判别器配对验证）是成败唯一变量**，L1 缓存只防重放不降语料调用。

> **审计**：`src/` 无再改动（§16 退役后恒定）；新增 `scripts/phase_a_l0.mjs`、`reports/phase-a-l0.md`；
> 判别器接口（含 L0 保留规则表）待 Phase B 验证达标后接入。

---

## 18. 账本快照 v0.4.0：判别器接入主循环（三层容错 + 溯源图 + 观测模式）

> 背景：Phase B 达标（v2.2 定稿：minimax 92.3%、三面 92/90/94，docs/07 §17 前文 + phase-b-v22.md）。
> 用户定调：当前实例是活环境（人在用），接入必须三层隔离（装载/行为/运行期）、错误可追溯
> （溯源图依赖关系 + 结构化日志），观察模式先跑、不改变任何行为。

> **接入面（docs/10 挂点表新增行）**：`session/event`（`user/message` 输入面：append +
> `source.kind==='user'` + 主会话（parentSession 缺省）+ 非伪 user + 非空文本；u=0 首条交给投影隐式开段）。
> 输出：`context-economy/judge-recorded|judge-error|judge-verdict`（log-only）+ 权威日志行
> `context-economy: judge record <json>`（一行一条，可 grep 回放）。段状态机消费 `judge-verdict`
> 为下一步（本快照只到 verdict 通道，不写任何状态机/flag）。

> **三层容错（用户可核实的实事）**：
> - 装载隔离：不重启/不写 patch/不写 package.json——热注入通道（dev_inject_plugin），失败=拒绝注入
>   （预检拦截自杀 + 失败回滚旧代，dev_self_test 全链路 PASS）；卸载即净（fiber dispose）。
> - 行为隔离：`discriminator.mode`（默认 **observe**）——只记台账/日志/事件；不写段状态机、
>   不发边界信号；mode='active' 才发 `judge-verdict`（且仅 verdict=new-task）；'off' 不挂载。
> - 运行期容错：事件处理器同步快速返回（异步旁路，绝不阻塞主循环）；每条路径 try/catch
>   （错误链 JudgeError{phase,code,message,action}，动作=degrade/fallback/skip，一律不外溢）；
>   LLM 带 AbortSignal+timeoutMs（默认 15s）；并发闸 maxConcurrency=4 + 排队上限 64（超出记
>   overload 跳过）；配置经 resolveConfig 深合并（部分 config 不丢默认字段——防启动崩溃）。

> **溯源图（每次判定 = 节点，依赖 = 边）**：
> - `JudgeRecord`（节点）：judgeId=`j:{sessionId}:{seq}`（幂等覆盖）、触发路径（explicit/
>   l0-continue/l1-cache/llm/error-fallback）、verdict、调用参数快照、窗口事实、modelView、
>   LLM 事实（usage/耗时/finish）、错误链；
> - `sources[]`（边）：preset（DISC_PRESETS v1）/config（物化值指纹）/capability
>   （DISC_CAPABILITIES v1 条目）/runtime（resolveModelInfo 快照）/prompt（版本+窗口指纹）/
>   context（段头+窗口内容指纹）——任一"为什么"可沿边回溯到来源版本；
> - 错误可追溯：phase 归因（config/context/prompt/model-info/stream/parse/emit/journal）+
>   降级动作 + 一句人话摘要；台账环表（journalLimit=256）+ 统计（judged/l0/llm/errors/errors）。

> **判定口径（与 Phase B 同构，测试口径=生产口径）**：
> - 窗口 v6 冻结：anchor=段头（投影 anchorText，≤350 头截断）/ patches=锚后 target 前最近
>   2 条（≤350）/ target ≤800（头 600 尾 200 中缀截断）；模板 v2.2 定稿（datasets 同源断言）；
> - 自适应链：发送档位 = resolveModelInfo 运行时许可 ∩ DISC_CAPABILITIES 验证层
>   （sanitizeEffort；交集外不发送=默认档）；'off' 只在能力表外（DSH 语义 off=省略参数）；
> - L1 精确键缓存（cacheLimit=1024；键含配置面——重放防重不降语料调用；解析失败不写缓存防坏票）。

> **审计（本次有 src 改动）**：新增 `src/discriminator/{trace,l0,prompt,journal,engine}.ts`；
> 修改 `src/{config,index}.ts`、`src/task/events.ts`、`src/discriminator/presets.ts`
> （materialize 过滤 undefined 覆盖）；config 新增 discriminator.mode/maxConcurrency/timeoutMs/
> cacheLimit/journalLimit/historyWindow/messageExcerptChars（均带默认值）；typecheck 0 错；
> 构建通过；unit 76/76（既有 52 + 新增 24：tests/discriminator.spec.ts）。docs/10 挂点表补判别行；
> docs/03/01/00 状态指针更新（机械信号表退役标注）。

> **度量（本快照起可观测）**：judgeCount / judgeErrorRate（errors/记录）/ judgeCacheHitRate /
> judgeLatencyMs / judgeLLMUsage（input/output/cacheRead）/ l0CaptureRate / l0Leak
> （L0-continue 翻转泄漏，必须保持 0——phase-a-l0.md 验证基线）。

> **预注册验证（下一步，观察模式验收口径）**：① 热注入后当前实例真实消息流判，记录涌现；
> ② 判定 vs 实际会话走向配对 Δ（真实流量上与 Phase B minimax 92.3% 基线对齐）；
> ③ 错误链全为 0（observe 3 天内无 judge-error）；④ l0Leak=0。达标后用户批准 → mode='active'
> 单会话试点 → 全局默认；每步可回滚（uninject 即净 / 关开关）。

### 18.1 账本快照 v0.4.0-runtime1：真实实例判账号本（含 Bug 2 修复前后对照）

> 触发：判别器接入主循环后的首个真实判定快照（观察模式，行为零影响）。
> 位置：`~/.dsh/context-economy/judge-records.jsonl`（追加式，judgeId 幂等回放源）。

| judgeId 尾号 | trigger | verdict | latencyMs | 错误链 | totalTokens | costUsd（ops 定价） |
|---|---|---|---|---|---|---|
| 2405373 | error-fallback | continue | 7 | MODEL_INFO_FAILED:degrade, STREAM_FAILED:fallback | — | — |
| 2409517 | error-fallback | continue | 5 | MODEL_INFO_FAILED:degrade, STREAM_FAILED:fallback | — | — |
| 2411941 | llm | continue | 632 | — | 892 | 0.0002423 |
| 2412392 | llm | continue | 1746 | — | 916 | 0.0002802 |
| 2415225 | llm | continue | 1284 | — | 918 | 0.0002501 |
| 2420363 | llm | continue | 1187 | — | 960 | 0.0002627 |

> **对照结论（这正是 docs/07 要的配对 Δ）**：
> - 前 2 条（2405373/2409517）为 **Bug 2 时期实例**：latency 5–7ms、MODEL_INFO_FAILED+STREAM_FAILED
>   ——根因是 Cordis 代理 getter 对未声明 `inject` 的服务属性访问抛 "cannot get property without
>   inject"，判别器一直 `ctx.llm` 属性访问失败（修复：显式 `ctx.get('llm')`，官方免注入读取路径）。
>   此 2 条是修复前的"假零成本"证据——**当时 docs 的判别成本是估值，不是实盘**。
> - 后 4 条（2411941 起）为修复后实例：全部 trigger=llm、零错误链、latency 632–1746ms、
>   单条成本 ≈ 0.00024–0.00028 USD。2411941 为 probe 注入的伪造 user/message（链路验证用，
>   见 reports/probe-parrot.md）；2412392/2415225/2420363 为用户真实消息触发。
> - 观察模式验收口径（§18 预注册验证）：① 记录涌现 ✓（6 条，4 条 llm 实判）；
> ④ l0Leak=0 ✓（本快照无 l0-continue 记录，无不命中泄漏）。②与③ 待持续观测。

### 18.2 账本快照 v0.4.0-runtime2：settings 配置通道 + 判别器阶段化重构（无行为 Δ）

> 触发：v0.4.0-runtime2（settings 动态配置 + GUI 卡片 + judge() 阶段化重构）。纯结构/装配重构，
> 判定行为零变化：**无新增判定语义**，账本不产生新记录类型。可观测变更 = 配置来源与挂载语义。

| 观测点 | 快照 | 证据 |
|---|---|---|
| 判账号本 | 6 条（3 llm 实判 + 2 早期 Bug 2 失败 + 1 probe），无新增 | judge-records.jsonl |
| settings namespace | `context-economy` 注册 ✓，schema 全字段 + 默认值，applies=live，value=解析配置 | settings.describe 输出 |
| 配置写入 | revision 0→1（mode=off）→2（observe）；user 层 mutation 持久化 | settings.update + describe |
| mode 切换 | off：判别器 hook 26→25（卸载）；observe：25→26（重挂重应用配置） | events._hooks['session/event'] |
| 测试 | 85/85 绿（新增 3：config-defaults 双源防漂移） | vitest |
| 类型/构建 | host tsc 0 错；client tsc 0 错；client.js 18.98kB（Loader 契约） | tsc/tsdown |
| 行为一致性 | judge() 阶段化（312 行→210 行 + 3 私有方法），硬约束"行为零变化"由 30 判别器用例兜底 | tests/discriminator.spec.ts |

> **与 §18.1 的关系**：§18.1 是判别器接主循环（账本涌现）；§18.2 是配置面/结构面变动（行为零变化），
> 账本记录数不升是预期——不是回归，是重构无 Δ 的证明。
>
> **client 端 GUI 验证（待重启）**：settings 写入链已在本实例实测（host 侧）；浏览器卡片渲染与
> 保存交互需 dsh 重启后按 docs/12 §9 验收项目视确认（client-modules 无全量重扫路径）。

### 18.3 账本快照 v0.4.0-runtime3：配置卡片 UI 重构（无行为 Δ）

> 触发：v0.4.0-runtime3（配置卡片按分组/下拉/品牌化重构 + 吉祥物）。纯 client 外表层变更：
> 配置 schema 与判别逻辑零改动，无新增判定语义——账本不产生新记录类型。

| 观测点 | 快照 | 证据 |
|---|---|---|
| 判账号本 | 7 条（4 llm 实判 + 2 早期 Bug 2 失败 + 1 probe），无新增 | judge-records.jsonl |
| 可编辑字段 | 21 → 21（分组：装配 4 / 判别 2 / 容错 6 / 高级 7）；`promptVersion` 移除用户暴露（保留 schema 内部字段） | client/controller.ts |
| 字段形态 | 枚举→`<select>` 下拉；数字→步进+单位；布尔→复选框；文本→placeholder | client/controller.ts |
| 品牌化 | DeepSeek 官方蓝 #4D6BFE/#4166D5；四组配色区组 + 编号标题 + 折叠 | client/Card.tsx |
| 吉祥物 | MIT whale-maid.png（DeepSeek-Whale-Girl）缩放 192px → base64 data-URL 内嵌 | client/assets/whale-maid.png + client/mascot.ts |
| 恢复默认 | CLIENT_DEFAULTS 镜像 CONFIG_DEFAULTS（可选覆盖清空） | client/controller.ts |
| 测试 | 85/85 绿（config-defaults 双源防漂移不变；行为零变化由 30 判别器用例兜底） | vitest |
| 类型/构建 | host tsc 0 错；client tsc 0 错；client.js 18.98kB → 104.25kB（含吉祥物 base64） | tsc/tsdown |
| 行为一致性 | 配置 schema 未改；仅 UI 暴露收窄（promptVersion → 内部字段），判别逻辑零动 | src/config.ts / client/controller.ts |

> **client 端 GUI 验证（待用户刷新）**：卡片已热重载（lib/client.js 刷新 + fiber 重建，dev_reload_package）；
> 浏览器刷新设置页后按 docs/12 §9 视确认（分组/下拉/恢复默认/吉祥物渲染；判账号本 call 字段反映新配置）。

### 18.4 账本快照 v0.6.0：配置组件库重构 + 判别器默认 off（唯一行为 Δ）

> 触发：v0.6.0（自研 token 组件库 + 分级精简 + 模型路由下拉 + ?浮窗 + 二次确认 + revision-fence）。
> **唯一行为 Δ = `discriminator.mode` 默认 observe→off**（判别器默认不挂载，零成本）；
> 其余为纯 client 外表层/默认呈现变更，无新增判定语义、无新增记录类型。

| 观测点 | 快照 | 证据 |
|---|---|---|
| mode 默认 | `'off'`（schema `.default()` + CONFIG_DEFAULTS + CLIENT_DEFAULTS 三源同改） | src/config.ts / client/field-model.ts |
| 行为影响 | 默认 off → `mountDiscriminator` 门（`mode!=='off'`）不挂 → 判别器零 judge 调用、`judgeCount` 归 0 | src/index.ts:96 / docs/12 §5 |
| 判账号本 | 默认配置下不再新增（判别器不挂载）；observe/active 由用户显式开启后继续记账 | judge-records.jsonl |
| 挂载/卸载 | 配置卡片把 mode 切 observe/active → hook +1（重挂应用新配置）；切 off → hook −1（卸载） | events._hooks['session/event'] |
| 可编辑字段 | 21 → 21（分级：核心 6 + 调节 5 + 排障 6 + hidden 4：compressionDriver + provider/model 由复合路由接管）；`mode` 默认显示 off | client/field-model.ts |
| 字段形态 | 原生 `<select>`/`<input type=checkbox>` → CeSelect/CeToggle/CeNumber/CeText/CePath（自研） | client/components/* |
| 模型路由 | provider/model 自由文本 → 复合下拉（预设三源 + `session.modelCatalog()` 目录合并 + 手动填写） | client/Card.tsx ModelRouteSelector |
| 帮助浮窗 | 长说明收进 CeTip（"?" 浮窗，in-place 绝对定位，不裁切） | client/components/CeTip.tsx |
| 危险确认 | 「恢复默认」+ CeConfirm 二次确认（危险红）；复原/放弃用 `--dsw-alias-state-error-primary` | client/components/CeConfirm.tsx |
| 高安全 | save 用 `scope.mutate(ops, basedRevision)` revision-fence；conflicted 提示刷新；parse 精确错误文案 | client/controller.ts |
| 测试 | 96/96 绿（新增 field-model 10 + config-defaults mode=off 回归断言） | vitest |
| 类型/构建 | host tsc 0 错；client tsc 0 错；client.js 104.25kB → 141.99kB | tsc/tsdown |
| 行为一致性 | 除 mode 默认外，判别器/压缩/输入域逻辑零改动 | src/ 无判别逻辑改动 |

> **为何默认 off**：observe 只记账零行为收益，却每消息一次 LLM 判定（主路径约 98.8% 消息）；
> `judge-verdict` 仅 engine 发、无消费端。默认 off = 判别器不挂载 = 零 token 支出。
> 需测量/主动编排时，用户在配置卡片的"判别模式"显式选 observe/active。
> **诚实边界**：默认为 off 后，`judgeCount` 类度量默认归 0，直到用户开启——这是默认变更的预期后果，
> 不是回归。跨配置的对比实验需显式记录 mode 档位。
>
> ### 18.5 账本快照 v0.6.1：配置卡片 UI 打磨（零行为 Δ）
>
> > 触发：用户 4 点打磨反馈（弹层被侧边栏裁切 / 顶部蓝条夹角 / 重置钮无背景 / `·`+序号改图标）+ 第二轮
> > （大折叠与模式常驻 / 纯 hover 浮窗 / 加减钮填充居中 / 标题对比度 / 选项系统提示弱化 / 文案严谨化）。
> > **零行为 Δ**：无 schema、判别器、压缩/输入域逻辑改动——纯 client 外表层呈现变更，无新增记录类型。
>
> | 观测点 | 快照 | 证据 |
> |---|---|---|
> | 弹层定位 | 浮窗/下拉/确认弹层全 `position:fixed` 视口定位 + z-index 3000/3500；祖先链核实无 transform/filter（读 AppFrame/PluginsSettingsSection .css 确认），fixed 不被 `overflow:hidden` 裁切 | client/components/popover.ts |
> | 大折叠 + 模式常驻 | 四组包进「设置项」大折叠默认收起；`discriminator.mode` 上提卡片头部常驻，组内 skipField 不重复渲染 | client/Card.tsx |
> | 帮助浮窗 | CeTip 纯 hover（无 click 兜底），120ms 悬停缓冲桥接 6px 间隙；不占布局、最上层 | client/components/CeTip.tsx |
> | 选项系统提示 | CeSelect 拆「值+浅色提示」对齐结构；`（跟随预设）/（默认）` 等为 labelTertiary 副文案、纯提示项整行浅色斜体 | client/components/CeSelect.tsx |
> | 加减步进钮 | `--dsw-alias-fill-l2` 填充底 + hover 高亮 + flex 居中（字形基线偏移已修） | client/components/CeNumber.tsx |
> | 标题对比度 | 组标题 `--dsw-alias-label-primary`，品牌色仅图标/描边/渐变/主按钮 | client/components/CeGroup.tsx |
> | 文案 | 卡片描述「自动识别对话节点，在合适的时机帮你压缩上下文、节约 token。」；字段 hint/docs 按同一句式重写 | client/field-model.ts / client/Card.tsx |
> | 测试 | 96/96 绿（field-model 10 + 既有 86 不变） | vitest |
> | 类型/构建 | host tsc 0 错；client tsc 0 错；client.js 141.99kB → 149.08kB | tsc/tsdown |
> | 行为一致性 | 判别器/压缩/输入域逻辑零改动；产包自包含（无 react-dom/createPortal/dsh-api-remotes 引入） | src/ 无逻辑改动 / lib/client.js grep |
>
> ### 18.6 账本快照 v0.6.2：真·悬浮弹层 + 主题感知配色 + 原生 V + 父级层级（零行为 Δ）
>
> > 触发：根因修复（弹层落位丢 `position:fixed` → static 撑布局）+ 用户 4 点（真悬浮/下拉无滚动条+渐变/
> > 内容一致性/大胆配色）+ 原生同款 V + 设置项父级层级。**零行为 Δ**：纯 client 外表层，无 schema/
> > 判别/压缩逻辑改动，无新增记录类型。
>
> | 观测点 | 快照 | 证据 |
> |---|---|---|
> | 弹层真悬浮 | 根因修复：`popover.ts` 落位 `setFixed({position:'fixed',left,top})`——此前落位丢 position 掉成 static、撑布局；现浮窗/下拉/`?`/确认真 fixed、不占布局、压最上层 | client/components/popover.ts |
> | 下拉浮层 | 显式取触发钮实宽（fixed 下 `minWidth:100%` 不再塌成视口宽）；`.ce-scroll-panel` 隐藏滚动条 + 保留滚轮；可滚动时顶/底透明→面板底色渐变预告（pointer-events:none） | client/components/CeSelect.tsx |
> | 原生同款 V | 提取 `IconChevronDownOutline14` 原生 path（自包含 `Chevron`，不 import 官方图标包）；组头/设置项/下拉触发钮全用，rotate 表达开合 | client/icons.tsx × components |
> | 主题感知配色 | 去所有硬编码 hex（`#4D6BFE/#4166D5/#0ea5e9/#7c3aed`/`DS_BLUE*`）；改用 `--dsw-alias-state-{business,success,warn,error}-{primary,tertiary}`（亮/暗自动换值）；`tint()` color-mix 做透明 | client/theme.ts × Card/CeButton/CeGroup/CeSelect |
> | 功能区语义色 | 四组 accent/tint = business(蓝)/success(绿)/warn(琥珀)/error(红)；图标+开态描边+浅底；正文仍 `label-primary` | client/field-model.ts / client/CeGroup.tsx |
> | 下拉项配色 | 选中 = 品牌浅底 + 左 3px 类别竖条 + 值加粗 + **绿勾**(success-primary)；每选项带类别彩色指示条（`tone` 望色生义）；系统提示 gray(tertiary) | client/components/CeSelect.tsx |
> | 父级层级 + 对齐 | 「设置项」= 父容器（bg-layer-1+border+圆角+分区标题行）包住四子组；取消横向缩进（CeGroup body 去 paddingLeft+borderLeft）→ 模式行与组字段同一竖线 | client/Card.tsx / client/components/CeGroup.tsx |
> | 模式常驻 | `discriminator.mode` 常驻卡片头部（零次点击），组内 skipField 不重复渲染；展开大折叠前两项默认开 | client/Card.tsx |
> | 文案一致性 | mode 字段 hint 补「（测量）」与下拉 observe 选项逐字一致（新增 spec 断言） | client/field-model.ts / tests/field-model.spec.ts |
> | 测试 | 97/97 绿（新增 1 条 mode 文案一致性）+ 既有 96 不变 | vitest |
> | 类型/构建 | host tsc 0 错；client tsc 0 错；client.js 149.08kB → 155.33kB | tsc/tsdown |
> | 行为一致性 | 判别器/压缩/输入域逻辑零改动；产包自包含（无 react-dom/createPortal/dsh-api-remotes/官方图标包引入） | src/ 无逻辑改动 / lib/client.js grep |
>
> ### 18.7 账本快照：配置卡片稳定性与间距补丁（零行为 Δ，随 v0.6.2）
>
> > 触发：模型下拉框残留"文字型复原"胶囊 / 「复原」出现时布局微晃 / 子标题胶囊+贴身 / 字段无间距+单位挤数值空间。
> > **零行为 Δ**：纯 client 外表层；无 schema/判别/压缩逻辑改动，无新增记录类型。
>
> | 观测点 | 快照 | 证据 |
> |---|---|---|
> | 模型下拉去复原 | `ModelRouteSelector` 删除"文字型复原"胶囊（下拉复位 = 选「（跟随预设）」）；`modified` 变量一并清除 | client/Card.tsx |
> | 复原预占位 | 「复原」胶囊改为**预留固定 56px 右槽**（flex:0 0 56px，常驻空槽，出现/消失零位移；可扩展：后续右侧控件自然接到同排，不遮撞） | client/components/FieldRow.tsx |
> | 保存按钮稳定 | `保存修改`/`保存中…` 用 `minWidth:88` 预占位，文字切换不再挤动「放弃修改」 | client/Card.tsx |
> | 提示行稳定 | hint 行固定 `minHeight:14`，正常↔错误/换行不上下跳 | client/components/FieldRow.tsx |
> | 子标题去胶囊 | 组标题改扁平行（去 border/圆角），展开/悬停 `group.tint` 浅底；accent 图标+主色标题+N 项+原生 V | client/components/CeGroup.tsx |
> | 内容列间距 | 父容器「设置项」`padding:6px 12px`；「模式」常驻行 `padding:0 12px` → 与组内字段共用同一根 12px 竖线 | client/Card.tsx |
> | 数字控件定宽 | `CeNumber` input 固定 `100px`（5 位范围值均可完整显示）+ `[−]28[＋]28` + **unit 独立 48px 槽**；控件 `fit-content` 不再挤满整行；单位不挤占数值空间，所有数字行对齐 | client/components/CeNumber.tsx |
> | 链接/激活色 | 手动填写（高级）/从列表选择模型/重试 + `CePath` 激活边框 + `CeToggle` 默认 accent 全由 `brandPrimary`（中性）改 `businessPrimary`（品牌蓝，望色生义） | client/Card.tsx / CePath.tsx / CeToggle.tsx |
> | 测试 | 97/97 绿（既有断言不变） | vitest |
> | 类型/构建 | host tsc 0 错；client tsc 0 错；client.js 155.33kB → 155.09kB | tsc/tsdown |
> | 行为一致性 | 判别器/压缩/输入域逻辑零改动；产包自包含 | src/ 无逻辑改动 / lib/client.js grep |
>
> ### 18.8 账本快照：数字控件整行化 + 复原零位移（零行为 Δ，随 v0.6.3）
>
> > 触发：数字字段仍是 `fit-content` 窄带，与下拉框/文本/路径整行制式不一致（"太窄+不对齐+单位挤数值"）；
> > 「复原」虽预留 56px 槽仍因"有无按钮行高不同"垂直微晃；`+/−` 上下不居中。
> > **零行为 Δ**：纯 client 外表层；无 schema/判别/压缩逻辑改动，无新增记录类型。
>
> | 观测点 | 快照 | 证据 |
> |---|---|---|
> | 数字控件整行化 | `CeNumber` 改**整行框**（与 CeSelect 触发区同高/同描边/同底色/同圆角）：可编辑数值 `flex:1` 撑满，与其它字段左缘/右缘同位 | client/components/CeNumber.tsx |
> | 步进钮升级 | `+/−` 文字钮改为**上下 chevron（沿用 CHEVRON_PATH 原生 wide-V，up/down 旋转）**，一组两钮 embed 整行尾部，fillL2 底 + borderLeft 分隔"编辑区/步进区"，hover 加深变色；视觉+可点区更统一 | client/components/CeNumber.tsx |
> | 单位统一贴后 | 单位右对齐浅色（`paddingRight:9`），统一贴到步进列左侧（"放置在后"），不再挤数值、跨行同位 | client/components/CeNumber.tsx |
> | 复原零 reflow | 「复原」**始终渲染、仅 `visibility:hidden` 切换**（占位恒定）→ 出现/消失连垂直方向也不跳；叠加 `disabled`+`tabIndex=-1`+`aria-hidden`，鼠标/键盘/读屏均无法命中隐藏态 | client/components/FieldRow.tsx |
> | 聚焦/步进交互 | `focus-within` 时框边 `businessPrimary`（invalid 恒 `errorPrimary`）；步进钮 hover `交互底`+文字加深 | client/components/CeNumber.tsx |
> | 测试 | 97/97 绿（既有断言不变） | vitest |
> | 类型/构建 | host tsc 0 错；client tsc 0 错；client.js 155.09kB → 156.28kB | tsc/tsdown |
> | 行为一致性 | 判别器/压缩/输入域逻辑零改动；产包自包含 | src/ 无逻辑改动 / lib/client.js grep |
>
> ### 18.9 账本快照：下拉框滚动渐变淡出（修复定位 bug）（零行为 Δ，随 v0.6.3）
>
> > 触发：下拉框可滚动但看不到"还有内容"的渐隐提示——渐变 div 用 `position:absolute` 却**只设了
> > `left/right`、漏 `top/bottom`**，落位到滚动列表**下方**静态位置而非列表上/下边缘，故滚到底/滚开时
> > 无淡出。作用域仅本插件下拉（CeSelect），「设置项」展开区仍随外层滚动、不引入内部滚动。
> > **零行为 Δ**：纯 client 外表层；无 schema/判别/压缩逻辑改动。
>
> | 观测点 | 快照 | 证据 |
> |---|---|---|
> | 渐变落位修复 | fade 顶/底各加 `top:4`/`bottom:4`（对齐 fixed 面板 4px padding），两块渐变真正叠在列表上/下边缘；方向不变（顶=menu→透明，底=透明→menu），与滚动检测 `scroll.up/.down`（>1px / 未达底）联动 | client/components/CeSelect.tsx |
> | 淡出明显度 | 高度 18→30px（约盖住一行选项）+ 边缘 22% 保色平台（menu 先实后虚线性下滑）→ 边缘仅少量内容时也清晰可辨；100% 处收尾透明，不形成硬边 | client/components/CeSelect.tsx |
> | 作用域 | 仅本插件下拉（CeSelect 唯一实现，模型路由/选择字段全复用）；「设置项」不加内部滚动 | client/Card.tsx / CeSelect.tsx |
> | 测试 | 97/97 绿（既有断言不变） | vitest |
> | 类型/构建 | host tsc 0 错；client tsc 0 错；client.js 156.28kB → 156.38kB | tsc/tsdown |
> | 行为一致性 | 判别器/压缩/输入域逻辑零改动；产包自包含 | src/ 无逻辑改动 / lib/client.js grep |

---

## 19. 账本快照 v0.7.0：压缩"性价比"真实化（tool/result 积重 + 真实定价 + 缓存固定三路盘）

> 本快照记录**离线测量 harness 升级**（回答用户"用真实后续任务成本 + 固定标准衡量性价比"）：
> 不改任何生产 `src/` 判定逻辑，**无运行时 Δ**（纯 scripts/ + datasets/ + reports/）。

> **改动对象（scripts/ 层）**：
> - `mech_replay.mjs`：canonical 会话模型扩展——每个 U 新增 `userTokens`/`assistantTokens`/`resultTokens`
>   （`tokensOf = ceil(chars/4)`，与 fidelity 同标准）；DSH 解析在 `tool/result` 事件里用递归 `collectText`
>   抽取真实工具结果文本。**这是把此前"只留 user 文本、丢掉工具结果"的缺陷补齐**——`resultTokens` 才是
>   `compoundedVolume`（积重）的大头。
> - 新增 `scripts/compaction_cost_bench.mjs` + `datasets/model-pricing.json`（opencode-go 用户提供的
>   真实定价，含 input/output/cache-read/cache-write）→ `reports/compaction-cost-bench.md`。
> - `compaction_fidelity.mjs` 未动（方向 1 文本侧）；本次是**性价比侧**独立盘。

> **实测（DSH 归档，3 个带工具结果的会话）**：tool/result token≈1,053,143；单 U 峰值 72,390；每 U 平均
> result≈3,989 vs user 文本≈54（claudeset 无 tool/result，故其积重=0；积重大头确在 DSH 工具结果）。

> **成本模型（固定标准，新盘）**：span(T)=Σ user+assistant+**result**；digest=100t；research=800t；
> 节省$（前瞻）=(span−digest)×roundsAfter×cacheRead（压缩把 span 换 digest ⇒ 其后每轮按 cacheRead 重读省）；
> 重发现$=research×[input+roundsAfter×cacheRead]×reRefCount（重搜索结果首次进入按 input、其后每轮按 cacheRead）；
> 净收益=节省−重发现；冷盘另计摘要生成（digest×output×被压任务数）。

> **三路盘结果（retainChars=16000；20 会话；$/session，5 轮 measure 稳态 + hash PASS 字节一致）**：

| model（input$/M / cacheRead$/M） | A1 净 | A2 净 | A3 净 | 最优 |
|---|---|---|---|---|
| GPT 5.6 Luna（0.20/0.02） | 0.701 | 0.710 | **0.712** | A3 |
| GLM-5.3-Flash（0.15/0.03） | 1.114 | **1.132** | 1.126 | A2 |
| MiMo V2.5（0.14/0.0028） | 0.052 | 0.050 | **0.056** | A3 |
| Muse Spark 1.2（0.10/0.002） | 0.037 | 0.035 | **0.040** | A3 |
| DeepSeek V4 Flash Vision Exp（0.22/0.007，当前 agent） | 0.183 | 0.182 | **0.190** | A3 |
| Hy3（0.14/0.035） | 1.315 | **1.336** | 1.328 | A2 |

> **判定（诚实版）**：① 计入 tool/result 真实积重后，**三臂净收益全为正**——直接回答"即使重发现，
> 前面的积重节省可能更大"为**成立**；② 整体倾向 **A3（近因门）**（6 模型里 A3 最优 4，含当前 agent；
> A2 仅在高 cacheRead/input 价比的两款——GLM-Flash 0.20x、Hy3 0.25x——以 <2% 相对优势居首）；
> ③ **A2 vs A3 的经济学枢轴 = cacheRead/input 价比**：cache-read 便宜（MiMo/Muse/DS-Flash ~0.02–0.03x）
> → 重读本来就便宜 → A2 多压省不了多少 → A3 靠更少重搜胜出；cache-read 贵 → 重读省钱多 → A2 胜。
> ④ **诚实限定**：$ 模型不含 A2 压 hot 任务的**质量风险**（丢信息→下游犯错，非经济隐性成本）与摘要
> 内容保真度；agent loop 端到端成本仍需 live-session 冒烟。

> **审计**：`src/` 零改动（判定/压缩/配置/schema/`stateVersion` 均未动）；typecheck 0 错；vitest 145/145；
> 新增工件如上；无运行时字节路径变化（无 Δ）。

### 19.1 账本快照 v0.7.0：效果门补测（更正 §19 的"A3 默认"结论——该结论基于错误假设）

> 触发：用户质疑"你检查任务效果了吗？是否按任务情景制定检查与打分、确保每个策略达到**统一要求**后再算成本，
> 还是它们报完成就算完成？"——**说得对**。§19 只算 token/$，**没测任务效果**，默认"压缩不破坏下游任务"未经验证。
> 本快照补上**统一效果门**（新增 `scripts/compaction_effect_gate.mjs` → `reports/compaction-effect-gate.md`），
> 并由此**更正 §19 的错误结论**。`src/` 零改动，无运行时 Δ。

> **统一效果门（对全部策略/模型同门槛，确定性）**：被压任务 T 的 digest（预算 **800t**，因其是结构化 schema
> `purpose/decisions/artifacts/touchedFiles/pending/triedRejected/verbatimSpans` 的一个完整 JSON 对象，几百 token
> 才是合理体积，**不是 100t**）必须背得动下游对其内容的复用需求（行级 verbatim 复引 token）。复用 ≤ 预算 ⇒ pass；
> 否则 ⇒ fail（digest 太小、压掉必丢、下游任务效果被破坏）。

> **效果门读数（retainChars=16000，当前 agent DeepSeek V4 Flash Vision Exp，$/session）**：
> A1 fail 11/31（35.5%）净 0.0092；A2 fail 12/64（18.8%）净 0.0155；A3 fail 11/27（40.7%）净 0.0071。
> digest 敏感性（当前 agent）：digest=100t → A1/A2/A3 fail = 14/22/12；200t → 13/20/12；400t → 13/16/12；800t → 11/12/11。
> **A2 在更大预算下 fail 塌缩、净收益领先** —— 因 A2 压的"近因热任务"真实下游复用少（实测热区 avg 15,968t vs
> 冷区 43,115t，峰值 58,177t），大预算轻松 pass；A3 只压冷区老任务、老任务下游复用需求大、易 fail。

> **更正（诚实，两处）**：
> ① **§19"默认 A3"是错的**：基于**没测效果** + **武断 digest=100t**（把结构化摘要当 100t prose），错误假设让
> A2 显得"压 hot 有害"。真实预算下 A2 更可能占优。
> ② **现在也不能反过来断言"A2 最优"**：效果门有**可测位置偏置**——冷/老任务积累更多下游复用，部分是因为
> 它们之后有更多下游回合（positional bias），而这恰好只惩罚 A3。故 A2-vs-A3 **效果高下无定论**。
>
> **符合证据的工程落点**：①digest 预算必须按真实结构化摘要体积配置（几百 token）；②在 A4 参考拦截
> （docs/15 蓝图：文件/符号引用索引，可消除 bias）落地前，**默认保持 `native`（A1）**最稳——它破坏中等
> （fail 11–14）且不引入"未验证是否破坏热任务"的激进动作；③A2/A3 取舍取决于 A4 参考拦截 + docs/08 质量门
> （LLM 摘要器是否真产出高保真 schema digest）——那是 Direction 2 的实质工作。

> **审计**：`src/` 零改动；新增 `scripts/compaction_effect_gate.mjs`；`mech_replay.mjs` 增加
> `us[u].assistantText`/`resultText`（供 verbatim 复用检测，canonical 扩展）；typecheck 0 错；
> vitest 145/145；无运行时字节路径变化（无 Δ）。

## 20. 账本快照 v0.8.0：输入域闭环——语义票接入投影合议（active 模式生效）

> 触发：用户确认下一步 = 输入域闭环（judge-verdict 消费端接入段状态机）——phase-b-v22 已验证
> v2.2 × minimax 92.3%，但 `judge-verdict` 只有 engine 发、无消费端（docs/03 §5 自指"属下一步接入"），
> 判别器开到 active 也不影响边界。本快照把断线接上。

> **机制（回退链第 2 步，平面 L0）**：判别器（active + verdict=new-task）把语义票**追加为会话日志事件**
> `context-economy/judge-verdict`（`session.append`，与 `todo/write` 同先例：log-only、non-surface、
> 不进模型历史、可回放）；投影 fold（`src/task/projection.ts`，纯函数）消费它做**段内切分**：
> 旧段闭合于目标消息的前一条 surface 事件，新段以判定消息为段头开启（锚 = 判定原文）。
> **合议语义**：T0 显式（/task）天然优先（verdict 落在段起 seq → no-op，同 seq 已是权威边界）；
> fail-lazy（无当前段 / 目标不在当前段 / 不在 surface → no-op 同引用，绝不改写闭合段历史）；
> verdict 迟到（后续消息已入旧段）→ 尾部随新段迁移——折叠序无关，重放确定。

> **代码落点**：
> - `src/task/events.ts`：`SessionEventMap` 声明合并（`context-economy/judge-verdict`，载荷
>   `{judgeId, seq, verdict, anchorText}`）；cordis 事件保留（live 总线）；
> - `src/discriminator/engine.ts`：`finish()` 增 `verdictCtx`（会话 + 目标消息原文）——active +
>   new-task 时 `session.append`；7 处调用点全部传入；append 失败 fail-lazy（仅日志）；
> - `src/task/projection.ts`：fold 增 verdict case + `applySemanticVerdict`；`stateVersion` 4 → 5
>   （fold 语义变化 → persisted checkpoint 失效）；位置语义注意：**段头（锚）消息无 surfaceIndex
>   条目**（v4 既有）——目标位置 0 ⇒ 前驱 = 段锚 startSeq，位置 >0 ⇒ 反查 pos-1。

> **行为 Δ 声明（诚实）**：默认档（`discriminator.mode='off'`）**零行为**（不挂载）；
> observe 模式**零行为**（不 append verdict 会话事件、不动状态机）；仅 active 模式生效：
> new-task verdict → 会话日志 +1 事件（log-only，non-surface）→ 投影切分。投影 fold 对
> 无 verdict 事件日志的行为与 v4 一致（单测：`未装配判别器` 组）。

> **审计**：typecheck 0 错；vitest **153/153**（新增 projection.spec「语义票合议」8 例：
> 切分 / 迟到尾随迁移 / 早到-迟到边界事实一致 / T0 权威同 seq no-op / continue no-op /
> 过期 no-op / 不可定位 no-op / 无 verdict 行为同 v4；stateVersion=5 断言）；`lib/` 已重编译
> （tsc EXIT=0）；client 未动（无 client Δ）。

> **验证边界（诚实记录）**：单测覆盖 fold 与事件契约；**运行时端到端**（真实会话 active 模式
> 下 verdict → session.append → 投影切分 → orchestrator 压缩触发）需 live-session 冒烟
> （默认 off 下无运行时路径变化，装配即净）。

---

## 21. 账本快照 v0.8.0-harness：native 控制 cache-reuse 组装保真修复（无运行时 Δ）

> 触发：为 `native-auto`/`manual-habit` 控制加「ASSEMBLY 组装不变量」确定性断言时，
> 断言抓出一个**测量保真度 bug**：native 压缩器的 `prefix` 用 `[system, ...regionMsgs]`，
> 会**丢掉 system 与压缩区间之间的所有消息（含 index 1 的任务指令）**，导致压缩器调用
> 不再是主会话的 genuine prefix → 真实网关下 KV-cache miss，`cacheReadTokens`
> 被系统性低估（`compressionCacheHitRate` 是 E3 压缩效率的核心对比指标，见 AGENTS.md）。
> 修复为 `messages.slice(0, end + 1)`（会话 up to & 含区域末端——genuine prefix）。
> 全部改动在 `experiments/evalground/`（离线 harness），**`src/` 零改动，无运行时 Δ**。

> **改动对象（evalground/scripts 层）**：
> - `lib/runner.mjs`：native 压缩路径的 cache-reuse 前缀 `[system, ...regionMsgs]` →
>   `messages.slice(0, end + 1)`（注释更新；删死变量 `regionMsgs`）；新增 `compressSnapshots`
>   （每次 native 压缩的精确 pre/post 消息列表，供组装断言与离线审计）。
> - `lib/gateway-mock.mjs`：`createScriptedGateway` 记录 `req.messages` 时改为**调用时刻快照**
>   （此前记录的是活引用，runner `messages.length=0; push(...)` 原地重建后 log 读到终态，
>   污染任何读 `req.messages` 的回放/组装审计；`createRecordingGateway` 本就 JSON.stringify 于调用时刻，不受影响）。
> - `tests/assert-controls.mjs`：新增 **ASSEMBLY** 断言组（AS1–AS9，逐次压缩），以真实
>   `compressSnapshots` + 网关 `req.messages` 校验两条**组装-代码约束**（非模型补全）：
>   (a) cache-reuse——压缩器请求是 pre-compression 会话的 genuine prefix（否则 cache miss）；
>   (b) 单节点重建——`[start..end]` 坍缩为恰一个 `<compacted-summary>` 节点，头/尾逐字节不变、
>   恰好一个 tag 对、被压实区域的消息不残留。

> **度量影响（诚实声明）**：离线 mock 下 `cacheReadTokens` 由脚本显式给定，本修复不改 mock 读数；
> 修复作用于**真实网关运行**（`gateway.mjs`）下压缩器调用的缓存复用正确性——此前 cache-read 会虚低，
> 修复后 `cacheReadTokens`/`compressionCacheHitRate` 反映 DSH-native 实际行为。**无数字 Δ 可报**：
> 由确定性组装不变量（AS3/AS5–AS9 全绿）验证，非模型测量；未重跑真实网关对照实验。
> `src/` 判定/压缩/配置/schema/`stateVersion` 零改动——生产运行时字节路径不变。

> **审计**：`src/` 零改动；typecheck/N/A（evalground 为 .mjs 无 TS 编译）；`npm run ground:assert`
> 全量 5 文件 **ALL ASSERTIONS PASS**（含既有 O3–O9/V12–V13 缓存观测回归断言，确认 gateway
> 快照改动未破坏记录/回放/usage 读取）；无运行时 Δ。

---

## 22. 账本快照 v0.8.0-harness：压缩域 A1×A2 网格 4 臂落地（无运行时 Δ）

> 触发：用户要求把「四个实验臂」设计落地 + 低成本核验 + 试运行读结果与上下文组装查一致。
> 方向确认 = **A1×A2 网格 4 臂**（EXPERIMENT.md §3 可落地规格收敛：A1-S1 近因门·保尾压头 /
> A1-S2 闭合即全压 × A2 方案0 保留原始 / 方案1 信息块展开），叠加在 task 边界压缩主触发上。
> 全部改动在 `experiments/evalground/`（离线 harness），**`src/` 零改动，无运行时 Δ**。

> **改动对象（evalground/scripts 层）**：
> - `arms.config.json`：新增 **4 臂行** `self-s1-orig` / `self-s1-expand` / `self-s2-orig` /
>   `self-s2-expand`（均 `compression:'task-boundary'` + `a1` + `a2` + `decision` ledger）。
> - `config.mjs`：新增 `KNOWN_A1 = ['s1','s2']` + 校验 `row.a1`。
> - `assemble.mjs`：新增 `renderBlocks`（信息块 4 类渲染），`renderProduct` 派发 blocks 产品。
> - `runner.mjs`：task-boundary 分支接 `a2`（此前丢失，E4 产物从未真正落地）+ 读 `opts.a1`
>   实现 **A1 近因门**——新增 `splitRecentTail`（冷区压头 + 近因尾逐字保留，cold 是前缀保缓存），
>   S1 内容仍在近因尾内时 defer（不压），S2 每闭合 task 全压；`task-compact`/`decision` 记录 `retainedTokens`。
> - `run-one.mjs` / `run-cascade.mjs`：透传 `arm.a1`。

> **改动对象（新增断言 `tests/assert-arms-grid.mjs`，全量套件第 6 个文件，已注册 `lib/assert.mjs`）**：
> - ARMS-A：4 臂声明 + 校验 + 覆盖 A1×A2 全交叉。
> - A1-SPLIT：`splitRecentTail` 纯语义（retain=0 全冷 / tiny 尾 / huge clamp / cold 恒为前缀保缓存）。
> - A2-RENDER：`renderBlocks` 渲染 4 类块 + `renderProduct` 派发。
> - TRIAL（低成本试运行，scripted 动态网关）：逐臂读**结果 + 上下文组装**——E1 任务边界触发、
>   E2 压缩单元=task(segmentIndex)、A2 方案0 落盘=semantic(goal,无blocks) vs 方案1 落盘=blocks 且
>   `renderProduct` 成信息块上下文、A1-S2 retainedTokens=0（闭合即全压）vs A1-S1 retainedTokens>0
>   （近因尾保留）、A1-S1 小内容 defer（S1 压缩次数 < S2）。

> **度量影响（诚实声明）**：A1/A2 进入插件压缩域的成本路径（压缩器调用 + 决策成本），
> 但本次仅为**离线/scripted 核验**（无真实网关、无对照实验），故**无数字 Δ 可报**；由确定性
> 不变量（TRIAL-A1..A8 全绿）验证臂语义与设计一致。一旦在 `runCascade` 上配真实网关跑
> E1–E4 对照，`compressionCacheHitRate` / `costPerSuccessfulTask` / `reDiscoveryTokens` 才可报 Δ。
> `src/` 判定/压缩/配置/schema/`stateVersion` 零改动——生产运行时字节路径不变。

> **审计**：`src/` 零改动；`npm run ground:assert` 全量 **6 文件 ALL ASSERTIONS PASS**
> （含既有 RUNNER/ARMS/COMPAT/CASCADE 回归断言，确认 task-boundary 分支改动未破坏既有行为）；
> 新增工件 `tests/assert-arms-grid.mjs`；无运行时 Δ。

## 23. 账本快照 v0.8.0-harness：真实级联循环试运行 + 防损压缩账本（无运行时 Δ）

> 触发：用户「低成本试运行与验证修复，重点关注真实的上下文与循环运作，以及每个分支的重点特性」。
> 前两次（§21/§22）为**单任务/纯函数级**核验；本次用**整条流级联 `runCascade`**（T0..T7 一次会话）
> 离线驱动，读真实循环的上下文组装 + 每分支重点特性，且修掉真实循环里暴露的**防损压缩**缺口。

> **核心发现（真实循环暴露的缺陷）**：`runner.mjs` task-boundary 分支此前把 `cold = splitRecentTail(messages)`
> 作为压缩器输入，而**累积压缩块 `## 已压缩任务历史` 位于 `messages[1]`**——第二个压缩段起，
> 压缩器把**自己上一次已压成的累积块再次压一遍**（实测 7 次压缩器调用里 6 次 `contains accumulated
> block: true`）→ **二次损毁（loss compounding）**，违反 EXPERIMENT.md §9「压缩段...永不参与下次压缩」
> 与 §3 已压缩边界防语义漂移。修复：压缩器输入改为 **`live = messages.slice(freshStart)`**（freshStart=1
> 首压无块 / 2 有块），即**只压本段未压缩新增**，累积块永不重喂；`a2` 产物仍按累积段渲染进上下文块。

> **改动对象**：
> - `runner.mjs`：task-boundary 压缩输入从整串 `messages` 改为**块之后的新增面**（`freshStart` 切片），
>   压缩器前缀 `[system, ...cold]`；`pressuredTokens` 用 live 面（去掉块自身）。
> - `run-cascade.mjs`：透传 `calibrated` / `compressionDomain` / `maxSteps` / `maxCompressions` 到 `runSession`
>   ——此前未转发，`native-auto` 对照在级联里**永远退化（never-compressed）**，离线无法驱动；断言级联修复。
> - 新增断言 `tests/assert-cascade-loop.mjs`（全量套件**第 7 个文件**，已注册 `lib/assert.mjs`）。

> **新增断言（`assert-cascade-loop.mjs`，离线 scripted 网关 + 真实投影 fold 边界标记）**：
> - MASTER：`markCascadeBoundaries` 用真实投影 fold 把 T0..T7 切为 **8 段**（T0..T6 各 1 段、T7 三消息=1 段），
>   记录真实判别成本（9 judgements）。
> - S2O / S2X：S2（闭合即全压）**每闭合段边界压一次**（seg1..seg7 = 7 次，E1 触发/E2 task 单位），
>   所有 `task-compact.retainedTokens=0`；A2 方案0 落盘=semantic(goal,无blocks) / 方案1 落盘=blocks 且
>   `renderProduct` 成信息块上下文；**防损**：7 次压缩器调用全部 `refeed=0`（不再重喂累积块）。
> - S1：near-term gate 在小内容下**全 defer**（S1=0 < S2=7）；在真实多消息面（read 大文件产生 tool 结果）下
>   **压冷头、保留近因尾**（5 次 compact 全部 `retainedTokens=8000 > 0`，且次数 < S2）——A1-S1 的「保尾压头」。
> - NAT：`calibrated` 覆盖下 `native-auto` **可驱动（不退化）**；每成功压缩 1 快照；压缩器请求是
>   `before` 的**真前缀**（KV 缓存复用）+ checkpoint = **单一** `### <compacted-summary>` 节点。

> **度量影响（诚实声明）**：仍为**离线/scripted 核验**（无真实网关、无对照实验），故**无数字 Δ 可报**；
> 本次价值在**真实循环里发现并修复防损压缩缺陷** + 验证各分支在真实级联中与设计一致（7 文件全绿）。
> 一旦配真实网关跑 E1–E4 对照，`compressionCacheHitRate` / `costPerSuccessfulTask` / `reDiscoveryTokens`
> 才可报 Δ。`src/` 零改动——生产运行时字节路径不变。

> **审计**：`src/` 零改动；`npm run ground:assert` 全量 **7 文件 ALL ASSERTIONS PASS**
> （含既有 RUNNER/ARMS/COMPAT/CASCADE 回归，确认 runner 修正未破坏既有行为）；
> 新增工件 `tests/assert-cascade-loop.mjs`；无运行时 Δ。测试自恢复 `boundaries/CASCADE.*` 不再污染。

## 24. 账本快照 v0.8.0-harness：真实 API 级联试运行（A1×A2 × native-auto，真实网关）

> 触发：用户「真实 api 试运行与验证修复，重点关注真实的上下文与循环运作，以及每个分支的重点特性」。
> §22/§23 为离线/scripted；本次**配真实网关 `createGateway()`**（opencode zen，凭据已探活 HTTP 200）
> 跑**整条流级联 `runCascade`（T0..T7 一次会话）**，executor = `hy3`（scores.config 固定）、
> 判别器 = `minimax-m3`、judge 跳过（`skipScore:true` 省成本）。**单次复现**（非配对 Δ，见诚实声明）。

> **真实边界标记**（判别器 minimax-m3，非 scripted）：整条流判出 **5 段**——T0 / T1-T3 / T4 / T5-T6 / T7。
> 注意：**真实判别器把 T1+T2+T3 合并为一段**（`continue`）、T5+T6 合并一段——这是真实语义，与 §22 的
> 8 段 scripted 不同，故真实级联只有 **4 个闭合边界**（seg1..4）。决策真实成本 = **$0.00634 / 9 judgments**。

> **真实 5 臂结果**（同 8-task 流，同模型；`finished:false` = maxSteps=60 在第 8 长任务未收口）：

| 臂 | finished | comp 次数 | task-compact（seg:retained） | execUSD | compressUSD | compTokens | 总USD | 缓存命中% |
|---|---|---|---|---|---|---|---|---|
| self-s2-orig | false | 4 | 1:0, 2:0, 3:0, 4:0 | 0.1517 | 0.01665 | 107247 | 0.1747 | 82.3 |
| self-s2-expand | false | 4 | 1:0, 2:0, 3:0, 4:0 | 0.1148 | 0.00756 | 98353 | 0.1287 | 86.7 |
| self-s1-orig | **true** | 3 | 2:8000, 3:8000, 4:8000 | 0.2323 | 0.00825 | 41247 | 0.2469 | 88.3 |
| self-s1-expand | false | 3 | 2:8000, 3:8000, 4:8000 | 0.1668 | 0.01351 | 75898 | 0.1867 | 88.1 |
| native-auto | false | 2 | —（whole-surface） | 0.1729 | 0.00339 | 16613 | 0.1826 | 92.5 |

> **每分支重点特性（真实上下文组装，非 scripted）**：
> - **E3 保留**：S2（orig/expand）**每闭合段压**（seg1..4 全 `retained=0`=闭合即全压）；S1（orig/expand）
>   **近因门保尾压头**——seg1 **defer**（内容仍在近因尾内），seg2..4 压冷头 + `retainedTokens=8000`
>   近因尾逐字保留，且 **S1 压 3 次 < S2 压 4 次**（近因门生效）。
> - **E4 产物**：方案0（orig）落盘 = **semantic**（goal/steps/fileStream/compressed，无 blocks）；
>   方案1（expand）落盘 = **真实信息块** `plan/impl/verify/wrap`（如 seg2=10 块：wrap 结论 + plan 目标 +
>   impl 文件坐标 + verify 命令）。——两者都是真实模型产出，非 mock。
> - **E2 范围/触发**：task 边界自动（真实判别器段界），压缩单元 = task（segmentIndex）。
> - **对照组 native-auto**：whole-surface 压 **2 次**（非退化），checkpoint 单一 `<compacted-summary>`；
>   缓存命中率最高（92.5%，整面前缀复用，无累积块阻断）。
> - **防损压缩（§23 修复）在真实成立**：各臂真实产物是**单段**摘要（seg2=T0 答案、seg3=审查+文档、seg4=修复），
>   不重压先前段——累积块未重喂。
> - **0 gateway-error、0 hard-truncate** 全臂——真实循环无请求失败、无溢出截断。

> **关键权衡（真实，诚实记录）**：task-boundary 臂**排除累积块**（防损，§23）后，压缩器前缀
> `[system, ...cold]` 不再是整面对**真前缀**——seg1 命中缓存（`cache=3328/6464`），但 seg2..4 部分
> `cache=0`（累积块插在 system 与 live 之间**阻断前缀**）。**压缩缓存命中率 Task-boundary < native-auto**
> （native 整面替换单节点、前缀恒连续）。这是「防损（永不重喂块）」与「压缩调用缓存复用」的**真实权衡**：
> 保持块不重喂则牺牲压缩调用的前缀缓存。executor 主请求缓存不受影响（执行成本含 1.2M+ cacheRead）。

> **诚实声明（重要）**：本次为**单次复现、非配对 Δ**；且 **4/5 臂 `finished:false`**（maxSteps=60 在长任务
> T7 未收口），故 exec 成本**不可直接比作倾向结论**（未完成的臂执行成本偏低）。仅可作**机制验证**：
> 真实循环跑通、每分支特性（E2/E3/E4）与设计一致、防损修复在真实成立、0 请求失败/0 溢出截断。
> **不做「哪臂更省」结论**——那需 ≥3 复现配对 Δ + 质量门（judge），见 EXPERIMENT.md §7。`src/` 零改动
> （仅 `experiments/evalground/` 与 `docs/`）——生产运行时字节路径不变。

> **审计**：真实网关探活 200；5 臂真实级联 0 gateway-error / 0 hard-truncate；
> 全量离线断言 **7 文件 ALL ASSERTIONS PASS**；本次无 `src/` 改。1 次复现（非结论性 Δ）。

> ### 24.1 补记：缓存差是「规模」还是「结构」？（scale-敏感性分解）
>
> 触发：用户追责「你读的是原文吗（发送前检查上下文组装）」「对照是否因为规模太小才缓存低」。诚实回答需
> 分解清楚，故生成本节——它是**对 §24 关键权衡的补充**，非推翻。
>
> **① 取证方式（诚实说明）**：§24 的「每分支符合预期」系**代理信号 + 离线断言套件**（运行中观测
> `retained/tc/产物块`，离线断言在压缩域模拟验证同一组不变量），**非发送前逐字读 `messages`**；逐调用
> transcript 已被清理、不可复现。故「符合预期」= 指标反推 + 离线断言，非原文核验。
>
> **② 规模 vs 结构分解（确定性 LCP 前缀缓存模拟，`cached_tokens` = 与上一次同路由请求的最长公共前缀）**：
> 把两个候选因子分开扫（`rounds`=每边界间增量工具工作，`segs`=边界数）：
>
> | 隔离因子 | 扫法 | 聚合缓存命中率差 native−task-boundary |
> |---|---|---|
> | **rounds**（每边界间 append 工作量） | segs=20 固定 | rounds=3 → **27.1**；10 → 16.0；30 → 8.3；80 → **3.9** |
> | **segs**（边界数 = 压缩次数） | rounds=8 固定 | segs=5 → 13.5；20 → 17.8；50 → 15.9；100 → **14.1**（main 命中钉在 ~88%，不随 native 的 99.7% 走） |
> | 大数据规模（两者同增的「真实大任务」代理） | 5,3 → 30,12 → 60,20 | 18.4 → 13.8 → 9.0（缓慢收敛，未归零） |
>
> **结论**：
> - **是「规模」但不全是**：决定性变量是 **`rounds`（每边界之间的增量工作量）**，不是绝对 token 数。
>   真实任务在任务边界间做大量工具轮 → task-boundary 聚合命中**收敛向 native**（rounds=80 时差仅 3.9）。
>   因此「小任务把压缩调用占比放大、拉低聚合」这部分成立。
> - **有一个真实存在、不随规模消失的结构性残留**：固定 `rounds` 只增 `segs`（边界数），差值**停在 ~14–17**
>   不收敛（tb 主命中 ~88% vs native ~99.7%）。根源即 §24 记录的**每边界付一次低缓存调用**：
>   块插 index1 + 防损不重喂 → 压缩机调用只复用到 `[system]`，且**每个边界后首个主调用也只复用到 `[system]`**
>   （native 原位替换保住 `[system,task]` 头、且压缩机输入是真前缀，故无此残留）。此成本按**边界密度**
>   （每单位增量工作压几次）缩放，非按任务规模。
>
> **度量（诚实声明）**：这是**机制模拟**（结构忠实），不是复现——绝对数值依赖 token 画像（真实任务上下文
> 40–60K、每段工具轮数多，故真实 tb=82.3% 高于本法 scale A 模拟的 68.4%，方向一致）；逐调用 transcript
> 已删不可复现。故本节只用于**解释差值构成**，不用于下「哪臂更好」结论。
>
> **设计推论**：要想让 task-boundary 的缓存贴上 native，需在不破坏[system,task]稳定头的前提下做**原位单节点
> 替换**（而非在 index1 长一个累积块），或让压缩机输入成为真前缀——这正是 native 的两招；task-boundary 的
> 防损（块不重喂）与它们互斥，二者取其一是 §24 已定的设计取舍。

> ### 24.2 补记：缓存占比低 ≠ 总 token 多——「总 token 更少」只在特定条件成立
>
> 触发：用户重框架——「相比原生，长期工作下我们的方法缓存占比下降，但实际总 token 更少，对吗？」。本节
> 验证该重框架：**缓存占比（cacheRead/input）本就不是目标，总 token 与总成本才是**。用与 §24.1 相同的
> LCP 前缀缓存模型，叠加 runner 成本公式（`fresh×P_in + cache×P_cache + out×P_out`，hy3
> in0.14/cache0.035/out0.58 per M），跟踪 **total input + 成本 + fresh 拆分**（非只看占比），在三种负载下
> 比 native / tb-S2(retain=0) / tb-S1(retain=8k)。

> | 负载（segs × rounds） | 臂 | 缓存分数% | 总 input | 总成本$ | Δinput vs native | Δ成本 vs native |
> |---|---|---|---|---|---|---|
> | 深长 50×12 | native | 96.1 | 23.31M | 1.069 | — | — |
> | | tb-S2(retain=0) | 86.9 | 17.67M | 1.029 | **−24.2%** | **−3.7%** |
> | | tb-S1(retain=8k) | 88.2 | 22.83M | 1.252 | −2.0% | +17.1% |
> | 浅多边界 80×4 | native | 95.4 | 12.35M | 0.583 | — | — |
> | | tb-S2 | 77.0 | 12.94M | 0.879 | +4.7% | +50.8% |
> | | tb-S1 | 77.6 | 16.22M | 1.063 | +31.3% | +82.3% |
> | 短级联 8×6 | native | 94.3 | 1.35M | 0.068 | — | — |
> | | tb-S2 | 75.6 | 0.553M | 0.0485 | −59.1% | −29.1% |
> | | tb-S1 | 79.8 | 0.943M | 0.068 | −30.4% | −0.7% |

> **结论（对用户假设的精确回应）**：
> - **「缓存占比更低」——对**（native 94–96% vs tb 75–88%），这是机制决定（§24 关键权衡），稳健。
> - **「总 token 更少」——只在特定条件成立**：
>   - **S2（闭合即全压，retain=0，无近因尾）在深任务下总 input 确实更少**（50×12 时 −24.2%），成本略降
>     （−3.7%）；短任务亦更少（−59%）。**成立**，但**收益是边际的**，且**来源是 S2 丢掉近因尾**。
>   - **S1（近因门·保尾压头，retain=8k，保留近因尾）总 token 与 native 相当或更多，成本反而更高**
>     （深任务 +17.1%）。因为 S1 保留了与 native 相同的近因尾（节省有限），却**多付了每次边界的压缩开销**
>     + 低缓存 → **不成立**。
>   - **浅任务多边界（80×4）下，S2/S1 都更贵**（+50.8%/+82.3%）——每次边界的压缩开销（fresh + output）
>     超过省下的上下文。**不成立**。
> - **所以「总 token 更少」不是方法的一般属性**，而是「**S2 全压 × 深任务、让省下的上下文超过压缩开销**」的
>   特定组合。其成本优势的来源是**近因门的质量取舍**（S2 丢近因细节目录换 token），非免费午餐。

> **度量（诚实声明）**：这是**确定性机制模拟**（结构忠实：native 按阈值持续压、上下文有界；tb 每边界压），
> 绝对数值依赖 token 画像（RETAIN=8k / THRESH=40k / PROD_UNIT=650 / NATIVE_PROD=900）。按 AGENTS.md
> 「derived 值不得进入结论」——**本节只用于解释权衡结构，不得当作真实成本结论**；真实成本结论需 ≥3 复现
> 配对 Δ + 质量门（EXPERIMENT.md §7）。`src/` 零改动（仅 `experiments/evalground/` 与 `docs/`）。

## 25. 账本快照 v0.8.0-harness：压缩域 PTC 工具化改造 + 严格原生对照（实验域，无运行时 Δ）

> **改动内容（全在 `experiments/evalground/`；`src/` 零改动）**：
> 1. **压缩器 = PTC 式**（`lib/code-run.mjs` worker_threads seam + `compressor-io.mjs` 绑定 + `sdk.mjs`/`compressor-prompt.mjs` 严格指令）：模型**写程序**（不调工具），一次 LLM 调用 + 一次代码运行 + 确定性校验（M1 一次完成，无模型迭代）。
> 2. **输出/指针代码化**（M2）：产物 = 总-分 `[summary]+[typed subtask1..K]`；指针（path/lineRange/symbol）由 `locate_change` 从真实转录/文件计算，`validate_pointer`+`verifyRefGroundTruth` 验真；**展开（A2 方案1）= harness 侧 `resolve_pointer` 替换**，模型从不嵌入内容。
> 3. **压缩比检查**（M3）：有效 ≤0.5、>0.75 fail-lazy（产物不入上下文）、提示词 ≤45%、区域 <3000 tok 免查。
> 4. **S1 引用化保尾**（M4）：保留 = 最后子 task 的 refs+outline（无原文、≤8 refs/≤40 tok）；**下次压缩整片删除**（不重喂、不重压）；S2 无保留。
> 5. **缓存修复**（M5）：删 `freshStart` 切块；旧分节留在压缩器前缀（FROZEN 提示词排除）；累积块单体字符串 → **每分节一个不可变消息节点**（只增不改，跨压缩前缀字节稳定）。
> 6. **M0 严格原生对照**：native-auto/manual-habit 压缩范围 `messages.slice(2)` → **`slice(1)`**（含 task，与真实 native 头锚定一致——此前"保留 [system,task] 固定头"是**改良版 native**，已修正）。
> 7. **验证门 V0–V5**：离线模板电池（真实绑定+真实 fixture，56 断言）→ 小样真实 LLM（4 模式全 PASS）→ 提示词契约（23 断言）→ 短真实流程审计（覆盖矩阵 M0–M5 全 PASS，含 1 次真实模型方差被 fail-lazy 安全兜住）→ 全量离线断言 9 文件 ALL ASSERTIONS PASS。

> **度量影响（诚实声明）**：
> - **无运行时 Δ 可报**——本轮是**实验域机制替换**（E1–E4 对照的臂语义更新），不是插件运行时行为变化；真实成本结论仍需配对 Δ（Δ=臂−基线）+ 质量门，按 EXPERIMENT.md §7 执行。
> - 本轮真实网关试运行观测（非结论）：压缩器真实调用 4 次（2 臂 × 2 压缩），首次调用 **cacheRead=1792**（真前缀缓存命中）；产物 ratio 全 effective（0.03 量级）；PTR-TRUTH 0 违例；OUT 0 泄漏。**中间量只作归因诊断，不入判定**。
> - 新观测字段进 scorecard/transcript：`task-compact.retain/retainedRefs/ratio/ratioVerdict/sections`，`compress.ratio`——供 E3/E4 判定与归因诊断。

> **已验证不变量（机械断言，`tests/`）**：M1 一次完成（每压缩 1 程序）；M2 schema/PTR-EXIST/PTR-TRUTH/展开内容；M3 ratio 阈值两侧 + fail-lazy；M4 S1 保留节点渲染+下次删除、S2 无保留；M5 压缩器保留 FROZEN 前缀（system+分节）字节不变、分节跨压缩不可变；OUT 无原文回显（harness 展开内容豁免）；M0 范围含 task；运行期错误（语法错/超时/超限/未知绑定）→ fail-lazy。

## 26. 账本快照 v0.8.0-harness：死配置清理 + 臂表瘦身 + 成本账本抽取 + runner 解耦 + 级联语义修正 A/B（实验域）

> **改动内容（全在 `experiments/evalground/`；`src/` 零改动）**：
> 1. **P0 死配置清理（零行为变化）**：`scores.config.json` 删除指向不存在臂的 `baseline`、删除无消费者 `weights`/`humanBandMap`；`arms.config.json` 删除无消费者 `default`、删除 `self-compact` 的无效触发字段；README 评审模型表述与配置对齐（GLM）。
> 2. **P1 臂表瘦身（协议 6 臂）**：历史 V1/V2/V3/X 系列 20+ 实验臂清出；`self-compact`（=s2×方案0）并入 `self-s2-orig`；默认臂改 `native-auto`；同步改写断言（Y1–Y5/TE1/ARMS1–4/CASCADE-RUN1–5）——diff 仅含有意改动的断言标签。
> 3. **P2 成本账本抽取（纯搬家）**：`run-one.mjs` 与 `run-cascade.mjs` 手写且已漂移的成本块 → `lib/cost-ledger.mjs`（`executionCostOf`/`judgeCostOf`/`compressionCostOf`/`decisionCostOf`/`collectCompressUsage`/`makeRunLogger`/`safeLogJson`）；两边差异**先原样保留**（级联的 judge 缺账留到修正 A 处理）。
> 4. **P2 runner 解耦（纯搬家）**：`runner.mjs` 主循环约 480 行内联五套压缩分支 → `lib/runner-compress.mjs`（`wholeSurfaceStep`/`taskBoundaryStep`），主循环每分支一行调用；事件写入顺序、条件、日志文本、快照形状逐字节不变。
> 5. **语义修正 A（级联补记 judge 成本）**：`run-cascade.mjs` 原来**写死 `judge` 为空**（级联实际跑了逐 task 评审）→ 逐 task 聚合真实 judge usage（`judgeUsageAgg`，subjective 不入账，与 run-one 口径一致）；门控按 **token** 判定（单采样 judge usage 无 `calls` 字段，calls 门恒假会永远 null——实现期发现并修正）。
> 6. **语义修正 B（切分编号错位）**：`task-compact` 事件新增 `slot`（关闭段最后一条消息的**真实流位置**）；`splitTranscriptByTask` 改用 `slot` 归因（旧代码把**段序号**当消息位置——段跨多条消息时压缩事件记到隔壁 task 窗口）。级联 `costs.judge` 绝对值口径修正（此前所有臂同样漏记 judge 成本，臂间差值不受影响，但"每成功任务成本"绝对值一直被低估）。

> **度量影响（诚实声明）**：
> - **无运行时 Δ 可报**——本轮纯实验域：重构部分（P0/P1/P2）逐字节等价，语义修正仅修正**记账与归因的诊断精度**，不改任何判分/结论通道（判分只看各任务自己的收尾文本与 mech/judge，压缩成本与归因**只作归因诊断，不入判定**）。
> - 级联 scorecard 新口径：`costs.judge` 从 null → 真实 usage 聚合（CJ5–CJ7 断言 usd=0.000105 精确等于生产公式）；`task-compact.slot` 归因（CJ2–CJ4）。
> - **记档知情（用户批注，仅记录不改变行为）**：F1 native 对照触发压力双算（`lastPromptTokens`+当前估算）→ E1 触发时机偏移；F2 硬截断固定 `[system,task]` 前缀 → 极端溢出会丢分节节点（压缩域 5e4 ≪ 地板 2e5，正常不可达）；F3 设计内约定（边界文件存在性、12000/1500 截断）。详见 EXPERIMENT.md §9 记档知情。

> **已验证（机械断言 + 回放比对）**：全量离线断言 **481 PASS / 0 FAIL**（P2b 基线 474 + CJ1–CJ7 恰好 7 项，其余标签与基线逐行一致）；回放比对：同一脚本化假模型喂改前/改后 runner，5 个场景（task-boundary A1/A2、native-auto、manual-habit、legacy mock、hard-truncate）transcript/快照/落盘产物三者逐字节一致；CJ 组断言 7 条（judge 账本非 null + token 精确 504 + usd=生产公式；slot=0 + 压缩事件归因到闭合段 T1、不泄漏到 T2）。

## 27. 账本快照 v0.8.0-harness：原生模拟度审计 + PTC 压缩请求 wire 前缀修复（真实交错证据，实验域）

> **背景**：用户要求诚实核查"原生对照是否高度模拟 DSH"与"代码化/结构化/缓存方案是否生效"。对照全部核实自 `G:\deepseek-harness\packages\compaction\compaction-basic`（DSH 原生包）与 evalground 实现，并新增真实交错观测（`scripts/cache-live-check.mjs`：3×T0 段边界、hy3 真实执行器 + 真实压缩器、注入边界标记、skipScore）。

> **发现 1（原生模拟度，诚实结论：机械层高保真、触发与收缩门两处不符）**：
> - **一致（逐字/等价逐字）**：压缩指令 8 节 + "prior checkpoint 合并"条款 + 检查点前导——程序化字节对比：**PREAMBLE 逐字相同；INSTRUCTION 等长差 1（DSH 1803 / eval 1802，仅末位尾换行 `\n`）**；范围选择（头锚定 surface[0]..cutoff + 尾保 retain + 配对平衡，`region.ts:100-136` ↔ `native-range.mjs` 结构一致，角色近似对扁平消息列表等价）；压缩输入 = system+tools+区域消息逐字 + 指令附加（`region.ts:508-524` ↔ `runner-compress.mjs` `messages.slice(0,end+1)+tools`）；检查点替换语义（range → 单节点头锚定；检查点框架文案一致——evalground 在摘要前后各强制一个 `\n`，DSH 直接拼块，模型输出自带头尾换行时实际等价）。
> - **F1（已知，E1 保真度）**：触发压力 = `lastPromptTokens + estimateMessagesTokens(messages)` ≈ **2× 全量**；DSH = `measurement.totalTokens`（上次 usage 总 + **增量**，`index.ts:304/312`）→ evalground native 触发**早约一半**。
> - **F4（新发现，未修正——有意宽松）**：DSH 有**收缩检查**（摘要 token ≥ 被压区间 token → 抛错，`index.ts:383-388`）；evalground native 分支**无**（仅非空/≥80 字符校验）——控件比真实原生**宽松**，可能接受 DSH 会拒绝的摘要。
> - token 计数：evalground 用 chars/4 估计（粗于 DSH 路由 meter 的 usage 复用）——标定/保留边界位置有估计误差，机制不受影响。

> **发现 2（代码化/结构化：正常生效）**：真实模型（hy3）4 模式直检全 PASS；审计产物 M1（一调用一程序）、M2（总-分 schema + PTR-TRUTH 6 记录 + OUT 0 泄漏）、M3（ratio effective 0.02–0.04，即 ~25–50× 实际压缩）、M4（S1 保留/删除生命周期）全部机械通过。

> **发现 3（缓存方案：曾漏掉一半，已修复并实证）**：M5 原实现只保证**消息级**前缀字节稳定；但 wire 前缀 = **system + tools + messages**——`compressWithProgram` 的 LLM 调用**漏传 `tools`**（`compress.mjs` 原始 `callLLM({provider,model,messages,...})`，vs 原生/语义路径 `tools: prefix?.tools`），提供方缓存在 tools 位置分叉。真实交错观测（修复前）：压缩调用 cacheRead=**128**（≈仅 system 段），执行调用 832→3264 正常。
> **修复**：`compressWithProgram` 增加 `tools` 透传；`taskBoundaryStep` 传 `ctx.makeSchemas()`；`scripts/audit-compression.mjs` M5 断言扩展为 wire 前缀（system+tools+sections）+ 真实转发带上 tools。
> **修复后实证**（同一脚本化观测）：压缩调用 cacheRead **128 → 3008 / 2944**（input 4563/4739，命中率约 62–66%）；执行调用 832→2624 正常增长；离线全量 481 PASS / 0 FAIL；V5 审计全 PASS（M5 wire 断言组含 tools）。

> **诚实声明**：本轮发现的 native 触发偏移（F1）与收缩门缺失（F4）**均未改变行为**（有意保留/记档）；"缓存方案"此前**只部分生效**（消息前缀对齐保证已成立，但 tools 缺失使其在真实传输上大打折扣）——现在 wire 前缀完全对齐并经真实交错验证。E1 解读 native 触发轮数时务必按 F1 偏移修正；若需 F4 对齐，把 DSH 收缩检查移植进 native 分支即可（已定位精确位置）。

> **同装置 native ↔ PTC 成本对照（2026-09-02 补测，`scripts/cache-live-native.mjs`：同 3×T0 流、同真实网关 hy3、同录制；native 用 calibrated {retain 400, threshold 700} 使压力触发可达，PTC 用 task-boundary 触发）**：
> | 压缩调用 | 臂 | input | cacheRead | 命中率 | output |
> |---|---|---|---|---|---|
> | #1 | PTC (S2) | 4563 | 3008 | 65.9% | 2311 |
> | #2 | PTC (S2) | 4739 | 2944 | 62.1% | 4352 |
> | #1 | native-auto | 1314 | 0 | 0% | 148 |
> | #2 | native-auto | 1441 | 960 | 66.6% | 1096 |
> **结论（诚实修正上一轮"量级接近"的判断）**：缓存**命中率**同级（62–66% vs 0→67%），但**单次压缩成本差 3–4×**——PTC 平均 input 4651 / output 3332 vs native 1378 / 622。**结构性原因**：DSH 原生回放 = system+tools+**被压区域**（头锚定，区域即头部前缀，输入小）；PTC 压缩的是**尾部新工作**，回放全量前缀（system+旧分节+新工作，输入大）——以"大输入"换缓存前缀完全对齐 + 压缩器上下文完整。**影响**：压缩器成本是 E3/E4 判分中的真实变量，PTC 的"每次压缩需足够大的回收才划算"门槛比原生高；同装置样本仅 1 流 2 次/臂，方向性结论，非批次判定。**另记录**：本流 native 触发含 3 次 "no compactable range" 退化跳过 + maxCompressions=2 封顶（小流语义），与 PTC 段边界触发天然不同。

## 28. 账本快照 v0.8.1-costfix：失败调用计费入账 + judge/subjective usage 聚合（实验域）

> 背景：2026-09 计费全量核验（4 个真实 run 逐 token 复算全部 8 位一致，账本公式/单价解析/缓存读取均正确）暴露的
> **唯一真实缺口 = 失败调用的 usage 被丢弃**（T4-manual-habit 实测：压缩器输出 8 段全 `(none)` 被拒 → 那次真实
> LLM 调用的 token 不可回放），另有 judge 重试"只记最后一次"的覆盖损失。本轮修复为**审计/计费完整性**，不改判分、
> 不改压缩语义、不改任何臂行为；压缩失败**失败后行为与修复前逐字节相同**（产物不入上下文、继续全上下文）。

> **改动内容（全在 `experiments/evalground/`；`src/` 零改动）**：
> 1. **失败压缩调用入账**：`runner-compress.mjs` 三处失败分支（native whole-surface / legacy whole-surface /
>    task-boundary PTC）追加 `compress` 事件（`ok:false` + `problems[:3]` + **真实 usage**）——`collectCompressUsage`
>    统计全部 compress 事件 → 失败调用的 token 进 `costs.compression`（**零成本失败**——网络错误/mock 的 usage=null →
>    inputTokens=0 → 仍被 `inputTokens>0` 门排除，不污染账本）。`transcript.mjs` validateEntry 增 `ok`（可选布尔）校验。
> 2. **judge usage 全量聚合**：`judge.mjs` judgeOnce 建立 usageAgg，主调用 + strict retry（坏 JSON / 校准怀疑）**每次
>    调用都累加**（此前 `out = retry` 覆盖 → 只记最后一次）；parseFailed/调用失败返回也携带已发生 usage。
>    judgeTask 多采样聚合修正：`cacheReadTokens` 从硬编码 `null` → 真实求和（此前多采样把缓存命中丢弃 → 高估）。
> 3. **subjective usage 聚合**：`subjective.mjs` 3 次尝试的每次调用 usage 累加进返回块的 `usage`（此前只记最后一次）。
> 4. **新断言** `tests/assert-cost-failures.mjs`（已注册）：CF-1 native 压缩失败事件带 usage + collectCompressUsage
>    计入；CF-2 PTC 失败（坏程序→program error→fail-lazy）同；CF-3 judge 重试 usage = 两次调用之和（15/15/calls=2）；
>    CF-4 多采样 cacheRead 保留（3+7 in / 2+4 cr → 10/6）。

> **已验证**：全量离线断言 **ALL ASSERTIONS PASS**（481 基线 + 10 新断言；既有断言无回归——压缩成功路径的
> `compress` 事件未含 `ok` 字段（success 事件不变），失败分支新增事件不影响任何成功路径断言）。

> **度量影响（诚实声明）**：无行为 Δ——失败调用**从未产生过产物**（fail-lazy 语义不变），只是其成本从"丢失"
> 变为"可审计地计入 compression 账"。**口径变化**：凡发生过压缩失败的 run，`costs.compression` 会比修复前
> **略高**（包含失败调用的真实 usage）——这是修复真实低估，不是成本上涨。**已知残留（记档，未改）**：
> ①`rejudge`/`re-score-run` 回填判分后 `costs.judge` 不追加新 judge/subjective 支出（需用户拍板口径：追加 vs 替换）；
> ②docs/07 §24 表 native-auto 行"总USD"与 exec+comp 差 $0.0063（疑似笔误，引用前修正）；③主观评审成本仍不入
> `costPerSuccessfulTask`（设计内：评测固定开销、Δ 免疫，但真实支出已可在 `scorecard.subjectivity.usage` 观测）。

> ### 28.1 补记：留档完整性补齐 + 真实彩排暴露的 judge 模型 bug（AC 组验证）
>
> 背景：计费核验指出"判定层可验证、机制层不可复验"（transcript 是截断摘要；压缩器输入原文与压前/压后快照
> 未落盘；级联 scorecard 只留分数不留判分依据）。本轮补齐为**纯增量留档，零语义/零成本影响**：
> 1. **完整请求日志**（`runs/<runId>/calls.jsonl`）：`runCascade` 对真实网关调用默认自动包 `RecordingGateway`
>    （透明代理：请求原文转发、响应原样返回、每调用多落一行 {req 全文, resp usage}）；离线测试注入 callLLM 时
>    自动跳过（文件清淡），`record:true` 可强制。`createRecordingGateway` 现同时接受 chatCall 函数或网关对象。
> 2. **压缩前后快照**（`compress-snapshots.jsonl`）：每次压缩前/后完整消息列表深拷贝落盘（`lib/archive.mjs`），
>    runCascade 与 runOne 两条入口都接。
> 3. **级联判分细节**：taskBreakdown 扩展 `mechViolations` / `judgeDetail`（dims/antiCheat/notes/usage/
>    calibrationSuspect）/ `subjectivity`（含 usage）；`scorecard.archived = { requestLog, compressSnapshots }` 自述。
> 4. **彩排暴露的判分 bug（真实网关才现形）**：`run-cascade.mjs` 判分循环把未解析的 `opts.judgeModel`
>    （undefined）传进 scoreOne → 真实网关 401 "Model  is not supported"，8 个 judge + 主观评审全部静默失败
>    （离线 mock 不校验模型名，断言从未抓到）→ judgeModel/judgeProvider 改为 runCascade 顶层解析一次并传入
>    判分层；新增 **CJ8** 防回归（注入网关 req.log 探测 judge 调用携带 resolve 后的模型名）。
> 5. **彩排数据（native-auto，8 task，20.6 分钟）**：完成率 8/8（T7 收口，72 步/250 上限，maxSteps=250 充足）；
>    execution $0.2525（4.40M in / 4.11M cache=93.4% / 117.5K out）；compression $0.00479（2 次未退化）；
>    decision null（native 无判别器，正确）；calls.jsonl 17.9MB / snapshots 2 / P.json 落盘。**判分串味问题
>    见 §28.2**（同批彩排发现：全 task 报大面积 scope-violation）。
> 6. **断言**：`tests/assert-archive.mjs`（AC-1 请求日志逐调用全文可回放 / AC-2 快照 before-after /
>    AC-3 判分细节存档）；全量离线断言 ALL PASS（481 + CF 11 + AC 10 + CJ8）。

> ### 28.2 补记：级联判分 scope 串味修复——归属账（writtenPathsOf）+ 任务视角判分（CT 组验证）
>
> 背景（彩排实测暴露）：级联 8 task 共享一个 relaudit 工作区，per-task `mechCheck` 用
> `collectDiff(workspace)`（**最终工作区 vs fixture 全局 diff**）倒推"本任务改了什么"→ 每个任务判分时把
> **先前/后任任务的全部改动**算进自己的账（彩排：T1 报 19 个越界文件、T0 报 readonly-violation、T1/T2 报
> tests-tampered……全部误报；transcript 层已有 splitTranscriptByTask 防串味，**workspace 层没有**）。
>
> **修复（架构：归属账与产物读取分离）：**
> - `mech.mjs` 新增 **`writtenPathsOf(entries)`**：从任务窗口 transcript 的 `tool/write` 事件提取
>   **"这个任务实际写过哪些文件"**（相对路径，去 `./`、`\`→`/`）——"动过就算"的单一事实源，不靠全局 diff 猜。
> - `mechCheck(workspace, task, runner, opts)` 增任务视角输入：`writtenPaths`（归属账）/`transcriptText`
>   （本任务窗口文本）。**scope-violation / diff-empty(readonly) / tests-tampered / data-tampered /
>   answer-leak-attempt 五个检查全部改用归属账与窗口文本**；产物读取（file-exists/pattern/word-count/
>   report-match）仍读最终工作区（每任务产物文件名独立，不受影响）；judge 看到的 `diff` 也换成
>   归属账的 per-task 修改列表（不再全局）。
> - `run-one.mjs`：scoreOne（级联）与 runOne（单任务）**两条判分路径统一传入归属账**（单任务 = 全 transcript
>   的 write 事件，语义与旧 diff 等价且更严——写后又回滚也算"动过"，审计视角正确；无既有断言依赖旧语义）。
> - **断言** `tests/assert-scope-attribution.mjs`（CT-1 T0 只读无违规 / CT-2 T1 越界恰好=自己、不背 T2 的
>   tests 写债 / CT-3 T2 tamper 只记自己、score 归零正确）；已注册，全量 ALL PASS。
>
> **影响**：纯判分层修复；不改执行、不改实验、不改任何臂行为；修复后 scope/readonly/tamper 才是**每个任务
> 自己的真实行为**，质量门（完成率不降 + 盲评不劣）不再被假越界污染——正式批次结论可信的前提。
>
> ### 28.3 补记：F7 特殊事件——T7 tests-tampered 机械归零 → 反事实评级替换（数据调整快照，2026-09-03）
>
> - **现象**：manual-habit 彩排 `CASCADE-manual-habit-mtkrx7zs`：T7 因模型一次"未遂 tests/ 写尝试"
>   （误判 fixture 缺失 → 试图写 `tests/00-gen-fixture.test.js`，write-guard 拒绝、未落盘）被
>   `tests-tampered` 机械归零（mech=0/total=0）；judge 仅判 `suspect`。完整行为链/判定口径/处理决定见
>   EXPERIMENT.md §9 记档知情 **F7**。
> - **处理决定（用户）**：特殊情况——**不重跑、不改任务提示**；按反事实评级**替换评分并标明**。
> - **调整（前 → 后）**：T7 mech 0→**100**（同臂同型 T4/T5/T6 机械全过，tamper 为唯一归零项）、
>   judge 80→**88**（原 80 含 tamper 压分 scope=2，等权评级修正）、total 0→**95**（T4 类比 92 与满分 100
>   间保守居中）；顶层按 8 任务均值重算：total **76→87**、avgJudge **75→76**。
> - **留档**：原始评分 = `runs/CASCADE-manual-habit-mtkrx7zs/scorecard.original.json`（备份）；
>   调整版 `scorecard.json` 带 `adjustment` 标记（T7 条目 + 顶层各一处，含 original/adjusted 双值）；
>   调整脚本 = `.scratch/adjust-t7-score.mjs`。
> - **口径**：敏感度反事实（按应得质量回填），**非精确重判分**；Δ 判读（manual−native）：total 76→**87**
>   （Δ −6 而非 −17）、avgJudge 75→**76**（Δ −7）；正式批次以 3 复现公式为准，F7 按复现频率裁定
>   （≥2/3 系统性 → 任务提示澄清，不动机械规则）。

## 29. 账本快照 v0.9.0-transport：opencode 网关退役 → DeepSeek 官方 API 直连（实验域，2026-09-03）

**改前状态**：传输 = opencode zen 网关（`https://opencode.ai/zen/go/v1`，OPENCODE_GO_API_KEY）；executor hy3 / judge glm-5.3-flash / decision minimax-m3。历史 9 个 CASCADE run 账本见 §24–§28（opencode 时代批次，封存不重跑）。

**改动**：gateway 默认 `https://api.deepseek.com`；凭据链 `EVAL_GROUND_API_KEY → DEEPSEEK_API_KEY`（homedir yaml）；scores.config executor=judge=decision=deepseek-v4-flash-vision-exp（provider deepseek）；判别器预设 V2（deepseek-official）；pricing 补 canonical 行（谷时记账基准 0.22/0.66/0.007 USD/M，官方 RMB 谷时价折算，峰值 2x 行保留）。插件产品面同步：DISC_PRESETS_V2 / DISC_CAPABILITIES_V2、config 默认 deepseek、client 预设路由更新。

**改后实测**（2026-09-03，首批真实调用）：
- 冒烟：`/models` 200（vision-exp 逐字在列）；chat 接受 `max_completion_tokens`；reasoning_content 返回（len 184/131）；共享前缀二连调 cached_tokens 0→640（缓存可观测，官方无 F6 式长固化时序问题——待批次复核）。
- `CASCADE-self-s1-orig-mtlwszja`（--tasks=T0，9 步 21.9s）：finished=true、total=100（T0 无 rubric → judge null 属设计内）；usage 32470 in / 2154 out / **cacheRead 26368（81% 命中）**；costs.execution=$0.00295；compression count=0（单任务无边界的正确行为）；hard-truncate 0。
- `CASCADE-self-s1-orig-*`（--tasks=T0,T1，双任务激活边界压缩 + judge）：见 scorecard 账本（runs/）。

**门禁**：ground:assert 全绿（更新后 O2=api.deepseek.com）；插件 build（host+client）✓；vitest 153/153 ✓（vitest.config.ts 排除 experiments/ 沙箱内容——评测评断言走 ground:assert，不混入插件测试面）。

**§29.1 追记（2026-09-04）：PTC 修复（F9）+ judge 协议 v2 实测快照**

- **E2 三臂判分稳定性测量**（同工件 T1 重判，n=5/臂，15 次调用 ≈$0.17）：none/v1 摆幅 27、sd 9.1；none/v2 摆幅 19、sd 6.4；**low/v2 摆幅 12、sd 4.9、输出 token 4943（−64%）**。决策按预注册规则 → 锁定 **v2 + low + samples=3**。明细表见 `experiments/evalground/reports/judge-stability-deepseek-2026-09.md`。
- **E3/E3b 真实短流**（T0,T1 self-s1-orig）：`mtlze9r5`（指令 v2）拒写消失（refusal:false）但围栏噪声致 type-strip 失败 → 加 `stripProgramFences`；`mtm09n7d`（+围栏剥离 + judge 协议）**task-compact 成功**（ratio=skip 属设计内、S1 retain、pruned=0）、judge samples=3 生效、finished=true、缓存命中 94.6%、total=109。
- **成本验证**：judge 账本 $0.0102（v1 单样本）→ $0.0072（v2+low+samples=3）——三倍评审更便宜（low 砍输出 + 重复输入缓存命中）。
- 本轮真实支出合计 ≈ $0.24（E2+E3+E3b），帽内。

**§29.2 追记（2026-09-04）：F10 压缩域重标定（shakedown 双对照驱动）**

- **实测**：native `mtm2wwpf`（总96，$0.268）+ manual `mtm4ovi3`（总92，$0.219）全链路组装/账本/判分验证通过；native 真实上下文峰值 **233,249 wire tokens**（旧 256K 假设的 91%，险溢出），估计器（chars/4）对 wire 低估中位数 **2.7×**，保留尾名义 8K 实际圈住 ~28K，native 两次压缩净减仅 ~5K（2%）。
- **修正**：`CHARS_PER_TOKEN` 4→1.5（wire 校准）；触发公式改纯消息估计（去双倍计数）；`contextWindow`→1M（安全阀专用，地板 800K 恢复活阀）；`compressionDomain` 50K→125K ⇒ **threshold=100K 真实**；retain 改**绝对覆写 10K 真实**（DSH 本体 8K 量级，比例派生降为 fallback）；outlineTokenBudget 40→110（保留原意图）。
- **有效性**：shakedown 批 mech/judge/账本/组装结论有效；臂间压缩效率结论以重标定后批次为准（旧两对照降级为 shakedown 证据）。回归：E0 全量 + vitest 153 全绿。

**§29.3 追记（2026-09-04）：F11 设计 R 热尾（S1 便利贴升级）**

- S1 保留桥从纯指针卡（refs+outline）升级为**高保真热尾**：模型只写 outline+refs，harness 门后确定性附①逐字末次验证②逐字失败行③retain 引用展开内容；渲染总帽 5000 token（用户批准），超限确定性裁剪。产品 schema 与五道门零改动（提取全部 POST-gate）。
- **批次声明：COMPRESSOR_PROMPT_VERSION = 3**——S1 臂新 run 与 v2 指令时代 S1 run 不混批。设计意图：S1 vs S2 从"测近因显著性（预期零效应）"改为"测高保真热尾 vs 无保留对下个任务开局质量的差异"。
- 回归：RD-1~10 + PC 更新 + E0 全量绿（纯离线，¥0）；插件本体未动。

**§29.4 追记（2026-09-05）：F10 标定下 native-auto 正式基线（mtn7l9mm）+ 两个 run 级发现**

- **基线**：`CASCADE-native-auto-mtn7l9mm` finished=True、97 步、25.2 分钟、总 90 / judge 均分 84、$0.253（谷时）。压缩两次触发均 ≈169.6K wire 输入、缓存命中 99.8%；成功压缩净减 170K→22.9K（−86.5%）。
- **发现 1（估计器盲区，记 F10a）**：`estimateMessagesTokens` 只数 content，不数 `reasoning_content`（thinking 回显）+ `tool_calls`——本 run 估计 81K 时 wire 已 162K（比率随会话成分浮动）。"100K 触发"实际落在估计空间（wire ≈170K）。安全性无损（1M 窗/800K 阀），但触发与选范围用了两把不一致的尺（`native-range.msgTokens` 计 tool_calls）。批 2 前统一。
- **发现 2（25 分钟默认墙钟）**：`runner.mjs` 默认 `timeoutMs=25min`，F10 下全套件超时——首批入口必须显式传 `--timeoutMs`（本基线 90min）。另首个截断 run `mtn5s2tk`（finished=false）留档作超时证据。
- **发现 3（native 压缩器空摘要失败，fail-lazy 生效）**：首次压缩调用模型输出 5,240 token 但 content 为空（thinking + 工具模式干扰：M5 缓存对齐要求回放执行器 tool schema，模型偶发顺应 schema 发 tool call 而非摘要）。validateNativeSummary 拒绝 → violation 落 T3 窗（mech 50）→ 下轮重触发成功。代价 ≈$0.004（99.8% 缓存命中使失败重试近乎免费）。

**§29.5 追记（2026-09-05）：F10a wire 锚定触发**

- 触发/截断阀从全量字符估计改为**锚点 + 增量**：`contextWireTokens` = 上次请求精确 usage（provider tokenizer，含 reasoning/tool schema）+ assistant 回合精确生成量 + 新增 tool 结果的字符估计；每步重锚定、误差不累积；重建后锚点重置一轮。硬截断阀与 manual-habit pressure-50 同步接线。
- 口径：生产 run-cascade 走 wire 锚定（"100K 触发"从此是真实 wire 空间）；离线测试 `calibrated` 覆写保持纯估计。回归 W18a~d + E0 563 PASS + vitest 153 全绿，¥0。

**§29.6 追记（2026-09-05）：F10a wire 锚定下 native 正式批次基线（mtnay1ej）**

- `CASCADE-native-auto-mtnay1ej`：finished=True、98 步、27.0 分钟、**总 90 / judge 均分 83**、$0.254（谷时）。**两次压缩全部成功**（`fired=pressure`，range [1..97] 与 [1..102]，均 ≈90K wire 输入、缓存命中 99.5%、输出 2,510/1,694），压缩后上下文 12.4K——全程峰值 ≤100K 真实 wire，`maxCompressions=2` 首次用满且零失败、零空摘要。T1/T3/T5 的 mech 扣分均为 run-denied 测试命令守卫（全 run 恒有，非压缩相关）。
- **三代 native 基线对照**：shakedown（旧估计器）触发 32K wire、净减 2%、峰值 233K；F10 纯估计（mtn7l9mm）触发 ~170K wire、净减 86%、1 成功 1 失败；**F10a 锚定（本 run）触发 ~100K 真实、净减 87%、双成功**——触发语义落到设计点。
- **批次地位**：本 run = native-auto 臂的批次基线（F10a 触发语义）；mtn7l9mm/mtn5s2tk/mtn2wwpf/mtm4ovi3 全部降级为各自标定时代的机制证据，**不进批次对照**。

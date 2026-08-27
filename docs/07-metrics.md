# 07 · 度量账本

> 一切改动的裁判。字段定义、来源事件、口径、固定单价与报表模板都在这里。
> 原则：**先立度量，后改代码**；任何改动必须能在账本上被观测（AGENTS.md 强制）。

## 0. 它解决什么问题（人话版）

这套插件每加一件事，都可能让 token 变多或变少，但不量一下根本不知道到底是省了还是亏了、值不值。那份"没跑实验就拍脑袋说省了"的改动，很容易把自己骗过去——今天看着省了，哪天模型一升级可能又变贵。所以规矩是**先立度量，后改代码**（AGENTS.md 强制）：先把"要观测什么、从哪算、单价多少、报表长什么样"全部定义好，任何改动都必须能在账本上被看到才算数。做法是：把所有字段定义成**能由会话日志回放计算**的（不用重跑实验），配一组**固定单价**（统一用一处价格折算，保证横向可比），改一次前后各出一份报表。收益是每次改动都有据可依、能横向比较；代价只是一层前置功夫，而且很小——全靠日志回放，不用额外重跑。注意这里只管"能测、可比"，**真实账单另列一行**（与官方现价对齐），两者分开报。

## 1. 字段定义与来源（全部可从会话日志回放计算，无需重跑）

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

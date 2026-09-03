# 03 · 输入域：task 生命周期发现（判别器语义判定）

> 域定义：**输入域发现 task 生命周期**——判定用户消息是否开启新任务（task 边界），并维护段状态机。
> 判定口径（v0.8.0 真相）：**T0 显式指令 + 判别器语义票（合议接入投影）**。机械信号层已整体退役
> （v0.3.0，docs/07 §16：词面覆盖 26.6%、单意图误开 holdout 100%——语义翻转只能语义判）。
> 本文只描述**已落地代码**的现状；对应 src：`src/task/explicit.ts`、`src/task/projection.ts`、
> `src/discriminator/*`。历史机械设计不在此列（意者见 docs/07 §16 退役快照）。

## 0. 它解决什么问题（人话版）

一个会话里用户会连续干好几件事：改一个 bug、补一个测试、再去重构另一个模块。每件事是一个 **task（段）**。
难点是用户不会说"这件干完了、开始下一件"——只能从用户消息本身"猜"边界。**猜错了，后面压缩、归档全跟着错位。**

v0.2.x 用机械信号（工具重复、静默时长、词面）猜，实测失败：真实语料 73.4% 的翻转（换任务）是纯语义的，
机械词面根本看不见（docs/07 §16）。v0.3.0 之后改用**判别器**：让 LLM 读"段头锚 + 段内历史 + 当前消息"，
判定是否开新任务。这是 v0.4.0 的实际形态，Phase B 配对验证达标（minimax 92.3%，reports/phase-b-v22.md）。

代价是每消息一次 LLM 调用（主路径约 98.8% 消息），所以判别器带三层省通道
（显式指令 / L0 词表 / L1 缓存）只让"真该判的"走 LLM；**默认 off（不挂载，零成本）**，
observe/active 由用户在配置卡片显式开启。observe = 只记账不动状态。

## 1. 决策链（省通道在前，LLM 兜底在后）

每条用户消息按下面顺序走，**命中即返回**（链路与代码一一对应）：

| 步 | 通道 | 判定 | 代码落点 |
|---|---|---|---|
| 0 | 输入面过滤 | 非判别面直接跳过 | `engine.handleSessionEvent` |
| 1 | T0 显式指令 | `/task`(open) / `/task close`(close) → 边界事实，判别器只记账 | `task/explicit.ts` `classifyExplicitUserMessage` |
| 2 | L0 延续词 | 整条消息 = 延续词（"好"/"ok"/"继续"…）→ continue（零 LLM 成本） | `discriminator/l0.ts` `isL0Continue` |
| 3 | L1 精确键缓存 | 同会话+同 seq+同配置+同文本 → 直接取缓存票 | `discriminator/engine.ts` `cache` |
| 4 | **LLM 主路径** | 判据 v2.2（排除式 + 宣布/承诺/命令链）→ new-task / continue | `discriminator/engine.ts` + `prompt.ts` |
| 5 | fail-lazy 兜底 | 任何错误/超时 → 判 continue（宁可漏切，不打断会话） | `engine.ts` error-fallback |

> 通道顺序就是成本顺序：0 免费、1 免费、2 免费、3 免费、4 唯一付费（每判 ≈103µ$ @ minimax）。
> 第 5 步是铁律：判别器**永远不让异常外溢到会话流**（异步旁路 + 全 try/catch，docs/07 §18）。

## 2. 输入面（只有这些消息进判别）

`session/event` 上监听 `user/message`，全部满足才进判别（`engine.handleSessionEvent`）：

- **append**（替换面 `surfaceOp.replace` 不判）；`source.kind === 'user'`（plugin/tool/系统注入不判）；
- **主会话**（子代理会话 `parentSession !== undefined` 不判）；
- **非伪 user**（approval policy 等系统消息标成 user 的，`discriminator/l0.ts isPseudoUser`）；
- 文本非空；**u≥1**（首条交给投影隐式开段，不判——与 Phase B 实验面一致）。

## 3. 窗口口径（判定输入，与实验冻结同构）

判别输入 = 三段渲染进判据模板（`discriminator/prompt.ts`，长度阀与 phase_b_prep.mjs v6 冻结一致）：

```
anchor  = 当前段头原文（投影 anchorText，截断 ≤350 字符）
patches = 段内、target 之前最近 2 条用户消息（每条 ≤350；config.historyWindow 可调 0–6）
target  = 当前消息（≤800，头 600 + 尾 200 中缀截断）
```

渲染 = 模板在前、实例在后（`renderDiscPrompt` 逐字节稳定）；模板 v2.2 定稿与
`datasets/prompt-discriminator-v2.2.txt` 同源（测试断言防漂移）。

## 4. 自适应链（发送参数跨版本不失效）

调用 LLM 前先查运行时能力，再与实测能力表取交集（`engine.judge` + `discriminator/presets.ts`）：

```
运行时许可 = ctx.llm.resolveModelInfo(provider, model).reasoning.efforts   （DSH 当前视角，自动跟随包更新）
实测验证层 = DISC_CAPABILITIES[provider@model].effortLevels                 （人工复核版本化表）
最终发送   = sanitizeEffort(许可, 请求档位, 验证层)   —— 交集外一律不发送（=默认档）
```

> 这解决"供应商包更新后参数失效"：许可层自动跟随，验证层保守兜底；模型下线/改名 → 运行时查询失败 →
> 降级默认档继续判（不崩、不传伪参数）。细节见 `reports/phase-b-effort-support.md` §8。

## 5. 段状态机（投影，纯 fold）

判别/显式指令的**事实归宿**是段状态机（`task/projection.ts`，状态 v5，纯函数 fold，从会话日志重建）：

- `user/message`：T0 open → 开新段（锚 = 原文）；T0 close → 闭合；段为空 → 隐式开段；否则推进表面；
- `context-economy/judge-verdict`（**v0.8.0 接入**，会话日志事件——`session.append`，
  与 `todo/write` 同先例：log-only、non-surface、不进模型历史、回放即重建）：
  `verdict=new-task` → **段内切分**（旧段闭合于前一条 surface 事件，新段以判定消息为段头开启，
  锚 = 判定原文，与可见层用户指令原文同源）；`continue` / 过期（目标不在当前段）/ 不可定位
  （不在 surface）→ no-op（同引用，fail-lazy）；
- `compaction/summary` → 摘要归入所属 task；
- 其余事件（tool/todo/turn）不参与判段（返回同一引用）。

**合议语义（v0.8.0）**：T0 显式指令**天然优先**——verdict 落在段起 seq 时 no-op（该消息已是权威边界）；
语义票只在当前活动段内生效（不改写已闭合段历史）。判别器在 **observe** 模式只记账不碰状态机；
**active** 模式额外发 `judge-verdict`（cordis 事件 + 会话日志事件双通道）并由此接入投影。

## 6. 溯源与诊断（错误可追溯）

每次判定产一条 `JudgeRecord`（`discriminator/trace.ts`）：judgeId=`j:{session}:{seq}`、触发路径、
verdict、调用参数快照、窗口事实、modelView、LLM 用量/耗时、**cost**（单价表 `DISC_PRICING`
估算，缺失单价不猜价）、**错误链**（phase/code/action）、**依赖边 sources[]**
（preset/config/capability/runtime/prompt/context 各自的版本+指纹）。

**落盘（可回放账本）**：每条判定追加 `judge-records.jsonl`（常开；含 usage/cost）；
输入/输出原始日志（渲染后 prompt + 模型输出）追加 `judge-io.jsonl`（仅 `debugIo=true`）；
目录 = `discriminator.journalPath` 或默认 `~/.dsh/context-economy/`；落盘失败 fail-lazy 降级为仅日志。

**日志与事件**：权威日志行 `context-economy: judge record <json>`（一行一条，grep 即回放）；
事件（`task/events.ts`，log-only）：`judge-recorded`（全量记录）、`judge-error`（错误摘要）、
`judge-verdict`（active 模式，new-task 才发）；台账环表 `discriminator/journal.ts`。

## 7. 模式与配置（行为隔离 + 落盘）

`config.discriminator.mode`：**off**（默认，不挂载）/ **observe**（只记账，零行为影响）/
**active**（额外发 `judge-verdict`）。装配与其它能力域无关：`mode!=='off'` 即挂
（headless 无投影时以 `contextModel='unbound'` 判，仍不出错）。

落盘/观测相关配置：`journalPath`（台账目录，空=默认 `~/.dsh/context-economy/`）、
`debugIo`（输入/输出原始日志开关，默认关）、`messageExcerptChars`（记录内消息摘录长度）、
`journalLimit`（内存环表容量）。全部字段与默认值见 `src/config.ts`。

**v0.4.0-runtime2 增补**：配置权威源已升级为 settings scope 动态读取（`context-economy`
namespace，docs/12 §5）——GUI 设置页可改这些字段，保存即重挂判别器（mode 切换拆旧挂新）；
`journalPath` 落盘目录等构造期字段保存后**下次重挂生效**（引擎构造时读配置）。

## 8. 事件与度量（已落地）

- 事件：`task-boundary`（投影边界事实，log-only）、`task-compacted`（orchestrator）、
  `judge-recorded` / `judge-error` / `judge-verdict`；
- 度量：`segmentsPerSession` / `taskSwitchRate` / `taskDefinitionBytes`（投影侧）
  + `judgeCount` / `judgeErrorRate` / `judgeCacheHitRate` / `judgeLatencyMs` /
  `l0CaptureRate` / `l0Leak`（判别器台账统计）——**定义/观测方式/代码落点见 [docs/07 §0.5](07-metrics.md)**。

## 9. 验收标准（已落地断言）

- [ ] L0-continue 词表与 phase_a_l0.mjs 同源（unit 断言）；翻转泄漏保持 0（基线 phase-a-l0.md）；
- [ ] 窗口裁剪/模板渲染与冻结口径逐字节一致（unit 断言）；模板与 datasets 定稿同源（unit 断言）；
- [ ] observe 模式零行为影响（只出日志/事件/台账，不写状态机，不发 verdict）；
- [ ] active 模式 verdict → 投影切分：new-task 段内切分（旧段闭合/新段锚 = 判定原文）、
      verdict 迟到尾随迁移、过期/不可定位/continue no-op（同引用断言，projection.spec）；
- [ ] 回放确定：verdict 会话事件在日志中可回放——重放同序同字节（与 todo/write 同契约）；
- [ ] 错误链不外溢：任何路径异常 → error-fallback continue（单元/运行时验证）；
- [ ] 配置经 resolveConfig 深合并——部分 config 对象装载不崩（曾致崩溃类问题兜底）。
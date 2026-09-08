# 10 · 挂点与接线（权威挂点地图）

> 本文是**权威挂点地图**——插件接到 DSH 的哪个事件/服务/槽上，逐条对 harness 源码核验。
> 域归属视角与三条主时序也在此。事件分两层：会话日志事件（`session/event` firehose，
> append-only 落盘）与 cordis 运行时事件（waterfall/emit，不落盘）。
> 状态：部分实现（H1/H4/H5/H6/H7/H10/H12/H13/H14 已施工于 platform/events.ts·history.ts·logger.ts·ignorable-channel.ts·llm.ts·storage.ts·skills.ts·tools.ts；**H6 四档执行已由 P15b、run 冲刷已由 P16 接线于 `domains/shear.ts`**；**H15 盘上取真已由 P17b 接线于 `platform/files.ts`（装配域 `domains/assemble.ts`，压缩触发归 P19；P17c 补 HT 软门与丢弃归因）**；**P18 压缩调用纯核已施工**（`core/compress/` 两模式 prompt + 产物 schema 校验；H12 purpose `context-economy-compaction` 的**调用契约**已定，实际 `llm.stream` 调用归 P19/P20a）；**P19 已接线 H2**（`platform/agent-step.ts` 收口 + `domains/compaction.ts` 边界触发；`compaction/summary` + checkpoint 替换经 `platform/history.ts` `commitCheckpoint`；快照 [§46](ledger-history.md)）；
**P20 已接线 H3**（`platform/agent-step.ts` `onAgentRequestError` + `domains/compaction.ts` 压力触发/溢出接管；
> `cordis.patch.yml` 覆写 compaction-basic `auto:false`；快照 [§47](ledger-history.md)）；
H8/H11 设置壳已保留，H11 星标按钮已施工于 `conversation.input.right`；H9 仍为设计态（P21a），模块落位见 [11 §3](11-structure.md)）。

## 0. 它解决什么问题（人话版）

接线错两件事就全白做：**监听不存在的事件**（机制聋了）和**绕过官方协议改历史**（升级即碎）。
这篇就是接线手册：每个机制挂哪个确切钩子、走哪条官方通道、命令面怎么注册、三条主流程
逐步怎么走、改完跑哪四道缓存断言。

## 1. 挂点表（H1–H13，对 harness 源码逐条核验）

| # | 机制 | 挂点（确切名） | 通道与语义 |
|---|---|---|---|
| H1 | 判别器输入 | `session/event` → `user/message` | 输入面过滤同 [02 §2](02-discriminator.md)（append + `source.kind==='user'` + 主会话 + u≥1）；同步 post-commit 派发，监听器异常不外溢 |
| H2 | 边界/步准入 | `agent/pre-step`（waterfall） | task 闭合发现（边界信号成立 → 触发边界压缩）；**必须 `return next()`**。**P19 已接线**：收口 = `platform/agent-step.ts`（唯一持有 `agent/pre-step` 字面与 `dsh-agent` 类型面，D14 断言锁定）；域侧 `domains/compaction.ts` `onPreStep` 恒放行、异常只 warn（fail-lazy） |
| H3 | 压力触发 | `agent/pre-step`（压力计量）+ `agent/request-error`（`CONTEXT_WINDOW_EXCEEDED`） | `pressureRatio=0.4` × 压缩域窗口按 wire 锚定计量（[04 §3](04-compactor.md)）；溢出恢复走 request-error 接管 |
| H4 | **改史唯一通道** | `session.append(type, data, {surfaceOp:{op:'replace',start,end}, sourceEventSeqs})` | replace 的 `sourceEventSeqs` 必含全部被遮蔽节点；紧邻契约：`compaction/summary` ↔ 替换 `user/message`；`compaction/prune` 影子计价紧随同步 append。**P19 落位**：`platform/history.ts` `commitCheckpoint` 原子提交 summary（影子价）+ 官方 checkpoint `user/message`（`compactCheckpointSource`，`sourceEventSeqs=[start,summary,...shadowed]`） |
| H5 | 压缩事务 | `compaction/start` … `compaction/end`（log-only 标记对） | 持锁幂等（`turn:null` 独立事务）；`assertNoActiveCompaction` 防重入 |
| H6 | 剪切层挂点 | `tools/post-execute` accept `content` 覆盖 = T-entry 写时整形（落账前）；accept 追加 = T-note 贴注；surfaceOp replace = T-loop stub / T0-R 修复 / run 冲刷；task 大 replace = T-boundary 搭车；`tools/execute` 仅作信号/计量 around-wrapper | 工具自有 `finalizeContent` 属定义侧（仅自有工具）；P1.2 契约闭合核验见 [03 §2](../03-shear.md) 表后注；**P15b 已接线**：T-entry/T-note 贴注 = `platform/tools.ts` `createShearToolPort`（同步相），T-loop/T0/T0-R/T-note 剪除 = `domains/shear.ts` 经 H4 执行（异步相），快照 §39；**P16 已接线**：run 冲刷 = **多节点区间** replace → `user/message`（`source:{kind:'plugin',plugin:'context-economy',form:'notice'}`，官方 `compaction/summary`+checkpoint 同构；结论消息构造收拢于 `platform/history.ts` `buildNoticeUserMessage`），快照 §40/§41 |
| H7 | 度量回放 | `step/start|end`、`assistant/message`（usage）、`request/header`、`tool/call|result`（原始 arguments + meta） | [07](07-metrics.md) 账本全部字段可从会话 JSONL 回放重算 |
| H8 | 设置 | `ctx.settings.installSection(owner,'context-economy',Config,entry,hooks)`；写 = `mutate(ns,ops,expectedRevision)` revision-fence | 持久化归 settings-file（原子写 + 文件锁）；`settings/updated` 观察 |
| H9 | 恢复 | `agent/session-start{source:'resume'|'startup'}` + Session 构造种子 | 种子**不上 firehose**（`firstLiveSeq` 定界）——重启重建需自扫或订阅时区分；恢复序 = [09 §4](09-state.md) |
| H10 | 持久 KV | `ctx.storageDomain.open(defineDomain({name,version,tables}))` | durable 写 + `domain/changed`；backend 可换（json/sqlite） |
| H11 | UI | client `ctx.slots.register({name:'settings.plugin.item'…},Card)`（设置卡壳已保留）；conversation.input.right 星标按钮；`ctx.remote.session.modelCatalog()` | 星标 → host 方法（时序 B；P14b1 落位 = Connection RPC 通道 `/context-economy`，端点 `star.preview`/`star.apply`，端口 `platform/star-bridge.ts`，见 [13 §3.11](13-harness-plugin-spec.md)）；模型路由目录 |
| H12 | 辅助 LLM | `llm.stream({purpose})` | 判别 / 断面 / 压缩调用统一 purpose 标记（度量可区分 + 前缀对齐）；usage 回执入账。**宿主现仅 `'compaction'|'session-title'`**，插件自定义 purpose 经 `platform/llm.ts` 单点适配（[12 §1 C2](../12-platform-capabilities.md)），P5 已施工：`platform/llm.ts` `streamCeLlm` + usage 回执；**P18 已定压缩调用契约**（两模式 prompt + 产物 schema），调用接线归 P19/P20a |
| H13 | 技能目录 | `ctx.skills` 官方注册表（`snapshot`/`get`；`skills/change` 热更新）——`SKILL.md` 扫描与目录 watch 由 harness skill-filesystem 提供者承担 | 稳定前缀原料 + 引用守卫查表（[02 §2](02-discriminator.md)）；枚举纯机械零 LLM |
| H14 | 会话事实发射 | `session.append` + LogIntent（`IgnorableSessionEventMap` 合并成员） | `context-economy/*` log-only 事件唯一写入通道（append 侧编译闸，读取不查合并表）；能力探测与降级契约 = [12](12-platform-capabilities.md) |
| H15 | **盘上取真** | `ctx.fs`（`resolve`/`stat`/`readText`） | 文件坐标 `{path,vN,lineRange?}` 经版本补丁链重映射后取**盘上当前字节**（含本会话已落盘编辑——上下文副本是历史快照，改过的文件从上下文取 = 复活旧版本；[04 §2](04-compactor.md)）；服务缺失 / 读失败 = 通道 A 降级丢弃 + 计数，通道 B 与位置兜底照常。**P17b 落位 = `platform/files.ts`（唯一 fs 触点，D11 断言锁定单元边界），装配域 = `domains/assemble.ts`，快照 [§43](ledger-history.md)；P17c：HT 软门（坏形状不触盘）+ 丢弃归因 `{badDecl,unknownUnit,remap,fetch}`** |

**三条辨析（防接错缝）**：

1. **harness 的 task ≠ 域 task**：原生 `team/task` 与 `todo/write` 只是判别器 L0 侧的
   免费辅助事实；边界权威 = 优化判别器（[01 §3.5](01-architecture.md) 意图轴）。
2. **改史没有任何旁路**：不能原地改写/删除会话行；一切历史变更（剪切/压缩/修复）都表达为
   "append 带 replace 的表面事件"——原生表面 fold 因此自动正确派生（原生兼容的核心承诺）。
3. **引擎协调**：压缩实现以旁路协议写入（不动 `ctx.compaction` 服务），
   `cordis.patch.yml` 覆写 compaction-basic `auto:false` 防双触发；整体替换引擎为后续选项
   （换引擎不换协议）。

## 2. 命令面（用户权威入口）

| 命令 | 归属 | 行为 |
|---|---|---|
| `/task <描述>` | 判别器 | **显式新 task 起点**（Tier-0 权威边界，压倒自动判定） |
| `/task close` | 判别器 | 显式闭合当前 task（→ 边界压缩 + 归档） |
| `/task`（无参） | 判别器 | 查看当前 task（id、卷宗规模、回填版本） |
| `/init <项目目标>` | 项目帧 | 发起 init 提案（LLM 整理，用户确认后写 project_frame v1） |
| `/init confirm` / `/init cancel` / `/init` | 项目帧 | 确认/取消/查看当前项目帧 |
| `/optimize-prompt` | 判别器手动断面 | = 星标按钮（一入口两形态），跑 [02 §4](02-discriminator.md) 断面 |
| `/compact`（DSH 原生） | 非边界 | 历史维护，判别器忽略（维护类命令不切碎 task） |

## 3. 时序 A：task 闭合 → 边界压缩 → 归档

```text
turn/end → 自动断面边界信号成立（或 /task close）
  → H2 agent/pre-step：发现 closed && 未归档的 task
  → 压缩器边界装配（H4/H5）：类型化摘要 + 热尾申报 → 装配（事实层冻结 + 坐标层 + 热尾 ≤10K）
     · T-boundary 搭车：段内老调用对随大 replace 折叠（剪切层清单）
  → 档案归档 vN（H10）→ 卷宗清空（新 task 新卷宗）
  → 度量：task-digest-created / hotTail* / cutEvents 入账（H7）
```

## 4. 时序 B：星标点击 → 断面 → 预览 → 回填 + 剪切

```text
用户点星标（H11 conversation.input.right）或 /optimize-prompt
  → host 方法：装配输入栈（稳定前缀[技能目录+项目帧] + 卷宗 + 当前 prompt）
  → H12 llm.stream({purpose:'context-economy-optimize'})：单次断面（temperature 0、无工具调用；推理档 = 设置 `discriminator.reasoningEffort`，缺省跟随模型默认）
  → 双通道解析：产品（自由文本）+ 行式裁决（行级容错）
  → client 渲染预览（P14d：无 diff、无统计噪声，裁决折叠在详情里）→ 用户确认/编辑（= 终稿）
  → 执行：确认即发送（`setDraft` + `submit()`）；判别回填落卷宗 vN+1（H10）；
     剪切清单 → H4 surfaceOp 执行（run 冲刷，结论句落位；**P14b 阶段只落盘记账，执行归 P15b**）；task 边界裁决仅提示不执行
  → 度量：optimize-run 全账（输入栈体积/产出/回填/剪切规模/explorationAvoided 基线）
```

## 5. 时序 C：压力触发与保险丝

```text
每请求前 wire 锚定计量 ≥ 0.4 × 压缩域窗口
  → 压力压缩（H4/H5）：选缝（末段子任务起点）→ 检查点 + [cutPoint..end] 全量逐字
  → 断路器（单 task 上限 3–4）；fail-lazy 重试一档
保险丝（独立兜底）：估算 ≥ contextWindow × 0.8 → 重建消息表（保 [system, task] 前缀 +
  最尾近消息）→ hard-truncate 事件入账；低于地板完全 no-op
```

## 6. 缓存对齐检查点（每次改动后跑）

```text
断言1：本轮请求 = 上轮请求 + 新增段（前缀性质）
断言2：同版本卷宗/项目帧/档案/优化产物逐字节一致
断言3：辅助调用（判别/断面/压缩）= 上一次请求真前缀 + 新短尾
断言4：档案堆只追加（无原地改写；硬帽截断走 bump 语义）
```

## 7. 实施顺序（依赖关系）

与 [11 §9](11-structure.md) 搭建序一致：平台面（H7/H8/H10 观测与存储先行）→ 判别域
（H1/H2/H12 + 星标 H11）→ 剪切域（H6/H4）→ 压缩域（H3/H4/H5）。
前面的不做，后面的立不起来；每阶段出门槛 = 度量先行。

## 8. 验收标准

- [ ] 每个挂点都有对应度量字段（[07](07-metrics.md)）；
- [ ] 断言 1–4 进 CI；改史调用只出现在 platform/history 层（grep 断言，[11 §10](11-structure.md)）；
- [ ] 自定义会话事件全部 `ignorable:true`（类型级测试）；
- [ ] 关闭任一域（Config 布尔）后其余功能完整。

# 10 · 挂点与接线（权威挂点地图）

> 本文是**权威挂点地图**——插件接到 DSH 的哪个事件/服务/槽上，逐条对 harness 源码核验。
> 域归属视角与三条主时序也在此。事件分两层：会话日志事件（`session/event` firehose，
> append-only 落盘）与 cordis 运行时事件（waterfall/emit，不落盘）。
> 状态：部分实现（H1/H4/H5/H6/H7/H10/H12/H13/H14 已施工于 platform/events.ts·history.ts·logger.ts·ignorable-channel.ts·llm.ts·storage.ts·skills.ts·tools.ts；H8/H11 设置壳已保留；H2/H3/H9 仍为设计态，模块落位见 [11 §3](11-structure.md)）。

## 0. 它解决什么问题（人话版）

接线错两件事就全白做：**监听不存在的事件**（机制聋了）和**绕过官方协议改历史**（升级即碎）。
这篇就是接线手册：每个机制挂哪个确切钩子、走哪条官方通道、命令面怎么注册、三条主流程
逐步怎么走、改完跑哪四道缓存断言。

## 1. 挂点表（H1–H13，对 harness 源码逐条核验）

| # | 机制 | 挂点（确切名） | 通道与语义 |
|---|---|---|---|
| H1 | 判别器输入 | `session/event` → `user/message` | 输入面过滤同 [02 §2](02-discriminator.md)（append + `source.kind==='user'` + 主会话 + u≥1）；同步 post-commit 派发，监听器异常不外溢 |
| H2 | 边界/步准入 | `agent/pre-step`（waterfall） | task 闭合发现（边界信号成立 → 触发边界压缩）；**必须 `return next()`** |
| H3 | 压力触发 | `agent/pre-step`（压力计量）+ `agent/request-error`（`CONTEXT_WINDOW_EXCEEDED`） | `pressureRatio=0.4` × 压缩域窗口按 wire 锚定计量（[04 §3](04-compactor.md)）；溢出恢复走 request-error 接管 |
| H4 | **改史唯一通道** | `session.append(type, data, {surfaceOp:{op:'replace',start,end}, sourceEventSeqs})` | replace 的 `sourceEventSeqs` 必含全部被遮蔽节点；紧邻契约：`compaction/summary` ↔ 替换 `user/message`；`compaction/prune` 影子计价紧随同步 append |
| H5 | 压缩事务 | `compaction/start` … `compaction/end`（log-only 标记对） | 持锁幂等（`turn:null` 独立事务）；`assertNoActiveCompaction` 防重入 |
| H6 | 剪切层挂点 | `tools/post-execute` accept `content` 覆盖 = T-entry 写时整形（落账前）；accept 追加 = T-note 贴注；surfaceOp replace = T-loop stub / T0-R 修复 / run 冲刷；task 大 replace = T-boundary 搭车；`tools/execute` 仅作信号/计量 around-wrapper | 工具自有 `finalizeContent` 属定义侧（仅自有工具）；P1.2 契约闭合核验见 [03 §2](../03-shear.md) 表后注 |
| H7 | 度量回放 | `step/start|end`、`assistant/message`（usage）、`request/header`、`tool/call|result`（原始 arguments + meta） | [07](07-metrics.md) 账本全部字段可从会话 JSONL 回放重算 |
| H8 | 设置 | `ctx.settings.installSection(owner,'context-economy',Config,entry,hooks)`；写 = `mutate(ns,ops,expectedRevision)` revision-fence | 持久化归 settings-file（原子写 + 文件锁）；`settings/updated` 观察 |
| H9 | 恢复 | `agent/session-start{source:'resume'|'startup'}` + Session 构造种子 | 种子**不上 firehose**（`firstLiveSeq` 定界）——重启重建需自扫或订阅时区分；恢复序 = [09 §4](09-state.md) |
| H10 | 持久 KV | `ctx.storageDomain.open(defineDomain({name,version,tables}))` | durable 写 + `domain/changed`；backend 可换（json/sqlite） |
| H11 | UI | client `ctx.slots.register({name:'settings.plugin.item'…},Card)`（设置卡壳已保留）；conversation.view 星标按钮；`ctx.remote.session.modelCatalog()` | 星标 → host 方法（时序 B）；模型路由目录 |
| H12 | 辅助 LLM | `llm.stream({purpose})` | 判别 / 断面 / 压缩调用统一 purpose 标记（度量可区分 + 前缀对齐）；usage 回执入账。**宿主现仅 `'compaction'|'session-title'`**，插件自定义 purpose 经 `platform/llm.ts` 单点适配（[12 §1 C2](../12-platform-capabilities.md)），P5 已施工：`platform/llm.ts` `streamCeLlm` + usage 回执 |
| H13 | 技能目录 | `ctx.skills` 官方注册表（`snapshot`/`get`；`skills/change` 热更新）——`SKILL.md` 扫描与目录 watch 由 harness skill-filesystem 提供者承担 | 稳定前缀原料 + 引用守卫查表（[02 §2](02-discriminator.md)）；枚举纯机械零 LLM |
| H14 | 会话事实发射 | `session.append` + LogIntent（`IgnorableSessionEventMap` 合并成员） | `context-economy/*` log-only 事件唯一写入通道（append 侧编译闸，读取不查合并表）；能力探测与降级契约 = [12](12-platform-capabilities.md) |

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
用户点星标（H11 conversation.view）或 /optimize-prompt
  → host 方法：装配输入栈（稳定前缀[技能目录+项目帧] + 卷宗 + 当前 prompt）
  → H12 llm.stream({purpose:'context-economy-optimize'})：单次断面（temperature 0、无工具调用）
  → 双通道解析：产品（自由文本）+ 行式裁决（行级容错）
  → client 渲染 diff → 用户确认/编辑（= 终稿）
  → 执行：优化后 prompt 原地替换（对话框）；判别回填落卷宗 vN+1（H10）；
     剪切清单 → H4 surfaceOp 执行（run 冲刷，结论句落位）；task 边界裁决仅提示不执行
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

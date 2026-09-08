# P19 边界路径编排（R4；依赖 P17,P18,P2,P3；尺寸 **L → 拆 P19a/P19b**）

> 设计正典：docs/04 §1（共享事务原语/缩水校验）· §2（边界装配：类型化摘要 + hotTail / 预算三环 / 三环 fatal 口径）·
> §3（机制 A 续传 / 机制 B 折叠 / 生产消费不对称律）· §5（标定）· §6（档案区：只追加 + 15K 硬帽 + 版本协议 + 内容寻址复用）·
> §7（事件与度量）；docs/10 §1 H2/H4/H5 + §3 时序 A + §6 断言 1–4；docs/09 §1（workspace 隔离）/§2（边界档案 vN）/§4；
> docs/07 §0.5 压缩族 + §5 回放管道；docs/11 §2 模块树 + §4 三纪律 + §6 装配开关 + §8 R4 门槛；docs/06 §2/§6；docs/05 §6。
> harness 符号清单（逐条 grep 到定义处，找不到即停工上报）：
> - H2 `agent/pre-step` waterfall：`G:/deepseek-harness/packages/core/agent/src/runtime-types.ts:276`
>   （payload `{ agent, messages, turn, step, signal }`，`next(): Promise<PreStepDecision>`）；包 `@deepseek-ai/dsh-agent` @ `packages/core/agent`。
> - H4/H5 官方压缩提交协议：`packages/compaction/compaction-basic/src/region.ts:437-488`
>   （`compaction/summary` → `user/message` + `surfaceOp:{op:'replace'}` + `sourceEventSeqs:[start,summary,...shadowed]`）、
>   `compactCheckpointSource` @ `packages/llm/llm`（P19 收口到 platform/history.ts）。
> - H10 storageDomain：P3 已落位 `platform/storage.ts`（`boundary_archive` 表已声明）。
> - 原生引擎现状：profile `~/.dsh/.agent-presets/anchored-standard/agent.cordis.yml:293` 挂载 compaction-basic **无 config**
>   ⇒ `auto` 默认 **true**（`config.ts:95`）；P19 **不动** `cordis.patch.yml`（`auto:false` 覆写归 P20b，总纲行 + 11 §1 表已定）。

## 1. 目标

把 P17（装配）+ P18（调用）接成**第一条会真正开火的压缩路径**：task 闭合发现（H2）→ 压缩器单次调用
（H12 purpose `context-economy-compaction`）→ 产物 schema 校验（P18）→ 装配（P17）→ **缩水校验**（replace 前置）→
档案 vN 落盘（H10，含 15K 硬帽 + 内容寻址复用）→ H4/H5 事务内大 replace（官方 `compaction/summary` + checkpoint 同构）→
卷宗清空（结构性）→ T-boundary 搭车入账 → `compress-run` 事实。

**本单不触发压力路径、不做保险丝**（P20a/P20b）；**不实现注入**（无隐藏注入段：摘要+热尾即替换节点本身，模型可见）。

## 2. 输入

- 正典要点（工单内自足）：
  - **时序 A**（10 §3）：`agent/pre-step` 发现 `closed && 未归档` 的 task → 边界装配（H4/H5）→ 档案归档 vN（H10）→ 卷宗清空。
  - **触发语义**（AGENTS 压缩域标定）：闭合发现 = `foldSegmentState` 里 `closed===true` 的段，**不是** `thresholdTokens`（那是 P20a 的压力触发）。
  - **三环 fatal 口径**（04 §2）：仅解析失败/schema 违例 fatal；`hotTail` 缺失/坐标全坏 → 装配器位置兜底；超预算/坏坐标机械降级。
    **本单新增的缩水校验失败 = 非 fatal**（不落刀、保留原文、如实记账）。
  - **缩水校验**（04 §1）：产物 token < 被压区间 token，否则重试；P19 = 边界档（**重试 1 次**，P20a 压力档更激进）。
  - **机制 A**（04 §3）：摘要字节一经写出不可变；后续压缩遇旧块**原样续传**；输出 = 续传旧块 + 追加新块。
    P19 的 `priorChain` 来源 = 档案区里同 task 的 `checkpoint` 条目（压力路径生产者 = P20a，当前恒空）。
  - **档案区**（04 §6）：只追加、永不改写；硬上限 15K（从最老整条机械截断，`archiveTruncate{count,tokens}` 入账）；
    落盘走 09 §2 版本协议（原子写 + source + 快照）；**跨会话复用不重算 = 内容寻址缓存**（span 哈希命中即复用，零调用）。
  - **workspace 隔离**（09 §1）：档案是项目级实体 ⇒ 键含 workspace。
  - **卷宗清空**（10 §3）：`sessionScopedTaskId` 使新 task 天然新卷宗（P13 先例）；**本单不删旧卷宗**（失败方向保留）。
  - **T-boundary 搭车**（03 §1/§2 表 + 10 §3）：段内老调用对随大 replace 折叠 = 构造性生效；
    07 `cutEvents` 只认 `shear-applied` 事实 ⇒ P19 为区间内 hold 对**补发** `tier:'T-boundary'` 事实（会计，不改机制）。
  - **失败默认保留**：LLM 失败/解析失败/schema 失败/缩水失败/落盘失败/区间失效 → **不 replace**，原文照旧，如实记 `compress-run`。
- 现有文件（**复用，不重复实现**）：
  - `core/compress/prompt.ts` `renderBoundaryPrompt` / `renderPriorChain` / `compressUnitList`；`product.ts` `parseCompressProduct`；
    `consume.ts` `planTailConsumption`；`ledger.ts` `COMPRESS_RUN_FACT_TYPE` / `foldCompressCalls`。
  - `core/assemble/` `assembleArchive` / `truncateArchiveArea` / `archiveChainShape` / `planTxn` / `DEFAULT_ASSEMBLE_POLICY` / `AssembleUnit`。
  - `domains/assemble.ts` `mountAssembleDomain`（`unitList` + `assemble` + `runCompactionTxn`）；`platform/history.ts` `createHistoryPort`；
    `platform/storage.ts` `boundary_archive` 表 + CAS；`platform/llm.ts` `streamCeLlm` / `resolveReasoningEffort`；
    `domains/input.ts` `resolveJudgeModel`（辅助调用模型路由 = 判别/★ 共用，压缩同源）；`core/units.ts` `foldSegmentState`；
    `core/ledger/fold.ts` `estimateTokens` / `extractTextFromToolResult`；`core/shear/tool.ts` `foldToolShear` + `toolCategory`。
- **本单不做**：压力触发/断路器（P20a）；保险丝与 `cordis.patch.yml auto:false`（P20b）；恢复编排（P21a）；
  四次序端到端交错验收与四道缓存断言进 CI（P21b）；真前缀布局重构（见 §8-3）。

## 3. 产出（按 L 拆两单两提交）

### P19a 纯核 + 端口面（src 净增估计 ≤420）
- `src/core/compress/region.ts`（新）：`renderRegionTranscript(events, range)`——表面事件 → 机械逐字节转写
  （`[seq] user|assistant|tool:call|tool:result` 头 + 原文；工具调用含 arguments；工具结果含 callId）；
  `regionTokens(events, range, policy)`；`REGION_TRANSCRIPT_VERSION`（转写格式版本，改格式升版本）。
- `src/core/compress/store.ts`（新）：档案区实体纯核——
  `ARCHIVE_STORE_VERSION`、`ArchiveRecord = ArchiveEntry & { sessionId?, layer?, at? }`、
  `ArchiveStoreBody { schemaVersion, workspace, entries, cache }`、`emptyArchiveStore(workspace)`、
  `readArchiveStore(value, workspace)`（防御解析，坏形状 = 空）、
  `appendArchiveEntry(body, entry, policy)`（追加 → `truncateArchiveArea` → `{ body, truncation }`）、
  `compressSpanHash(input)`（FNV-1a 64 位十六进制；键 = promptVersion/policyVersion/layer/region 字节/单元 ID 序/priorChain 文本序）、
  `lookupCachedProduct(body, key)`、`putCachedProduct(body, key, entry, limit)`（`ARCHIVE_CACHE_LIMIT=32`，插入序淘汰）、
  `priorChainFor(body, taskId, sessionId)`。
- `src/core/compress/ledger.ts`（改）：`CompressRunFactData` 追加 `taskId?/reason?/shadowedTokens?/productTokens?/retry?/carried?/archiveEntries?/archiveTruncateCount?/archiveTruncateTokens?/shearFolded?`；
  `CompressCallLedger` 追加自持观测位（`skips/retries/shrinkRejects/storageFailures/archiveAppends/shearBoundaryFolded`）；
  `foldCompressCalls` 同步汇总（坏载荷跳过，绝不抛错）。
- `src/core/assemble/ledger.ts`（改）：`CompressionLedger` 透出 P19 自持位（合并 `foldCompressCalls`）。
- `src/core/shear/ledger.ts`（改）：`ShearAppliedKind` + `'t-boundary'`、`ShearAppliedTier` + `'T-boundary'`（既有 fold 视为工具剪，落 `cutEvents.tool`）。
- `src/platform/agent-step.ts`（新，H2 端口收口）：`onAgentPreStep(ctx, { logger, handler })`——
  唯一持有 `@deepseek-ai/dsh-agent` 类型面与 `agent/pre-step` 字面；**必 `return next()`**、异常只 warn 不外溢。
- `src/platform/history.ts`（改）：新增 `commitCheckpoint(input)`——事务内提交官方压缩协议
  （`compaction/summary` → `user/message` 替换，`source = compactCheckpointSource(compactionId)`，
  `sourceEventSeqs = [start, summary, ...shadowed]`）；`HistoryPort` 同步扩面。
- `src/domains/compaction-facts.ts`（新）：`context-economy/compress-run` 声明合并（D3 白名单 + ignorable）。
- `scripts/assert-structure.mjs`（改）：**D14**（`agent/pre-step`/dsh-agent 概念收口于 `platform/agent-step.ts`）。
- 测试：`tests/compress-region.spec.ts`、`tests/compress-store.spec.ts`、`compress-ledger.spec.ts`（扩）、
  `tests/assert-structure.spec.ts`（D14 负/正样本 + 零位快照 +1）。

### P19b 编排 + 接线 + 配置面（src 净增估计 ≤450）
- `src/domains/compaction.ts`（新）：`mountCompactionDomain(deps)`——
  触发发现（facts → `foldSegmentState` → 闭合且未归档段）→ 区间落表面（`balanceRange`）→ 单元清单 + 区间转写 →
  内容寻址复用（命中 = 零调用）→ `renderBoundaryPrompt` → `streamCeLlm`（temperature 0、推理档同辅助调用）→
  `parseCompressProduct` → `assembleArchive` → 缩水校验（重试 1）→ 档案 vN 落盘（CAS 重试 1）→
  `runCompactionTxn`（open → prune → `commitCheckpoint` → close）→ `compress-run` 事实 + T-boundary 补账。
- `src/config.ts`（改）：`compression` 组 6 字段（`boundary=true`/`pressure=true`/`domainTokens=125000`/
  `retainTokens=10000`/`thresholdTokens=100000`/`archiveCapTokens=15000`）+ 不变量校验 `retain < threshold`。
- `src/index.ts`（改）：装配 `mountCompactionDomain` + `onAgentPreStep` 接线（storage/llm 子 fiber 就绪后可用）。
- `client/field-model.ts`（改）：`compression.*` 载荷同步（boundary/pressure 进「功能开关」；四个数值进「模型与调优」）+ 文案。
- `package.json`（改）：peerDep `@deepseek-ai/dsh-agent`；`scripts/build.sh`（改）：`link_pkg @deepseek-ai/dsh-agent packages/core/agent`。
- 测试：`tests/compaction-domain.spec.ts`（fake session/pump/storage/llm 端到端）、`tests/field-model.spec.ts`（扩）。
- `scripts/verify-p19.mjs`（新）：导出面 / 结构 / D14 / 假会话端到端 / 真机只读回放 / 文档标记 / 尺寸。

## 4. 实现要点

1. **度量先行**：先扩 `compress-run` 载荷与 fold（`cacheHit`/`calls`/`outcome`/`reason`/usage + P19 自持位），再写编排。
2. **触发发现**：domain 自持 `facts/session-event` 分桶（**不依赖 `discriminator.auto`**——T0 事实与压缩无关）；
   `foldSegmentState(facts, { sessionFirstSeq })` 取最后一个 `closed` 段；已归档判定 = 同 `taskId` 的 `compress-run` 事实
   （`outcome==='ok'` 或 `parse`/`schema`/`shrink`/`storage` 已试过即不再试；仅 `llm-unavailable` 允许重试）。
3. **区间落表面**：`start` = 首个 ≥ 段起点且仍在表面的节点；`end` = 最后一个 **< 下一段起点** 的表面节点
   （T0 close 时段尾 = 新段首，必须排除新 task 首条消息 = 权威段）；再 `balanceRange` 收工具对；null = 放弃。
4. **区间原文** = `renderRegionTranscript(visibleEvents, range)`（逐字节、字节稳定；单元 ID 与清单同源）。
5. **调用**：模型路由 = `resolveJudgeModel(getConfig(), readSessionModel(session))`（判别/★/压缩同源辅助模型）；
   推理档 = `reasoningEffortSetting` + `resolveReasoningEffort`（缺省跟随）；`temperature:0`；
   usage 经 `onUsage` 回执入 `compress-run.llmUsage`；非 stop finish / 空文本 = 失败（fail-lazy）。
6. **缩水校验**（replace 前置）：`productTokens < shadowedTokens` 才落刀；否则**重试 1 次**，仍不满足 = 保留原文 + 记账。
7. **档案 vN**：`boundary_archive:<workspace>` 实体；`putEntity` 带 `source {taskId, eventType:'boundary-archive', evidence:{...}}`；
   CAS 冲突重读重试 1 次；**落盘成功才 replace**（09 §6：LLM 产物未落盘不被引用）。
8. **事务**：`runCompactionTxn(history, planTxn({...replaceKind:'digest'}), apply)`；`apply` 内 `recordPrune`（原区间影子价）+
   `commitCheckpoint`；`plan.txnId` = `ce-compact-boundary-<taskId>-<start>-<end>`（幂等键）。
9. **事实**：一次尝试一条 `compress-run`（`at/layer/taskId/promptVersion/policyVersion/cacheHit/calls/regionTokens/
   promptTokens/productBytes/shadowedTokens/outcome/reason/droppedHotTail/llmUsage/archive*/retry/shearFolded`）。
10. **T-boundary 补账**：区间内 `foldToolShear` 的 `hold` 决策 → 逐条 `shear-applied{tier:'T-boundary',kind:'t-boundary',
    beforeTokens,afterTokens:0,savedTokens:before,breakTokens:0,tailNodes:0}`；与剪切域既有事实同形，回放自动计入 `cutEvents.tool`。
11. **卷宗清空** = 结构性（`sessionScopedTaskId` 分键）：不删旧卷宗；事实位 `dossierRetired` 供审计。
12. **共存**：与原生 compaction-basic 共持 `compaction/start` 锁（`runCompactionTxn` 的 `assertNoActiveCompaction`）；
    原生 `auto:true` 现状见工单头，覆写归 P20b。
13. **确定性**：核心纯函数无时钟/随机（D12/D13）；编排层时钟只进事实 `at`；同输入同装配字节。

## 5. 验收（全机械；[x] = 实测已过，2026-09-08）

- [x] `npm run gate` → **478 用例 / 46 文件**（M1–M5 / S1–S5 / **D1–D15** 全 PASS，`ok=true vacuous=[]`）
- [x] `npm run typecheck:tests`（绿）
- [x] `tests/compress-region.spec.ts`（**4**：四类转写 / 遮蔽过滤 / 坏形状 / 体量双跑）·
      `compress-store.spec.ts`（**6**：追加 + 硬帽整条截断 / 续传链过滤 / 防御解析 / 键确定性 + 敏感 / 缓存淘汰）·
      `compress-ledger.spec.ts`（**+3**：P19 自持位 / 合并 fold 透出 / 档案硬帽两源入账）·
      `compaction-domain.spec.ts`（**16**：全路径 / 已归档守卫 / 跨会话复用 / 机制 A / T-boundary / 解析/schema/shrink/storage/llm 失败 /
      开关 / 无闭合 / 不变量回退 / 卷宗分键）· `agent-step.spec.ts`（**4**：载荷 / 恒 next / 遏制 / 中止 / 退订）·
      `history.spec.ts`（**+2**：commitCheckpoint 官方协议 + 拒绝）· `field-model.spec.ts`（**+1**：压缩六字段）·
      `assert-structure.spec.ts`（**+D14/D15** 负正样本 + 零位快照）
- [x] `node scripts/verify-p19.mjs` → **P19 VERIFY PASS (27 checks)**（导出面 13 / 结构 D14+D15 / 区间转写 / 档案区 / 账本 /
      假会话端到端 4 项 / 真机只读回放 2 项 / spec 标记 / 文档标记 / 尺寸）
- [x] `DSH_CHECKOUT=G:/deepseek-harness` + Git bash `scripts/build.sh` 绿（host + client；新增 `@deepseek-ai/dsh-agent`、
      `@deepseek-ai/dsh-token-meter` 链接）
- [x] `node scripts/verify-p18.mjs`（45）/ `verify-p17.mjs`（54）/ `verify-p16.mjs`（30）→ PASS（无回归）
- [x] 文档同步：总纲 P19 行 + 施工记录；docs/04 状态行；docs/09 状态行；docs/10 状态行（H2/H4）；
      docs/11 状态行 + §2 树 + §6 开关表；AGENTS 现状；`docs/ledger-history.md` 新增快照 §46（只增不改）

## 6. 禁区与注意

- 不动 `docs/00–11` 设计正文（状态行除外）、`datasets/`、`experiments/`、`reports/`、`scripts/attic/`、`cordis.patch.yml`（P20b）。
- **N1**：H2 必须 `return next()`，异常只 warn；压缩失败绝不阻塞本轮（D2 + fail-lazy）。
- **N2**：区间尾必须排除新 task 首条消息（权威段不可折）；`balanceRange` 失败 = 放弃本轮。
- **N3**：`hotTail` 缺失/全坏不是 fatal（P18 口径），装配器位置兜底；本单不新增 fatal。
- **N4**：档案只追加；硬帽截断只从最老整条开始（`truncateArchiveArea` 纯核，P17c）；截断计数入 `assemble-run` + `compress-run`。
- **N5**：`compressionCacheHitRate` 分母 = `compress-run` 事实数（P18 口径不变）；内容寻址键随 P19 落位，跨会话命中 = 零调用。
- **N6**：一个 task 一次尝试（事实键），防 pre-step 每步重复计费；仅 `llm-unavailable` 允许重试。
- **N7**：`compressionLayer` 仍只由 `assemble-run` 计数（P18 N6 防双计不变）。
- **N8**：不实现注入段；替换节点 = 官方 checkpoint user message（模型可见），档案 KV 只是镜像/缓存。
- **N9**：原生 compaction-basic `auto:true` 现状（profile 未覆写）→ 共存风险如实上报；覆写归 P20b。
- **N10**：尺寸申报（开工估计/实测）——P19a 估计 ≤420 / 实测 **512**（+92）；P19b 估计 ≤450 / 实测 **577**（+127）；
  合计 **1,089**（超估计 219）；另 spec ≈**622**、`verify-p19.mjs` **379**、`assert-structure.mjs` **+9**。
  超线归因 = 合规自证头（docs/05 §6）约 100 行 + 端到端域编排六段 + 两个新端口（H2/H7）；
  不拆单理由 = 已按 L 规则拆 P19a/P19b 两提交（各带独立验收），P19b 内部六段互为同一端到端路径（拆开产生跨提交悬空行为）。

## 7. 完成动作

- commit: `feat(p19a): 边界路径纯核与端口面——区间转写 + 档案区存储 + 内容寻址复用 + H2/H5 端口`；
  `feat(p19b): 边界路径编排——H2 闭合触发 + 档案 vN + 缩水校验 + T-boundary 搭车`；
  `docs(p19): 工单修正 + 快照 §46 + 文档同步`。
- 账本快照：`docs/ledger-history.md` 新增一节（只增不改）。

## 8. 计划修正（依据 P17/P17c/P18 执行结果 → P19 计划落位）

| # | 前序执行结果 | P19 计划修正 | 落位 |
|---|---|---|---|
| 1 | 总纲 P19 行未列「缩水校验」，但 04 §1 明令「产物 token < 被压区间 token，否则重试」；总纲 P19 尾注（master §180）已点出 | 纳入 P19b（**replace 前置**，边界档重试 1 次）；失败 = 非 fatal 保留原文 + 记账 | §2/§4.6/§6 N3 |
| 2 | P18 N5：「`compressionCacheHitRate` 键与 KV 缓存实现归 P19」；04 §6「跨会话复用不重算」 | P19a 落内容寻址纯核（`compressSpanHash`/lookup/put）+ P19b 接档案实体；命中 = `calls:0` | §3 `store.ts` / §4.8 |
| 3 | P18 的压缩 prompt = **模板在前**单字符串（`renderBoundaryPrompt`），与 docs/06 §6「辅助调用 = 上一次请求真前缀 + 短尾」在压缩调用上**不同构**（原生 compaction 走真前缀） | **不改正典**：本单以 `compress-run.llmUsage.cacheReadTokens` 如实记账，把「压缩调用是否值得改真前缀布局」作为 P21b 的账本决策项上报 | §4.5 / §6 N10 实测读数 |
| 4 | 09 §1：档案 = 项目级实体（键含 workspace）；P13 已落 `sessionScopedTaskId` | 档案键 = `boundary_archive:<workspace>`；条目带 `sessionId`；卷宗清空 = 结构性分键，**不删旧卷宗** | §3 `store.ts` / §4.7/§4.11 |
| 5 | T-boundary 搭车 = 大 replace 构造性折叠，但 07 `cutEvents` 只认 `shear-applied` 事实（`core/shear/ledger.ts:213-223`） | 新增 `tier:'T-boundary'`/`kind:'t-boundary'` + P19 为区间内 hold 对补发事实（**会计**，不改机制） | §3 `shear/ledger.ts` / §4.10 |
| 6 | H2 挂点需 `@deepseek-ai/dsh-agent` 类型面（`packages/core/agent`，当前非 peerDep） | 新增 peerDep + build.sh link；概念收口到 `platform/agent-step.ts`，新增 **D14** 断言锁死 | §3/§4 / §6 N1 |
| 7 | docs/11 §6 已定 `compression.*` 六字段与不变量，但 P17/P18 以 `DEFAULT_*` 常量承接 | P19b 落 config 六字段 + `retain < threshold` 校验 + client 对应律同步 | §3 `config.ts` |
| 8 | 总纲尺寸规则：M = ≤400 行净增；本单按 P17/P18 实际体量估算 ≈ 800–900 行 | **按 L 规则拆 P19a/P19b 两提交**（各带独立验收），工单一份 | §3/§7 |
| 9 | 原生 compaction-basic `auto` 默认 true 且本机 profile 未覆写；P20b 才加 `auto:false` | P19 **不越权改 patch**；两者共持 `compaction/start` 锁（安全），共存风险如实上报 | §6 N9 |
| 10 | harness 压缩不变式：`compaction/start` 的 `turn` 必须等于当前打开轮（`owner:null` 在轮内非法） | `planTxn` 增 `turn?: number \| null`；域侧把 `agent/pre-step` 的 `turn` 传入事务 | §3 P19a `txn.ts` / §4.8 |
| 11 | token-meter 影子价必须与 harness 固定估计器同源（否则投影总量漂移） | 新增 H7 端口 `platform/meter.ts` + **D15**；服务缺失时降级本地估算并在事实里如实记账 | §3 P19b / §4.7 |
| 12 | `archiveTruncate` 若走 `assemble-run` 会形成"装配事实先于档案落盘"的先后循环（截断取决于装配产物字节） | 边界路径把截断计入 `compress-run`（07 fold 同时认两源，生产者各自唯一）；P20a 可继续用 `assemble-run` 通道 | §3 P19a `ledger.ts` / §4.9 |

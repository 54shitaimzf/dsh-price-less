# P20 压力路径与保险丝（R4；依赖 P19；尺寸 P20a **M** + P20b **S**，两单两提交）

> 设计正典：docs/04 §1（共享事务原语/缩水校验）· §3（层 3 压力路径：40% 触发 / 检查点 + 缝 /
> 保留区全量逐字 / 机制 A 续传 + 机制 B 折叠 / 生产消费不对称律 / 失败语义重试一档）·
> §4（层 4 保险丝：地板 / no-op / hard-truncate 事件）· §5（标定：domain/threshold/retain 绝对设计值 +
> wire 锚定估计器 CHARS_PER_TOKEN=1.5）· §6（档案区只追加 + 15K 硬帽）· §7（事件与度量）；
> docs/10 §1 H3（压力触发 + request-error 接管）+ H4/H5 + §5 时序 C + §6 断言 1–4；
> docs/09 §1（workspace 隔离）/§2（边界档案 vN）/§4；docs/07 §0.5 压缩族 + §1 关键字段 + §5 回放管道；
> docs/11 §2 模块树 + §6 装配开关 + §8 R4 门槛；docs/06 §2/§6；docs/05 §6。
> harness 符号清单（逐条 grep 到定义处，找不到即停工上报）：
> - H3 压力触发 + 溢出接管：agent/pre-step waterfall
>   G:/deepseek-harness/packages/core/agent/src/runtime-types.ts:276（payload {agent,messages,turn,step,signal}）；
>   agent/request-error waterfall 同文件 :305（payload {agent,turn,step,provider,failure,retryPolicy,signal}，
>   next(): Promise<RequestErrorAction>）；RequestErrorAction 同文件 :68（{kind:'retry'} | undefined）；
>   包 @deepseek-ai/dsh-agent @ packages/core/agent。
> - 溢出错误码：CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
>   packages/llm/llm/src/error.ts:25（包 @deepseek-ai/dsh-llm，已 peerDep）。
> - 模型真实窗口：llm.resolveModelInfo(provider, model, signal).context.contextWindow
>   packages/llm/llm/src/index.ts:726（LlmResolvedModelInfo.context）。
> - wire 锚定计量：ctx.tokenMeter.measure(session).totalTokens
>   packages/llm/token-meter/src/index.ts:144（baseline=provider usage 或估计 + surfaceDeltaTokens，
>   每步由新 usage 重锚定、误差不累积；contextPressure 投影同源 packages/llm/token-meter/src/usage-projection.ts:173）。
> - 原生引擎现状：packages/bundle/base/cordis.patch.yml:320 挂 id=compaction-basic 无 config；
>   auto 默认 true（compaction-basic/src/config.ts:95），auto 门控同时关压力与溢出恢复
>   （compaction-basic/src/index.ts:130）；P20b 以本插件 bundle 层 patch 覆写 auto:false。

## 1. 目标

把 P17/P18/P19 的装配与调用能力接成**层 3 压力路径**与**层 4 保险丝**：

- **P20a 压力路径**（时序 C 上半）：H2 每步 wire 锚定计量（ctx.tokenMeter 的 provider 锚 + 表面增量，
  每步重锚不累积）→ 触发阈 = compression.thresholdTokens（绝对设计值；比例式 pressureRatio × domainTokens
  作 fallback，见 §8-1）→ 选缝（最后一个子任务起点 = 单元边界，不切工具对）→ 单次调用产出
  **进行时检查点 + cutPoint** → 保留区 [cutPoint..end] 全量逐字（无 10K 帽、无 span 申报、无盘上物化）→
  缩水校验（replace 前置，压力档重试 2）→ 档案 vN（kind=checkpoint，存 cutPointSeq/rangeEndSeq）→
  H4/H5 事务替换 → 断路器（单 task 上限 3）→ pressure-fired 事实。
- **P20b 保险丝**（时序 C 下半）：地板 = contextWindow × 0.8 的**纯机械谓词**；低于地板**严格 no-op**
  （零事实、零调用、零改史，字节不变断言）→ 地板以上或 provider 报 CONTEXT_WINDOW_EXCEEDED 时
  走**紧急压力折叠**（同一条 P20a 路径，force=true）→ agent/request-error 返回 {kind:'retry'} 让本轮重试；
  hard-truncate 事实入账；cordis.patch.yml 覆写 compaction-basic auto:false（防双触发）。

**本单不做**：恢复编排（P21a）；四次序端到端交错验收与四道缓存断言进 CI（P21b）；
真前缀布局重构（P19 §8-3，仍为 P21b 账本决策项）。

## 2. 输入

- 正典要点（工单内自足）：
  - **触发语义**（04 §3 + 10 §5）：pressureRatio = 0.4 × 压缩域窗口，wire 锚定；P19 已用 thresholdTokens
    作绝对设计值（docs/04 §5「绝对设计值…比例派生只作 fallback」）——两式在默认值下不一致
    （0.4×125K=50K vs 100K），P20a 按 §5 主次落地并在 §8-1 上报。
  - **输出 schema**（04 §3）：①进行时检查点 progress/currentState/nextStep/liveConstraints（受众 = 当前任务的自己，
    不宣称最终事实）；②cutPoint = 最后一个子任务起点（单元边界；机械校验仅两条 = 单元存在 + 缝不切工具对，P18 已交付）。
  - **保留区**（04 §3）：[cutPoint..end] 全量逐字；无帽、无 span 申报、无盘上物化。
  - **机制 A**（04 §3）：摘要块字节一经写出不可变；后续压缩遇旧块**原样续传**；输出 = 续传旧块 + 追加新块。
  - **机制 B**（04 §3）：压力路径把折叠区内的热尾/保留材料折进检查点（坐标锚保留）；热尾申报是边界压缩器专属。
  - **断路器**（04 §3）：单 task 压力上限 3–4（链长有界，账本可见）；本单取 3。
  - **失败语义**（04 §3）：fatal 口径同 §2（仅解析/schema）；压力折叠失败 fail-lazy 继续全上下文，
    重试预算比边界激进一档（边界 1 → 压力 2）。
  - **保险丝**（04 §4）：估算 ≥ contextWindow × 0.8 → 触发；低于地板**完全 no-op**（不改变任何未护栏行为）；
    记 hard-truncate 事件与计数器；裸模型窗口只喂保险丝地板，**永不作为压缩触发**。
  - **workspace 隔离**（09 §1）：档案 = 项目级实体（键含 workspace）；条目带 sessionId。
- 现有文件（**复用，不重复实现**）：
  - core/compress/prompt.ts renderPressurePrompt / renderPriorChain；product.ts parseCompressProduct（压力两校验）；
    consume.ts planTailConsumption（机制 A/B + 四次序闭合表）；store.ts（档案区 + 内容寻址 + priorChainFor）；
    region.ts renderRegionTranscript / surfaceEventsInRange / messageTextOf。
  - core/assemble/assemble.ts foldAssembleInputs（单元清单）+ DEFAULT_ASSEMBLE_POLICY；core/ledger/fold.ts
    estimateTokens / extractTextFromToolResult；core/ledger/surface.ts foldSurfaceNodes。
  - domains/compaction.ts mountCompactionDomain（边界路径 + 共享事务执行器调用）；domains/assemble.ts
    runCompactionTxn；platform/history.ts commitCheckpoint / balanceRange；platform/llm.ts streamCeLlm /
    resolveReasoningEffort / resolveLlmService；platform/meter.ts createMeterPort；platform/agent-step.ts
    onAgentPreStep（H2 收口 D14）；domains/input.ts resolveJudgeModel。
- **本单不做**：见 §1。

## 3. 产出

### P20a 压力路径（src 净增估计 ≤400；文件 4–6）
- src/core/compress/pressure.ts（新）：纯核——
  PRESSURE_RATIO=0.4 / PRESSURE_CHAIN_LIMIT=3 / PRESSURE_RETRY_BUDGET=2 / PRESSURE_FIRED_FACT_TYPE；
  pressureThreshold({thresholdTokens, domainTokens})（绝对设计值为主、比例式 fallback）；
  shouldFirePressure(...) / pressureChainDepth(priorChain) / pressureBreakerTripped(depth)；
  renderCheckpoint(checkpoint) / composePressureArchive({priorChain, checkpointText, retainedText})；
  isPressureMaterial(event) / renderFoldMaterialTranscript(events, range)（折叠区 = 上次缝之后的原始材料，
  含被上次压力替换遮蔽的原文；剔除 compaction 协议事件与本插件 checkpoint 节点）；
  PressureFireFactData + foldPressureFires（07 pressure* 四字段）。
- src/core/compress/ledger.ts（改）：CompressRunFactData 追加 cutPointSeq?/foldedTokens?/retainedTokens?/emergency?；
  CompressCallLedger 追加 pressureOk / pressureFoldedTokens / pressureRetainedTokens / pressureEmergencies；fold 同步。
- src/core/compress/store.ts（改）：ArchiveRecord 追加 cutPointSeq? / rangeEndSeq?（额外字段不参与链字节判定）。
- src/core/assemble/ledger.ts（改）：compressionLayer.pressure 由 compress-run（layer=pressure ∧ outcome=ok）计数
  （边界仍由 assemble-run 计数；两源各自唯一，见 §8-3）；pressureFireCount / pressureTriggerWireTokens /
  pressureChainDepth / pressureBreakerTrips 由 pressure-fired 事实 fold。
- src/core/compress/index.ts（改）：导出 pressure.ts。
- src/platform/meter.ts（改）：MeterPort 追加 wireTokens(session)（= measure().totalTokens，provider 锚 + 增量）。
- src/domains/compaction-facts.ts（改）：context-economy/pressure-fired 声明合并（D3 白名单已含本文件）。
- src/domains/compaction.ts（改）：onPreStep 内压力分支（阈值判定 → 链深/断路器 → 折叠区与单元清单 →
  内容寻址复用 → renderPressurePrompt → 单次调用 → parseCompressProduct → 保留区逐字 + 检查点渲染 →
  缩水校验（重试 2）→ 档案 append（kind=checkpoint）→ runCompactionTxn（prune + commitCheckpoint）→
  compress-run + pressure-fired 事实）。
- 测试：tests/compress-pressure.spec.ts（纯核）、compaction-domain.spec.ts（扩压力端到端）、
  compress-ledger.spec.ts（扩 pressure* fold）、tests/meter.spec.ts（新，wireTokens）。

### P20b 保险丝（src 净增估计 ≤150；文件 4–5）
- src/core/compress/fuse.ts（新）：FUSE_RATIO=0.8 / HARD_TRUNCATE_FACT_TYPE / fuseFloorTokens(contextWindow) /
  fuseArmed({wireTokens, contextWindow}) / HardTruncateFactData + foldHardTruncates（07 hardTruncateCount）。
- src/platform/agent-step.ts（改）：新增 onAgentRequestError(ctx,{handler,logger})——唯一持有
  agent/request-error 字面与 RequestErrorAction；非接管恒 next()，异常只 warn（D14 扩面）。
- src/platform/llm.ts（改）：resolveContextWindow(ctx,provider,model)（resolveModelInfo().context.contextWindow，
  按 route 缓存）+ 重导出 CE_CONTEXT_OVERFLOW_CODE（= CONTEXT_WINDOW_EXCEEDED_CODE，llm 词汇仍收口本文件）。
- src/domains/compaction.ts（改）：onPreStep 地板判定（低于地板 no-op）→ 地板以上 force 紧急折叠 + hard-truncate 事实；
  新增 onRequestError(payload)（溢出码 → force 紧急折叠 → 'retry'；否则 'pass'）；同 (turn,step) 只接管一次。
- src/index.ts（改）：onAgentRequestError 接线（disposer 收编）。
- cordis.patch.yml（改）：bundle 层 patch 覆写 compaction-basic config {auto:false}（防双触发，10 §1 辨析③）。
- scripts/assert-structure.mjs（改）：D14 扩面（agent/request-error / RequestErrorAction 同样收口 platform/agent-step.ts）。
- 测试：tests/fuse.spec.ts（新）、agent-step.spec.ts（扩 request-error）、compaction-domain.spec.ts（扩溢出接管/地板 no-op）。

## 4. 实现要点

1. **度量先行**：先落 compress-run 压力字段 + pressure-fired 事实 + fold（07 pressure* 四字段 + compressionLayer.pressure），再写编排。
2. **wire 锚定**：每步 onPreStep 读 meter.wireTokens(session)（ctx.tokenMeter 的 provider 精确 usage + 表面增量，每步重锚）；
   服务缺失 → 不触发（fail-lazy，不本地估触发——触发必须 wire 锚定）。
3. **触发**：wireTokens ≥ pressureThreshold(config) 才进入压力流程；**一个 turn 至多尝试一次**（防每步重复计费与事实刷屏；
   紧急折叠 force=true 绕过该守卫但受同 (turn,step) 去重）。链深 = 同 task 已归档 checkpoint 条目数；
   链深 ≥ PRESSURE_CHAIN_LIMIT → pressure-fired{outcome:'breaker'} + 计数，不调用。
4. **折叠区**：foldStartSeq = 同 task 上一检查点的 cutPointSeq ?? 当前 task 段起点；
   replaceStart = 上一检查点的 rangeEndSeq 之后的首个表面节点 ?? 段内首个表面节点。
   折叠区原文 = renderFoldMaterialTranscript(events, {foldStartSeq, taskEndSeq})（含被遮蔽原文；剔协议/检查点节点）。
5. **单元清单**：foldAssembleInputs(材料事件) 取 seqStart ≥ foldStartSeq ∧ seqEnd ≤ taskEndSeq 的单元；
   与折叠区同源（模型只从清单抄 unitId 选缝）。空清单 → skipped/no-units。
6. **调用**：模型路由/推理档/温度/usage 回执与 P19 边界档同源（辅助调用路由 + reasoningEffortSetting + temperature 0）。
7. **保留区**：cutSeq = 选中单元 seqStart；retainedText = renderRegionTranscript(events, {cutSeq, taskEndSeq})
   （表面逐字；此区间在本次缝之后，必为未遮蔽原文）。渲染 = composePressureArchive（续传旧块 + 新检查点 + 保留区）。
8. **缩水校验**：分母 = estimateTokens(折叠区原文)（被压区间 = 上次缝之后的原始材料）；
   分子 = estimateTokens(检查点 + 保留区)（续传旧块两侧抵消）。分子 < 分母才落刀；否则重试，预算 2（压力档激进一档）。
9. **档案 vN**：appendArchiveEntry 存 **检查点文本**（C，非整节点 C+R——续传只带 C，保留区下次折叠由原文重建）；
   条目带 cutPointSeq / rangeEndSeq / layer='pressure'；CAS 冲突重读重试 1；落盘成功才 replace（09 §6）。
10. **事务**：planTxn({layer:'pressure', txnId:'ce-compact-pressure-<taskId>-<replaceStart>-<replaceEnd>',
    shadowedTokenCount: 计量端口区间价 ?? 折叠区估计, turn}) → runCompactionTxn(prune + commitCheckpoint)。
    影子价 = meter.heuristicTokensInRange(session, replaceStart, replaceEnd)（H7 同源；缺失 = 折叠区估计）。
11. **事实**：每次尝试一条 compress-run（layer='pressure'，字段同 P19 + cutPointSeq/foldedTokens/retainedTokens/emergency）；
    每次**决定开火**一条 pressure-fired（at/wireTokens/thresholdTokens/outcome/chainDepth/foldedTokens/retainedTokens）。
    outcome ∈ fired | breaker | skip（skip 细分 reason：no-task/no-units/range/chain-invalid/llm-unavailable/…）。
12. **保险丝地板**：floor = contextWindow × FUSE_RATIO；contextWindow 经 resolveContextWindow（llm 路由缓存）；
    缺失 = 不武装（no-op）。低于地板 = 零事实零行为。地板以上 = force 紧急折叠 + hard-truncate 事实（outcome=fuse-fold）。
13. **溢出接管**：onRequestError 仅在 failure.code === CE_CONTEXT_OVERFLOW_CODE 且本轮未接管过时接管：
    force 紧急折叠 → 折叠落刀 = 'retry' + hard-truncate{outcome:'overflow-retry'}；未落刀 = 'pass' +
    hard-truncate{outcome:'overflow-declined'}（失败方向 = 原错误交给上游）。非溢出码恒 'pass'。
14. **确定性**：核心纯函数无时钟/随机（D12/D13）；编排层时钟只进事实 at；同输入同装配字节。

## 5. 验收（全机械；[x] = 实测已过，2026-09-08）

- [x] `npm run gate` → **512 用例 / 49 文件**（M1–M5 / S1–S5 / **D1–D15** 全 PASS，`ok=true vacuous=[]`）
- [x] `npm run typecheck:tests`（绿）
- [x] `node scripts/verify-p20.mjs` → **P20 VERIFY PASS (34 checks)**（导出面 18 项 / 结构 S1+D13+D14 扩面 /
      patch auto:false / 三事实声明 / 压力纯核 6 / 保险丝纯核 2 / 账本 1 / 假会话端到端 8〔压力全路径 / 紧邻契约 /
      断路器 / 地板 no-op 字节不变 / 地板以上紧急折叠 / 溢出接管 retry / 二次接管 pass / 非溢出码 pass〕/
      真机只读回放 2 / spec 5 / 文档 3 / 尺寸）
- [x] `DSH_CHECKOUT=G:/deepseek-harness` + Git bash `scripts/build.sh` 绿（host + client）
- [x] 回归：`verify-p19`（27）/ `verify-p18`（45）/ `verify-p17`（54）/ `verify-p16`（30）→ PASS
- [x] 文档同步：总纲 P20a/P20b 行 + 施工记录；docs/04 状态行；docs/09 状态行（档案两形态）；
      docs/10 状态行（H3）；docs/11 状态行 + §2 树 + §6 开关表；AGENTS 现状；
      `docs/ledger-history.md` 新增快照 §47（只增不改）

## 6. 禁区与注意

- 不动 docs/00–11 设计正文（状态行除外）、datasets/、experiments/、reports/、scripts/attic/。
- **N1**：H2 必须 return next()，H3 request-error 非接管必须 next()；异常只 warn，折叠失败绝不阻塞本轮。
- **N2**：保留区 [cutPoint..end] 全量逐字、**无帽**（04 §3 硬断言）；缝不切工具对由 P18 validateCutPoint 保证。
- **N3**：机制 A 只续传**检查点文本**；保留区不进档案条目（它是账本连续尾段，下次由原文重建后折叠）。
- **N4**：压力触发必须 wire 锚定（meter 缺失 = 不触发）；**不得**用裸模型窗口作触发（04 §4 硬规则）。
- **N5**：断路器上限 3（单 task checkpoint 条目数）；每次开火一条事实，防每步重复计费（turn 守卫）。
- **N6**：保险丝低于地板**零行为**（不写事实、不调用、不改史；字节不变断言）；contextWindow 缺失 = 不武装。
- **N7**：compressionLayer 口径修正——boundary 由 assemble-run 计数、pressure 由 compress-run（ok）计数，各自唯一不双计。
- **N8**：不实现注入段；压力替换节点 = 官方 checkpoint user message（模型可见）。
- **N9**：cordis.patch.yml 只加 compaction-basic auto:false（重述保留字段为空 = 默认值全保留）；不动其它行。
- **N10**：尺寸申报（开工估计/实测）——P20a 估计 ≤400 / 实测 **562**（+162）；P20b 估计 ≤150 / 实测 **259**（+109）；
  合计 **821**；另 spec ≈ **515**、`verify-p20.mjs` **458**、`assert-structure.mjs` **+8**。
  超线归因 = 合规自证头（docs/05 §6）约 60 行 + 压力端到端七段 + 保险丝三段 + 三个端口扩面（H7 wire / H3 request-error / H12 窗口）；
  不拆单理由 = 已按总纲 P20a/P20b 两单两提交（各带独立验收），P20a 内部七段互为同一端到端路径。

## 7. 完成动作

- commit：feat(p20a) 压力路径——wire 锚定计量 + 检查点 + 保留区逐字 + 断路器；
  feat(p20b) 保险丝——地板 no-op + request-error 溢出接管 + auto:false 覆写；
  docs(p20) 工单 + 快照 §47 + 文档同步。
- 账本快照：docs/ledger-history.md 新增一节（只增不改）。

## 8. 计划修正（依据 P19 执行结果 → P20 计划落位）

| # | 前序执行结果 | P20 计划修正 | 落位 |
|---|---|---|---|
| 1 | 04 §3 触发式 = 0.4 × 压缩域窗口（=50K），04 §5/config 绝对设计值 thresholdTokens=100K；两式默认值不一致 | 按 §5「绝对设计值为主、比例派生只作 fallback」：触发阈 = thresholdTokens，ratio 式作 fallback；作为 P21b 账本决策项上报（domain 是否调到 250K 使两式一致） | §2/§4.3 |
| 2 | P19 档案条目 text = 整节点（C+R）；压力续传会把旧保留区永久滚存 | 压力条目只存**检查点文本 C**；保留区下次由账本原文重建后折叠（机制 B）；续传 = C 链 | §4.9 |
| 3 | P18 N6/N7：compressionLayer 只由 assemble-run 计数 | 压力路径不经边界装配器（保留区无帽 + 无热尾语义）⇒ pressure 由 compress-run（ok）计数；两源各自唯一 | §3 assemble/ledger.ts |
| 4 | harness 无 hard-truncate 挂点（pre-step 只准入 inbox 消息；历史派生自表面 fold，无法重建请求消息表） | 04 §4「重建消息表」落为**紧急压力折叠**（唯一合法缩上下文通道）+ request-error retry；地板谓词 + no-op 语义保留 | §4.12/§4.13 |
| 5 | P19 事务 turn 由 pre-step 注入；溢出接管发生在轮内 | 紧急折叠复用同一 planTxn(turn)；request-error 载荷 turn = 打开轮 | §4.10/§4.13 |
| 6 | 压力需 wire 锚定计量，P19 meter 只有区间启发式 | meter 端口追加 wireTokens（measure().totalTokens）；contextWindow 经 llm 端口解析（D6 收口） | §3 meter/llm |
| 7 | compaction-basic auto 默认 true 且自动门控同时关压力与溢出恢复 | P20b patch 覆写 auto:false 后，溢出恢复唯一提供者 = 本插件 request-error 接管 | §3 cordis.patch.yml |
| 8 | 总纲尺寸：P20a M / P20b S | 两单两提交（同一工单）；若 P20a 实测超 400 行按 P19 先例申报 + 说明 | §7 |

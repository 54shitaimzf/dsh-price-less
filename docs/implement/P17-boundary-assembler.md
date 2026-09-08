# P17 边界装配器（R4；依赖 P6,P8,P9；尺寸 L → 工单内拆 **P17a 纯核+度量** / **P17b 接线**）

> 设计正典：docs/04 §1（共享事务原语）· §2（边界装配：事实层冻结 / 双通道坐标 + 版本重映射 / 预算三环 / 热尾生命周期）· §6（档案形态）· §7（事件与度量）· §8（验收）；
> docs/07 §0.5 压缩族；docs/10 §1 H4/H5/H15；docs/11 §2 core/assemble 行 + §9（装配器确定性）；docs/09 §2（边界档案 vN）；docs/01 §3.5（稳定点）；docs/05 §6。
> harness 符号清单（逐条 grep 到定义处，找不到即停工上报）：
> - `FileSystem`（抽象服务，`super(ctx,'fs')`）+ `Context.fs` 声明合并 @packages/fs/fs/src/index.ts:86-89 / 44-47
> - `resolve(path,{cwd,signal})` :116 · `stat(target,signal)` :165 · `readText(target,signal)` :189 · `processPath(target)` :126
> - `FsTarget{targetKey,displayPath}` @packages/fs/fs/src/types.ts:60 · `FsInfo{version,type,size?}` :76 · `FsVersion` :35（**不透明 token，禁解释**）
> - read 结果落盘 meta = `{path,offset,lines[{number,text}],totalLines,lang?}` @packages/fs/tool-fs/src/read.ts:122-131（→ `tool/result.data.meta` @packages/core/session/src/types.ts:337）
> - `tool/call {callId,name,arguments}` @packages/core/session/src/types.ts:325 · edit/write 结果 meta = `{diffs}`（**无行号**）@packages/fs/tool-fs/src/edit.ts:106-108
> - H4/H5 执行面 = `src/platform/history.ts`（P6 已收拢：`beginCompaction/endCompaction/recordPrune/balanceRange/assertNoActiveCompaction`）；配对平衡 = `toolPairingBalancedBefore/After`（D7 锁在 platform）
> - `estimateTokens` @src/core/ledger/fold.ts:16 · `DEFAULT_CHARS_PER_TOKEN = 1.5` @src/core/ledger/types.ts:71（docs/04 §5 wire 校准）

## 1. 目标

把「task 闭合后的档案装配」做成**纯核 + 薄接线**：机械产出 ①事实层（类型化摘要，稳定点冻结）②坐标层（文件坐标 `{path,vN,lineRange?}` 经版本补丁链重映射后**盘上取真** / 历史 span 坐标经**账本取真**）③热尾（按申报序贪心累加到 10K 即停 + 地板填充 + 位置兜底），
并交付**边界/压力两路径共用的压缩事务原语**（标记对 + 影子计价 + 配对平衡），使 07 压缩族 `hotTail*` / `digestBytes` / `digestEntryCount` / `compressionLayer` 字段可回放计算。

## 2. 输入

- 正典要点（工单内自足）：
  - **事实层冻结**：task 闭合 = 区间信息稳定点；装配产物 = ①类型化摘要（plan/impl/verify/wrap 信息块；impl 用坐标指针不嵌代码）+ ②坐标层 + ③热尾原文（04 §2/§6）。
  - **双通道坐标**（"范围 → 原文"= 两级机械查表，模型只生产坐标）：**通道 A** `{path,vN,lineRange?}`，vN = 模型见过的版本；补丁链按逐版行偏移机械平移 vN→当前版，**从磁盘取字节**（含本会话已落盘编辑；上下文副本是历史快照）；文件未改 = 恒等零成本；出界裁剪；已删除丢弃 + 计数。**通道 B** 单元 ID 区间 → 账本取真（历史不可变，切片即精确真值）。分通道根据 = **可变性**（磁盘可变 / 历史不可变）。
  - **预算三环**：压缩器输入尾部机械追加单元清单（ID·路径·版本对·粗标体量）；prompt 令模型按重要性降序申报、**禁止预算计算**；装配器按申报序**贪心累加、到 10K 即停**（可少不多、无下限）；单单元超帽 → 尾截断 + 可见标记；**tool_call/result 对永不拆分**。
  - **地板填充**：申报装填停机后，run 结果类目未覆盖且预算有余 → 确定性补最近验证尾（逐字末次验证 ≤3 条）+ 逐字失败/错误行 ≤5 条；同单元 ID 去重。
  - **三环 fatal 口径**：仅解析失败 / schema 违例 fatal；`hotTail` 缺失或坐标全无效 → 回退位置法反向累加 10K；部分无效 → 丢弃 + 计数；超预算/坏坐标全部机械降级，**不产生新 fatal**。
  - **热尾生命周期**：单任务一次性；装配进新 task 后即普通成员；**热尾是缓存不是档案**（源 = 盘上文件 + append-only 账本，永久可重推导）。
  - **共享事务原语**（04 §1）：一切历史变更只走 `surfaceOp replace` + 完整 `sourceEventSeqs`；压缩事务 = 标记对（持锁幂等）；`compaction/prune` 影子计价紧随每次遮蔽；跨工具对边界永不拆散；缩水校验（产物 token < 被压区间 token，否则不落刀）。
- 现有文件：`src/core/ledger/{fold,types,facts}.ts`、`src/core/shear/{tool,ledger}.ts`（读窗口/类别/路径判据可参考）、`src/platform/history.ts`、`src/domains/shear.ts`（事件摄取形态）、`src/domains/shear-facts.ts`（事实声明形态）、`scripts/assert-structure.mjs`（D 族规则表）。
- **本单不做**：压缩 prompt 组装与产物解析（P18）；边界触发/档案落盘 vN/卷宗清空/T-boundary 搭车（P19）；压力路径与保险丝（P20a/P20b）；`compression.*` 配置面（随 P19/P20a 落，本单以 `DEFAULT_ASSEMBLE_POLICY` 初值 + 可注入 policy 参数承接）。

## 3. 产出

### P17a（纯核 + 度量；零 harness/platform import、无时钟随机、不抛错）
- `src/core/assemble/types.ts`：`ASSEMBLE_POLICY_VERSION`/`AssemblePolicy`/`DEFAULT_ASSEMBLE_POLICY`（`hotTailTokens=10000`、`charsPerToken=1.5`、`floorVerifyLines=3`、`floorErrorLines=5`、`maxFetchUnits=64`）、`LineRange`、`FileCoord`/`SpanCoord`/`HotTailDecl`、`TaskDigest`/`DigestBlock`/`DigestCoord`/`DigestBlockType`、`AssembleUnit`、`HotTailSelection`/`HotTailPlan`/`AssembleResult`/`AssembleOutcome`、`AssembleLayer`。
- `src/core/assemble/chain.ts`：`FileOp`、`FileVersion`、`Hunk`、`FileChain`、`foldFileChains(ops)`（read 窗口 / write 全文 / edit 定位 oldString 求 hunk；定位失败 → 链断，不猜）、`remapFileCoord(chain, coord, currentLineCount?)` → `{ok:true,lineRange,clipped}` | `{ok:false,reason:'unknown-version'|'chain-break'|'deleted'|'empty'}`（恒等 / 逐版行偏移 / 出界裁剪 / 删除丢弃）。
- `src/core/assemble/assemble.ts`：`foldAssembleUnits(events)`（tool 对 = 单元，配对不拆；read 窗口/写路径与版本挂单元）、`validateDigest`/`renderDigest`（类型化摘要 schema + 字节稳定渲染）、`assembleArchive(input)`（贪心停机 + 单单元尾截断 + 地板填充 + 位置兜底 + 装配序 = transcript 序 + 计数）、`renderArchive(result)`。
- `src/core/assemble/txn.ts`：共享事务原语（**中性词汇，D7 锁**）：`TxnLayer`/`TxnStep`/`TxnPlan`/`planTxn`/`TxnMarker`/`foldTxnMarkers`/`txnOrderValid`（open→replace→prune→close 顺序、单事务持锁、幂等键）。
- `src/core/assemble/ledger.ts`：`ASSEMBLE_RUN_FACT_TYPE`、`AssembleRunFactData`、`CompressionLedger`（07 压缩族全字段；未实现项显式 0 并注明归属）、`foldCompressionLedger(facts, policy?)`。
- `src/core/assemble/index.ts`：re-export。
- `tests/assemble-chain.spec.ts` / `tests/assemble-hottail.spec.ts` / `tests/assemble-ledger.spec.ts`（新）。

### P17b（接线）
- `src/platform/files.ts`（新）：**盘上取真唯一触点**（`ctx.fs` resolve/stat/readText；行切分；越界裁剪；一切失败 → `null` + warn，零重试）。`FilesPort`、`createFilesPort(ctx, opts?)`。
- `src/domains/assemble-facts.ts`（新）：第五类 ignorable 事实 `context-economy/assemble-run`（声明合并 + `compactFact` 复用）。
- `src/domains/assemble.ts`（新）：装配域服务——事件摄取（file ops / 单元 / 表面 fold）→ 范围过滤 → `foldFileChains` → 通道 A 经 `FilesPort` 取真 / 通道 B 取单元原文 → `assembleArchive` → 事实发射；`runCompactionTxn(history, plan, apply)`（H5 标记对执行器，P19 复用）；`stats()`。
- `src/index.ts`（改）：挂载装配域 + `ctx.inject(['fs'], …)` 注入盘上取真端口（服务缺失 = 通道 A 降级为丢弃计数，通道 B/兜底照常）。
- `package.json`（改）：peerDep `@deepseek-ai/dsh-fs`；`scripts/build.sh`（改）：链接 `packages/fs/fs`。
- `scripts/assert-structure.mjs`（改）：**D11**（`ctx.fs`/`dsh-fs` 概念只许在 `platform/files.ts`）+ **D12**（`core/assemble/**` 无时钟随机）；`tests/assert-structure.spec.ts`（改）：负/正样本 + 零位快照。
- `tests/assemble-domain.spec.ts`（新）+ `scripts/verify-p17.mjs`（新，机械验收 + 真机回放）。

## 4. 实现要点

1. **度量先行**：先落 `core/assemble/ledger.ts` 与 `assemble-run` 事实载荷（07 压缩族字段全部有位置，未实现项显式 0），再写机制本体。
2. **坐标层（通道 A）**：版本号 = 插件侧逐路径单调计数（**不解释 harness 不透明 `FsVersion`**）；read 窗口 = 该版本已知切片，write 全文 = 该版本全文；edit 用 `old_string` 在**最近已知全文**里定位（`replace_all` 逐处），得到 `{startLine,endLine,newLineCount}` hunk；定位不到 → `chain-break`（不猜位置、不复活旧版本）。
3. **重映射**：从 `coord.version` 逐版前进——行号 = 原行号 + 该行之前全部 hunk 的净行差；区间与 hunk 相交 → 机械扩到 hunk 新跨度；`lineRange` 省略 = 整文件；末版后按 `currentLineCount` 出界裁剪（`clipped`），整段越界或文件不存在 → 丢弃 + 计数。
4. **坐标层（通道 B）**：单元 = tool 对（callId 为 ID，`seqStart/seqEnd` 为 span），文本 = 会话事件切片（域侧提供）；单元清单同时供压缩器 prompt（P18）枚举。
5. **贪心停机**：申报序累加；首单元超帽 → 尾截断（保头）+ 可见标记 `…（此处按装配预算截断）`；已有选中则停机 `budget`；申报耗尽 → `list-end`；**渲染序 = transcript 序**（`seqStart` 升序），同输入同装配字节。
6. **地板填充**：仅当预算有余且 run 结果类目未被覆盖；验证尾 ≤3 行 + 失败/错误行 ≤5 行，逐字摘抄、按单元 ID 去重；`floorFilled=true` 入账。
7. **位置兜底**：`hotTail` 缺失/空/坐标全部无效 → 从尾反向累加至 10K，`source='positional-fallback'`；**不产生 fatal**。
8. **共享事务原语**：`planTxn` 产出 open→(replace|prune)*→close；`foldTxnMarkers` 检测未闭合/ID 不匹配；`runCompactionTxn` 执行 = `assertNoActiveCompaction` → `begin` → 业务 op → `end`（失败带 `error` 收尾 + 遏制）；缩水校验由调用方（P19）在 replace 前用 `estimateTokens` 机械比对。
9. **事实与度量**：`assemble-run {at,layer,digestBytes,digestEntryCount,hotTailTokens,hotTailDeclaredUnits,hotTailStopReason,hotTailSource,hotTailFloorFilled,unitCount,dropped,clipped,truncated}`；fold 汇总压缩族；同输入同账。
10. **带外**：装配产物只在内存/事务里；不进模型视野的判定（vN、坐标、计数）只落事实轨；`core` 零 harness import（S1）、改史零出现（S2）、`ctx.fs` 零越界（D11）。

## 5. 验收（全机械）

- [ ] `npm run typecheck && npm run typecheck:client && npm test`（gate 四段）
- [ ] `npm run typecheck:tests`
- [ ] `tests/assemble-chain.spec.ts`：恒等（未改文件零成本）/ 单次 edit 行偏移 / 多次 edit 累积 / replace_all 多 hunk / write 全文替换 / 定位失败链断 / 未知版本 / 出界裁剪 / 整段越界丢弃 / 文件不存在丢弃 / 输入未 mutate / 双跑相等；
- [ ] `tests/assemble-hottail.spec.ts`：贪心到 10K 即停 / 申报耗尽 list-end / 单单元超帽尾截断 + 标记 / tool 对不拆 / 地板填充（验证 ≤3 + 错误 ≤5 + 去重 + 预算不足不填）/ 位置兜底 / 装配序 = transcript 序 / digest schema 违例 fatal / 同输入同字节；
- [ ] `tests/assemble-ledger.spec.ts`：压缩族字段由 `assemble-run` 事实汇总、未实现项恒 0、同输入同账；
- [ ] `tests/assemble-domain.spec.ts`：域装配端到端（fake session + fake FilesPort）→ 计划 + 事实；fs 缺失 = 通道 A 丢弃计数 + 兜底照常；`runCompactionTxn` 开闭配对/防重入/失败带 error 收尾；
- [ ] `tests/assert-structure.spec.ts`：D11/D12 负样本 + 正样本 + 零位快照；
- [ ] `node scripts/verify-p17.mjs`：文件齐备 / 导出面 / S1+S2+D7+D11+D12 / 策略初值 / 事实名跨层一致 / 账本 fold / 真机会话回放（file ops 数、可重映射率、假想热尾）/ 尺寸申报；
- [ ] `DSH_CHECKOUT=G:/deepseek-harness npm run build` 绿；
- [ ] `node scripts/verify-p16.mjs` / `verify-p15b.mjs` / `verify-p15a.mjs` 无回归。

## 6. 禁区与注意

- 不新增 LLM 调用（P17 零模型）；不触发压缩（触发归 P19）；不改 T-* / run 剪切语义；不动 `cordis.patch.yml`（`auto:false` 归 P20b）。
- 不解释 harness 不透明 `FsVersion`（只用插件侧版本计数）；不原地改写历史（唯一通道 `platform/history`）；不把插件内部标志写进模型视野。
- **N1**：vN 语义 = "该路径第 N 次被观察到的状态"（read/write/edit 各计一版）；模型从单元清单抄版本号（选坐标不造坐标）。
- **N2**：edit 定位只在"最近已知全文"里做（write 全文 / read 全覆盖窗口）；定位失败 = 链断 → 坐标丢弃 + 计数（**不猜位置**，失败默认保留）。
- **N3**：单单元超帽 = 尾截断保头 + 可见标记（canon 原文"尾截断"；错误行价值由地板填充另路覆盖）。
- **N4**：热尾不落盘、不跨压缩滚存（缓存非档案）；本单只产出计划与度量，注入与档案 vN 归 P19。
- **N5**：`compressionCallCount`/`compressionCacheHitRate`/`archiveTruncate`/`pressure*`/`hardTruncateCount`/`extraSearchCalls` 本单显式 0（归属 P18/P19/P20/P20b/P21b），口径先立不空转。
- **N6**：`ctx.fs` 缺失（服务未挂/降级）= 通道 A 全丢弃 + 计数，通道 B 与位置兜底照常（安全侧）。
- **N7**：`runCompactionTxn` 只做标记对与顺序；缩水校验/档案落盘/卷宗清空归 P19。
- 尺寸申报（**开工时估计 / 实测修正**）：P17a 估计 ≤780（红线 860）→ **实测 src 净增 1223**（types 168 / chain 342 / assemble 466 / txn 125 / ledger 113 / index 9；spec 482），超红线 363。
  超线原因 = 本单含 5 个纯核模块（坐标链 + 贪心装配 + 共享事务原语 + 压缩族账本 + 词汇面），初始估计按 P16a 单模块经验给出，低估了双通道与地板/兜底分支；**不为凑预算删减契约与合规头**。
  拆单方案（后续修订如继续膨胀即执行）：P17a1 = types + chain（510，含 spec 146）；P17a2 = assemble + txn + ledger（704，含 spec 336）。
  P17b 估计 ≤420（红线 480）。

## 7. 完成动作

- commit: `feat(p17a): 边界装配纯核——双通道坐标/贪心停机/共享事务原语`；
  `feat(p17b): 边界装配接线——盘上取真端口 + 装配域 + assemble-run 事实`；
  `docs(p17): 账本快照 §42/§43 + 文档同步（H15 盘上取真）`。
- 账本快照：P17a/P17b 各一节入 `docs/ledger-history.md`（只增不改）。

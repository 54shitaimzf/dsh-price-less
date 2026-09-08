# P17 边界装配器（R4；依赖 P6,P8,P9；尺寸 L → 工单内拆 **P17a 纯核+度量** / **P17b 接线** / **P17c 修正单**）

> 设计正典：docs/04 §1（共享事务原语）· §2（边界装配：事实层冻结 / 双通道坐标 + 版本重映射 / 预算三环 / 热尾生命周期）· §3 机制 A（追加式链两形态 / stub 不可重压）· §6（档案形态 + 15K 硬帽）· §7（事件与度量）· §8（验收）；
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

**P17c 目标（2026-09-08 修正单，依据 = P17a/P17b 执行结果）**：把正典里已引用、但 P17a/P17b 未落地的机械面补齐，并把工单自身与实测不符处改正——
① **HT 软门**（04 §2 门禁组：坐标可解析性机械校验，只降级不拒压）显式成函数；
② **裁剪计数修复**（`clipped` 计数此前恒 0——P17a 缺陷，实测审计发现）；
③ **档案区硬帽 15K 机械截断 + `archiveTruncate` 入账路径**（04 §6/§7；原 N5 记"归 P19"，现把**纯核部分**提前到 P17c，P19 只做档案区落盘/编排）；
④ **追加式链两形态校验**（04 §3 机制 A / §8"追加式链两形态皆可校验"）：单块总摘要 / `[C…][D]` 链、字节不可变（append-only 前缀恒等）；
⑤ **真机归因**：把 P17b 回放的 `chain-break 21` 拆成 write 屏障 / 定位失败两类并固化进 verify（不加启发式猜测——04 §2"不猜位置"）。

## 2. 输入

- 正典要点（工单内自足）：
  - **事实层冻结**：task 闭合 = 区间信息稳定点；装配产物 = ①类型化摘要（plan/impl/verify/wrap 信息块；impl 用坐标指针不嵌代码）+ ②坐标层 + ③热尾原文（04 §2/§6）。
  - **双通道坐标**（"范围 → 原文"= 两级机械查表，模型只生产坐标）：**通道 A** `{path,vN,lineRange?}`，vN = 模型见过的版本；补丁链按逐版行偏移机械平移 vN→当前版，**从磁盘取字节**（含本会话已落盘编辑；上下文副本是历史快照）；文件未改 = 恒等零成本；出界裁剪；已删除丢弃 + 计数。**通道 B** 单元 ID 区间 → 账本取真（历史不可变，切片即精确真值）。分通道根据 = **可变性**（磁盘可变 / 历史不可变）。
  - **预算三环**：压缩器输入尾部机械追加单元清单（ID·路径·版本对·粗标体量）；prompt 令模型按重要性降序申报、**禁止预算计算**；装配器按申报序**贪心累加、到 10K 即停**（可少不多、无下限）；单单元超帽 → 尾截断 + 可见标记；**tool_call/result 对永不拆分**。
  - **地板填充**：申报装填停机后，run 结果类目未覆盖且预算有余 → 确定性补最近验证尾（逐字末次验证 ≤3 条）+ 逐字失败/错误行 ≤5 条；同单元 ID 去重。
  - **三环 fatal 口径**：仅解析失败 / schema 违例 fatal；`hotTail` 缺失或坐标全无效 → 回退位置法反向累加 10K；部分无效 → 丢弃 + 计数；超预算/坏坐标全部机械降级，**不产生新 fatal**。**门禁组 HT 软门**（坐标可解析性机械校验）只降级不拒压。
  - **热尾生命周期**：单任务一次性；装配进新 task 后即普通成员；**热尾是缓存不是档案**（源 = 盘上文件 + append-only 账本，永久可重推导）。
  - **共享事务原语**（04 §1）：一切历史变更只走 `surfaceOp replace` + 完整 `sourceEventSeqs`；压缩事务 = 标记对（持锁幂等）；`compaction/prune` 影子计价紧随每次遮蔽；跨工具对边界永不拆散；缩水校验（产物 token < 被压区间 token，否则不落刀）。
  - **档案形态**（04 §6）：`[system+tools][task1 档案][task2 档案]…[当前 task]`；只追加、不可变；**档案区硬帽 15K token**，超限从最老档案条目起**整条机械截断**直至入限，`archiveTruncate{count,tokens}` 入账；**不合并、不重压**。
  - **追加式链**（04 §3 机制 A）：摘要字节一经写出即不可变；后续压缩遇旧块**原样续传、绝不重压**；输出 = 续传旧块 + 追加新块；两形态 = 单块总摘要 / `[C1…Cn][D]`。
- 现有文件：`src/core/ledger/{fold,types,facts,surface}.ts`、`src/core/shear/{tool,ledger}.ts`（读窗口/类别/路径判据可参考）、`src/platform/history.ts`、`src/platform/files.ts`、`src/domains/{assemble,assemble-facts,shear}.ts`、`scripts/assert-structure.mjs`（D 族规则表）。
- **本单不做**：压缩 prompt 组装与产物解析（P18）；边界触发/档案落盘 vN/卷宗清空/T-boundary 搭车（P19，含档案区生产者）；压力路径与保险丝（P20a/P20b）；`compression.*` 配置面（随 P19/P20a 落，本单以 `DEFAULT_ASSEMBLE_POLICY` 初值 + 可注入 policy 参数承接）。

## 3. 产出

### P17a（纯核 + 度量；零 harness/platform import、无时钟随机、不抛错）——**已施工（commit `24c30a5`）**
- `src/core/assemble/types.ts`：`ASSEMBLE_POLICY_VERSION`/`AssemblePolicy`/`DEFAULT_ASSEMBLE_POLICY`（`hotTailTokens=10000`、`charsPerToken=1.5`、`floorVerifyLines=3`、`floorErrorLines=5`、`maxFetchUnits=64`、`minTruncatedChars=200`）、`LineRange`、`FileCoord`/`SpanCoord`/`HotTailDecl`、`TaskDigest`/`DigestBlock`/`DigestCoord`/`DIGEST_BLOCK_ORDER`、`AssembleUnit`、`HotTailSelection`/`HotTailPlan`/`AssembleResult`/`AssembleOutcome`、`AssembleLayer`、`HOT_TAIL_TRUNCATION_MARKER`。
- `src/core/assemble/chain.ts`：`FileOp`、`FileVersion`、`Hunk`、`FileChain`、`foldFileChains(ops)`（read 窗口 / write 全文 / edit 定位 oldString 求 hunk；定位失败 → 链断，不猜）、`lastLineCount`、`remapFileCoord(chain, coord, currentLineCount?)` → `{ok:true,lineRange,clipped}` | `{ok:false,reason:'unknown-version'|'chain-break'|'deleted'|'empty'}`（恒等 / 逐版行偏移 / 替换区扩展 / 出界裁剪 / 删除丢弃）。
- `src/core/assemble/assemble.ts`：`foldAssembleInputs(events)`（tool 对 = 单元，配对不拆；read 窗口/写路径与版本挂单元）、`readWindowOf(meta)`、`validateDigest`/`renderDigest`、`renderUnitList`、`pickVerbatimLines`、`assembleArchive(input)`（贪心停机 + 单单元尾截断 + 地板填充 + 位置兜底 + 装配序 = transcript 序 + 计数）、`renderArchive(result)`、`VERIFY_LINE_RE`/`ERROR_LINE_RE`。
- `src/core/assemble/txn.ts`：共享事务原语（**中性词汇，D7 锁**）：`TxnLayer`/`TxnStep`/`TxnPlan`/`planTxn`/`TxnMarker`/`foldTxnMarkers`/`txnOrderValid`（**open → prune → replace → close** 顺序、单事务持锁、幂等键 `layer|taskId|start..end`）。
- `src/core/assemble/ledger.ts`：`ASSEMBLE_RUN_FACT_TYPE`、`AssembleRunFactData`、`CompressionLedger`（07 压缩族全字段；未实现项显式 0 并注明归属）、`foldCompressionLedger(facts, policy?)`、`emptyCompressionLedger`。
- `src/core/assemble/index.ts`：re-export。
- `tests/assemble-chain.spec.ts`（16）/ `tests/assemble-hottail.spec.ts`（20）/ `tests/assemble-ledger.spec.ts`（4）。

### P17b（接线）——**已施工（commit `67de3cd` + `6c9cbaf`）**
- `src/platform/files.ts`（新）：**盘上取真唯一触点**（`ctx.fs` resolve/stat/readText；行切分；越界裁剪；一切失败 → `null` + warn，零重试）。`FilesPort`、`createFilesPort(ctx, opts?)`、`splitFileLines`、`FILES_MAX_BYTES`。
- `src/domains/assemble-facts.ts`（新）：第五类 ignorable 事实 `context-economy/assemble-run`（声明合并 + `compactFact` 复用）。
- `src/domains/assemble.ts`（新）：装配域服务——事件摄取（file ops / 单元 / 表面 fold）→ 范围过滤 → `foldFileChains` → 通道 A 经 `FilesPort` 取真 / 通道 B 取单元原文 → `assembleArchive` → 事实发射；`runCompactionTxn(history, plan, apply)`（H5 标记对执行器，P19 复用）；`unitList`/`stats`/`dispose`。
- `src/index.ts`（改）：挂载装配域 + `ctx.inject(['fs'], …)` 注入盘上取真端口（服务缺失 = 通道 A 降级为丢弃计数，通道 B/兜底照常）。
- `package.json`（改）：peerDep `@deepseek-ai/dsh-fs`；`scripts/build.sh`（改）：链接 `packages/fs/fs`。
- `scripts/assert-structure.mjs`（改）：**D11**（`ctx.fs`/`dsh-fs` 概念只许在 `src/platform/files.ts`）+ **D12**（`core/assemble/**` 无时钟随机）；`tests/assert-structure.spec.ts`（改）：负/正样本 + 零位快照。
- `tests/assemble-domain.spec.ts`（11）+ `scripts/verify-p17.mjs`（40 checks）。

### P17c（修正单；纯核为主 + 薄接线；**本单新做**）
- `src/core/assemble/gate.ts`（新）：**HT 软门** `gateHotTailDecls(decls, units)` → `{accepted, rejected:[{reason,unitId?}]}`；`HotTailRejectReason = 'bad-decl'|'unknown-unit'`；形状非法（非对象 / `unitId` 非空串缺失 / `coord` 非对象 / `path` 空 / `version` 非正整数 / `lineRange` 非法）→ 拒绝 + 计数，**永不抛错**（只降级不拒压）。
- `src/core/assemble/archive.ts`（新）：`ArchiveEntry`（`{taskId,kind:'checkpoint'|'boundary',text}`）、`archiveChainShape(entries)` → `'empty'|'prefix'|'single'|'chain'` | `invalid{reason:'order'|'shape'}`、`archiveChainAppendOnly(prev,next)`（前缀逐条字节恒等）、`truncateArchiveArea(entries, policy?)` → `{kept,truncated:{count,tokens},keptTokens,overCap}`（从最老整条截断至入限；单条超帽 = 保最新一条 + `overCap=true`，见 N9）。
- `src/core/assemble/types.ts`（改）：`AssemblePolicy.archiveTokens=15000`；`HotTailDropCounts{badDecl,unknownUnit,remap,fetch}`；`HotTailPlan.dropReasons`；`AssembleResult.archiveForm{form,checkpointCount}`；`ArchiveEntry`/`ArchiveKind`/`ArchiveTruncation` 词汇面。
- `src/core/assemble/assemble.ts`（改）：软门接入（`badDecl`/`unknownUnit` 入 `dropReasons`，`declaredUnits` 仍记原始申报数）；**`clipped` 计数修复**（此前恒 0）；位置兜底统一用 `policy.charsPerToken`（原用 fold 期默认 cpt）并去重双份循环；`AssembleInput.priorChain` → 形态校验（非 `empty|prefix` = `digest-schema` fatal）+ 渲染 = 续传旧块 + 追加新块。
- `src/core/assemble/ledger.ts`（改）：`AssembleRunFactData.archiveTruncateCount?/archiveTruncateTokens?`（缺省 0，向后兼容）；`foldCompressionLedger` 汇总进 `archiveTruncate{count,tokens}`（原恒 0 的路径打通，生产者 = P19 档案区）。
- `src/domains/assemble.ts`（改）：取真前先过软门（只对 accepted 申报读盘；`coord:null` 等坏形状不再可能抛错）；`AssembleRequest.priorChain?/archiveTruncate?` 透传；事实带 `dropReasons`。
- `tests/assemble-archive.spec.ts`（新）+ `tests/assemble-hottail.spec.ts`（扩软门/clipped/兜底 cpt）+ `tests/assemble-ledger.spec.ts`（扩 archiveTruncate）+ `tests/assemble-domain.spec.ts`（扩软门接线/priorChain/透传）。
- `scripts/verify-p17.mjs`（扩）：P17c 导出面 / `archiveTokens=15000` / 软门 fixture（坏形状不抛错）/ clipped>0 / 硬帽截断 / 两形态 / append-only / archiveTruncate fold / **回放归因**（write 屏障 vs 定位失败）。

## 4. 实现要点

1. **度量先行**：先落 `core/assemble/ledger.ts` 与 `assemble-run` 事实载荷（07 压缩族字段全部有位置，未实现项显式 0），再写机制本体。
2. **坐标层（通道 A）**：版本号 = 插件侧逐路径单调计数（**不解释 harness 不透明 `FsVersion`**）；read 窗口 = 该版本已知切片，write 全文 = 该版本全文；edit 用 `old_string` 在**最近已知全文**里定位（`replace_all` 逐处），得到 `{startLine,endLine,newLineCount}` hunk；定位不到 → `chain-break`（不猜位置、不复活旧版本）。
3. **重映射**：从 `coord.version` 逐版前进——行号 = 原行号 + 该行之前全部 hunk 的净行差；区间与 hunk 相交 → 机械扩到 hunk 新跨度；`lineRange` 省略 = 整文件；末版后按 `currentLineCount` 出界裁剪（`clipped`），整段越界或文件不存在 → 丢弃 + 计数。
4. **坐标层（通道 B）**：单元 = tool 对（callId 为 ID，`seqStart/seqEnd` 为 span），文本 = 会话事件切片（域侧提供）；单元清单同时供压缩器 prompt（P18）枚举。
5. **贪心停机**：申报序累加；首单元超帽 → 尾截断（保头）+ 可见标记 `…（此处按装配预算截断）`；已有选中则停机 `budget`；申报耗尽 → `list-end`；**渲染序 = transcript 序**（`seqStart` 升序），同输入同装配字节。
6. **地板填充**：仅当预算有余且 run 结果类目未被覆盖；验证尾 ≤3 行 + 失败/错误行 ≤5 行，逐字摘抄、按单元 ID 去重；`floorFilled=true` 入账。
7. **位置兜底**：`hotTail` 缺失/空/坐标全部无效 → 从尾反向累加至 10K，`source='positional-fallback'`；**不产生 fatal**；token 一律按 `policy.charsPerToken` 现算（不混用 fold 期默认 cpt）。
8. **共享事务原语**：`planTxn` 产出 **open → prune（原区间影子价）→ replace（同区间）→ close**；`foldTxnMarkers` 检测未闭合/ID 不匹配；`runCompactionTxn` 执行 = `assertNoActiveCompaction` → `begin` → 业务 op → `end`（失败带 `error` 收尾 + 遏制）；缩水校验由调用方（P19）在 replace 前用 `estimateTokens` 机械比对。
   **顺序实证（P17a 修正）**：`recordPrune` 需要"替换前"的表面 span 才能记账，`replaceSurface` 一旦执行原区间即消失——故 prune **必须先于** replace，且两者同区间同事务。canon §1"prune 影子计价紧随每次遮蔽"由此满足（同一事务、相邻一步）。
9. **事实与度量**：`assemble-run {at,layer,digestBytes,digestEntryCount,hotTailTokens,hotTailDeclaredUnits,hotTailStopReason,hotTailSource,hotTailFloorFilled,unitCount,dropped,dropReasons,clipped,truncated,archiveTruncateCount?,archiveTruncateTokens?}`；fold 汇总压缩族；同输入同账。
10. **带外**：装配产物只在内存/事务里；不进模型视野的判定（vN、坐标、计数）只落事实轨；`core` 零 harness import（S1）、改史零出现（S2）、`ctx.fs` 零越界（D11）。
11. **HT 软门（P17c）**：纯函数、单次线性扫描；`coord` 形状全部机械校验后才交给 `remapFileCoord`（后者假定 `coord.version` 可读——软门是其前置守卫）；拒绝项只计数、不抛错、不阻断其余申报。
12. **档案硬帽（P17c）**：`truncateArchiveArea` 从**最老**起整条丢弃直至后缀总量 ≤ `archiveTokens`；不做条内截断、不合并、不重压（04 §6）；`overCap` 只在新est单条本身超帽时出现（保最新 + 标记，失败方向 = 保留）。
13. **追加式链（P17c）**：`archiveChainShape` 只认 `[]` / `[C…]` / `[D]` / `[C…][D]`；`priorChain` 必须是 `empty|prefix`，否则 `digest-schema` fatal；`archiveChainAppendOnly(prev,next)` 用于验收"续传不改写"（前缀逐条字节恒等）。
14. **确定性**：P17c 全部新函数纯函数（无时钟/随机/IO，D12）；同输入同输出，双跑逐字节一致。

## 5. 验收（全机械；[x] = P17a/P17b 实测已过，[ ] = P17c 待过）

- [x] `npm run typecheck && npm run typecheck:client && npm test`（gate 四段）→ **391 用例 / 37 文件**
- [x] `npm run typecheck:tests`
- [x] `tests/assemble-chain.spec.ts` **16 用例**：恒等 / 单次 edit 行偏移 / 多次 edit 累积 / replace_all 多 hunk / write 全文替换 / 定位失败链断 / 未知版本 / 出界裁剪 / 整段越界丢弃 / 文件不存在丢弃 / 输入未 mutate / 双跑相等
- [x] `tests/assemble-hottail.spec.ts` **20 用例**：贪心到 10K 即停 / 申报耗尽 list-end / 单单元超帽尾截断 + 标记 / tool 对不拆 / 地板填充（验证 ≤3 + 错误 ≤5 + 去重 + 预算不足不填）/ 位置兜底 / 装配序 = transcript 序 / digest schema 违例 fatal / 同输入同字节
- [x] `tests/assemble-ledger.spec.ts` **4 用例**：压缩族字段由 `assemble-run` 事实汇总、未实现项恒 0、同输入同账
- [x] `tests/assemble-domain.spec.ts` **11 用例**：域装配端到端（fake session + fake FilesPort）→ 计划 + 事实；fs 缺失 = 通道 A 丢弃计数 + 兜底照常；`runCompactionTxn` 开闭配对/防重入/失败带 error 收尾
- [x] `tests/assert-structure.spec.ts`：D11/D12 负样本 + 正样本 + 零位快照
- [x] `node scripts/verify-p17.mjs` → **P17 VERIFY PASS (40 checks)**（文件 / 导出面 / S1+S2+D7+D11+D12 / 策略初值 / 坐标链 6 项 / 热尾 4 项 / digest 2 项 / 事务 2 项 / 账本 / spec 标记 / 真机回放 3 项 / 尺寸 / 文档 7 项）
- [x] `DSH_CHECKOUT=G:/deepseek-harness npm run build` 绿（host + client）
- [x] `node scripts/verify-p16.mjs`（30）/ `verify-p15b.mjs`（19）/ `verify-p15a.mjs`（10）无回归
- [x] **P17c**（→ **实测**：gate **413 用例 / 38 文件**（D1–D12 全 PASS）+ `typecheck:tests` + build 全绿；`verify-p17` **PASS 54 checks**；`assemble-archive` **13** / `assemble-hottail` **26** / `assemble-domain` **13** / `assemble-ledger` **5**；verify-p16 **30** / p15b **19** / p15a **10** 无回归；P17c src 净增 **217**，预算内）：`npm run gate` + `typecheck:tests` + build 全绿；`tests/assemble-archive.spec.ts`（硬帽 / 两形态 / append-only / priorChain 续传）；`assemble-hottail.spec.ts` 扩软门（坏形状不抛错 + 计数）+ `clipped` > 0 + 兜底 cpt；`assemble-ledger.spec.ts` 扩 `archiveTruncate` fold；`assemble-domain.spec.ts` 扩软门接线 + 透传；`verify-p17.mjs` 扩 P17c 导出面/初值/fixture/**回放归因**；`verify-p16/p15b/p15a` 无回归

## 6. 禁区与注意

- 不新增 LLM 调用（P17 零模型）；不触发压缩（触发归 P19）；不改 T-* / run 剪切语义；不动 `cordis.patch.yml`（`auto:false` 归 P20b）。
- 不解释 harness 不透明 `FsVersion`（只用插件侧版本计数）；不原地改写历史（唯一通道 `platform/history`）；不把插件内部标志写进模型视野。
- **N1**：vN 语义 = "该路径第 N 次被观察到的状态"（read/write/edit 各计一版）；模型从单元清单抄版本号（选坐标不造坐标）。
- **N2**：edit 定位只在"最近已知全文"里做（write 全文 / read 全覆盖窗口）；定位失败 = 链断 → 坐标丢弃 + 计数（**不猜位置**，失败默认保留）。**真机归因（P17c 固化）**：44 会话 / 60 链 / 重映射 95 次自检中 `chain-break 21` = **write 全文替换屏障 9 + 定位失败屏障 12**（读窗为部分窗口、oldString 不在任何已知窗口）；3 条链断 = 首见即 edit 1 / write→edit 序列 1 / 仅部分读窗 1。两类均为设计内降级，**不加启发式猜测**（04 §2）。
- **N3**：单单元超帽 = 尾截断保头 + 可见标记（canon 原文"尾截断"；错误行价值由地板填充另路覆盖）。
- **N4**：热尾不落盘、不跨压缩滚存（缓存非档案）；本单只产出计划与度量，注入与档案 vN 归 P19。
- **N5**（P17c 修正）：`compressionCallCount`/`compressionCacheHitRate`/`pressure*`/`hardTruncateCount`/`extraSearchCalls` 仍显式 0（归属 P18/P19/P20/P20b/P21b）；**`archiveTruncate` 由 P17c 打通 fold 路径**（生产者 = P19 档案区；纯核截断函数本单交付）。
- **N6**：`ctx.fs` 缺失（服务未挂/降级）= 通道 A 全丢弃 + 计数，通道 B 与位置兜底照常（安全侧）。
- **N7**：`runCompactionTxn` 只做标记对与顺序；缩水校验/档案落盘/卷宗清空归 P19。
- **N8**（P17c）：HT 软门是 `remapFileCoord` 的前置守卫——`coord` 形状非法一律 `bad-decl` 丢弃；`unknown-unit`（ID 不在清单）同样只计数。二者都不产生 fatal（04 §2"只降级不拒压"）。
- **N9**（P17c）：档案硬帽截断粒度 = **整条档案条目**（一条 = 一个 task 的归档块）；"从最老起"= 保留满足总量 ≤ 15K 的**后缀**（不跳洞保留中间条目）；若最新单条本身超帽 → 保最新一条 + `overCap=true`（不空档，失败方向 = 保留）。
- **N10**（P17c）：`priorChain` 只接受 `empty|prefix`（checkpoint 序列）；`[C…][D]` 的 `D` 由本次边界装配追加；已闭合链不得二次追加（形态 `chain` 再追加 = `order` 违例 → fatal）。
- 尺寸申报（**开工估计 / 实测修正**）：
  - P17a 估计 ≤780（红线 860）→ **commit 净增 1,223**（types 168 / chain 342 / assemble 466 / txn 125 / ledger 113 / index 9；spec 482），超红线 363。P17b 修 txn 顺序后现文件合计 **1,229**（txn 131）——两数口径不同，均如实记录。
  - P17b 估计 ≤420（红线 480）→ **实测净增 402**（`67de3cd` 385 + `6c9cbaf` 17：platform/files 79 / domains/assemble 257+1/−1 / assemble-facts 30 / index +11 / core/ledger +38〔facts 7 / surface 30 / index 1〕/ shear/ledger 3/−17 / shear-facts 1/−6 / chain 1/−1 / txn +6），另 spec 262 + verify 316，**在预算内**（此前工单/快照记 396、总纲记 381 均为口径错误，P17c 一并更正）。
  - P17 合计 **1,625 = L**，按总纲 §3 拆 a/b 两单两提交（+ P17c 修正单）。
  - **P17c 估计**：src 净增 ≤300（红线 360）——gate ~70 / archive ~150 / types +35 / assemble +70 / ledger +20 / domain +15，另 spec ~220 + verify +90。若超线，拆 `P17c1`（gate + clipped/兜底修正）/`P17c2`（archive 硬帽 + 追加式链）。

## 7. 完成动作

- commit: `feat(p17a): 边界装配纯核——双通道坐标/贪心停机/共享事务原语`；
  `feat(p17b): 边界装配接线——盘上取真端口 + 装配域 + assemble-run 事实`；
  `refactor(p17b): 表面 fold 上移 core/ledger/surface.ts（剪切面导出不变）`；
  `docs(p17): 账本快照 §42/§43 + 文档同步（H15 盘上取真）`；
  **P17c**：`feat(p17c): 边界装配修正——HT 软门/裁剪计数/档案硬帽/追加式链` + `docs(p17c): 工单修正 + 快照 §44 + 文档同步`。
- 账本快照：P17a/P17b/P17c 各一节入 `docs/ledger-history.md`（只增不改）。

## 8. P17c 修正单（执行结果 → 计划修正）

| # | 执行结果发现 | 计划修正 | 归属 |
|---|---|---|---|
| 1 | 工单 §3/§4 记 `foldAssembleUnits`、txn 顺序 `open→replace→prune→close` | 改正为 `foldAssembleInputs`；顺序改为 **prune → replace**（附实证，§4.8） | 本单（文档） |
| 2 | §6 尺寸口径混用（commit 净增 vs 现文件行数），P17b 记 396、总纲记 381 | 统一为"commit 净增 + 现文件合计"两栏，P17b 更正 **402**，总纲同步 | 本单（文档） |
| 3 | `clipped` 计数声明但从未自增（恒 0） | 修复 + 用例断言 > 0 | P17c（纯核） |
| 4 | 软门只在 `validateDigest` 间接覆盖；`hotTail` 坏形状可触发 `coord.version` 读取异常 | `gateHotTailDecls` 显式前置 + 域侧取真前调用（永不抛错） | P17c（纯核+接线） |
| 5 | 位置兜底用 fold 期默认 cpt（与注入 policy 不一致）；双份循环 | 统一 `policy.charsPerToken` + 去重 | P17c（纯核） |
| 6 | 04 §6 硬帽 + `archiveTruncate` 在 P17 只留 0 字段；总纲 P19 行自相矛盾 | 纯核截断 + fold 路径提前到 P17c；P19 只做档案区落盘/编排 | P17c（纯核） |
| 7 | 04 §3 机制 A / §8"两形态皆可校验"未落 | `archiveChainShape`/`archiveChainAppendOnly` + `priorChain` 续传渲染 | P17c（纯核） |
| 8 | 回放 `chain-break 21` 只有总数，无归因 | verify 固化 write 屏障 9 / 定位失败 12 分类 + N2 记录 | P17c（验收） |

# P18 压缩调用（R4；依赖 P5,P9；尺寸 M）

> 设计正典：docs/04 §2（边界装配：类型化摘要 + `hotTail` 申报 / 预算三环 / 三环 fatal 口径）· §3（压力路径：
> 进行时检查点 + `cutPoint` / 共享机制 A/B / 生产消费不对称律 / 四种触发次序闭合）· §5（标定）· §6（档案形态）·
> §7（事件与度量）· §8（验收）；docs/07 §0.5 压缩族；docs/10 §1 H12；docs/11 §2 `core/compress` 行 + §7 资产登记 + §9；
> docs/09 §2（边界档案 vN；落盘归 P19）；docs/05 §6。
> harness 符号清单（逐条 grep 到定义处，找不到即停工上报）：**本单零 harness 触点**——纯核，不读盘、不调模型、不写事实。
> 唯一跨层引用 = purpose 词汇 `'context-economy-compaction'` @src/platform/llm.ts:27-32（P5 已落位；本单只把
> **调用契约**写进 prompt/产物 schema，实际 `llm.stream` 调用与 usage 回执归 P19/P20a）。

## 1. 目标

把「压缩器调用」的两半做成**纯核**：①**边界/压力两模式 prompt 组装**（模板在前、实例参数在后；压缩器输入尾部机械
追加单元清单；旧检查点块原样续传）②**产物 schema 校验**（只输出 JSON；仅解析失败/schema 违例 = fatal；坏热尾申报
只降级计数）。同时把 07 压缩族 `compressionCallCount` / `compressionCacheHitRate` 的**回放 fold 路径**打通
（P17 N5 显式留 0 并归属本单；生产者 = P19/P20a），使「调用了几次 / 复用了几次」在账本里可算。

**本单不调用模型、不接线、不落盘**——产物注入、档案 vN、卷宗清空、缩水校验归 P19；压力触发/断路器归 P20a。

## 2. 输入

- 正典要点（工单内自足）：
  - **边界模式产物**（04 §2）：①类型化摘要（`plan/impl/verify/wrap` 信息块；**impl 用坐标指针不嵌代码**）
    + ②`hotTail` 范围申报（边界压缩器**专属**）。prompt 明令按重要性降序申报、**禁止任何预算计算**（计量/裁剪/
    取真全由 harness 机械完成；模型零转写零算术）。
  - **压力模式产物**（04 §3）：①**进行时检查点**（进度/当前状态/下一步/活约束；受众 = 当前任务的自己，
    **不宣称最终事实**）②`cutPoint` = 最后一个子任务的起点。机械校验**仅两条**：单元存在 + 缝不切工具对。
    保留区 = `[cutPoint..end]` 全量逐字（无帽、无 span 申报——预算控制从「帽」变成「缝的选择」）。
  - **共享机制 A**（04 §3）：摘要字节一经写出即**不可变**；后续压缩遇旧块**原样续传、绝不重压、绝不并入总结构
    重生；输出 = 续传旧块 + 追加新块。两形态 = 单块总摘要 / `[C1…Cn][D]`。
  - **共享机制 B**：热尾块是**缓存非档案**；压力路径把折叠区内的热尾折进检查点（坐标锚保留）；热尾申报/物化机制
    只为边界压缩器服务。
  - **生产/消费不对称律**（04 §3）：尾部模式是**生产签名**（边界产热尾、压力产检查点 + 末段子任务，各只生产一种）；
    处理能力**普遍**（任一压缩器遇任一尾部模式都有确定语义：摘要块 → 机制 A 续传，材料块 → 机制 B 折叠）。
    四种触发次序（边→边 / 边→压 / 压→边 / 压→压）全有定义 → 任意交错闭合。
  - **三环 fatal 口径**（04 §2）：仅**解析失败 / schema 违例** fatal；`hotTail` 缺失或坐标全部无效 → 回退位置法
    （装配器侧）；部分无效 → 丢弃 + 计数；超预算/坏坐标全部机械降级，**不产生新 fatal**。
- 现有文件（**复用，不重复实现**）：
  - `src/core/assemble/assemble.ts`：`validateDigest`（digest 结构校验，坏形状 = undefined）、`renderDigest`、
    `renderUnitList`（单元清单 `[id] name path@vN ~Nt`）、`foldAssembleInputs`（单元 = tool 对）。
  - `src/core/assemble/gate.ts`：`gateHotTailDecls(decls, units)`（HT 软门：`bad-decl`/`unknown-unit`，永不抛错）。
  - `src/core/assemble/archive.ts`：`archiveChainShape` / `archiveChainAppendOnly`（追加式链两形态）。
  - `src/core/assemble/types.ts`：`TaskDigest` / `HotTailDecl` / `HotTailDropCounts` / `ArchiveEntry` / `AssembleLayer`。
  - `src/core/assemble/ledger.ts`：`foldCompressionLedger`（压缩族 fold 汇合点；`compressionCall*` 恒 0）。
  - `src/core/ledger/fold.ts`：`estimateTokens(text, charsPerToken)`；`src/core/ledger/types.ts`：`DEFAULT_CHARS_PER_TOKEN=1.5`。
- **本单不做**：`llm.stream` 调用与 usage 回执（P19/P20a）；档案区落盘 vN / 卷宗清空 / 注入 / 缩水校验（P19）；
  压力触发与断路器（P20a）；保险丝（P20b）；`compression.*` 配置面（P19 落位，本单以 `DEFAULT_COMPRESS_POLICY` 承接）；
  内容寻址复用键与 KV 缓存（P19，04 §6）。

## 3. 产出

- `src/core/compress/types.ts`（新）：`COMPRESS_PROMPT_VERSION=1`、`COMPRESS_POLICY_VERSION=1`、`CompressMode`、
  `CompressPolicy`/`DEFAULT_COMPRESS_POLICY`（`charsPerToken=1.5`、`maxUnitListEntries=0`〔0 = 不限 = 正典行为〕）、
  `CompressCheckpoint`、`CutPointDecl`、`BoundaryProduct`/`PressureProduct`/`CompressProduct`、
  `CompressParseResult`、`CompressOutcome`、`CompressPromptInput`/`CompressPromptRender`、
  `TailBlockKind`/`TailConsumeOp`/`TailConsumption`/`TailPlanOutcome`。
- `src/core/compress/prompt.ts`（新）：`COMPRESS_BOUNDARY_HEAD/RULES/OUTPUT` + `COMPRESS_PRESSURE_HEAD/RULES/OUTPUT`
  （静态常量，模板在前）、`renderBoundaryPrompt(input)`、`renderPressurePrompt(input)`、
  `renderPriorChain(entries)`（机制 A 续传面）、`compressUnitList(units, policy)`（清单 + 上限计数）。
  渲染序 = 静态模板 → 已归档检查点 → 闭合段/折叠区原文 → 单元清单（04 §2「输入尾部机械追加单元清单」）。
- `src/core/compress/product.ts`（新）：`stripProductFences`（机械剥离 ```json 围栏）、`extractJsonObject`
  （首个 `{` → 平衡末 `}` 扫描）、`parseCompressProduct(raw, mode, units)`（**永不抛错**；boundary = `validateDigest`
  + `gateHotTailDecls(decls, units)`；pressure = `validateCheckpoint` + `validateCutPoint`）、
  `validateCheckpoint(value)`、`validateCutPoint(value, units)`（`unknown-unit` / `pair-split` / `schema`）。
- `src/core/compress/consume.ts`（新）：`TAIL_CONSUME_OPS`、`classifyTailBlock(kind)`（摘要块 → `continue`；
  材料块 → `fold`）、`planTailConsumption({priorChain, layer})`（四次序闭合表：`form`/`carryCount`/`appendKind`/
  `foldMaterial`；链形态非法 → `{ok:false, reason:'chain-invalid'}`，复用 `archiveChainShape`）。
- `src/core/compress/ledger.ts`（新）：`COMPRESS_RUN_FACT_TYPE='context-economy/compress-run'`（ignorable 注记）、
  `CompressLlmUsage`、`CompressRunFactData`（`at/layer/promptVersion/policyVersion/cacheHit/calls/regionTokens/
  promptTokens/productBytes/outcome/droppedHotTail/llmUsage`）、`CompressCallLedger`、`emptyCompressCallLedger`、
  `foldCompressCalls(facts)`（坏载荷跳过、绝不抛错）。
- `src/core/compress/index.ts`（新）：re-export。
- `src/core/assemble/ledger.ts`（改）：`foldCompressionLedger` 合并 `compress-run` → `compressionCallCount` /
  `compressionCacheHitRate` 真实可算；新增自持观测位 `compressInvocations`/`compressCacheHits`/
  `compressUsage{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}`/`compressParseFailures`/
  `compressSchemaFailures`（**不属 07 字段**，同 `assembleRuns` 先例，见 N7）。
- `scripts/assert-structure.mjs`（改）：**D13**（`src/core/compress/` 无时钟/随机）。
- `tests/compress-prompt.spec.ts` / `compress-product.spec.ts` / `compress-consume.spec.ts` / `compress-ledger.spec.ts`（新）。
- `scripts/verify-p18.mjs`（新）：导出面 / 结构 / 两模式 prompt fixture / 产物 fixture / 四次序 / 账本 fold /
  **真机只读回放**（真实会话 → 单元清单 → 渲染 prompt：字节稳定 / 预算数字零泄漏 / 清单上限 / 体量分布）/ 文档标记。

## 4. 实现要点

1. **度量先行**：先落 `compress/ledger.ts` + `foldCompressionLedger` 合并路径（07 压缩族两个 0 字段转为可算），再写 prompt/parse。
2. **模板在前**（docs/11 §4 纪律）：静态 HEAD/RULES/OUTPUT 常量逐字节固定；实例参数（检查点/原文/清单）在后；
   渲染 = `[HEAD, RULES, OUTPUT, priorChain?, region, unitList]` 过滤空段后 `join('\n\n')`——同输入同字节。
3. **零预算泄漏**：模板内**不出现**任何预算常数（10000/15000/100000/0.4）与「算 token」指令；只写「禁止任何预算计算」。
   单元清单的 `~Nt` 是**粗标体量**（04 §2 明文「仅供直觉比较」）。
4. **坐标纪律**：prompt 明令 `path`/`version` 只能从清单抄（选坐标不造坐标）；校验端 `gateHotTailDecls` 用
   **完整单元清单**（`unknown-unit` 也计入），坏形状只降级计数（HT 软门语义，P17c N8）。
5. **fatal 口径**：`parseCompressProduct` 只返回 `{ok:false, reason:'parse'|'schema'}`；热尾申报问题走
   `dropped: HotTailDropCounts`（`remap`/`fetch` 为运行时归因，本层恒 0）；`hotTail` 缺失 = `ok:true` + 空申报
   （装配器回退位置法，不在此 fatal）。
6. **cutPoint 两校验**：①`unitId` 必须在清单内（`unknown-unit`）②`pair-split` = 缝落在某 tool 对
   `[seqStart, seqEnd]` **内部**（对边界之外 = 合法）；两者任一不满足 = `schema` fatal（04 §3「机械校验仅两条」）。
7. **续传面**：`renderPriorChain` 逐条 `--- <taskId> ---\n<text>`；`planTailConsumption` 只读 `priorChain` +
   `layer`，`carryCount = priorChain.length`、`form = priorChain.length === 0 ? 'single' : 'chain'`、
   `appendKind = layer === 'boundary' ? 'boundary' : 'checkpoint'`、`foldMaterial = layer === 'pressure'`（机制 B）。
8. **确定性**：全部纯函数（无时钟/随机/IO，D13）；`JSON.parse`/`JSON.stringify` 固定键序由构造保证；双跑逐字节一致。
9. **账本口径**：`compressionCallCount += calls ?? (cacheHit === true ? 0 : 1)`；
   `compressionCacheHitRate = invocations === 0 ? 0 : cacheHits / invocations`（`invocations` = `compress-run` 事实数）；
   `compressionLayer` **仍只由 `assemble-run` 计数**（防双计）；`outcome` 非 `ok` 计入解析/schema 失败自持位。
10. **带外**：prompt 与产物都只在内存/事实里；不进模型视野的判定（版本、计数、fatal）只落事实轨；core 零 harness import（S1）。

## 5. 验收（全机械；[x] = 实测已过，2026-09-08）

- [x] `npm run gate` → **440 用例 / 42 文件**（M1–M5 / S1–S5 / **D1–D13** 全 PASS，`ok=true vacuous=[]`）
- [x] `npm run typecheck:tests`（绿）
- [x] `tests/compress-prompt.spec.ts`（**7 用例**）：模板在前 / 清单在尾 / 两模式 schema 段落 / priorChain 续传 / 清单上限与省略计数 /
      预算数字零泄漏（10000/15000/100000/0.4 全不出现）/ `regionTokens` 按 policy cpt / 双跑字节一致
- [x] `tests/compress-product.spec.ts`（**6 用例**）：围栏剥离 / JSON 平衡抽取 / boundary 合法产物 / digest 坏形状 = `schema` /
      非 JSON = `parse` / `hotTail` 缺失 = ok + 空 / 坏申报降级计数（`badDecl`/`unknownUnit`）/ pressure 检查点字段校验 /
      `cutPoint` 未知单元 = `schema` / 缝切工具对 = `schema` / 输入含噪声不抛错
- [x] `tests/compress-consume.spec.ts`（**3 用例**）：摘要块 → `continue` / 材料块 → `fold` / 四次序闭合表（边→边 / 边→压 /
      压→边 / 压→压）/ 链形态非法 → `chain-invalid` / 无 priorChain → `single`
- [x] `tests/compress-ledger.spec.ts`（**5 用例**）：`calls`/`cacheHit` 汇总 / `cacheHitRate` 分母口径 / 空账 = 0 / 坏载荷跳过 /
      `compress-run` 合并进 `foldCompressionLedger`（`compressionCallCount` > 0 且 `compressionLayer` 不双计）/ 同输入同账
- [x] `tests/assert-structure.spec.ts`：D13 负样本（`Date.now`/`Math.random`/`new Date`）+ 正样本 + 零位快照
- [x] `node scripts/verify-p18.mjs` → **P18 VERIFY PASS (45 checks)**（导出面 25 项 / S1+D13 / 初值 / 两模式 fixture /
      产物 fixture / 四次序 / 账本 / 真机只读回放 / 尺寸 / 文档标记）
- [x] `DSH_CHECKOUT=G:/deepseek-harness` + Git bash `scripts/build.sh` 绿（host + client；本单零 client 改动）
- [x] `node scripts/verify-p17.mjs`（54）/ `verify-p16.mjs`（30）无回归
- [x] 文档同步：总纲 P18 行 + 施工记录；docs/04 状态行；docs/10 状态行（H12 契约）；docs/11 状态行 + §2 树 +
      §7 资产登记；AGENTS 现状；`docs/ledger-history.md` 新增快照节（只增不改）

## 6. 禁区与注意

- 零模型调用、零接线、零落盘：本单不 import `platform/**`、不读会话、不写 KV、不发事实（S1/D3/D6/D7/D11 全不碰）。
- 不动 `docs/00–11` 设计正文（状态行除外）、`datasets/`、`experiments/`、`reports/`、`scripts/attic/`、
  `cordis.patch.yml`、client 壳。
- **N1**：prompt 版本 = `COMPRESS_PROMPT_VERSION`；改模板必须升版本（产物 schema 与模板同版演进）。
- **N2**：模型可见面**无预算数字**——「禁止任何预算计算」是硬规则；harness 侧计量（`regionTokens`/`promptTokens`）只进事实轨。
- **N3**：`hotTail` 缺失/全坏**不是** fatal（三环口径）——本层只报 `dropped`；位置兜底由装配器执行。
- **N4**：压力模式**不申报热尾**；`cutPoint` 由单元 ID 表达（选缝 = 相位边界识别，04 §3）。
- **N5**：`compressionCacheHitRate` 口径 = 内容寻址复用命中率（04 §6）；**键与 KV 缓存实现归 P19**——本单只立分母口径
  与事实字段（`cacheHit`/`calls`），不定义哈希函数（core 无加密依赖）。
- **N6**：`compressionLayer` 防双计——只由 `assemble-run` 计数（一次压缩 = 一次装配事实 + 一次调用事实）。
- **N7**：07 压缩族**缺压缩 usage 字段**（判别族有 `judgeLLMUsage`、断面族有 `optimizePromptTokens`，成本恒等式 §3
  却含「压缩(compress*)」）——不改正典，usage 记入 `compress-run` 载荷 + 账本自持观测位（同 `assembleRuns` 先例），
  字段缺口在本单 §8 上报。
- **N8**：四次序闭合只做**纯核表**；跨模式端到端（真实装配 × 压力 × 保险丝）归 P21b（04 §8「共享模块用例」）。
- 尺寸申报（**开工估计 / 实测**）：估计 src 净增 ≤400（红线 480）——实测 **567**（`git diff --cached --numstat`：
  新 6 文件 **544**〔types 127 / prompt 118 / product 141 / consume 48 / ledger 101 / index 9〕+ `assemble/ledger.ts`
  **+23/−2**），**超红线 87**；另 spec **+364**（4 新 355 + `assert-structure.spec` +9）、`assert-structure.mjs` +7、
  `verify-p18.mjs` +343。超线归因 = 合规自证头（docs/05 §6 强制）6 文件约 66 行 + 度量先行 fold 路径 + 两模式模板；
  **不拆单理由** = 四文件互为同一验收面（prompt → 产物 → 消费 → 账本），拆开产生跨提交悬空导出（P15b 先例：超线申报、
  单提交）。若审查要求拆，拆法 = `P18a`（types + prompt + product + consume）/ `P18b`（ledger + 压缩族 fold 合并 + D13）。

## 7. 完成动作

- commit: `feat(p18): 压缩调用纯核——两模式 prompt 组装 + 产物 schema 校验 + 调用账本`；
  `docs(p18): 工单修正 + 快照 §45 + 文档同步`。
- 账本快照：`docs/ledger-history.md` 新增一节（只增不改）。

## 8. 计划修正（依据 P17/P17c 执行结果 → P18 计划落位）

| # | P17/P17c 执行结果 | P18 计划修正 | 落位 |
|---|---|---|---|
| 1 | 总纲 P18 行引「04 §7」（§7 = 事件与度量）；prompt 依据实为 §2/§3，验收 = §8 | 引用改正为 §2/§3/§8；§7 只作度量字段面 | 本工单头 + 总纲 P18 行 |
| 2 | 总纲 P18 行要求「datasets 同源断言」；`datasets/` **无压缩器 prompt 资产**（只有判别 prompt v1–v2.2）；封存实验资产 `experiments/evalground/lib/compressor-prompt.mjs` 是 **program 形态**，与正典 JSON digest schema 不同构且属禁区 | **删除 datasets 同源断言**（无资产可断）；改为**版本化常量 + 字节稳定断言**（P10/P11 同模式），封存资产只作历史出处注记（只读、不 import、不设门禁） | 本工单 §2/§5 + 总纲 P18 行 + docs/11 §7 |
| 3 | P17 已交付 `validateDigest` / `gateHotTailDecls` / `renderUnitList` / `renderDigest` | P18 **组合复用**：产物校验 = 解析信封 + 既有校验器（带 units）；清单渲染复用 `renderUnitList`，本层只加上限计数 | 本工单 §3/§4 |
| 4 | P17c 已交付 `archiveChainShape`/`archiveChainAppendOnly` + `priorChain` 续传 | 共享消费模块**建在其上**（`planTailConsumption` 四次序表），不重复实现链校验 | 本工单 §3 `consume.ts` |
| 5 | P17 N5：`compressionCallCount`/`compressionCacheHitRate` 显式 0、归属 P18；P17c 已打通 `archiveTruncate` fold（生产者 = P19） | P18 **度量先行**：`compress-run` 载荷 + `foldCompressCalls` + 合并进 `foldCompressionLedger`；**生产者 = P19/P20a**（本单零调用） | 本工单 §4.1 + `core/assemble/ledger.ts` |
| 6 | 04 §3 压力模式「机械校验仅两条：单元存在 + 缝不切工具对」在 P17 无落点 | 落 `validateCutPoint`（`unknown-unit`/`pair-split`/`schema`） | 本工单 §3 `product.ts` |
| 7 | 07 压缩族无 usage 字段，但成本恒等式含「压缩(compress*)」 | 不改正典：usage 入 `compress-run` + 账本**自持观测位**；缺口上报（N7） | 本工单 §6 N7 |
| 8 | P17c 真机回放显示压缩域 live 事实 = 0（无触发）；P18 纯核同样零 live | 验收口径 = 机械断言 + **只读真机回放**（真实会话单元清单 → 渲染 prompt：字节稳定/零预算泄漏/上限/体量分布）；live 计数如实声明 0 | 本工单 §5 + verify |

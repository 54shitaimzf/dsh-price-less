# P16 对话剪切（R3；依赖 P15b；尺寸 L → 工单内拆 **P16a 纯核+度量** / **P16b 接线**）

> 设计正典：docs/03 §3（对话剪切器）· §6（事件与度量）· §7（验收）· §8（阈值初值）；docs/07 §0.5 剪切族；
> docs/10 §1 H4/H6；docs/11 §6/§8；docs/02 §4（断面行协议 `SHEAR` 行）；docs/09（带外状态）；docs/05 §6。
> harness 符号清单（逐条 grep 到定义处，找不到即停工上报）：
> - `SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result'` @packages/core/session/src/types.ts:393
> - `MessageSourceMap`（merge-extensible）+ `ContextFormed`（`{form:'notice'; summary}`）@packages/llm/llm/src/message.ts:102 / 81-93
> - `createUserMessage({content, source})` @packages/llm/llm/src/message.ts:194
> - **官方先例** `commitCompactionBody`：先 append log-only `compaction/summary`，再 `session.append('user/message', checkpoint, {surfaceOp:{op:'replace',start,end}, sourceEventSeqs:[…]})` @packages/compaction/compaction-basic/src/region.ts:437-475
> - `case 'user/message': break`——替换 user/message 不要求 open turn/step（配对检查除外）@packages/core/session/src/invariant.ts:145
> - `toolPairingBalancedBefore/After` @dsh-compaction（已由 `platform/history.ts` 收拢为 `balanceRange`）
> - `context-economy/judge-recorded` 载荷含 `{seq, decision, class?}` @src/domains/judge-facts.ts:24-36（**分类输入，零协议扩张**）
> - 星标行协议 `SHEAR <startSeq>..<endSeq> 已吸收：<note>` @src/core/optimize.ts:42 / `parseShearLine` :247

## 1. 目标

把「连续追问 / 连续验证」的整段 run 在吸收证明到达时，经 H4 换一句中立叙述体结论（配对平衡 + 影子计价 + 三类事实入账），
且 07 剪切族 `cutEvents{question}` / `questionBacklogDepth` / `cutMisfireDetected` / `thinkingCutTokens` 四个此前显式 0 的字段可回放计算。

## 2. 输入

- 正典要点（工单内自足）：
  - **单位 = 整段 run**（不是逐对）：run = 一段最大连续的**理解类**（pureQ）**或验证类**（verifyQ）交换串；
    边界机械可推 = 到下一条**动作类**消息（action）或**星标**为止（03 §3）。
  - **触发 = 吸收证明，纯机械**：动作到达（用户开始动手）即证明前段已被吸收；星标同样是用户明确动作（顺产剪切清单）。
  - **结论句三档**：短 run（≤1–2 对）= 机械摘句（零 LLM）；长 run = LLM 一句结论（**断面内搭车**，不新增调用）；
    验证 run = 判决提取（退出码 / 测试模式机械，语义结论随断面）。
  - **验证类处置**：动作到达不直接剪 → 专项判定依赖边 → 确认无依赖降级剪除；有依赖或存疑 = 延迟观察窗（后续 K 条零引用才剪）。
  - **三道闸**：① 带外原则（判定与范围记插件侧，主模型只见剪后产物）；② 选坐标不造坐标（模型只从枚举消息坐标选边界 + 每段一句结论）；
    ③ 结论句中立叙述体（无指令词，避免被读成待办）。
  - **误剪反馈**：用户重问被剪内容 = `cutMisfireDetected`（指纹可检出，不静默）。
- 现有文件：`core/shear/{types,tool,ledger,index}.ts`、`domains/{shear,shear-facts,star,input,judge-facts}.ts`、`platform/{history,tools,logger}.ts`、`core/{optimize,judge,units}.ts`。

## 3. 产出

### P16a（纯核 + 度量）
- `src/core/shear/run.ts`（新）：`RunClass`/`RunPolicy`/`DEFAULT_RUN_POLICY`、`RunEvent`、`RunOp`、`RunRecord`、`RunPlan`、
  `foldRunShear(events, policy?)`、`mechanicalQuote`、`extractVerifyEvidence`、`neutralizeConclusion`、`salientTokens`。
  纯函数、零 harness/platform import、无时钟/随机（D10）、不抛错（失败默认保留）。
- `src/core/shear/run.ts` 自持 `RUN_POLICY_VERSION`/`RUN_CLASS_FACT_TYPE`（不动 `types.ts` 四档语义；分类事实名跨层一致由单测守住）。
- `src/core/shear/ledger.ts`（改）：`ShearAppliedTier` += `'run'`、`ShearAppliedKind` += `'run-flush'`，
  `ShearAppliedFactData` 增可选 `runPairs`/`runClass`/`conclusionTier`/`startSeq`/`endSeq`；
  新增 `SHEAR_RUN_PLAN_FACT_TYPE`；`foldShearLedger` 填 `cutEvents.question`/`questionBacklogDepth`/`cutMisfireDetected`
  （重折 `foldRunShear`），`thinkingCutTokens` 保持显式 0（N5）。
- `tests/shear-run.spec.ts`（新）+ `tests/shear-ledger.spec.ts`（扩）。

### P16b（接线）
- `src/domains/shear-facts.ts`（改）：第四类 ignorable 事实 `context-economy/shear-run-plan`（星标剪切清单 + `classes` 三分类回填）。
- `src/platform/history.ts`（改）：`buildNoticeUserMessage(text, summary)`——`createUserMessage` + `source:{kind:'plugin',plugin:'context-economy',form:'notice'}`
  （官方 `compaction` checkpoint 同构；harness 运行期 import 只留 platform 层）。
- `src/domains/shear.ts`（改）：run 相接线（`judge-recorded` + `shear-run-plan` 入缓冲 → `foldRunShear` → 门槛 → `executeRunOp`）。
- `src/domains/star.ts`（改）：apply 成功路径（用户确认 = 星标动作）追加发射 `shear-run-plan` 事实（preview 不发）——含 `SHEAR` 清单与 `CLASS` 回填（★ 断面即判别器手动产出，run 分类输入之一）。
- `tests/shear-domain.spec.ts`（扩）+ `scripts/verify-p16.mjs`（新，机械验收 + 真机回放）。

## 4. 实现要点

1. **分类输入（N1）**：`context-economy/judge-recorded` 的 `{seq, decision, class}`——`seq` = 被判定用户消息 seq。
   `discriminator.auto=false` 且未点星标 → 无分类 → 全 `keep`（失败默认保留；零成本）。
2. **run 分段（N2）**：用户消息按 seq 升序，同类（pureQ / verifyQ）连续成串；异类、未分类、`new-task` 判决、星标注记皆边界。
   run 起 = 首条理解/验证消息 seq；run 止 = 边界前最后一个事件 seq。
3. **吸收证明**：边界为 `action` 类用户消息，或该 run 被 `shear-run-plan` 条目覆盖（星标 = 用户明确动作）。无证明 = `questionBacklogDepth`。
4. **结论三档（N3）**：① `mechanical-quote`（pairs ≤ `shortRunMaxPairs`）：`已吸收：关于「<首问摘录>」的 n 轮问答，结论：<末答首句>（用户已确认理解）`；
   ② `verdict-extract`（verifyQ）：扫 run 内 tool/result 的 `[exit code: N]`/`PASS`/`FAIL`/`N passed|failed` → `已验证：<标签>，依据：<证据行>（用户已确认理解）`；
   ③ `star-note`（长 run）：星标 `SHEAR` 行的 note 套同一叙述体；无 ②③ 依据的长 run = `hold: long-run-needs-star`（N3，待 P19 搭车）。
5. **结论预算与中立性**：截断到 `conclusionMaxChars`（截断安全）；命中指令词黑名单（必须/请/不要/禁止/需要/你应该/下一步/待办/务必/记得）
   或含换行 → `hold: conclusion-not-neutral`（零重试）。
6. **验证依赖窗（N6）**：verifyQ run 在前向 `observationWindow`=4 条事件内与 `salientTokens`（≥4 字符 ASCII 标识/路径/数值）有交集 → `hold: verify-dependency-window`。
7. **执行（N4/N7/N10）**：`recordPrune(整段)` → `replaceSurface({type:'user/message', data: buildNoticeUserMessage(…), range})`；
   范围 = 落在 [startSeq,endSeq] 内的当前表面节点，经 `history.balanceRange` 收拢（null → hold 事实，零重试）；
   **G10 尾部窗**：止点距尾部 ≥ `TAIL_NODE_WINDOW`（8 节点）→ `hold run-too-old`（中段剪除负收益，docs/03 §1）；
   `afterTokens >= beforeTokens` → 不落刀（无净省）。失败遏制 + `shear-error` 事实 + op 键消费。
8. **事实与幂等**：`shear-applied`（tier `'run'`，kind `'run-flush'`，含 startSeq/endSeq/runPairs/runClass/conclusionTier）；
   `shear-decision`（hold 原因）；op 键 = `run|<startSeq>..<endSeq>`。
9. **带外（N8）**：判定与范围只由重折日志派生，不写卷宗、不新增 KV 实体、不进模型视野；替换物是叙述位结论本身。

## 5. 验收（全机械）

- [ ] `npm run typecheck && npm run typecheck:client && npm test`（gate 四段）
- [ ] `npm run typecheck:tests`
- [ ] `tests/shear-run.spec.ts`：短 run 摘句 / 长 run hold / 验证 run 判决提取 / 无证据 hold / 星标注记覆盖 /
      异类边界 / new-task 边界 / 指令词黑名单 hold / 结论截断 / 观察窗命中 hold / 同输入双跑 JSON 相等 / 输入未 mutate / 无分类全 keep；
- [ ] `tests/shear-ledger.spec.ts`：`cutEvents.question`/`questionBacklogDepth`/`cutMisfireDetected` 由重折得出、`thinkingCutTokens` 恒 0、同输入同账；
- [ ] `tests/shear-domain.spec.ts`：run 冲刷后表面配对平衡（`toolPairingBalancedAfter`）、替换节点 = `user/message` notice 源、
      吸收证明到达即剪、`★ CLASS 回填`（无 SHEAR 行）落刀、`G10 尾部窗` hold、`shear-run-plan` 幂等（重复事件不二次落刀）；
- [ ] `node scripts/verify-p16.mjs`：19+ 项断言（含真机会话回放：run 候选 / 门槛拦截 / 假想节省，重启前 live run 事实 = 0）；
- [ ] `npm run assert`（D3/D10 结构断言；若新增事实文件需同步白名单）；
- [ ] `node scripts/verify-p15a.mjs` / `verify-p15b.mjs` 无回归。

## 6. 禁区与注意

- 不新增 LLM 调用（长 run 结论只走星标断面搭车）；不剪未吸收 run；不改 T-entry/T-loop/T-note/T0/T0-R 既有语义；
- 不改 `judge-verdict` 协议（分类读 `judge-recorded`）；不给主模型任何可见标志；
- 不原地改写历史（唯一通道 `platform/history`）；结论句逐字确定（无时间戳/随机）；
- 尺寸申报：P16a src 净增 ≤420、P16b ≤260；超红线即在本单账本快照里申报并给出拆单方案。
- **N9**：★ 断面 `CLASS` 行回填也作分类输入（`shear-run-plan.classes` → verdict），故 `discriminator.auto=false` 时仍可由 ★ 激活机械路径。
- **N10**：run 冲刷加尾部窗门槛（止点距尾 ≥8 节点 → hold），与 T0/T0-R 同口径；分类迟到不中段回剪。
- **N11**：未分类用户消息 = run 边界（保守；`auto=false` 时 run 只在连续分类段内形成）。

## 7. 完成动作

- commit: `feat(p16a): 对话剪切纯核——run 状态机/吸收证明/结论三档`；
  `feat(p16b): 对话剪切接线——run 冲刷 H4 + 星标清单事实`；
  `docs(p16): 账本快照 §40/§41 + 文档同步`。
- 账本快照：P16a/P16b 各一节入 `docs/ledger-history.md`（只增不改）。

# P14d 断面产品契约 + 弹层瘦身 + 推理档（映射 R2 修正；依赖 P14c；尺寸 M）

> 状态：**已施工**（验收见 §6；账本快照 = `docs/ledger-history.md` §35）。
> 设计正典：[02 §4](../02-discriminator.md)（断面五出口/产品契约）/[10 §4](../10-wiring.md)（时序 B）/
> [11 §5](../11-structure.md)（星标接线）/[07 §0.5](../07-metrics.md)（断面族字段）。
> harness 核验源（本仓 checkout 实际源码，非推测）：
> - `packages/client/ui-conversation/src/client/contract/input.ts`：`InputActions = { setDraft, submit }`；
>   `tests/apply-inject.client.spec.tsx:186-204` 证明 `setDraft("hello")` + `submit()` 会以该草稿发送。
> - `packages/llm/llm/src/index.ts:868-887`：请求不支持的 `reasoningEffort` 直接抛
>   `UNSUPPORTED_REASONING_EFFORT`（无静默回退）；`resolveModelInfo` 公开可查 `reasoning.efforts`。
> - `packages/llm/llm-deepseek/src/index.ts:132`：adapter 默认档 = `high`。

## 1. 目标（用户四问的落地）

1. 影子记账数据不足 → 结论写死：对表保留为零成本遥测，**不再等它做决策**（§35 ①）。
2. 断面 prompt 的根因 = 候选段按行切分（单行 prompt → 整条原文 = 唯一候选，KEEP 即锁死改写；§35 ②）
   → 改**事实级预抽**。
3. 产品不许出现"原样保留用户提示词"这类元注释与分节标签 → prompt 契约 + 机械剥离。
4. 防过度思考 → 推理档能力探测 + `off`（实测 9657 输出 token 中 8863 是思考）。

## 2. 实现清单

| 文件 | 改动 |
|---|---|
| `src/core/optimize.ts` | prompt v2（关键事实保真 / 大胆重写 / 禁标签与元注释）；`extractAuthorityCandidates` 事实级 + `mandatory`；`mandatoryCandidateIndexes`；`stripProductMeta`；`metaStrippedLines` fold |
| `src/platform/llm.ts` | `resolveReasoningEffort`（`resolveModelInfo` 探测 + 进程内缓存 + fail-lazy）；`CeGenerateOptions.reasoningEffort` 宽化（收窄仍在 `toHarnessGenerateOptions` 单点） |
| `src/domains/star.ts` | 推理档来自设置（P14f，缺省跟随）；剥离/必保接入；账本记 `metaStrippedLines`/`requestedEffort`/`sentEffort`；`keptSpanIndexes` = 必保 ∪ KEEP |
| `src/domains/optimize-facts.ts` | 三个可选字段 + fold |
| `client/star/*` | 删 diff/`clampPreviewText`/`DiffLine`；`verdictSummary`；弹层只留正文 + 关键事实警告 + 无历史提示 + 折叠详情；点侧面不关闭；确认 → `setDraft` + `submit()`；**结果复用**（同草稿二次点击只展开） |
| 结果复用（P14e 追加） | host `previewCache`（同会话 + 同 prompt + 同输入指纹，命中零调用/零事实；apply 后失效）+ client `cached`（连桥调用都省） |
| 推理档设置（P14f 追加） | `src/config.ts` + `client/field-model.ts` 新增 `discriminator.reasoningEffort`（select：off/low/medium/high/max；留空 = 跟随模型默认）；**判别与 ★ 共用**，探测后只传模型声明的档；判别事实记 `requestedEffort`/`sentEffort`；弹层删除"已发送"提示 |

## 3. 明确不做

- **不默认强制任何推理档**——判别与 ★ 都只在用户显式设置时传档，缺省跟随模型默认。关闭思考会明显影响任务边界判断与改写质量，故默认不动（P14f）。
- 不做产品长度的机械上限（长度是质量判断，归预览）。
- 不剥离正文中部的同类文字（只剥开头连续元注释；剥空回退原文——失败默认保留）。

## 4. 回退链

用户可控指令（prompt 契约即规则）→ 代码分支（事实级候选 / 元注释剥离 / 推理档）→ 机械匹配
（包含性检查）→ 不引入 embedding / 本地模型。失败方向朝安全侧：探测失败按默认档发；剥离剥空
回退原文；必保事实缺失只报警不阻断（预览 = 终审）。

## 5. 度量（docs/07 §0.5 断面族）

`metaStrippedLines` · `optimizeEffort{requested,sent}` · `optimizePromptTokens`（含 reasoning）·
`missingAuthorityCount`（关键事实未保真数）。

## 6. 验收

- [x] `npm run gate` 绿（253 用例 / 29 文件）
- [x] `npm run typecheck:tests` 绿
- [x] `DSH_CHECKOUT=G:/deepseek-harness bash scripts/build.sh` 绿（host + client）
- [x] `node scripts/verify-p14d.mjs` → `P14D VERIFY PASS (18 checks)`（双跑逐字节一致）
- [x] `node scripts/verify-p14c.mjs` → `P14C VERIFY PASS`（无回归）
- [x] ★ 结果复用：`tests/star-host.spec.ts` 12b（同 prompt 二次点击 calls 不增、facts 不增、stats.previewCacheHits=1；apply 后失效重断面）
- [x] 账本快照 = `docs/ledger-history.md` §35 / §36

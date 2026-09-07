# P11 星标断面（映射 R2；依赖 P8,P9,P5,P2；尺寸 M）

> 状态：**已施工（commit `9e5de9b` + 修正 `4a20d32`；`node scripts/verify-p11.mjs` 输出 `P11 VERIFY PASS`）**。前序：P8 稳定前缀已施工（commit `fa8fdab` + fix `037b413`）；P9 卷宗纯核已施工
> （commit `78f33ad`）；P10 判据与对表纯核已施工（commit `e00fbd7` + fix `7d435b2`）。
> 本单交付 `core/optimize.ts` 纯核，**不做运行期接线**：不订阅事件、不调 `streamCeLlm`、不写 KV、不发事实。
> 运行期消费归 P14b 星标 host 方法（时序 B）；`/optimize-prompt` 命令入口归 P13。
> 设计正典：[02 §4](../02-discriminator.md)（手动断面：门控 / 一次断面五出口 / 机械化审计表 / 双通道输出契约）/
> [02 §5](../02-discriminator.md)（执行路线确定化）/
> [07 §0.5](../07-metrics.md)（断面族字段）/
> [11 §2](../11-structure.md)（模块树 `core/optimize.ts` 行）/
> [05 §4](../05-constitution.md)（引用守卫 / 预算守卫）/
> [06 §4/§6](../06-cache.md)（模板在前、实例在后；版本化资产）/
> [P4 工单](P4-skills.md) §8.1（引用守卫由 P4 查表提供；P11 用 P8 同构类型）/
> [P8 工单](P8-units-prefix.md) §3.1（`renderStablePrefix` / `SkillCatalogSnapshot`）/
> [P9 工单](P9-dossier.md) §3.1（`DossierBody` / `isDossierShort` / `backfillDossier`）。
> harness 符号清单：本单**零新增直接 harness import**（core 零 harness import；P14b 才经
> `platform/llm.ts` / `platform/skills.ts` 消费 H12/H13）。

## 1. 目标

落地 R2 判别域的**星标断面纯核** `core/optimize.ts`：输入栈装配（稳定前缀 + 卷宗 + 当前 prompt，
预算钳制）、断面 prompt v1 渲染、双通道解析（产品自由文本 + 行式裁决，行级容错）、四道机械闸
（短卷宗门控 / 输入预算 / 引用守卫 / 权威段逐字保留检查），并先落断面族度量 fold
`foldOptimizeLedger`（度量先行）。本单只交付纯核与测试，**不做运行期接线**；P14b 将本核函数与
P4 `listSkillCatalog`、P5 `streamCeLlm`、P3 `putEntity`、P9 `backfillDossier` 编排为时序 B。

## 2. 输入

### 2.1 正典摘录（工单自足；与正典冲突以正典为准并停工上报）

- **02 §4 触发与门控**：星标按钮 / `/optimize-prompt` 同一管线；上下文 = §2 输入栈全量。
  卷宗太短（无贴文、无约束、消息寥寥）→ 产品层跳过，只回填裁决。
- **02 §4 一次断面、五个出口**：A 优化后 prompt（自由文本，预览 diff → 用户确认 → 原地替换）；
  B 判别回填（卷宗版本 +1）；C task 边界裁决（只判断不执行）；D 剪切清单（行式记录，机械执行）；
  E 度量事件（log-only）。
- **02 §4 机械化审计表**：门控（词长/条数阈值）、权威段逐字保留检查（包含性 diff，span 逐字可寻）、
  技能/命令引用存在性（目录查表）、剪切时机与范围（分类给定后扫描推导）、prompt 组装
  （LLM 生成 + 机械校验）全部机械；LLM 只剩意图结构、约束/验收选择、技能/路径选择、长 run 结论句。
- **02 §4 双通道输出契约（基本不打回）**：产品通道 = 自由文本，任何文本都合法，最终把关 =
  预览 diff + 用户确认；裁决通道 = 行式记录，每行一条独立决策（`BOUNDARY 12` /
  `SHEAR 3..7 已吸收：…` / `SKILL build-fix`），逐行解析，坏行丢弃**那一行**（该决策默认保留），
  好行照常执行；无全局拒绝、无重试、异常成本 = 零额外调用。
- **02 §4 选坐标不造坐标**：行号、范围、技能名只允许从输入枚举（消息坐标表、技能目录）里选；
  解析 = 查表校验。机械钳制兜底：结论句长度上限（超长截断安全）、决策行数上限、候选 span 机械预抽注入。
- **02 §4 协议确定性**：单次调用、temperature 0、宽松 completion 预算、断面内无工具调用。
- **02 §5 执行路线确定化**：优化产物中的技能/命令引用必须查表存在（幻觉技能名机械拦截）。
- **07 §0.5 断面族**：`optimizePromptTokens{in,out}` / `verdictBackfill{count,conflicts}` /
  `shearAtStar{pairs,tokens}` / `explorationAvoided`（星标后探索类调用配对 Δ；本单只定义 fold 形状，
  运行期配对由 P14b/P21b 记账）。
- **11 §2 模块树**：`core/optimize.ts` = 星标断面：输入栈装配、双通道解析、行级容错、四道机械闸
  （02 §4）；`core ↛ platform`。

### 2.2 现有文件

| 路径 | 相关导出/内容 | 本单动作 |
|---|---|---|
| `src/core/dossier.ts` | `DossierBody` / `DossierMessage` / `DossierClass` / `isDossierShort` / `foldDossierLedger` | 复用；不修改 |
| `src/core/prefix.ts` | `ProjectFrameBody` / `SkillCatalogSnapshot` / `renderStablePrefix` | 复用；不修改 |
| `src/core/ledger/fold.ts` | `estimateTokens` | 复用；不修改 |
| `src/platform/skills.ts` | `skillCatalogContains` | **本单不 import**（core 零 platform；P14b 传入 P8 同构 `SkillCatalogSnapshot`） |
| `src/platform/llm.ts` | `streamCeLlm` | **本单不 import**（P14b 消费） |
| `src/index.ts` | 装配根 | **零改动**（P11 无运行期接线） |
| `tsconfig.tests.json` | include 列表 | 增 `tests/optimize.spec.ts` |
| `docs/implement/00-master.md` | P11 行 | 实现后回写 `已施工 commit <hash>` |

### 2.3 决策点记录（执行者不再自行裁量）

1. **门控阈值冻结**：`OPTIMIZE_GATE_DEFAULTS = { minMessages: 2, minTextLength: 10 }`。
   语义：消息数 < 2 或总文本长度 < 10 字符 → `product = null`，只回填裁决（docs/02 §4 门控）。
2. **输入栈预算钳制（预算守卫）**：`OPTIMIZE_INPUT_TOKEN_BUDGET = 24_000`（token，按 P2
   `estimateTokens` 估算）；`OPTIMIZE_PROMPT_MAX_CHARS = 4_000`（当前指令截断，头 3000 尾 1000
   中缀省略）；预算不足时**从最旧消息开始丢弃卷宗**，在渲染的 dossier 前插入一行
   `…[dossier truncated: N earlier messages omitted]…`（确定性输出）。丢弃只发生在渲染视图，
   不修改 `DossierBody` 入参。
3. **断面 prompt 版本化 v1 + 模板在前**：`OPTIMIZE_PROMPT_VERSION = 1`；
   `OPTIMIZE_PROMPT_HEAD`（任务说明 + 四件内容要求 + 候选 span 使用规则）与
   `OPTIMIZE_PROMPT_OUTPUT`（`[PRODUCT]` / `[VERDICTS]` 两段格式）由本单冻结；
   实例段（稳定前缀 / 卷宗 / 当前 prompt / 候选 span / 技能目录）由 `renderOptimizePrompt`
   按固定顺序追加在模板之后。模板文本见 §3.1 注释要求，实现时不得动态拼装模板语句。
4. **候选 span 机械预抽 v1（行级）**：`extractAuthorityCandidates(prompt)` 把 prompt 按行切分、
   trim 后取非空行，每行一个候选 span（编号从 1 开始）；最多 40 行，超限只取前 40 行。
   后续若正典细化 span 抽取规则，以正典为准停工修订。
5. **裁决通道行文法（P11 冻结；P14b 按此行文法消费）**：
   - `CLASS <seq> <action|pureQ|verifyQ>`：三分类终审；seq 必须存在于 dossier。
   - `BOUNDARY <seq>`：边界建议；seq 必须存在于 dossier。
   - `SHEAR <startSeq>..<endSeq> 已吸收：<note>`：剪切清单；start/end 必须存在于 dossier 且
     start ≤ end；note 超长按 `OPTIMIZE_CONCLUSION_MAX_CHARS = 40` 截断。
   - `SKILL <name>`：产品引用的技能名；经引用守卫查表。
   - `KEEP <spanIndex>`：模型勾选要在产品中逐字保留的候选 span；编号必须存在于候选表。
   - `ASPECT <text>`：task 意图画像方面（≤80 字，超长截断）。
   - `FILE <signature>`：文件签名（≤200 字，超长截断）。
   - `KEYWORD <keyword>`：关键词（≤80 字，超长截断）。
   - 每行独立解析；坏行仅计数并丢弃该行，好行照常返回。空行与 `#` 注释行忽略。
6. **引用守卫语义**：`catalog === undefined` 或 `catalog.complete === false` 时，所有 `SKILL`
   行视为坏行丢弃（目录不可用 → 引用不存在；P4 工单 §8.1 已提示）。`catalog` 可用时，`SKILL`
   名必须在 `normalizeSkillCatalog(catalog).skills[].name` 中精确命中，否则坏行丢弃。
   产品自由文本**不打回**；被拒的只是该 `SKILL` 行（行级丢弃，产品其余部分存活）。
7. **权威段逐字保留检查**：`checkAuthoritySpans(product, candidates, keptIndexes)` 对每个被勾选的
   `KEEP` 候选，检查其原文**逐字包含**在 product 中；缺失者记入 `missing`。本单只报告缺失，
   不打回产品（产品通道 = 自由文本；最终把关是 P14a 预览 + 用户确认）。
8. **不新增事实名**：P11 不声明任何 `context-economy/*` 事件；`optimize-run` 是 docs/00 §4 已列事实，
   由 P14b 运行期发射。`core/optimize.ts` 零 `context-economy/` 字面量。
9. **零 index.ts / 零 config.ts 改动**：星标通道常在，不受 `discriminator.auto` 门控；P11 无配置项。
10. **verify-p11 轻量化**：`scripts/verify-p11.mjs` 只跑**一次** `npm run gate` + P8/P9 专项 grep
    + P11 专项扫描；不重跑 verify-p8/p9/p10 全量（其测试已含在 gate 内）。

## 3. 产出

### 3.1 `src/core/optimize.ts`（新，≤320 行；core 零 harness/platform import）

```ts
import { isDossierShort, foldDossierLedger, type DossierBody, type DossierClass, type DossierMessage } from './dossier.ts'
import { estimateTokens } from './ledger/fold.ts'
import { normalizeSkillCatalog, renderStablePrefix, type ProjectFrameBody, type SkillCatalogSnapshot } from './prefix.ts'

// —— 常量与门控 ——
export const OPTIMIZE_PROMPT_VERSION = 1
export const OPTIMIZE_GATE_DEFAULTS = { minMessages: 2, minTextLength: 10 }
export const OPTIMIZE_INPUT_TOKEN_BUDGET = 24_000
export const OPTIMIZE_PROMPT_MAX_CHARS = 4_000
export const OPTIMIZE_CONCLUSION_MAX_CHARS = 40
export const OPTIMIZE_MAX_VERDICT_LINES = 200
export const OPTIMIZE_MAX_CANDIDATE_SPANS = 40
export const OPTIMIZE_PROMPT_HEAD = '…（任务说明 + 四件内容 + 候选 span 使用规则；冻结）'
export const OPTIMIZE_PROMPT_OUTPUT = '…（[PRODUCT] / [VERDICTS] 格式；冻结）'

// —— 输入栈装配与 prompt 渲染 ——
export interface OptimizeInput {
  projectFrame: ProjectFrameBody | undefined
  dossier: DossierBody
  prompt: string
  catalog: SkillCatalogSnapshot | undefined
}
export interface OptimizeRender {
  version: number
  prompt: string
  short: boolean
  ctxTokens: number
  truncatedDossierCount: number
}
export function assembleOptimizeInput(input: OptimizeInput): {
  prefixText: string
  dossierMessages: DossierMessage[]
  promptText: string
  ctxTokens: number
  truncatedDossierCount: number
  short: boolean
}
export function renderOptimizePrompt(input: OptimizeInput): OptimizeRender

// —— 候选 span 与四道机械闸 ——
export interface AuthorityCandidate { index: number; text: string }
export function extractAuthorityCandidates(prompt: string): AuthorityCandidate[]
export interface AuthorityCheck { missing: AuthorityCandidate[]; kept: number[] }
export function checkAuthoritySpans(product: string, candidates: AuthorityCandidate[], keptIndexes: number[]): AuthorityCheck
export function validateSkillName(name: string, catalog: SkillCatalogSnapshot | undefined): boolean
export function clampOptimizePrompt(prompt: string, maxChars?: number): string

// —— 双通道解析（行级容错） ——
export type OptimizeVerdict =
  | { kind: 'class'; seq: number; class: DossierClass }
  | { kind: 'boundary'; seq: number }
  | { kind: 'shear'; startSeq: number; endSeq: number; note: string }
  | { kind: 'skill'; name: string }
  | { kind: 'keep'; spanIndex: number }
  | { kind: 'aspect'; text: string }
  | { kind: 'file'; signature: string }
  | { kind: 'keyword'; keyword: string }

export interface OptimizeParseResult {
  product: string | null
  verdicts: OptimizeVerdict[]
  droppedLines: number
  skillNames: string[]
  shearItems: Array<{ startSeq: number; endSeq: number; note: string }>
  backfillVerdicts: Partial<Record<number, DossierClass>>
  judgeTable: { aspects: string[]; fileSignatures: string[]; keywords: string[] }
  keptSpanIndexes: number[]
}
export function parseOptimizeOutput(
  raw: string,
  dossier: DossierBody,
  catalog: SkillCatalogSnapshot | undefined,
  candidates?: AuthorityCandidate[],
): OptimizeParseResult

// —— 断面族度量 fold（度量先行） ——
export interface OptimizeLlmUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
export interface OptimizeRecord {
  time: number
  short: boolean
  ctxTokens: number
  llmUsage?: OptimizeLlmUsage
  backfillCount: number
  backfillConflicts: number
  shearPairs: number
  shearTokens: number
}
export interface OptimizeLedger {
  optimizeCount: number
  optimizePromptTokens: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }
  verdictBackfill: { count: number; conflicts: number }
  shearAtStar: { pairs: number; tokens: number }
}
export function foldOptimizeLedger(records: OptimizeRecord[]): OptimizeLedger
```

**语义（实现必须逐字照抄；冲突以正典为准停工）：**

1. **assembleOptimizeInput**：
   - `short = isDossierShort(input.dossier, OPTIMIZE_GATE_DEFAULTS)`；
   - `prefixText = input.projectFrame ? renderStablePrefix(input.projectFrame) : '(无项目帧)'`；
   - `promptText = clampOptimizePrompt(input.prompt)`（见下）；
   - `dossierMessages`：short 时与 `dossier.messages` 相同；否则从最旧开始丢弃，直到
     `estimateTokens(prefixText + dossierText + promptText) ≤ OPTIMIZE_INPUT_TOKEN_BUDGET` 或只剩 0 条；
     `truncatedDossierCount = 原条数 - 保留条数`；
   - `ctxTokens = estimateTokens(prefixText + '\n' + dossierText + '\n' + promptText)`；
   - 只读入参，返回新数组/新字符串。
2. **clampOptimizePrompt**：`prompt.length ≤ OPTIMIZE_PROMPT_MAX_CHARS` 时原样返回；否则
   返回 `prompt.slice(0, 3000) + '\n…[prompt truncated]…\n' + prompt.slice(-1000)`。
3. **renderOptimizePrompt**：按固定顺序
   `OPTIMIZE_PROMPT_HEAD + '\n\n' + prefix段 + '\n\n' + dossier段 + '\n\n' + prompt段 +
   '\n\n' + 候选span段 + '\n\n' + 技能目录段 + '\n\n' + OPTIMIZE_PROMPT_OUTPUT`。
   short 时产品段输出为 `[PRODUCT]\n(空)\n`；否则 `[PRODUCT]\n\n[VERDICTS]\n` 格式。
   返回 `{version:1, prompt, short, ctxTokens, truncatedDossierCount}`。
4. **extractAuthorityCandidates**：按 `\n` 切分、trim、去空行；每行一个候选，编号从 1 开始；
   最多 `OPTIMIZE_MAX_CANDIDATE_SPANS` 行，超出忽略。确定性：同一 prompt 同一输出。
5. **validateSkillName**：`catalog === undefined || catalog.complete === false` → false；
   否则 `normalizeSkillCatalog(catalog).skills.some(s => s.name === name)` 为 true。
6. **checkAuthoritySpans**：对每个 keptIndex，若对应候选存在且 `product.includes(candidate.text)`
   为 false，则该候选进 `missing`；keptIndex 非法或重复只去重不报错。纯函数。
7. **parseOptimizeOutput**：
   - 用 `[PRODUCT]` / `[VERDICTS]` 分界：`[PRODUCT]` 到 `[VERDICTS]` 之间的文本为 product
     （trim；空串或分界缺失时 product 为 `null`）；`[VERDICTS]` 之后按行解析，最多
     `OPTIMIZE_MAX_VERDICT_LINES` 行，超出部分计 `droppedLines` 后忽略。
   - 行解析按 §2.4 决策 5；任何类型/范围/枚举/长度校验失败 = 坏行（`droppedLines++`），
     不抛错、不连坐。
   - `backfillVerdicts` 由全部合法 `CLASS` 行组成（同 seq 后者覆盖前者）；
     `judgeTable` 由 `ASPECT`/`FILE`/`KEYWORD` 行聚合；`skillNames` 由合法 `SKILL` 行收集；
     `shearItems` 由合法 `SHEAR` 行收集；`keptSpanIndexes` 由合法 `KEEP` 行收集。
   - `product` 永不打回、不因坏行清空。
8. **foldOptimizeLedger**：
   - `optimizeCount = records.length`；
   - `optimizePromptTokens` 对含 `llmUsage` 记录按字段求和（缺省键按 0）；
   - `verdictBackfill = { count: Σ backfillCount, conflicts: Σ backfillConflicts }`；
   - `shearAtStar = { pairs: Σ shearPairs, tokens: Σ shearTokens }`；
   - 所有聚合可交换，与记录顺序无关；同一输入 `JSON.stringify` 逐字节一致。
9. **零外部状态**：所有函数纯函数；不 import platform/harness；不抛错。

### 3.2 `tests/optimize.spec.ts`（新，≤320 行；全部纯函数/fake 数据，零 cordis 运行时 import）

用例（九组，命名含 `optimize`）：

1. **门控**：`OPTIMIZE_GATE_DEFAULTS` 冻结为 `{minMessages:2, minTextLength:10}`；
   1 条消息或总长 < 10 → `renderOptimizePrompt` 返回 `short=true` 且 prompt 含 `[PRODUCT]\n(空)`；
   满足阈值 → `short=false`。
2. **输入栈装配与预算**：构造 prefix/dossier/prompt，`assembleOptimizeInput` 的
   `prefixText` 与 P8 `renderStablePrefix` 一致；`promptText` 超长按头 3000 尾 1000 截断；
   超预算时从最旧丢弃 dossier，`truncatedDossierCount` 正确，入参 dossier 不被修改。
3. **renderOptimizePrompt 布局与确定性**：prompt 以 `OPTIMIZE_PROMPT_HEAD` 开头，依次包含
   前缀段/卷宗段/prompt 段/候选 span 段/技能目录段/`OPTIMIZE_PROMPT_OUTPUT`；连续 3 次
   渲染逐字节一致。
4. **候选 span**：多行 prompt 提取非空行、编号从 1 起；超过 40 行只取 40；空 prompt 返回 []。
5. **双通道解析**：构造合法 `[PRODUCT]` + `[VERDICTS]` 文本，含 `CLASS`/`BOUNDARY`/
   `SHEAR`/`SKILL`/`KEEP`/`ASPECT`/`FILE`/`KEYWORD` 各 1 行，断言各集合、backfillVerdicts、
   judgeTable 与 keptSpanIndexes 正确。
6. **行级容错**：注入坏行（坏 class、未知 seq、坏范围、超长 note、未知 skill、缺 `[VERDICTS]`
   分界）仅 `droppedLines` 递增，好行全部保留，product 不受连坐。
7. **引用守卫**：catalog 含 `build-fix` 时 `SKILL build-fix` 通过、`SKILL ghost` 丢弃；
   catalog `undefined` 或 `complete:false` 时全部 `SKILL` 丢弃。
8. **权威段逐字保留检查**：候选被 `KEEP` 后 product 不含该 span → 进 `missing`；
   含该 span → 不缺失；非法 spanIndex 不报错。
9. **度量 fold**：手造 3 条 `OptimizeRecord`，逐项手算 `optimizePromptTokens`/
   `verdictBackfill`/`shearAtStar`；空 records 返回 0 值；`JSON.stringify` 连续 3 次一致。

### 3.3 `scripts/verify-p11.mjs`（新，≤140 行；agent 自动化验收入口，轻量模式）

流程（确定性输出，exit 0/1；**只跑一次完整 gate**）：

1. **P8/P9 专项门（轻量，不重跑 verify-p8/p9 全量）**：
   - `src/core/prefix.ts` 含 `renderStablePrefix` / `normalizeSkillCatalog`；
   - `src/core/dossier.ts` 含 `isDossierShort` / `foldDossierLedger` / `backfillDossier`；
   - `tests/prefix.spec.ts` 含 `describe('renderStablePrefix`；`tests/dossier.spec.ts` 含 `describe('dossier`。
2. **build（有 checkout 则构建；缺 checkout 记录 SKIP 继续）**：`DSH_CHECKOUT=G:/deepseek-harness npm run build`。
3. **一次完整门禁**：`npm run gate` → 非 0 即 FAIL；`npm run typecheck:tests` → 非 0 即 FAIL。
4. **断言确定性**：`node scripts/assert-structure.mjs --json` 连跑两次，diff 非空即 FAIL。
5. **core/optimize.ts 反向扫描（期望 0 命中）**：`@deepseek-ai/`、`from 'cordis`、`platform/`、
   `ctx\.`、`session.append`、`setInterval(`、`emitCeFact`、`context-economy/`、`fetch(`、`http.get`、`axios`。
6. **src/index.ts 零改动复查**：`git diff --numstat -- src/index.ts` 为空（或净增 0 行）。
7. **正向扫描（期望 ≥1 命中）**：`renderOptimizePrompt`、`parseOptimizeOutput`、
   `foldOptimizeLedger`、`extractAuthorityCandidates`、`checkAuthoritySpans`、
   `validateSkillName` 在 `src/core/optimize.ts`；`describe('optimize` 在 `tests/optimize.spec.ts`；
   `tests/optimize.spec.ts` 在 `tsconfig.tests.json`。
8. **行数预算**：`src/core/optimize.ts ≤320`、`tests/optimize.spec.ts ≤320`、
   `scripts/verify-p11.mjs ≤140`。
9. 打印 `P11 VERIFY PASS` 或失败清单，exit 0/1。

### 3.4 `tsconfig.tests.json`（改）

`include` 数组追加 `"tests/optimize.spec.ts"`。

### 3.5 文档回写（实现后执行）

- `docs/implement/00-master.md`：P11 行标 `已施工 commit <hash>`。
- `docs/11-structure.md` 状态行：`R2 判别域进行中（P8/P9/P10/P11 已施工）`。
- 不动 `docs/00–11` 设计正文、`datasets/`、`reports/`、`scripts/attic/`。

## 4. 实现要点（每步独立可验证；顺序执行）

### 阶段 0：P8/P9 基线确认（不重跑 verify-p8/p9 全量）

1. `grep -n "renderStablePrefix\|normalizeSkillCatalog" src/core/prefix.ts` 命中。
2. `grep -n "isDossierShort\|foldDossierLedger\|backfillDossier" src/core/dossier.ts` 命中。
3. `git diff --numstat -- src/index.ts` 为空（P11 开工前基线）。
4. 任一失败 → 停工上报。

### 阶段 1：P11 本体

1. **度量先行**：在 `src/core/optimize.ts` 先落 `OptimizeLlmUsage`/`OptimizeRecord`/
   `OptimizeLedger`/`foldOptimizeLedger` → `npm run typecheck` 绿。
2. **写常量/门控/输入栈/prompt 渲染**：补 `OPTIMIZE_*` 常量、`assembleOptimizeInput`、
   `clampOptimizePrompt`、`renderOptimizePrompt` → `npm run typecheck` 绿。
3. **写四道机械闸**：补 `extractAuthorityCandidates`、`validateSkillName`、`checkAuthoritySpans`。
4. **写双通道解析**：补 `parseOptimizeOutput` → `npm run typecheck` 绿。
5. **写 `tests/optimize.spec.ts`**（§3.2）→ `npx vitest run tests/optimize.spec.ts --pool=threads` 绿。
6. **改 `tsconfig.tests.json`**（§3.4）→ `npm run typecheck:tests` 绿。
7. **写 `scripts/verify-p11.mjs`**（§3.3）→ `node scripts/verify-p11.mjs` 输出 `P11 VERIFY PASS`。
8. **全链自验**：`DSH_CHECKOUT=G:/deepseek-harness npm run build`；`npm run gate`；
   `node scripts/assert-structure.mjs --json` 双跑 diff 空。
9. 对照 §5 清单逐条打勾；全部满足后执行 §3.5 文档回写，再进 §7。

## 5. 验收（全机械 + agent 自动化检查）

- [ ] `node scripts/verify-p11.mjs` 输出 `P11 VERIFY PASS`（§3.3 九组全过）
- [ ] `DSH_CHECKOUT=G:/deepseek-harness npm run build` exit 0（P11 新文件进 lib/ 编译；checkout 缺失时脚本 SKIP 且不判 FAIL）
- [ ] `npm run gate` exit 0（typecheck + typecheck:client + vitest + assert 四段全绿）
- [ ] `npm run typecheck:tests` exit 0（`tests/optimize.spec.ts` 进 include）
- [ ] `node scripts/assert-structure.mjs --json` 连跑两次输出逐字节一致（diff 为空）
- [ ] `tests/optimize.spec.ts` §3.2 九组用例齐全且绿（vitest 输出可见）
- [ ] `grep -n "from '@deepseek-ai\|from 'cordis\|from \".*platform\|ctx\.\|session.append\|setInterval(\|emitCeFact\|context-economy/\|fetch(\|http.get\|axios" src/core/optimize.ts`
      无命中（core 零 harness/platform import；纯核零触点、零 timer、零网络、零事实字面量）
- [ ] `git diff --numstat -- src/index.ts` 为空（P11 零接线；P14b 才改装配根）
- [ ] 行数预算：`src/core/optimize.ts ≤320`、`tests/optimize.spec.ts ≤320`、
      `scripts/verify-p11.mjs ≤140`（`wc -l`）

**agent 介入的自动化验证说明**：本单无真实宿主新接线面（`src/index.ts` 零改动，core 纯核），
不需要 `dev_self_test`/`dev_inject_plugin` 真机检查；P14b 接线时再补。Agent 自动化以
`scripts/verify-p11.mjs` 为唯一入口，全机械可复跑。

## 6. 禁区与注意（总纲 §2 全文继承，此处只列本单特有）

1. **core 零 harness import**：`core/optimize.ts` 不得出现任何 `@deepseek-ai/*` / `cordis` /
   `platform/` import（含 type-only）。
2. **不新增事实名**：`core/optimize.ts` 不得出现 `context-economy/*` 字面量；`optimize-run`
   事实由 P14b 运行期发射。
3. **不接线**：P11 不在 `src/index.ts` 订阅事件，不调用 `streamCeLlm`，不写 KV。
4. **不修改 P8/P9 body**：输入栈装配只读 `DossierBody` 与 `ProjectFrameBody`；截断只发生在
   渲染视图的新数组/新字符串；禁止原地修改 `messages`/`annotations`/`aspects`。
5. **产品通道不打回**：任何 product 文本（含空）都合法；`parseOptimizeOutput` 不因 product
   内容拒绝或清空。权威段缺失只报告，不修改 product。
6. **坏行只丢该行**：裁决解析不设全局失败；不得因坏行清空好行或 product。
7. **预算守卫只截断不 fail**：超预算按 §2.4 决策 2 截断；`short` 门控只影响是否出产品层。
8. **停工上报触发器**：① P8/P9 基线 grep 不过；② `renderStablePrefix` 或 `isDossierShort`
   签名与本工单不一致；③ 四道机械闸与 docs/02 §4 审计表冲突；④ 行数预算超限且无法精简；
   ⑤ 任何未覆盖决策点。上报带证据（命令 + 输出 + file:line）。

## 7. 完成动作

- commit（单笔，验收全绿后）：
  `feat(p11): 星标断面纯核——输入栈装配 + prompt v1 + 双通道解析 + 四道机械闸 + 断面 fold`
- 账本快照：**本单不需要**（P11 无运行期机制；R2 出门时随 P14b 出 07 快照，见总纲 §4）。
- 汇报（**本单最后一步，执行者必须完成**）：按 §9 向用户报告修改内容、功能实现与文档对应表。

## 8. 对接面（P11 如何被后续计划消费）与后续计划修正

### 8.1 对接面

| 后续工单 | 消费方式（P11 提供） |
|---|---|
| P12 自动断面服务 | 不直接消费 P11；P14b 回填后经 `optimize_artifact` 中的 `judgeTable`（本单 `OptimizeParseResult.judgeTable` 字段）对表 |
| P13 命令面 + init 项目帧 | `/optimize-prompt` 命令处理调用本核的 `renderOptimizePrompt` / `parseOptimizeOutput`（运行期组装由 P14b 承担） |
| P14a 星标按钮 UI | 预览 diff 用 `OptimizeParseResult.product` 与用户输入原 prompt 做 diff；`AuthorityCheck.missing` 可作预览警告项 |
| P14b 星标 host 方法 + 时序 B | 装配 `OptimizeInput`（P4 `listSkillCatalog` → P8 同构 catalog；P8 `renderStablePrefix`；P9 `DossierBody`）→ P5 `streamCeLlm`（purpose `'context-economy-optimize'`）→ `parseOptimizeOutput` → P9 `backfillDossier`（用 `backfillVerdicts`）→ P3 `putEntity('optimize_artifact', 'optimize_artifact:latest:' + workspace, …)`（body 含 product/verdicts/judgeTable/shearItems/authority；该 latest 指针即 P12 对表数据源）→ `foldOptimizeLedger` 入账 |
| P15b 工具剪切调度 | 消费 `optimize_artifact` 中的 `shearItems`（本单只落盘记账，不执行 surfaceOp） |
| P21a/P21b 恢复与全链验收 | `optimize-run` 事实重放为 `OptimizeRecord[]` 后调用 `foldOptimizeLedger` 同一 fold |

### 8.2 对后续计划的修正（本计划先行记录，实现后回写总纲）

| 行 | 原依赖 | 修正为 | 理由 |
|---|---|---|---|
| P11 | P8,P9,P5,P2 | 不变 | 本计划按总纲现状执行；P11 用 P8 `renderStablePrefix` 与 P9 `isDossierShort` |
| P12 | P10,P3,P8,P9 | 不变（但正文必须写明：对表层 `JudgeTable` 来自 `optimize_artifact` 最新版，P14b 写入前恒为空） | P12 对表数据源在 P11/P14b；P12 实现时只读、不自行造表 |
| P13 | P8,P9,P11,P3 | 不变（但正文必须补 taskId 跨会话唯一性决策） | 审查发现：`task-<n>` 只在单会话 fold 内唯一；P13 必须显式定稿会话级唯一 taskId |
| P14b | P14a,P11,P13,P6,P3 | 不变（但正文必须写"不原地修改 body/messages/annotations"禁区） | 审查发现：P9 `annotateDossier`/`backfillDossier` 返回的新 body 与入参共享 `messages` 数组 |
| P14a | P13 | 不变 | 预览 diff 可直接消费 P11 `OptimizeParseResult.product` |

## 9. 汇报模板（本单最后一步）

执行者在全绿后向用户报告，必须包含：

1. **修改内容**：列出新增/改动文件与行数；明确 `src/index.ts` 零改动、`src/config.ts` 零改动；
   P11 commit 单独列出。
2. **功能实现**：
   - `core/optimize.ts`：门控阈值、输入栈预算装配、prompt v1 渲染、候选 span 抽取、四道机械闸、
     双通道行级容错解析、`foldOptimizeLedger`；
   - `tests/optimize.spec.ts` 九组用例结果；
   - `scripts/verify-p11.mjs` 输出 `P11 VERIFY PASS`。
3. **与文档对应表**：

| 功能 | 代码 | 文档 |
|---|---|---|
| 短卷宗门控 | `OPTIMIZE_GATE_DEFAULTS` + `assembleOptimizeInput.short` | docs/02 §4 门控；P9 `isDossierShort` |
| 输入栈装配/预算 | `assembleOptimizeInput` / `clampOptimizePrompt` | docs/02 §2 输入栈；docs/05 §4 预算守卫 |
| 断面 prompt 版本化 | `OPTIMIZE_PROMPT_VERSION` / `renderOptimizePrompt` | docs/02 §4；docs/06 §4/§6；docs/11 §7 资产登记 |
| 双通道解析/行级容错 | `parseOptimizeOutput` | docs/02 §4 双通道输出契约 |
| 引用守卫 | `validateSkillName` | docs/05 §4；P4 工单 §8.1 |
| 权威段逐字保留检查 | `extractAuthorityCandidates` / `checkAuthoritySpans` | docs/02 §4 机械化审计表 |
| 剪切清单行式记录 | `SHEAR` 行解析 + `shearItems` | docs/02 §4 D 出口；docs/03 §3 |
| 断面族度量 fold | `foldOptimizeLedger` | docs/07 §0.5 断面族；docs/02 §6 |
| 零接线纯核 | `src/core/optimize.ts` 零 platform import | docs/11 §2 依赖铁律 |
| 自动化验收 | `scripts/verify-p11.mjs` | 总纲 §2 铁律 2 + §5 全机械验收 |

4. **后续计划修正已回写**：§8.2 的 P12 对表数据源、P13 taskId 决策、P14b 不可变禁区是否已核对并落笔。

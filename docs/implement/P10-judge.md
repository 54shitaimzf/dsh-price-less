# P10 判据与对表（映射 R2；依赖 P9,P5,P2,P8；契约前置 P8；尺寸 M）

> 状态：**已施工（commit `e00fbd7` + 修正 `7d435b2`；`node scripts/verify-p10.mjs` 输出 `P10 VERIFY PASS`）**。
> 前序：P8 已施工（commit `fa8fdab` + fix `037b413`）；P9 卷宗纯核已施工
> （commit `78f33ad`；`node scripts/verify-p9.mjs` 输出 `P9 VERIFY PASS`）。
> 本单交付 `core/judge.ts` 纯核，**不做运行期接线**：不订阅 `input/user-message`、不调用
> `streamCeLlm`、不写 KV、不发事实。运行期消费归 P12 自动断面服务（`domains/input.ts`）与
> P14b 星标 host 方法。
> 设计正典：[02 §3](../02-discriminator.md)（自动断面决策链 / L0 / L1 / 对表 / LLM 主路径 / fail-lazy）/
> [02 §6](../02-discriminator.md)（判别事件与度量）/
> [07 §0.5](../07-metrics.md)（判别族字段）/
> [11 §2](../11-structure.md)（模块树 `core/judge.ts` 行：L0 词表 / L1 缓存键 / 对表层 / LLM prompt 渲染）/
> [05 §3](../05-constitution.md)（回退链第 3 级机械匹配）/
> [06 §4/§6](../06-cache.md)（辅助调用模板在前、实例在后；字节稳定）/
> [P8 工单](P8-units-prefix.md) §2.4-2（`judge-verdict` 事实最小契约）/
> [P9 工单](P9-dossier.md) §3.1（`DossierClass` 词汇与 `foldDossierLedger` 口径）。
> harness 符号清单：本单**零新增直接 harness import**（core 零 harness import；P12 才经
> `platform/llm.ts` 消费 H12）。

## 1. 目标

落地 R2 判别域的**判据与对表纯核** `core/judge.ts`：冻结 L0 延续词表与匹配、L1 精确缓存键、
对表层纯谓词、LLM 判据 prompt 渲染（模板在前、实例在后）与 fail-lazy 解析，并先落判别族
度量 fold `foldJudgeLedger`（度量先行）。本单只交付纯核与测试，**不做运行期接线**；P12
自动断面服务将本核函数与 P1 事件面、P5 `streamCeLlm`、P3 `putEntity`、P8 `foldSegmentState`、
P9 `appendDossierMessage` 编排为真实决策链。

## 2. 输入

### 2.1 正典摘录（工单自足；与正典冲突以正典为准并停工上报）

- **02 §3 决策链**（每条消息按序走，命中即返回；顺序 = 成本顺序，前三级全免费）：
  1 T0 显式指令；2 L0 延续词表（整条消息 = 延续词（"好"/"ok"/"继续"…）→ continue）；
  3 L1 精确键缓存（同会话 + 同 seq + 同配置 + 同文本 → 直接取缓存票）；
  4 LLM 主路径（判据模板渲染卷宗 + 当前消息 → 判定）；5 fail-lazy 兜底（任何错误/超时 →
  判 continue，异常永不外溢）。
- **02 §3 三分类搭车**：第 4 步同一调用加输出维度，每条消息判 `action` / `pureQ` / `verifyQ`
  ——与 P9 `DossierClass` 三分类词汇一致，不得另造近义词。
- **02 §3 校准后对表**：星标回填产生权威意图结构后，第 2/3 级升级为对表层——文件签名重叠、
  关键词命中、T0 命令全部对表可判；只有"出表"消息（新对象/新域/疑似换意图）才走到第 4 步。
  意图切换是稀疏事件，校准后 LLM 主路径命中率应显著下降（`tableHitRate` 入账）。
- **02 §6 事件与度量**：判别侧 `judgeCount` / `judgeErrorRate` / `judgeCacheHitRate` /
  `judgeLatencyMs` / `judgeLLMUsage` / `judgeCtxTokens` / `judgeVerdictDist{action|pureQ|verifyQ}` /
  `l0CaptureRate` / `tableHitRate`。
- **07 §0.5 判别族**：`judgeCtxTokens`（卷宗体积）从卷宗文本体积 fold 得出；P9 已落
  `foldDossierLedger`，P10/P12 入账 `judgeCtxTokens` 时复用该函数，不得另算。
- **11 §2 模块树**：`core/judge.ts` = 判据组装：L0 词表 / L1 缓存键 / 对表层 / LLM prompt 渲染
  （模板在前）；`core ↛ platform`（反向禁止，CI 断言）。
- **05 §3 回退链**：对表判别是第 2/3 级在判别场景的形态；校准后大部分消息在链上第 3 级以内解决。
- **06 §4/§6**：辅助调用 = 上一次请求真前缀 + 新短尾；判据模板在前、实例（卷宗 + 当前消息）在后，
  模板字节稳定是缓存命中的物理基础。

### 2.2 现有文件

| 路径 | 相关导出/内容 | 本单动作 |
|---|---|---|
| `src/core/dossier.ts` | `DOSSIER_CLASSES` / `DossierClass` / `DossierBody` / `foldDossierLedger` | 复用；不修改 |
| `src/core/units.ts` | `JUDGE_VERDICT_FACT_TYPE` / `JudgeVerdictFactData` | 复用类型与常量；不修改 |
| `src/core/ledger/fold.ts` | `estimateTokens` | 不直接需要；`foldDossierLedger` 已封装 |
| `src/platform/llm.ts` | `streamCeLlm` / `CeLlmUsageReceipt` | **本单不 import**（core 零 platform；P12 消费） |
| `src/index.ts` | 装配根 | **零改动**（P10 无运行期接线） |
| `scripts/assert-structure.mjs` | RULES 表 | 本单**不追加规则**（S1 已覆盖 core 零 import） |
| `tsconfig.tests.json` | include 列表 | 增 `tests/judge.spec.ts` |
| `docs/implement/00-master.md` | P10 行 | 实现后回写 `已施工 commit <hash>` |
| `docs/11-structure.md` | 状态行 | 实现后回写 `R2 判别域进行中（P8/P9/P10 已施工）` |
| `datasets/prompt-discriminator-v2.2.txt` | 判据 prompt 规则段（v2.2 冻结资产） | **只读同源断言，不修改** |

### 2.3 决策点记录（执行者不再自行裁量）

1. **L0 词表同源冻结**：L0 延续词表与 strip 口径与 `scripts/attic/phase_a_l0.mjs` 的
   `strip` + `CONTINUE_WORDS` 逐字节一致（项目既有冻结口径；scripts/attic 封存，只抄录进
   `src/core/judge.ts`，不 import 不改动）。`strip` 正则：
   `/[\s\u3000！？。，、；：""''（）《》【】!?.,;:()\[\]{}~\-—_…]/gu`，匹配后
   `toLowerCase()`；空串返回不命中。完整词表（冻结后不改）：

   ```ts
   export const L0_CONTINUE_WORDS: readonly string[] = [
     '继续', '继续吧', '继续继续', '好的', '好的好的', '好', '好哦', '好呀', '好吧', '行', '行吧', '嗯', '嗯嗯',
     '对', '对的', '是的', '没错', '确实', '明白了', '明白', '知道了', '可以', '可以了', '没问题', '收到', '好滴',
     '谢谢', '然后呢', '还有', '接着', '接着吧', '继续做', '接着做', '继续说', '继续搞', '来吧', '请继续',
     'ok', 'okay', 'yes', 'yep', 'yeah', 'sure', 'great', 'nice', 'gotit', 'understood', 'thanks', 'thanks!',
     'continue', 'goon', 'alright', 'fine', 'right', 'indeed', 'good', 'perfect', 'done', 'works', 'ok!',
     'k', 'kk', 'ok.', 'yes.', 'sure.', 'thanks.', 'right.', 'great.', 'nice.', 'perfect.',
   ]
   ```
2. **L1 缓存键操作化**：`judgeL1CacheKey(scope, promptVersion)` 返回
   `JSON.stringify(['judge-l1', promptVersion, scope.sessionId, scope.seq,
   scope.configFingerprint, scope.text])`。`configFingerprint` 由 P12 用 P10 提供的
   `freezeJudgeConfig` 生成（对象键排序后 `JSON.stringify`），P10 不 import `src/config.ts`。
3. **判据 prompt 模板版本化 v3 + datasets 同源断言**：
   - `JUDGE_PROMPT_HEAD`（新头部）与 `JUDGE_PROMPT_CONTEXT`（卷宗上下文行）由本单冻结；
   - `JUDGE_PROMPT_RULES_CLAUSES`（"先决排除："至"否则 = continue…"的规则分句，切片长度
     = 841 字符）**必须与 `datasets/prompt-discriminator-v2.2.txt` 中 `indexOf('先决排除：')` 到
     `indexOf('\n\n<anchor>')` 的切片逐字节一致**（测试用只读方式读取 datasets，不修改）。
   - 输出契约扩展为 `{"decision":"new_task"|"continue","class":"action"|"pureQ"|"verifyQ"}`
     （docs/02 §3 三分类搭车；v2.2 模板无 class 输出，因此 P10 采用 v3 头部/上下文/输出段 +
     v2.2 规则分句的组合；规则分句不含 `<anchor>`/`<history>` 字样，可无冲突复用）。
4. **LLM 输出解析归一**：prompt 中 decision 词表为 `new_task`/`continue`（沿用 v2.2），
   `parseJudgeLlmOutput` 把 `"new_task"` 归一为 P8 事实词 `"new-task"`；只接受
   `class ∈ DOSSIER_CLASSES`；任何解析/校验失败返回 `null`（调用侧 fail-lazy，不抛错）。
5. **对表层语义（出表才 LLM）**：`matchJudgeTable(text, table)` 在 `table` 为空/`version<1` 时
   返回 `{hit:false}`；`keyword` 命中 = 原文 lower-case 后包含 lower-case 的 keyword；
   `fileSignature` 命中 = 原文 lower-case 后包含 lower-case 的 fileSignature；两者都命中时
   `reason='file-signature'`。命中 = 可机械判 `continue`；未命中 = 出表，P12 走 LLM 主路径。
   P10 只冻结匹配函数与 `JudgeTable` 数据契约，表内容由 P11/P14b 星标回填后填充。
6. **度量口径（foldJudgeLedger，全部从 JudgeRecord 纯函数重算）**：
   - `judgeCount = records.length`；
   - `judgeErrorRate = errorCount / judgeCount`（`errorCount` = `record.error !== undefined ||
     record.trigger === 'error-fallback'`；judgeCount 为 0 时该值为 0）；
   - `judgeCacheHitRate = count(trigger==='l1-cache') / judgeCount`；
   - `l0CaptureRate = count(trigger==='l0-continue') / judgeCount`；
   - `tableHitRate = count(trigger==='table') / max(1, count(trigger==='table') +
     count(trigger==='llm'))`；
   - `judgeLatencyMs` = 所有含 `latencyMs` 记录的平均值（无记录为 0）；
   - `judgeLLMUsage` 对含 `llmUsage` 的记录按字段求和（缺省键按 0 计）；
   - `judgeCtxTokens` = 所有含 `ctxTokens` 记录的求和（P12 必须用 `foldDossierLedger` 填该值）；
   - `judgeVerdictDist` = 只统计 `record.class` 存在的记录，按 `DossierClass` 三分类计数。
   - 上述除率类字段外均为确定整数或有限小数，同一输入 `JSON.stringify` 逐字节一致。
7. **不新增事实名**：P10 不声明任何 `context-economy/*` 事件；`judge-recorded` / `judge-error` /
   `judge-verdict` 是 docs/00 §4 / docs/09 §1 已列事实，由 P12 运行期经
   `platform/logger.ts`/`platform/ignorable-channel.ts` 发射。`core/judge.ts` 不重复定义
   `JUDGE_VERDICT_FACT_TYPE` 常量；本单只 import P8 的 `JudgeVerdictFactData` 类型。
8. **P9 不可变纪律**：`renderJudgePrompt` 只读 `DossierBody`，不得原地修改 `body.messages` /
   `annotations`；过滤当前消息时构造新数组。P10 测试冻结该行为。
9. **零 index.ts / 零 config.ts 改动**：`discriminator.auto` 开关归 P12 域工单落位；
   P10 只提供 `freezeJudgeConfig` 供 P12 生成 L1 指纹。
10. **verify-p10 轻量化（回应 P9 审查）**：`scripts/verify-p10.mjs` 只跑**一次** `npm run gate`
    + P9 专项 grep（不重复跑 verify-p9 全量；P9 已施工 commit `78f33ad` 且其测试已含在 gate 内）。

## 3. 产出

### 3.1 `src/core/judge.ts`（新，≤280 行；core 零 harness/platform import）

```ts
import { DOSSIER_CLASSES, foldDossierLedger, type DossierBody, type DossierClass } from './dossier.ts'
import type { JudgeVerdictFactData } from './units.ts'

// —— 判据 prompt v3（版本化；规则分句与 datasets/prompt-discriminator-v2.2.txt 同源） ——
export const JUDGE_PROMPT_VERSION = 3
export const JUDGE_PROMPT_HEAD = '你是会话任务边界判别器。用户消息是任务边界的唯一来源。对 <target> 判定相对任务上下文是否开启新任务。'
export const JUDGE_PROMPT_CONTEXT = '任务上下文 = <dossier> 中按序排列的全部用户消息（不含 <target>）。<dossier> 中最近一条用户消息是任务的最新进展，为主要参照；更早消息是背景。\n- 以下先决排除（任一命中即判 continue，不再往下检查）。'
export const JUDGE_PROMPT_RULES_CLAUSES = '先决排除：…（与 datasets/prompt-discriminator-v2.2.txt 切片逐字节一致）…否则 = continue，包括：同一工作进行、细化、推进、对工作本身的讨论等。'
export const JUDGE_PROMPT_OUTPUT = '输出（仅 JSON，无其他文本）：\n{"decision":"new_task"|"continue","class":"action"|"pureQ"|"verifyQ"}'

// —— L0 延续词表（与 scripts/attic/phase_a_l0.mjs 同源冻结） ——
export const L0_CONTINUE_WORDS: readonly string[] = [ /* §2.4 决策 1 的完整词表 */ ]
export function stripL0Text(text: string): string
export function matchL0Continue(text: string): boolean

// —— L1 精确缓存键 ——
export function freezeJudgeConfig(value: unknown): string
export interface JudgeL1Scope { sessionId: string; seq: number; text: string; configFingerprint: string }
export function judgeL1CacheKey(scope: JudgeL1Scope, promptVersion?: number): string

// —— 对表层 ——
export const JUDGE_TABLE_VERSION = 1
export interface JudgeTable { version: number; aspects: string[]; fileSignatures: string[]; keywords: string[] }
export interface JudgeTableMatch { hit: boolean; reason?: 'file-signature' | 'keyword' }
export function createEmptyJudgeTable(): JudgeTable
export function matchJudgeTable(text: string, table: JudgeTable | undefined): JudgeTableMatch

// —— LLM 主路径：prompt 渲染 + fail-lazy 解析 ——
export type JudgeDecision = 'continue' | 'new-task'
export interface JudgeTarget { seq: number; text: string }
export interface JudgePrompt { version: number; prompt: string; ctxTokens: number; targetSeq: number }
export function renderJudgePrompt(dossier: DossierBody, target: JudgeTarget): JudgePrompt
export interface JudgeLlmOutput { decision: JudgeDecision; class: DossierClass }
export function parseJudgeLlmOutput(raw: string): JudgeLlmOutput | null
export const FAIL_LAZY_JUDGE_DECISION: JudgeDecision = 'continue'
export function toJudgeVerdictFactData(decision: JudgeDecision, anchorSeq: number, taskId?: string): JudgeVerdictFactData

// —— 判别族度量 fold（度量先行） ——
export type JudgeTrigger = 't0' | 'l0-continue' | 'l1-cache' | 'table' | 'llm' | 'error-fallback'
export interface JudgeLlmUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
export interface JudgeErrorInfo { code: string; message: string }
export interface JudgeRecord {
  seq: number
  time: number
  trigger: JudgeTrigger
  decision: JudgeDecision
  class?: DossierClass
  latencyMs?: number
  ctxTokens?: number
  llmUsage?: JudgeLlmUsage
  error?: JudgeErrorInfo
}
export interface JudgeLedger {
  judgeCount: number
  judgeErrorRate: number
  judgeCacheHitRate: number
  judgeLatencyMs: number
  l0CaptureRate: number
  tableHitRate: number
  judgeLLMUsage: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }
  judgeCtxTokens: number
  judgeVerdictDist: Record<DossierClass, number>
}
export function foldJudgeLedger(records: JudgeRecord[]): JudgeLedger
```

**语义（实现必须逐字照抄；冲突以正典为准停工）：**

1. **stripL0Text**：正则 `[\s\u3000！？。，、；：""''（）《》【】!?.,;:()\[\]{}~\-—_…]` 全局
   删除后 `toLowerCase()`（与 `scripts/attic/phase_a_l0.mjs` 完全一致）。
2. **matchL0Continue**：`const s = stripL0Text(text)`；`s.length === 0` 返回 `false`；
   `L0_CONTINUE_WORDS.includes(s)` 返回 `true`。词表见 §2.4 决策 1 的完整列表。
3. **freezeJudgeConfig**：按以下算法实现（P12 用 `resolveConfig` 后取
   `{provider, model, auto}` 生成指纹）：

   ```ts
   function freezeJudgeConfig(value: unknown): string {
     if (Array.isArray(value)) return '[' + value.map(freezeJudgeConfig).join(',') + ']'
     if (value !== null && typeof value === 'object') {
       return '{' + Object.keys(value as Record<string, unknown>).sort()
         .map((k) => JSON.stringify(k) + ':' + freezeJudgeConfig((value as Record<string, unknown>)[k]))
         .join(',') + '}'
     }
     return JSON.stringify(value) ?? String(value)
   }
   ```
   注意：函数/Date/RegExp 等值不进入 P12 指纹输入；若遇到，`JSON.stringify` 返回
   `undefined` 时兜底 `String(value)`。
4. **judgeL1CacheKey**：`JSON.stringify(['judge-l1', promptVersion ?? JUDGE_PROMPT_VERSION,
   scope.sessionId, scope.seq, scope.configFingerprint, scope.text])`；数组顺序不得改变。
5. **matchJudgeTable**：见 §2.4 决策 5。
6. **renderJudgePrompt**：
   - 构造 `ctxMessages = dossier.messages.filter(m => target.seq === undefined ||
     m.seq < target.seq)`（防 P12 先 append 后误判时当前消息在卷宗与 target 重复）；
   - `ctxBody = { ...dossier, messages: ctxMessages, annotations: dossier.annotations }`（新对象，
     不改入参）；
   - `ctxTokens = foldDossierLedger(ctxBody).ctxTokens`（复用 P9 口径，不得另算）；
   - prompt 布局：
     ```
     ${JUDGE_PROMPT_HEAD}

     ${JUDGE_PROMPT_CONTEXT}

     ${JUDGE_PROMPT_RULES_CLAUSES}

     <dossier>
     ${ctxMessages.map(m => `<msg seq="${m.seq}">${m.text}</msg>`).join('\n') || '(空)'}
     </dossier>

     <target>${target.text}</target>

     ${JUDGE_PROMPT_OUTPUT}
     ```
   - 返回 `{ version: JUDGE_PROMPT_VERSION, prompt, ctxTokens, targetSeq: target.seq }`。
7. **parseJudgeLlmOutput**：
   - 输入 `trim()` 后，若以 ` ``` ` 开头则剥去首/尾 Markdown 代码围栏（允许 ` ```json` 与 ` ``` `）；
   - `JSON.parse`；失败返回 `null`；
   - `decision` 接受 `'continue'` 与 `'new_task'`，后者归一为 `'new-task'`；其他返回 `null`；
   - `class` 必须 ∈ `DOSSIER_CLASSES`；否则返回 `null`；
   - 不抛错、不重试、不填默认值（fail-lazy 语义交给 P12）。
7b. **toJudgeVerdictFactData**：返回 `{ verdict: decision, anchorSeq, taskId? }`；仅
   `decision === 'new-task'` 时携带 `taskId`（P8 状态机只取 `{verdict,anchorSeq,taskId}`
   三键；P12 发射时可用同一 helper 保持契约）。
8. **foldJudgeLedger**：公式见 §2.4 决策 6；`judgeVerdictDist` 初始化为
   `{ action: 0, pureQ: 0, verifyQ: 0 }`；所有聚合字段不得依赖记录顺序（求和/计数可交换）。
9. **零外部状态**：所有函数纯函数；不 import platform/harness；不抛错（`parseJudgeLlmOutput`
   返回 null，`freezeJudgeConfig` 对坏值兜底字符串化，其余为纯计算）。

### 3.2 `tests/judge.spec.ts`（新，≤300 行；全部纯函数/fake 数据，零 cordis 运行时 import）

用例（九组，命名含 `judge`）：

1. **L0 词表**：`matchL0Continue('好')`、`matchL0Continue('ok')`、`matchL0Continue('继续吧')`、
   `matchL0Continue('继续做')` 为 true；`'好的，请继续'`、`''`、`'帮我写个测试'` 为 false；词表包含
   `'继续'`、`'好的'`、`'ok'`、`'k'`、`'继续做'`；`stripL0Text` 对标点/空白/全角标点的删除与 lower-case
   与手写期望一致。
2. **L1 缓存键**：同一 scope 与 promptVersion 生成同一 key；不同 session/seq/text/config
   生成不同 key；`freezeJudgeConfig({b:1,a:2}) === freezeJudgeConfig({a:2,b:1})`；
   不同嵌套对象顺序同 key。
3. **对表层**：空表/version 0 不命中；keyword 命中（大小写不敏感）；fileSignature 命中；
   两者都命中 reason 为 `file-signature`；无重叠不命中；纯函数不修改 table。
4. **renderJudgePrompt**：
   - prompt 以 `JUDGE_PROMPT_HEAD` 开头，包含 `JUDGE_PROMPT_CONTEXT`、
     `JUDGE_PROMPT_RULES_CLAUSES`、`<dossier>`、`<target>`、`JUDGE_PROMPT_OUTPUT`；
   - 给定 2 条卷宗 + target seq=3，prompt 渲染 2 条卷宗且不含 `<msg seq="3">`；target 单独成节；
   - `ctxTokens === foldDossierLedger({...dossier, messages: dossier.messages.slice(0,2)}).ctxTokens`
     （P9 口径）；
   - 入参 `dossier` 与 `dossier.messages` 不被修改（冻结前后 JSON 一致）。
5. **parseJudgeLlmOutput**：`{"decision":"new_task","class":"action"}` 归一为
   `{decision:'new-task', class:'action'}`；`"continue"` 正常；Markdown 围栏剥除；
   非法 JSON / 缺 class / class 非法 / decision 非法 均返回 `null`。
6. **foldJudgeLedger**：手造 6 条记录覆盖六种 trigger 与部分缺省字段，逐项手算
   `judgeCount/errorRate/cacheHitRate/l0CaptureRate/tableHitRate/latency/llmUsage/ctxTokens/
   verdictDist`；错误记录缺 class 不进入 `judgeVerdictDist`；`judgeLLMUsage` 缺省键按 0 聚合。
7. **P8/P9 集成**：`JUDGE_VERDICT_FACT_TYPE === 'context-economy/judge-verdict'`；
   `parseJudgeLlmOutput('{"decision":"new_task","class":"action"}')` 的 decision 与
   P8 `JudgeVerdictFactData.verdict` 的 `'new-task'` 契约一致；`toJudgeVerdictFactData(
   'new-task', 10, 'task-x')` 返回 `{verdict:'new-task', anchorSeq:10, taskId:'task-x'}`；
   `toJudgeVerdictFactData('continue', 10)` 不携带 taskId；`DOSSIER_CLASSES` 与
   `foldJudgeLedger` 的 `judgeVerdictDist` key 完全一致。
8. **datasets 同源断言**：只读读取 `datasets/prompt-discriminator-v2.2.txt`，断言
   `JUDGE_PROMPT_RULES_CLAUSES === v2_2.slice(v2_2.indexOf('先决排除：'),
   v2_2.indexOf('\n\n<anchor>'))` 且切片长度 > 800；`JUDGE_PROMPT_OUTPUT` 含
   `"action"|"pureQ"|"verifyQ"`（三分类搭车）。
9. **确定性**：同一 `renderJudgePrompt` 输出连续 3 次逐字节一致；同一 `foldJudgeLedger`
   输出连续 3 次逐字节一致。

### 3.3 `scripts/verify-p10.mjs`（新，≤140 行；agent 自动化验收入口，轻量模式）

流程（确定性输出，exit 0/1；**只跑一次完整 gate**）：

1. **P9 专项门（轻量，不重跑 verify-p9 全量）**：
   - `src/core/dossier.ts` 存在且含 `dossierStorageKey`、`appendDossierMessage`、
     `backfillDossier`、`foldDossierLedger`、`isDossierShort`；
   - `tests/dossier.spec.ts` 存在且含 `describe('dossier`。
2. **build（有 checkout 则构建；缺 checkout 记录 SKIP 继续）**：
   `DSH_CHECKOUT=G:/deepseek-harness npm run build`；checkout 目录不存在 → `SKIP build
   (checkout missing)` 继续；存在但失败 → FAIL。
3. **一次完整门禁**：`npm run gate` → 非 0 即 FAIL；`npm run typecheck:tests` → 非 0 即 FAIL。
4. **断言确定性**：`node scripts/assert-structure.mjs --json` 连跑两次，diff 非空即 FAIL。
5. **core/judge.ts 反向扫描（期望 0 命中）**：`@deepseek-ai/`、`from 'cordis`、`platform/`、
   `ctx\.`、`session.append`、`setInterval(`、`emitCeFact`、`fetch(`、`http.get`、`axios`。
6. **src/index.ts 零改动复查**：`git diff --numstat -- src/index.ts` 为空（或净增 0 行）。
7. **正向扫描（期望 ≥1 命中）**：
   - `src/core/judge.ts`：`matchL0Continue`、`judgeL1CacheKey`、`matchJudgeTable`、
     `renderJudgePrompt`、`parseJudgeLlmOutput`、`foldJudgeLedger`、`JUDGE_PROMPT_RULES_CLAUSES`；
   - `tests/judge.spec.ts`：`describe('judge`；
   - `tsconfig.tests.json`：`tests/judge.spec.ts`。
8. **datasets 同源抽查**：`node -e` 一行只读比较 `JUDGE_PROMPT_RULES_CLAUSES` 与
   `datasets/prompt-discriminator-v2.2.txt` 切片（与 §3.2 用例 8 同源，脚本层再锁一次）。
9. **lib 新鲜度检查**：`lib/index.js` 必须存在、含 `ctx.inject(['skills']` 且不含
   `export const inject = ['skills']`（P8 防回归；若 checkout 构建已跑则自然覆盖，
   否则仍需检查）。
10. **行数预算**：`src/core/judge.ts ≤280`、`tests/judge.spec.ts ≤300`、
    `scripts/verify-p10.mjs ≤140`。
11. 打印 `P10 VERIFY PASS` 或失败清单，exit 0/1。

### 3.4 `tsconfig.tests.json`（改）

`include` 数组追加：

```json
"tests/judge.spec.ts"
```

### 3.5 文档回写（实现后执行）

- `docs/implement/00-master.md`：P10 行标 `已施工 commit <hash>`；同步把 P10 依赖列改为
  `P9,P5,P2,P8`（P8 为契约前置）并写清理由；P12 行依赖改为 `P10,P3,P8,P9`（见 §8.2）。
- `docs/11-structure.md` 状态行：`R2 判别域进行中（P8/P9/P10 已施工）`。
- 不动 `docs/00–11` 设计正文、`datasets/`、`reports/`、`scripts/attic/`。

## 4. 实现要点（每步独立可验证；顺序执行）

### 阶段 0：P9 基线确认（不重跑 verify-p9 全量）

1. `grep -n "dossierStorageKey\|appendDossierMessage\|backfillDossier\|foldDossierLedger\|isDossierShort" src/core/dossier.ts`
   五者均在。
2. `grep -n "describe('dossier" tests/dossier.spec.ts` 命中。
3. `git diff --numstat -- src/index.ts` 为空（P10 开工前基线；确认 P8/P9 接线已提交）。
4. 若上述任一失败 → 停工上报；不要用"边做边改 P9"的方式掩盖基线问题。

### 阶段 1：P10 本体

1. **度量先行**：在 `src/core/judge.ts` 先落 `JudgeTrigger`/`JudgeRecord`/`JudgeLlmUsage`/
   `JudgeErrorInfo`/`JudgeLedger`/`foldJudgeLedger`（§3.1 度量组）→ `npm run typecheck` 绿。
2. **写 L0/L1/对表**：在 `src/core/judge.ts` 补 `L0_CONTINUE_WORDS`/`stripL0Text`/
   `matchL0Continue`/`freezeJudgeConfig`/`judgeL1CacheKey`/`JudgeTable`/`matchJudgeTable`
   （§3.1）→ `npm run typecheck` 绿。
3. **写 prompt 渲染与解析**：补 `JUDGE_PROMPT_*` 常量/`renderJudgePrompt`/
   `parseJudgeLlmOutput`（§3.1）→ `npm run typecheck` 绿；手动 `node -e` 对比
   `JUDGE_PROMPT_RULES_CLAUSES` 与 datasets 切片一致。
4. **写 `tests/judge.spec.ts`**（§3.2）→ `npx vitest run tests/judge.spec.ts --pool=threads`
   绿（九组用例）。
5. **改 `tsconfig.tests.json`**（§3.4）→ `npm run typecheck:tests` 绿。
6. **写 `scripts/verify-p10.mjs`**（§3.3）→ `node scripts/verify-p10.mjs` 输出
   `P10 VERIFY PASS`。
7. **全链自验**：`DSH_CHECKOUT=G:/deepseek-harness npm run build`（checkout 缺失则 SKIP）；
   `npm run gate`；`node scripts/assert-structure.mjs --json` 双跑 diff 空。
8. 对照 §5 清单逐条打勾；全部满足后执行 §3.5 文档回写，再进 §7。

## 5. 验收（全机械 + agent 自动化检查）

- [ ] `node scripts/verify-p10.mjs` 输出 `P10 VERIFY PASS`（§3.3 十一组全过）
- [ ] `DSH_CHECKOUT=G:/deepseek-harness npm run build` exit 0（P10 新文件进 lib/ 编译；checkout 缺失时脚本 SKIP 且不判 FAIL）
- [ ] `npm run gate` exit 0（typecheck + typecheck:client + vitest + assert 四段全绿）
- [ ] `npm run typecheck:tests` exit 0（`tests/judge.spec.ts` 进 include）
- [ ] `node scripts/assert-structure.mjs --json` 连跑两次输出逐字节一致（diff 为空）
- [ ] `tests/judge.spec.ts` §3.2 九组用例齐全且绿（vitest 输出可见）
- [ ] `grep -n "from '@deepseek-ai\|from 'cordis\|from \".*platform\|ctx\.\|session.append\|setInterval(\|emitCeFact\|fetch(\|http.get\|axios" src/core/judge.ts`
      无命中（core 零 harness/platform import；纯核零触点、零 timer、零网络）
- [ ] `git diff --numstat -- src/index.ts` 为空（P10 零接线；P12 才改装配根）
- [ ] datasets 同源断言绿：`tests/judge.spec.ts` 用例 8 通过，且 `node -e` 脚本层抽查通过
- [ ] 行数预算：`src/core/judge.ts ≤280`、`tests/judge.spec.ts ≤300`、
      `scripts/verify-p10.mjs ≤140`（`wc -l`）

**agent 介入的自动化验证说明**：本单无真实宿主新接线面（`src/index.ts` 零改动，core 纯核），
因此不需要 `dev_self_test`/`dev_inject_plugin` 真机检查；P12 接线时再补。Agent 自动化以
`scripts/verify-p10.mjs` 为唯一入口，全机械可复跑。

## 6. 禁区与注意（总纲 §2 全文继承，此处只列本单特有）

1. **core 零 harness import**：`core/judge.ts` 不得出现任何 `@deepseek-ai/*` 或 `cordis`
   import；不得 import `platform/llm`（测试文件可以 import platform，但本单不需要）。
2. **不新增事实名**：`core/judge.ts` 不得声明新 `context-economy/*` 字符串；
   `JUDGE_VERDICT_FACT_TYPE` 常量由 P8 定义于 `src/core/units.ts`，P10 不重复定义；
   本单只 import P8 的 `JudgeVerdictFactData` 类型。
3. **不接线**：P10 不在 `src/index.ts` 订阅 `input/user-message`，不调用 `streamCeLlm`，
   不调用 `putEntity`，不写 KV；运行期编排归 P12/P14b。
4. **不修改 P9 body**：`renderJudgePrompt` 对 `DossierBody` 只读；过滤当前消息时构造新数组；
   禁止原地修改 `messages`/`annotations`。P10 自身不调用 `appendDossierMessage`/
   `backfillDossier`。
5. **不修改 datasets/scripts/attic**：同源断言只读 `datasets/prompt-discriminator-v2.2.txt`；
   L0 词表抄录自 `scripts/attic/phase_a_l0.mjs` 但不得改动 attic 文件。
6. **lib 必须与 src 同步重建**：任何 src 变更后，`dsh web`/注入器加载 `lib/index.js`；
   未 `npm run build` 即真机 = 陈旧 lib（P8 复盘教训）。P10 虽零接线，构建仍必须过。
7. **不可变纪律传递**：P12/P14b 调用 P9 `annotateDossier`/`backfillDossier` 时，必须遵守
   "不原地修改 body/messages/annotations"（审查发现：P9 返回的新 body 与入参共享 `messages`
   数组；调用方只读使用，禁止 `push`/`splice`）。P10 的 `renderJudgePrompt` 已示范只读
   `DossierBody` 与构造新数组。
8. **taskId 唯一性契约暂不替 P12/P13 猜测**：P8 生成的 `task-<n>` 只在单会话 fold 内唯一；
   P12/P13 若跨会话共用 storage domain，必须在调用 `dossierStorageKey` 前把 taskId 做成
   会话级唯一（P9 §2.4 决策 5 已提示；P10 仅记录此约束，不实现）。
9. **停工上报触发器**：① P9 基线 grep 不过；② datasets 同源断言无法与 v2.2 切片一致；
   ③ `parseJudgeLlmOutput` 与 P8 `judge-verdict` 契约冲突；④ 行数预算超限且无法精简；
   ⑤ 任何未覆盖决策点。上报带证据（命令 + 输出 + file:line）。

## 7. 完成动作

- commit（单笔，验收全绿后）：
  `feat(p10): 判据与对表纯核——L0/L1/对表 + judge prompt v3 渲染 + fail-lazy 解析 + 判别族 fold`
- 账本快照：**本单不需要**（P10 无运行期机制；R2 出门时随 P14b 出 07 快照，见总纲 §4）。
- 汇报（**本单最后一步，执行者必须完成**）：按 §9 向用户报告修改内容、功能实现与文档对应表。

## 8. 对接面（P10 如何被后续计划消费）与后续计划修正

### 8.1 对接面

| 后续工单 | 消费方式（P10 提供） |
|---|---|
| P11 星标断面 | 消费 `DossierClass` 三分类词汇与 `JudgeTable` 数据契约；P11/P14b 星标回填后填充权威意图结构 |
| P12 自动断面 | 按 §2.4 决策链调用：`matchL0Continue` → `judgeL1CacheKey` → `matchJudgeTable` → `renderJudgePrompt` → P5 `streamCeLlm`（purpose `'context-economy-judge'`）→ `parseJudgeLlmOutput` → 失败用 `FAIL_LAZY_JUDGE_DECISION`；`foldJudgeLedger` 入账 |
| P13 命令面 + init 项目帧 | T0 命令文本检测与 taskId 跨会话唯一性决策在 P12/P13 正文冻结；P10 不越界实现 |
| P14b 星标 host 方法 | 回填后生成/刷新 `JudgeTable`（P11 与 P14b 的边界：表由谁填、版本何时 bump）；`backfillDossier` 写卷宗仍走 P9 + P3 |
| P21a/P21b 恢复与全链验收 | `foldJudgeLedger` 作为判别族 fold 扩展；P21b 回放管道把 `judge-recorded` 事实重放为 `JudgeRecord[]` 后调用同一 fold |

### 8.2 对后续计划的修正（本计划先行记录，实现后回写总纲）

| 行 | 原依赖 | 修正为 | 理由 |
|---|---|---|---|
| P10 | P9,P5,P2 | **P9,P5,P2,P8** | `judge-verdict` 事实契约源在 P8（P8/P9 工单 §8.2 已记）；P10 解析输出必须对齐 `{verdict,anchorSeq,taskId}` 三键 |
| P12 | P10,P3 | **P10,P3,P8,P9** | P12 直接消费 `foldSegmentState`（P8）与 `dossierStorageKey`/`appendDossierMessage`（P9），必须写为直接依赖 |
| P13 | P8,P9,P11,P3 | 不变（但正文必须补 taskId 跨会话唯一性决策） | 审查发现：`task-<n>` 只在单会话 fold 内唯一；P13 若跨会话共用 storage domain，必须显式定稿会话级唯一 taskId 后再调 `dossierStorageKey` |
| P14b | P14a,P11,P13,P6,P3 | 不变（但正文必须写"不原地修改 body/messages/annotations"禁区） | 审查发现：P9 `annotateDossier`/`backfillDossier` 返回的新 body 与入参共享 `messages` 数组；调用方必须只读，否则破坏纯核语义与版本链 |
| P11 | P8,P9,P5,P2 | 不变 | P11 门控阈值冻结 `DossierGate`；对表层 `JudgeTable` 的填充者与版本 bump 时点在 P11/P14b 正文写明（P10 只冻结类型与匹配函数） |

### 8.3 对 P9 审查发现的处理（本计划落实）

1. **taskId 唯一性**：P10 不实现、不猜测；作为 P12/P13 工单必须写成显式决策的约束写入
   §8.2 修正表，并在 P12/P13 开工前由执行者复读本表。
2. **P9 不可变纪律**：P10 §6.7 已示范并传递；P12/P14b 工单须把"不原地修改
   `body/messages/annotations`"写入禁区（本表已列为对 P14b 的修正）。
3. **verify-p9 双 gate 偏重**：P10 的 `scripts/verify-p10.mjs` 采用"一次 gate + P9 专项
   grep + P10 专项扫描"的轻量模式；后续 verify 脚本继续沿用该模式。
4. **P9 无运行期接线**：P10 同样无运行期接线，符合工单设定；卷宗实际写入与判据运行期
   消费仍由 P12（自动断面追加）与 P14b（星标回填）完成。

## 9. 汇报模板（本单最后一步）

执行者在全绿后向用户报告，必须包含：

1. **修改内容**：列出新增/改动文件与行数；明确 `src/index.ts` 零改动、`src/config.ts`
   零改动、`datasets/` 与 `scripts/attic/` 零改动；P10 commit 单独列出。
2. **功能实现**：
   - `core/judge.ts`：L0 延续词表同源冻结与匹配；L1 精确缓存键；对表层纯谓词；
     judge prompt v3 渲染（模板在前、实例在后；卷宗 + 当前消息；datasets v2.2 规则分句
     同源断言）；`parseJudgeLlmOutput` fail-lazy 解析（`new_task` → `new-task`）；
     `foldJudgeLedger` 判别族度量（tableHitRate 等公式逐条对应 §2.4 决策 6）；
   - `tests/judge.spec.ts` 九组用例结果；
   - `scripts/verify-p10.mjs` 输出 `P10 VERIFY PASS`（轻量模式：一次 gate + 专项扫描）。
3. **与文档对应表**：

| 功能 | 代码 | 文档 |
|---|---|---|
| L0 延续词表与匹配 | `L0_CONTINUE_WORDS` / `stripL0Text` / `matchL0Continue` | docs/02 §3 决策链第 2 级；scripts/attic/phase_a_l0.mjs 同源 |
| L1 精确缓存键 | `judgeL1CacheKey` / `freezeJudgeConfig` | docs/02 §3 决策链第 3 级 |
| 对表层（出表才 LLM） | `JudgeTable` / `matchJudgeTable` | docs/02 §3 校准后对表；docs/05 §3 回退链 |
| 判据 prompt 渲染（模板在前） | `renderJudgePrompt` / `JUDGE_PROMPT_*` | docs/02 §3 LLM 主路径；docs/06 §4/§6；docs/11 §2 core/judge.ts 行 |
| fail-lazy 解析 | `parseJudgeLlmOutput` / `FAIL_LAZY_JUDGE_DECISION` | docs/02 §3 第 5 级；docs/05 条文 8 |
| 判别族度量 fold | `foldJudgeLedger` / `JudgeLedger` | docs/07 §0.5 判别族；docs/02 §6 |
| 三分类搭车 | `DOSSIER_CLASSES` + prompt 输出 schema | docs/02 §3；P9 工单 §2.4 决策 1 |
| judge-verdict 契约对齐 | `parseJudgeLlmOutput` 归一 `new-task`；引用 P8 常量 | P8 工单 §2.4-2；docs/02 §6 |
| 卷宗体积入账口径 | `renderJudgePrompt.ctxTokens = foldDossierLedger(ctxBody).ctxTokens` | docs/07 §0.5；P9 工单 §2.4 决策 6 |
| 自动化验收（轻量） | `scripts/verify-p10.mjs` | 总纲 §2 铁律 2 + §5 全机械验收；P9 审查发现 3 |

4. **后续计划修正已回写**：§8.2 的 P10/P12 依赖修正、P12/P13 taskId 唯一性显式决策、
   P12/P14b 不原地修改 body/messages/annotations 禁区是否已核对并写入
   `docs/implement/00-master.md` 对应行/后续工单提示。

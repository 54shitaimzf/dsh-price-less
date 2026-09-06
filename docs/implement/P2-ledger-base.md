# P2 度量底座（映射 R1；依赖 P1；尺寸 M）

> 状态：**计划态（本文件为扩写后的施工工单）**。
> 设计正典：[07 §5](../07-metrics.md)（回放管道与同输入同账）/ [07 §2](../07-metrics.md)
> （固定单价表口径）/ [07 §6](../07-metrics.md)（报表模板）/ [10 §1 H7](../10-wiring.md)
> （度量回放原料面）/ [11 §2](../11-structure.md)（模块树 core/ledger 行 + 依赖铁律）/
> [11 §8](../11-structure.md)（R1 出门门槛）/ [12 §2–§3](../12-platform-capabilities.md)
> （facts 源抽象与降级语义）。
> harness 符号清单：本单 **零 harness import**（core/ledger 本地重声明结构类型）；需逐条核验的
> 形状源见 §2.3（只 grep 形状，不 import）。若核验发现形状与 P1 固化面不符 → 停工上报。

## 1. 目标

让 docs/07 的**通用（回放）族**字段可以在纯函数 `core/ledger` 中从 H7 事件面重放计算：
同一批事件 + 同一批 facts → 同一份账本（字节级确定性）；facts 来源抽象为
「会话 ignorable 事件 ∨ KV 事实镜像」两个等价输入，通道存在与否不改变账本口径。
本单**只记账、不发行为**：不注册新事件监听、不新增配置项、不改任何机制路径。

## 2. 输入

### 2.1 正典摘录（工单自足；与正典冲突以正典为准并停工上报）

- **07 §5 回放管道**：`会话 JSONL → fold（事件序重放）→ 段状态机/卷宗版本链/剪除账 →
  usage 聚合 → 07 字段全表 → 报表`。**同输入同账（纯函数断言）**；KV 损毁不影响回放。
- **07 §5 事实源抽象**：`facts = 会话 ignorable 事件 ∨ KV 事实镜像（12 §2–§3）——同一 fold、
  同输入同账，通道存在与否两种环境的账本口径一致`。
- **07 §2 固定单价表口径**：输入缓存命中 = cached 口径 × 折扣单价；输入未命中 = 全价；
  输出 = 输出单价；辅助调用按 purpose 分账（P5 起）；**缺失单价不猜价，记 null**。
- **07 §6 报表模板**：`成本/机制/断裂/误伤/结论` 五段；本单只实现**通用族 + 成本段**的
  纯函数格式化，机制/断裂/误伤段留待各机制工单扩展（扩字段 ≠ 改本单 fold 口径）。
- **10 §1 H7**：度量回放原料 = `step/start|end`、`assistant/message`（usage）、
  `request/header`、`tool/call|result`（原始 arguments + meta）——**六类**，已由 P1 的
  `METRICS_FACE_TYPES` 固化为订阅白名单，本单不扩不缩。
- **11 §2**：`core/ledger` 行 = 度量 fold：从事件流计算 07 字段（纯函数，回放 = 同输入同账）；
  `core ↛ platform`、core 零 harness import（含类型——本地重声明结构性兼容）。
- **11 §8 R1 出门门槛**：`账本字段能从 JSONL 回放；ignorable 断言过`。
- **12 §2–§3**：通道缺失时事实轨降级 KV 镜像；P2 的 fold 对两种事实源**零感知**——同 fold、
  同输入同账（§2 缓解设计已列 P2 行）。

### 2.2 现有文件

| 路径 | 相关导出/内容 | 本单动作 |
|---|---|---|
| `src/platform/events.ts` | `METRICS_FACE_TYPES`（H7 六类白名单）；`CeDomainEvents['metrics/session-event']` 形状 `{ session, event }` | 只读引用其**形状与集合语义**，不 import（core 零 harness import） |
| `src/core/` | 不存在 | **新**：`ledger/`（S1 规则由 vacuous 转 pass，§5） |
| `scripts/assert-structure.mjs` | S1 规则 `appliesTo: src/core/**` | 零改动（新文件天然过 S1/S2/S3/D1–D3；见 §6 风险 1） |
| `tests/assert-structure.spec.ts` | 零位快照 `{… S1:'vacuous' …}` | 更新快照：`S1:'pass'`（§3.5） |
| `tsconfig.json` | include `src`，rootDir `src` | 零改动（新目录自动纳入 typecheck/build） |
| `tests/` | 既有 10 个 spec | 只增不改 |

### 2.3 harness 形状核验源（只 grep 形状；core 本地重声明，不 import）

| 形状 | 定义处（G:/deepseek-harness） | 本单用途 |
|---|---|---|
| `SessionEventMap['assistant/message']`（含 `usage?: TokenUsage`） | `packages/core/session/src/types.ts:299-316` | `tokensPerRound` 的 usage 抽取形状 |
| `TokenUsage`（input/output/total/cacheRead/cacheWrite/reasoning） | `packages/llm/llm/src/types.ts:149-157` | 本地 `TokenUsageLike` 字段名与语义一致 |
| `SessionEventMap['tool/call']`（`callId`/`name`/`arguments`） | `packages/core/session/src/types.ts:319-328` | `toolCallsPerTask` 与重发现配对 |
| `SessionEventMap['tool/result']`（`message: ToolResultMessage`；`message.content[0]` 为 tool-result block） | `packages/core/session/src/types.ts:331-340` + `packages/llm/llm/src/message.ts:154-166` | `compoundedVolume` / `reDiscoveryTokens` 的文本抽取形状 |
| `SessionEvent` 信封（`type`/`seq`/`time`/`data` 判别联合） | `packages/core/session/src/types.ts:475-510` | 本地 `LedgerSessionEvent` 的最小结构面 |
| `step/start` / `step/end` / `request/header` 载荷（`turn`/`step`/`header`/`reason`） | `packages/core/session/src/types.ts:278-284, 342-349` | 计数与事件序基准 |

### 2.4 决策点记录（执行者不再自行裁量）

1. **round 的操作化 = step**（H7 面只含 `step/start|end`）：`roundsPerTask = stepStartCount /
   taskCount`；`tokensPerRound` 按 step 平均（`assistant/message.usage` 入账）。若正典对
   “round”另有定义，以正典为准停工。
2. **taskCount 基线 = 1 + `task-boundary` 事实数**：P2 不实现段状态机（P8），只按正典已列
   事实名 `context-economy/task-boundary` 做**闭口计数**（每个 boundary 闭合一个 task，
   最后一个 task 到日志尾）。P8 落地段状态机后只换 `taskCount` 来源，fold 口径不变。
3. **compoundedVolume 基线 = 无剪切/无压缩上界**：每个 `tool/result` 的文本 token 估算值 ×
   其后 `step/start` 数（含当前 step，见 §3.3 公式）。机制工单（P15/P16/P19/P20）引入
   surface replace 影子价后再从本 fold 派生剪切后口径；本单先给可回放上界，不猜机制效果。
4. **reDiscoveryTokens 基线 = 重复调用结果 token**：`name + '\0' + arguments` 完全相同的
   `tool/call` 再次出现时，其配对 `tool/result` 的文本 token 计入重发现。机械、可回放，
   不建语义聚类（宪法 L0 原则）。
5. **token 估算 = `ceil(chars / 1.5)`**：与 AGENTS.md 固定校准 `CHARS_PER_TOKEN=1.5` 一致；
   只用于账本体积类字段，不进入模型路径。
6. **成本缺价记 null**：P2 提供可选 `PricingTable` 入参；无价目 → `cost*` 全 null（07 §2）。
   `costPerSuccessfulTask` 仅在显式给 `successfulTaskCount` 且成本可算时产出。
7. **facts 源抽象零感知**：`foldCommon` 只接受 `facts?: LedgerFact[]`；会话事件源由
   `factsFromSessionEvents` 抽取，镜像源由 P3 未来按 `LedgerFact` 同构行喂入。本单不 import
   `platform/ignorable-channel`（core 零 harness import），也不改 `setFactMirror` 签名。
8. **本单不接线运行期**：不订阅 pump、不加配置、不写会话事实。R1 门槛“账本字段能从 JSONL
   回放”由 fixture 回放 + `factsFromSessionEvents` 纯函数证明；运行期消费由 P10+ 域工单接。

## 3. 产出

### 3.1 `src/core/ledger/types.ts`（新，≤90 行）

```ts
export interface LedgerSessionEvent {        // 本地结构重声明，零 harness import
  type: string; seq: number; time: number; data?: unknown; [key: string]: unknown
}
export interface LedgerFact {                // 事实源抽象交换格式（P3 镜像表按此行存）
  type: string; seq?: number; time: number; data: unknown
}
export interface TokenUsageLike { inputTokens: number; outputTokens: number;
  totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
export interface PricingTable { inputPerToken: number; outputPerToken: number;
  cacheReadPerToken: number; cacheWritePerToken?: number }
export interface CommonLedger { … }          // 字段见 §3.3
export const DEFAULT_CHARS_PER_TOKEN = 1.5   // 决策点⑤固定校准
```

### 3.2 `src/core/ledger/facts.ts`（新，≤80 行）

```ts
export function factsFromSessionEvents(events: LedgerSessionEvent[]): LedgerFact[]
// 抽取 type 以 'context-economy/' 开头的事件 → { type, seq, time, data }；保事件序、保 data 原引用。
export function assertFactSourcesEquivalent(a: LedgerFact[], b: LedgerFact[]): boolean
// 排序后逐字段 deepEqual（JSON.stringify 比较）——「会话源 ↔ 镜像源」等价断言专用。
export function countFactsOfType(facts: LedgerFact[], type: string): number
```

### 3.3 `src/core/ledger/fold.ts`（新，≤180 行）

```ts
export interface FoldOptions {
  facts?: LedgerFact[]                 // 事实源（缺省 []）
  pricing?: PricingTable               // 缺价 → 成本字段 null
  successfulTaskCount?: number         // 质量门通过数（暂无来源时缺省 → costPerSuccessfulTask null）
  charsPerToken?: number               // 测试注入；缺省 DEFAULT_CHARS_PER_TOKEN
}
export interface CommonLedger {
  eventCounts: { stepStart: number; stepEnd: number; assistantMessage: number;
                 requestHeader: number; toolCall: number; toolResult: number }
  taskCount: number                    // 决策点②：1 + task-boundary 事实数
  roundsPerTask: number                // stepStartCount / taskCount
  tokensPerRound: { inputTokens: number; outputTokens: number } | null  // stepStartCount=0 → null
  toolCallsPerTask: number             // toolCallCount / taskCount
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number;
           cacheWriteTokens: number; reasoningTokens: number; totalTokens: number | null }
  compoundedVolume: number             // 决策点③：Σ resultTextTokens × stepsAfterSeq（含当前 step）
  reDiscoveryTokens: number            // 决策点④：重复 tool/call 的 result 文本 token
  cost: { inputCost: number; outputCost: number; cacheReadCost: number;
          cacheWriteCost: number; totalCost: number } | null
  costPerSuccessfulTask: number | null
}
export function estimateTokens(text: string, charsPerToken?: number): number
export function extractTextFromToolResult(data: unknown): string
export function foldCommon(events: LedgerSessionEvent[], options?: FoldOptions): CommonLedger
export function formatLedgerReport(ledger: CommonLedger, meta?: { id?: string }): string
// 07 §6 模板的成本段 + 通用族段；机制/断裂/误伤段留后续工单扩展。
```

**公式（实现必须逐字照抄；除显式 `null` 外全部为确定数值）**：

- `stepStartCount` = 事件序中 `type==='step/start'` 的数量；`stepEndCount` 同。
- `usage.totalInput = Σ assistant/message.data.usage.inputTokens`；output/cacheRead/cacheWrite/reasoning 同理；`totalTokens = Σ usage.totalTokens`（任一缺失则 totalTokens 记 null）。
- `tokensPerRound.inputTokens = usage.inputTokens / stepStartCount`（stepStartCount=0 → null；浮点保留原值，快照按 JSON 定）。
- `taskCount = max(1, 1 + countFactsOfType(facts, 'context-economy/task-boundary'))`。
- `compoundedVolume = Σ_{r ∈ toolResults} estimateTokens(extractTextFromToolResult(r.data)) × max(1, stepStartsAfterSeq(r.seq))`，其中 `stepStartsAfterSeq(seq) = #{ s ∈ stepStarts | s.seq > seq }`；若结果为 0，取 1（结果至少在其产生 step 被读一次）。
- `reDiscoveryTokens`：先建 `Map<callId, { name, arguments }>`；`name + '\0' + arguments` 在更早的 `tool/call` 中已出现过 → 该 callId 为重复；对每个 `tool/result`，若其 `message.content[0].toolCallId` 对应重复 callId，计入 `estimateTokens(extractedText)`。
- 成本：有 `pricing` 时 `inputCost = cacheReadTokens × cacheReadPerToken + max(0, usage.inputTokens − cacheReadTokens) × inputPerToken`；`outputCost = usage.outputTokens × outputPerToken`；`cacheReadCost = cacheReadTokens × cacheReadPerToken`；`cacheWriteCost = cacheWriteTokens × cacheWritePerToken`（缺 cacheWritePerToken 则该项为 0）；`totalCost = inputCost + outputCost + cacheWriteCost`。无 pricing → cost 全 null。
- `costPerSuccessfulTask`：`pricing` 存在且 `successfulTaskCount` 为正整数 → `totalCost / successfulTaskCount`；否则 null。

### 3.4 `src/core/ledger/index.ts`（新，≤10 行）

具名导出 `types.ts`、`facts.ts`、`fold.ts` 全部公共符号（barrel；不 default export——harness 函数插件规范）。

### 3.5 `tests/ledger-fold.spec.ts` 与 fixtures（新，合计 ≤250 行）

Fixtures 放 `tests/fixtures/ledger/`（JSON；事件与事实均为最小合成，手写可读）：

- `session-events.json`：13 条事件（2 step/start、2 step/end、2 assistant/message 含 usage、
  2 request/header、3 tool/call、2 tool/result），seq 连续，其中 1 对重复工具调用。
- `session-events.expected.json`：由 `foldCommon` 跑出的**唯一正确账本**（执行时先按公式手算/冻结，
  再用脚本生成后逐字段核对一次公式来源；生成值须与手算一致才可冻结）。
- `mirror-facts.json`：与 session-events 中 `context-economy/*` 事实抽取结果完全同构的镜像行。
- `pricing.json`：`{ inputPerToken: 1, outputPerToken: 3, cacheReadPerToken: 0.1, cacheWritePerToken: 0.05 }`。

用例：

1. `estimateTokens`：空串 0、`'a'` → 1、`'ab'` → 2、`'abc'` → 2（ceil(3/1.5)=2）、`charsPerToken=4` 注入生效。
2. `extractTextFromToolResult`：harness ToolResultMessage 形状（`message.content[0].content` 为 text blocks）→ 文本；空/坏形状 → `''` 不抛。
3. `foldCommon` 对 `session-events.json` + `pricing.json` + `successfulTaskCount=2`：
   输出 `eventCounts` 与 fixture 逐字段相等；`roundsPerTask`/`toolCallsPerTask`/`usage`/
   `compoundedVolume`/`reDiscoveryTokens`/`cost`/`costPerSuccessfulTask` 全等（按 §3.3 公式）。
4. **同输入同账（确定性）**：同一 fixture 连续 fold 3 次 `JSON.stringify` 逐字节一致。
5. **事实源等价**：`factsFromSessionEvents(sessionEvents)` 与 `mirror-facts.json` 的
   `assertFactSourcesEquivalent` 为 true；`foldCommon(events, { facts: 会话源 })` 与
   `foldCommon(events, { facts: 镜像源 })` 输出逐字节一致（docs/12 §3 净效果断言）。
6. **缺价记 null**：无 `pricing` → `cost`/`costPerSuccessfulTask` 为 null；无 `successfulTaskCount` →
   `costPerSuccessfulTask` 为 null（07 §2 不猜价）。
7. `formatLedgerReport`：文本含 `成本` 与 `通用` 两段，数字与 ledger 字段一致（07 §6 模板子集）。

### 3.6 `scripts/verify-p2.mjs`（新，≤100 行；agent 自动化验收入口）

Node 内置模块 + `child_process.spawnSync`，只跑命令不替代测试。流程：

1. `npm run gate` → 非 0 即 FAIL。
2. `DSH_CHECKOUT=G:/deepseek-harness npm run build`（`DSH_CHECKOUT` 环境变量可覆盖，缺省
   `G:/deepseek-harness`；目录不存在 → 打印 SKIP 并注明原因，不判 FAIL——纯 core 单不涉装配）→ 非 0 即 FAIL。
3. `node scripts/assert-structure.mjs --json` 连跑两次，输出 diff 非空即 FAIL（确定性）。
4. grep 组（全部期望 0 命中）：
   - `grep -R "from '@deepseek-ai\|from \"@deepseek-ai\|from 'cordis\|from \"cordis\|/platform/" src/core/ledger`
   - `grep -R "fetch(\|http.get\|axios" src/core/ledger tests/ledger-fold.spec.ts`
   - `grep -R "setInterval(" src/core/ledger`
   - `grep -R "context-economy/" src/core/ledger` **允许命中**但必须只在 `facts.ts` 的
     `FACT_TYPE_PREFIX` 常量与 `task-boundary` 闭口计数常量处（决策点②）——脚本 grep 后按
     `facts.ts` 白名单行核验，越出即 FAIL（保 S3 同源纪律：core 不得散落事件名）。
5. 行数预算：`src/core/ledger/*.ts` 逐文件 wc -l 与 §3 预算比较；超限即 FAIL。
6. 打印 `P2 VERIFY PASS` 或失败清单，exit 0/1。

### 3.7 零位快照更新

`tests/assert-structure.spec.ts` 快照 `S1:'vacuous'` → `S1:'pass'`（`src/core/` 落地，S1 规则
开始实测；本单 core/ledger 必须零命中）。其余规则状态不变。

## 4. 实现要点（每步独立可验证；顺序执行）

1. **核验形状**（§2.3）：grep 各定义处，确认字段名与 P1 事件面一致；不一致停工上报。
2. **写 `src/core/ledger/types.ts`**（§3.1）→ `npm run typecheck` 绿。
3. **写 `src/core/ledger/facts.ts`**（§3.2）→ typecheck 绿。
4. **写 `src/core/ledger/fold.ts` + `index.ts`**（§3.3/§3.4）→ typecheck 绿。
5. **手工冻结 fixture 期望值**：按 §3.3 公式先手算 `session-events.json` 的完整 ledger，
   再实现 `foldCommon`；两相对照一致后才写进 `session-events.expected.json`。
   公式与实现不一致 → 查实现，禁止改公式或改 fixture 迁就（防“自洽但不正典”）。
6. **写 `tests/ledger-fold.spec.ts` + fixtures**（§3.5）→ `npm test` 绿。
7. **更新零位快照**（§3.7）→ `npm run assert` 绿。
8. **写 `scripts/verify-p2.mjs`**（§3.6）→ `node scripts/verify-p2.mjs` 全 PASS。
9. **全链自验**：`npm run gate`；`DSH_CHECKOUT=G:/deepseek-harness npm run build`；
   `node scripts/assert-structure.mjs --json` 双跑 diff 空。
10. 对照 §5 清单逐条打勾，全部满足才进 §7。

## 5. 验收（全机械 + agent 自动化检查）

- [ ] `node scripts/verify-p2.mjs` 输出 `P2 VERIFY PASS`（§3.6 六组全过）
- [ ] `npm run gate` exit 0（= typecheck + typecheck:client + vitest + assert 四段全绿）
- [ ] `DSH_CHECKOUT=G:/deepseek-harness npm run build` exit 0（core/ledger 进 lib 声明产物）
- [ ] `node scripts/assert-structure.mjs --json` 连跑两次输出逐字节一致（diff 为空）；
      零位快照含 `S1:pass`（`tests/assert-structure.spec.ts` 对应断言绿）
- [ ] `tests/ledger-fold.spec.ts`：§3.5 七组用例齐全且绿（vitest 输出可见；fixture 期望文件存在）
- [ ] 事实源等价断言绿：会话源 ↔ 镜像源 fold 输出逐字节一致（docs/12 §3）
- [ ] `git diff tests/field-model.spec.ts tests/apply-smoke.spec.ts tests/events-pump.spec.ts`
      为空（既有测试零改动；assert-structure.spec 只改快照行）
- [ ] 行数预算：`types.ts ≤90`、`facts.ts ≤80`、`fold.ts ≤180`、`index.ts ≤10`、
      `scripts/verify-p2.mjs ≤100`（`wc -l`）
- [ ] 零网络：`grep -R "fetch(\|http.get\|axios" src/core/ledger tests/ledger-fold.spec.ts scripts/verify-p2.mjs`
      无命中（spawn 本地命令不算网络）
- [ ] 零 harness import：`grep -R "from '@deepseek-ai\|from \"@deepseek-ai\|from 'cordis\|from \"cordis" src/core/ledger` 无命中
- [ ] 事件名收口：`grep -R "context-economy/" src/core/ledger` 仅命中 `facts.ts` 白名单常量行
      （FACT_TYPE_PREFIX / TASK_BOUNDARY_FACT_TYPE）

## 6. 禁区与注意（总纲 §2 全文继承，此处只列本单特有）

1. **core/ledger 零 harness import（含 type-only）**：S1 规则把 `import type` 也算命中；
   本地重声明结构类型，不 import `@deepseek-ai/dsh-session`。
2. **不发行为**：本单不订阅 pump、不注册 settings、不写会话事实、不加配置。`foldCommon` 是
   纯函数；`factsFromSessionEvents` 只读输入数组。
3. **不扩 H7 白名单**：`METRICS_FACE_TYPES` 六类不动；`turn/start|end` 等不属本单原料。
4. **不猜价**：缺 `pricing` 时成本字段 null（07 §2），禁止用 0 或估算价。
5. **不建事件名**：`context-economy/task-boundary` 是正典已列事实名（docs/09/11 §3），本单
   只作为闭口计数常量引用；其余机制事实名一律不出现。
6. **fixture 期望必须手算冻结**（§4-⑤）：禁止先跑实现再反填期望。
7. **停工上报触发器**：① §2.3 形状核验与 P1 面不符；② `foldCommon` 公式与 fixture 手算
   无法一致且不是实现 bug；③ 行数预算超限且无法精简；④ `node scripts/verify-p2.mjs` 对
   `npm run gate` 的 spawn 在干净环境不可用；⑤ 任何未覆盖决策点。上报带证据
   （命令 + 输出 + file:line）。

## 7. 完成动作

- commit（单笔，验收全绿后）：
  `feat(p2): 度量底座——core/ledger 通用族 fold + facts 源抽象 + fixture 回放同账`
- 账本快照：**本单不需要**（本单产出的是账本**管道**，不是机制改动；R1 段末随 P7 完成后
  出首份 07 报表快照，见总纲 §4）。
- 汇报（**本单最后一步，执行者必须完成**）：按 §9 向用户报告修改内容、功能实现与文档对应表。

## 8. 对接面（P2 如何被后续计划消费）与后续计划修正

### 8.1 对接面

| 后续工单 | 消费方式（P2 提供） |
|---|---|
| P3 持久面 | 事实镜像表按 `LedgerFact` 同构行落 KV（`type`/`seq?`/`time`/`data`）；回放时以 `factsFromMirror` 语义灌入 fold（本单已定义等价断言） |
| P5 辅助调用端口 | `llm.stream` 的 usage 回执按 purpose 分账时，usage 聚合形状复用 `TokenUsageLike`；成本段复用 `PricingTable` 口径 |
| P8 分划单位 + 稳定前缀 | 段状态机产出 `task-boundary` 事实后，`foldCommon` 的 `taskCount` 来源从“事实闭口计数”切换为段状态机真实 task 数（fold 口径不变） |
| P10 判据与对表 | `tableHitRate`/`judgeCount` 等机制字段经新 fold 扩展追加，通用族字段继续由本单 fold 计算 |
| P11 星标断面 | `optimizePromptTokens` 入账走 facts → fold 扩展；通用族成本段不重算 |
| P15/P16 剪切域 | `cutTokensSaved`/`cutBreakCost` 等字段作为本单 fold 的机制扩展层，`compoundedVolume` 基线被 surface replace 影子价修正 |
| P19/P20 压缩域 | 压缩字段（`hotTail*`/`pressure*`/`archiveTruncate`）追加进 fold；成本恒等式分解继续用本单 `usage`/`cost` |
| P21 恢复编排 + 全链验收 | 账本回放、恢复演练的 `restore/*` 事实灌入同一 fold；07 报表快照 = 本单 `formatLedgerReport` + 机制段扩展 |

### 8.2 对后续计划的修正（已随本计划扩写先行回写 `docs/implement/00-master.md`）

以下行依赖列修正**已先行回写**总纲 §3 表（2026-09-06 扩写时完成）；执行者只需核对，若发现总纲被改回再按此表修正：

| 行 | 原依赖 | 修正为 | 理由 |
|---|---|---|---|
| P8 | P3,P4 | **P3,P4,P2** | `taskCount`/`task-boundary` 事实与 fold 口径来自 P2 |
| P10 | P9,P5 | **P9,P5,P2** | `tableHitRate` 入账走 P2 fold 扩展面 |
| P11 | P8,P9,P5 | **P8,P9,P5,P2** | `optimizePromptTokens` 入账走 P2 facts→fold |
| P15 | P6,P7,P12 | **P6,P7,P12,P2** | `cutTokensSaved` 入账走 P2 fold 扩展面 |
| P5 | P2 | 不变 | 已正确 |

总纲 §3 依赖主干图已同步补注边：`P2 ─ P8 / P10 / P11 / P15`（文字注记，不影响 P0 的“各行依赖列构成 DAG”验收——新增边仍从较早节点指向较晚节点）。

## 9. 汇报模板（本单最后一步）

执行者在全绿后向用户报告，必须包含：

1. **修改内容**：列出新增/改动文件与行数；`tests/assert-structure.spec.ts` 仅快照一行变化。
2. **功能实现**：通用族字段计算（公式逐条对应 docs/07 §0.5/§1/§2）；facts 源抽象等价性；
   fixture 回放确定性；verify-p2 自动化检查结果。
3. **与文档对应表**：

| 功能 | 代码 | 文档 |
|---|---|---|
| 度量 fold 纯函数（同输入同账） | `src/core/ledger/fold.ts` | docs/07 §5；docs/11 §2 core/ledger 行 |
| facts 源抽象（会话 ignorable ∨ KV 镜像） | `src/core/ledger/facts.ts` + `types.ts` | docs/12 §2–§3；docs/07 §5 |
| 通用族字段口径（成本/round/tool/复利/重发现） | `src/core/ledger/fold.ts` 公式 | docs/07 §0.5/§1/§2 |
| 报表模板（通用+成本段） | `formatLedgerReport` | docs/07 §6 |
| H7 六类原料 | 只读引用 P1 `METRICS_FACE_TYPES` | docs/10 §1 H7 |
| 零 harness import / core 纯核 | `src/core/ledger/*` 本地重声明 | docs/11 §2 依赖铁律 + §9 |
| 自动化验收 | `scripts/verify-p2.mjs` | 总纲 §2 铁律 2 + §5 全机械验收 |

4. **后续计划修正已回写**：§8.2 的依赖修正是否已写入 `docs/implement/00-master.md`。

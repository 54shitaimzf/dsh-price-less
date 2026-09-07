# P12 自动断面服务（映射 R2；依赖 P10,P3,P8,P9；尺寸 M）

> 状态：**已施工（commit `__P12_COMMIT__`；`node scripts/verify-p12.mjs` 输出 `P12 VERIFY PASS`）**。前序：P8 稳定前缀已施工（commit `fa8fdab` + fix `037b413`）；P9 卷宗纯核已施工
> （commit `78f33ad`）；P10 判据与对表纯核已施工（commit `e00fbd7` + fix `7d435b2`）；
> P11 星标断面纯核已施工（commit `9e5de9b` + 修正 `4a20d32`/`0b079b0`/`eb1d9b4`/`7595c43`；
> 其中 `7595c43` 修复短卷宗输出段重复问题，见 §0）。
> 本单交付 `domains/input.ts` 运行期自动断面服务与最小接线：`discriminator.auto` boolean 门控
> （默认 false；观察模式已取消）、T0→L0→L1→对表→LLM→fail-lazy 决策链、卷宗逐消息追加、judge 事实发射。
> 星标通道与 `/task` 命令面不属本单（P11/P13/P14a/P14b）。
> 设计正典：[02 §2](../02-discriminator.md)（输入面/卷宗纪律）/
> [02 §3](../02-discriminator.md)（自动断面决策链 / 三分类搭车 / 校准后对表 / fail-lazy）/
> [02 §6](../02-discriminator.md)（判别事件与度量）/
> [07 §0.5](../07-metrics.md)（判别族字段）/
> [10 §1](../10-wiring.md)（H1/H12/H14 挂点）/
> [11 §2/§6](../11-structure.md)（`domains/input.ts` 模块行 + `discriminator.auto` 默认 false）/
> [05 §3](../05-constitution.md)（回退链逐级尝试）/
> [P1 工单](P1-events-wiring.md) §8.3（`on('input/user-message')` 是 H1 消费入口）/
> [P5 工单](P5-llm.md) §3.1（`streamCeLlm` 消费）/
> [P8 工单](P8-units-prefix.md) §2.4-2（`judge-verdict` 事实最小契约）/
> [P9 工单](P9-dossier.md) §3.1（`dossierStorageKey` / `appendDossierMessage` / `annotateDossier`）/
> [P10 工单](P10-judge.md) §3.1（`matchL0Continue` / `judgeL1CacheKey` / `matchJudgeTable` /
> `renderJudgePrompt` / `parseJudgeLlmOutput` / `foldJudgeLedger` / `toJudgeVerdictFactData`）。
> harness 符号清单：`ctx.inject(['storageDomain','llm','skills'])` / `ctx.on('session/event')` /
> `session.append` LogIntent / `llm.stream` / `GenerateOptions` / `StreamChunk`——全部经既有
> `platform/` 端口消费，本单不新增直接 harness import（`src/domains` 允许 import platform/core）。

## 0. P11 落地审查结论与本单修正（审查回填）

P11 已施工且 `node scripts/verify-p11.mjs` 输出 `P11 VERIFY PASS`；P11 与本单无直接
import 关系，但其落地形状影响 P14b→P12 的对表数据契约。审查发现：

1. **P11 短卷宗输出段重复（已修复，commit `7595c43`）**：`renderOptimizePrompt` 在 `short=true` 时曾把
   `[PRODUCT]\n(空)\n\n[VERDICTS]` 拼在完整 `OPTIMIZE_PROMPT_OUTPUT` 之前，导致 prompt
   内出现两个 `[PRODUCT]`/`[VERDICTS]` 分界，破坏“严格两段”契约。本次已改为在
   `OPTIMIZE_PROMPT_OUTPUT` 内替换产品段，并新增单一分界断言。P14b 只需消费
   `parseOptimizeOutput`，不受影响。
2. **P11 `judgeTable` 无 version（本单必须吸收）**：`OptimizeParseResult.judgeTable` 形状为
   `{ aspects: string[]; fileSignatures: string[]; keywords: string[] }`，**不含** P10
   `JudgeTable.version`。P14b 写入 `optimize_artifact` 时不能把
   `parseOptimizeOutput().judgeTable` 原样落盘，必须包装为
   `{ version: JUDGE_TABLE_VERSION, ...judgeTable }`。P12 `readJudgeTable` 只认带 version≥1
   的结构（§2.3 决策 8 / §3.4 语义 3）。
3. **P11 行级容错已收紧**：`SHEAR` 行 note 为空按坏行丢弃（commit `eb1d9b4`）；`SKILL` 在目录
   不可用或 `complete:false` 时该行丢弃。P12 不消费这些字段，P14b 消费时无需额外处理。
4. **P12 事实 fold 必须按会话隔离（本单修正）**：`facts/session-event` 是全会话火线，若只维护
   单一全局 facts 数组，会把不同会话的 `task-boundary`/`judge-verdict` 混在一起串段。本单改为
   `factsBySession: Map<sessionId, LedgerFact[]>` 分桶；`foldSegmentState` 只使用当前会话的事实桶。
5. **P12 自身发射事实同步入桶 + 去重（本单修正）**：`judge-recorded`/`judge-error`/
   `judge-verdict` 发射后不能只等火线回灌（微任务时序可能让下一条消息读到旧桶）。P12 采用
   `recordFact(sessionId, fact)` 单点写入：火线回灌与自身发射都经它去重，保证处理下一条消息前
   本会话事实桶已包含本服务此前发射的事实。

## 1. 目标

落地 R2 判别域的**自动断面运行期服务** `domains/input.ts`：订阅 `input/user-message`，按
T0→L0→L1→对表→LLM→fail-lazy 决策链逐消息判定 task 边界与三分类，并把每条用户消息追加进
对应 task 卷宗（P3 `putEntity` + P9 `appendDossierMessage`），发射 `judge-recorded` /
`judge-error` / `judge-verdict` 事实。`discriminator.auto=false` 时零行为（不读 storage、
不调 LLM、不发射事实）；`true` 时发 `judge-verdict` 接入投影。本单同时把 `discriminator.auto`
落进 Config 与 client field-model（docs/11 §5 对应律）。

## 2. 输入

### 2.1 正典摘录（工单自足；与正典冲突以正典为准并停工上报）

- **02 §2 输入面过滤**：只有 `user/message` append + `source.kind==='user'` + 主会话 +
  文本非空 + u≥1 进判别；首条隐式开段由段状态机表达。P1 `passesInputFace` 已实现五条件，
  u≥1 由 P8 `foldSegmentState` 首条隐式开段表达。
- **02 §2 卷宗纪律**：原文逐条累积；不积累历史判定；task 边界清空。卷宗写入由 P12
  （自动断面追加）消费 P9 核 + P3 `putEntity` 完成。
- **02 §3 决策链**：T0 显式指令 → 边界事实，判别器只记账；L0 延续词表整条命中 → continue；
  L1 精确键缓存（同会话 + 同 seq + 同配置 + 同文本）；LLM 主路径（判据模板渲染卷宗 + 当前
  消息）；fail-lazy 兜底（任何错误/超时 → continue，异常永不外溢）。
- **02 §3 三分类搭车**：LLM 同一调用输出 `action` / `pureQ` / `verifyQ`。
- **02 §3 校准后对表**：星标回填产生权威意图结构后，第 2/3 级升级为对表层——文件签名重叠、
  关键词命中、T0 命令全部对表可判；出表才 LLM。P12 只读 `optimize_artifact` 中最新版
  `judgeTable`，P14b 写入前恒为空 → 对表层自然放行。
- **02 §3 段状态机与 active 语义**：`discriminator.auto=false` 时不挂载；`true` 时发
  `judge-verdict` 接入投影；P8 `foldSegmentState` 只在 T0 与有效 verdict 驱动下切分，
  `verdict === 'new-task'` 且 `anchorSeq` 正整数才切分；T0 天然优先。
- **02 §6 事件与度量**：`judge-recorded` / `judge-error` / `judge-verdict`（active）；
  判别侧 `judgeCount` / `judgeErrorRate` / `judgeCacheHitRate` / `judgeLatencyMs` /
  `judgeLLMUsage` / `judgeCtxTokens` / `judgeVerdictDist` / `l0CaptureRate` / `tableHitRate`。
- **07 §0.5 判别族**：`judgeCtxTokens` 复用 P9 `foldDossierLedger`，不得另算。
- **10 §1 H1/H12/H14**：H1 输入面已经由 P1 泵提供；H12 辅助 LLM 经 P5 `streamCeLlm`；
  H14 事实发射经 P1 `emitCeFact`（ignorable 通道，降级 KV 镜像）。
- **11 §2 模块树**：`domains/input.ts` = 判别域自动断面服务；`domains → core + platform`。
- **11 §6 装配开关**：`discriminator.auto` 默认 false；false=不挂载零成本 / true=发 verdict
  接入投影；星标通道常在，不受此开关门控。

### 2.2 现有文件

| 路径 | 相关导出/内容 | 本单动作 |
|---|---|---|
| `src/core/judge.ts` | `matchL0Continue` / `judgeL1CacheKey` / `freezeJudgeConfig` / `matchJudgeTable` / `renderJudgePrompt` / `parseJudgeLlmOutput` / `foldJudgeLedger` / `FAIL_LAZY_JUDGE_DECISION` / `toJudgeVerdictFactData` / `JudgeRecord` / `JudgeTable` / `JudgeDecision` | 复用；不修改 |
| `src/core/t0.ts` | 不存在 | **新**（§3.4a；P12 与 P13 共用的 T0 命令纯解析） |
| `src/core/units.ts` | `foldSegmentState` / `JUDGE_VERDICT_FACT_TYPE` / `JudgeVerdictFactData` | 复用；不修改 |
| `src/core/dossier.ts` | `dossierStorageKey` / `appendDossierMessage` / `annotateDossier` / `foldDossierLedger` / `DossierBody` | 复用；不修改 |
| `src/core/ledger/facts.ts` | `factsFromSessionEvents` / `LedgerFact` / `LedgerSessionEvent` | 复用；不修改 |
| `src/platform/events.ts` | `createEventPump` / `CeDomainEvents` / `EventPump` | **改**：新增 `'facts/session-event'` 领域事件（§3.3） |
| `src/platform/llm.ts` | `streamCeLlm` / `CeGenerateOptions` / `CeLlmUsageReceipt` | 复用；不修改 |
| `src/platform/storage.ts` | `ContextEconomyStorage` / `ENTITY_TABLES` | 复用；不修改 |
| `src/platform/logger.ts` | `emitCeFact` / `ceLogger` | 复用；不修改 |
| `src/config.ts` | Config schema + defaults | **改**：加 `discriminator.auto`（§3.2） |
| `client/field-model.ts` | `ECONOMY_FIELD_SPECS` / `ECONOMY_FIELD_COPY` / `ECONOMY_FIELD_GROUPS` / `CLIENT_DEFAULTS` | **改**：加 `discriminator.auto` 布尔字段（§3.5） |
| `src/index.ts` | 装配根 | **改**：泵变量外提、`getConfig` 保存、llm 子 fiber 挂载自动断面（§3.6） |
| `tests/events-pump.spec.ts` | 事件泵测试 | **追加** facts/session-event 用例，不改存量断言 |
| `tests/field-model.spec.ts` | field-model 壳不变量 | **改**：specs 数 2→3、assembly 组 fields 断言更新 |
| `tsconfig.tests.json` | include 列表 | 增 `tests/input.spec.ts` |
| `docs/implement/00-master.md` | P12 行 | 实现后回写 `已施工 commit <hash>` |

### 2.3 决策点记录（执行者不再自行裁量）

1. **`discriminator.auto` 落 Config + field-model**：`src/config.ts` 的
   `discriminator` 增加 `auto: boolean`（默认 `false`；`CONFIG_DEFAULTS.discriminator.auto = false`）；
   `client/field-model.ts` 同步增加 `discriminator.auto` 布尔字段，进 `assembly` 组（docs/11 §5
   对应律：Config + field-model 两处同扩）。
2. **false = 零行为**：`mountAutoDiscriminator` 始终订阅 `input/user-message`，但 handler 第一步
   `if (getConfig().discriminator.auto !== true) return`。false 时不读 storage、不调 LLM、不发射
   任何事实（订阅本身不产生 token 成本；P13 如需真正卸载可在命令面再加控制器，本单不实现）。
3. **T0 职责边界**：P12 识别 `/task` 文本（`parseT0Command`，仅 `/task <描述>` 与
   `/task close` 两种）后只记 `JudgeRecord{trigger:'t0', decision:'continue'}` 并发
   `judge-recorded`；**不发射 `task-boundary`**（该事实归 P13 命令面，避免双发）。
4. **事实流接入与按会话分桶（P12 需要事实做 foldSegmentState）**：`platform/events.ts` 新增
   `'facts/session-event'` 领域事件，把 firehose 中 `context-economy/*` 事件透传进泵。
   P12 维护 `factsBySession: Map<string, LedgerFact[]>`；收到事件后按 `sessionId(session)`
   转成 `LedgerFact` 写入对应会话桶（每桶只保留最新 2000 条，溢出丢最旧，确定性 FIFO）。
   P12 自身发射的 `judge-*` 事实也经同一写入点 `recordFact(sessionId, fact)` 入桶；
   火线回灌与自身写入用 `type|seq|time|JSON.stringify(data)` 去重，同一事件不重复入列。
5. **每条消息处理顺序（原子化到单消息）**：
   ① 事实桶已就绪（火线订阅与上一条消息的自身发射都已入桶）→ ② 取当前会话
   `sessionFacts = factsBySession.get(sessionId(session)) ?? []`，
   `foldSegmentState(sessionFacts, { sessionFirstSeq })` 取最后一段 `taskId` →
   ③ dossier append（P3 + P9，重试一次）→ ④ T0 → ⑤ L0 → ⑥ L1 缓存 →
   ⑦ 对表（读 `optimize_artifact` 最新版 `judgeTable`）→ ⑧ LLM 主路径 → ⑨ 解析 →
   ⑩ 发射事实、同步 `recordFact`、写缓存、annotate 卷宗。每步失败按 fail-lazy 局部降级，
   不阻断后续步骤可安全跳过的部分。`sessionFirstSeq` 取
   `firstSeqBySession.get(sessionId(session))`；首次处理该会话时记
   `firstSeqBySession.set(sessionId(session), seq)`，缺省回退当前 `seq`。
6. **dossier append 语义**：`key = dossierStorageKey(taskId)`；`getEntity('dossier', key)` 读取
   当前记录（无记录 = `createDossier(taskId)`）；`appendDossierMessage(body, msg)` 生成新 body；
   `putEntity('dossier', key, newBody, {taskId, eventType:'dossier-append', evidence:{seq}}, {baseVersion})`。
   `CasMismatchError` 重读一次并重试；仍失败 → `logger.warn` 后继续判定（LLM 路径仍可用，
   `renderJudgePrompt` 会按 seq 过滤当前消息，不依赖 append 成功）。
7. **L1 缓存语义**：进程内 `Map<string, {decision: JudgeDecision; class: DossierClass}>`，上限
   1024，FIFO 淘汰；key = `judgeL1CacheKey({sessionId, seq, text, configFingerprint})`；
   仅 LLM 成功结果写缓存；解析失败不写。缓存命中 → `trigger:'l1-cache'`，`class` 取缓存值，
   不 annotate 卷宗（原 LLM 路径已 annotate 过；同 seq 重复到达防重）。
8. **对表数据源（versioned judgeTable）**：`readJudgeTable(storage, workspace)` 读
   `optimize_artifact:latest:<workspace>` 记录 body 中的 `judgeTable` 字段；仅当
   `judgeTable` 结构为 `{ version: number ≥ 1; aspects: string[]; fileSignatures: string[]; keywords: string[] }`
   时返回，否则 `undefined`。P11 的 `parseOptimizeOutput().judgeTable` **无 version**，
   P14b 写入前必须包装为 `{ version: JUDGE_TABLE_VERSION, ...judgeTable }`（见 §0/§8.2）。
   P14b 写入前恒为 `undefined` → 对表层自然放行；表命中 → `trigger:'table'`，
   `decision:'continue'`，无 class（对表只判边界，不产三分类）。
9. **LLM 调用与模型路由**：`resolveJudgeModel(config)` 返回
   `{provider:'deepseek-official', model:'deepseek-v4-flash-vision-exp'}` 作为缺省（与
   `client/field-model.ts` 预设一致）；config 有 `provider`/`model` 时覆盖。`streamCeLlm` 参数：
   `{ provider, model, messages:[{role:'user', content: rendered.prompt}], purpose:'context-economy-judge',
   temperature: 0 }`。文本流只拼接 `text-delta` 块；`finish` 块 reason 非 `stop` 视为失败。
10. **fail-lazy 与事实发射**：LLM 调用/解析/append 任一失败 → `trigger:'error-fallback'`，
    `decision:'continue'`，无 class；发射 `judge-error`（含 code/message）与 `judge-recorded`；
    不发射 `judge-verdict`。`judge-verdict` 仅在 `auto===true && decision==='new-task'` 时发射，
    数据用 P10 `toJudgeVerdictFactData(decision, anchorSeq)`（不携带 taskId，由 P8 fold 生成
    `task-<n>` 命名新段）。
11. **SessionEventMap 声明合并**：`src/domains/judge-facts.ts` 对
    `@deepseek-ai/dsh-session/types` 声明合并 `context-economy/judge-recorded`、
    `context-economy/judge-error`、`context-economy/judge-verdict` 三键，并同步并入
    `IgnorableSessionEventMap`（P1 §2.4 决策⑤ / docs/12 §2 编译闸）。P12 只经 `emitCeFact`
    发射，不直接 `session.append`。
12. **异步队列**：`mountAutoDiscriminator` 内维护 FIFO 队列与 `processing` 标志，单消费者
    async 循环逐条处理；`input/user-message` handler 只 `queue.push(payload)` 后调度
    `void drain()`（O(1)，不阻塞 append）。dispose 时停止消费并清空队列（后续到达计 dropped
    由泵 stats 已覆盖；域内不再补）。
13. **verify-p12 轻量化**：`scripts/verify-p12.mjs` 只跑**一次** `npm run gate` + P10/P8/P9
    专项 grep + P12 专项扫描；不重跑 verify-p8/p9/p10 全量。

## 3. 产出

### 3.1 `src/domains/judge-facts.ts`（新，≤120 行）

```ts
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { JudgeRecord, JudgeDecision, JudgeLlmUsage, JudgeErrorInfo } from '../core/judge.ts'
import type { JudgeVerdictFactData } from '../core/units.ts'
import { JUDGE_VERDICT_FACT_TYPE } from '../core/units.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'context-economy/judge-recorded': JudgeRecordedFactData
    'context-economy/judge-error': JudgeErrorFactData
    'context-economy/judge-verdict': JudgeVerdictFactData
  }
  interface IgnorableSessionEventMap {
    'context-economy/judge-recorded': JudgeRecordedFactData
    'context-economy/judge-error': JudgeErrorFactData
    'context-economy/judge-verdict': JudgeVerdictFactData
  }
}

export interface JudgeRecordedFactData {
  seq: number
  time: number
  trigger: JudgeRecord['trigger']
  decision: JudgeDecision
  class?: JudgeRecord['class']
  latencyMs?: number
  ctxTokens?: number
  llmUsage?: JudgeLlmUsage
}
export interface JudgeErrorFactData {
  seq: number
  time: number
  code: string
  message: string
}
export function judgeRecordToFactData(record: JudgeRecord): JudgeRecordedFactData
export function factDataToJudgeRecord(data: JudgeRecordedFactData): JudgeRecord
export const JUDGE_RECORDED_FACT_TYPE = 'context-economy/judge-recorded'
export const JUDGE_ERROR_FACT_TYPE = 'context-economy/judge-error'
export { JUDGE_VERDICT_FACT_TYPE }
```

**语义**：`judgeRecordToFactData` 只搬运行期可序列化字段（`error` 不进入 `judge-recorded`，
走 `judge-error` 单独事实）；`factDataToJudgeRecord` 是回放逆映射（P21b 用，本单实现并测试）。

### 3.2 `src/config.ts`（改）

- `Config.discriminator` 增加 `auto: boolean`。
- `Config` schema 增加 `auto: z.boolean().default(false)`（或与现有 schemastery 写法一致、
  `CONFIG_DEFAULTS.discriminator.auto = false`）。
- `CONFIG_DEFAULTS.discriminator` 改为 `{ auto: false }`。

### 3.3 `src/platform/events.ts`（改，净增 ≤30 行）

- `CeDomainEvents` 增加：
  `'facts/session-event': { session: Session; event: SessionEvent }`。
- firehose 监听器在 `METRICS_FACE_TYPES.has(event.type)` 之后增加：
  `if (event.type.startsWith('context-economy/')) { queue.push({kind:'facts/session-event', payload:{session,event}}); stats.enqueued++ }`
  （注释窗口保留 `ignorable` 字样，满足 S3 启发式）。
- `EventPump` 类型相应增加 `'facts/session-event'` 分支（由 `CeDomainEventKind` 自动派生）。

### 3.4 `src/domains/input.ts`（新，≤340 行）

```ts
import { judgeL1CacheKey, matchJudgeTable, matchL0Continue, parseJudgeLlmOutput, renderJudgePrompt,
         foldJudgeLedger, freezeJudgeConfig, FAIL_LAZY_JUDGE_DECISION, toJudgeVerdictFactData,
         type JudgeDecision, type JudgeRecord, type JudgeTable } from '../core/judge.ts'
import { foldSegmentState } from '../core/units.ts'
import { dossierStorageKey, appendDossierMessage, annotateDossier, createDossier,
         type DossierBody, type DossierClass } from '../core/dossier.ts'
import type { LedgerFact } from '../core/ledger/facts.ts'
import { parseT0Command } from '../core/t0.ts'
import { streamCeLlm, type CeGenerateOptions } from '../platform/llm.ts'
import { emitCeFact, type CeLogger } from '../platform/logger.ts'
import type { EventPump, CeDomainEvents } from '../platform/events.ts'
import type { ContextEconomyStorage } from '../platform/storage.ts'
import type { Config as ConfigShape } from '../config.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { JUDGE_ERROR_FACT_TYPE, JUDGE_RECORDED_FACT_TYPE, JUDGE_VERDICT_FACT_TYPE,
         judgeRecordToFactData, type JudgeErrorFactData } from './judge-facts.ts'

export interface AutoDiscriminatorDeps {
  pump: EventPump
  storage: ContextEconomyStorage
  getConfig: () => ConfigShape
  logger: CeLogger
  workspace?: string
  now?: () => number
  cacheLimit?: number
}
export interface AutoDiscriminator {
  dispose(): void
  stats(): { queued: number; processed: number; facts: number; records: JudgeRecord[]; ledger: ReturnType<typeof foldJudgeLedger> }
}
export function resolveJudgeModel(config: ConfigShape): { provider: string; model: string }
export function readJudgeTable(storage: ContextEconomyStorage, workspace: string): JudgeTable | undefined
export function mountAutoDiscriminator(ctx: Pick<Context, 'llm'>, deps: AutoDiscriminatorDeps): AutoDiscriminator
```

**语义（实现必须逐字照抄；冲突以正典为准停工）：**

1. **T0 解析复用**：`parseT0Command` 由 `src/core/t0.ts` 提供，本文件只 import 不重定义。
2. **resolveJudgeModel**：config.discriminator.provider/model 均非空时用之；否则
   `{provider:'deepseek-official', model:'deepseek-v4-flash-vision-exp'}`。
3. **readJudgeTable**：P3 未提供实体枚举，本单**降级为固定键读取**：
   `getEntity('optimize_artifact', 'optimize_artifact:latest:' + workspace)` 读取 P14b 将来写入的
   latest 指针记录（`workspace = process.cwd().replaceAll('\\','/')`，由 deps 注入，缺省同 P8 口径）；
   body 必须含 `judgeTable` 且结构合法：`version` 为 ≥1 的 number、`aspects`/`fileSignatures`/
   `keywords` 均为 string 数组，否则返回 `undefined`。注意 P11 的
   `OptimizeParseResult.judgeTable` 无 `version`，P14b 写入前必须包装
   `{ version: JUDGE_TABLE_VERSION, ...judgeTable }`（P14b 修正项）。
4. **事实维护（按会话分桶 + 单点去重）**：订阅 `pump.on('facts/session-event', ...)`；
   对每条 `context-economy/*` 事件生成 `LedgerFact`（type/seq/time/data），调用
   `recordFact(sessionId(session), fact)` 写入 `factsBySession` 对应桶（每桶最多 2000 条，
   超出丢最旧，确定性 FIFO）。`recordFact` 以
   `type|(seq ?? '')|time|JSON.stringify(data)` 去重；P12 自身发射的 `judge-recorded`/
   `judge-error`/`judge-verdict` 也经同一 `recordFact` 入桶（发射后同步调用），因此处理下一条
   消息前本会话事实桶已包含本服务此前发射的事实；火线回灌同键不重复入列。
   `stats().facts` 返回 `factsBySession` 所有桶长度之和。
5. **单消息主流程 `processOne`**：
   - `if (getConfig().discriminator.auto !== true) return`（零行为）；
   - `session = payload.session`、`seq/time/text`、`sid = sessionId(session)`；
   - `firstSeqBySession` 无 `sid` 时记 `firstSeqBySession.set(sid, seq)`；
     `sessionFirstSeq = firstSeqBySession.get(sid) ?? seq`；
     `sessionFacts = factsBySession.get(sid) ?? []`；
   - `segments = foldSegmentState(sessionFacts, { sessionFirstSeq })`，
     `taskId = segments.segments.at(-1)!.taskId`；
   - `body = readDossier(storage, taskId)`（无记录 = `createDossier(taskId)`）；
   - `appended = appendDossierMessage(body, {seq, time, text})`；若 `appended !== body`，CAS 写
     （重试一次）；写失败仅 warn（fail-lazy，继续后续）；
   - T0：`parseT0Command(text)` 命中 → 记 `trigger:'t0'`、decision continue，发 `judge-recorded`，
     return（不发 `task-boundary`）；
   - L0：`matchL0Continue(text)` → 记 `trigger:'l0-continue'`、decision continue，发
     `judge-recorded`，return；
   - L1：`fingerprint = freezeJudgeConfig({provider, model, auto:true})`；
     `key = judgeL1CacheKey({sessionId: sessionId(session), seq, text, configFingerprint: fingerprint})`；
     `cache.get(key)` 命中 → 记 `trigger:'l1-cache'`、decision/class 取缓存，发 `judge-recorded`，return；
   - 对表：`table = readJudgeTable(storage, workspace)`；`matchJudgeTable(text, table)` 命中 →
     记 `trigger:'table'`、decision continue（无 class），发 `judge-recorded`，return；
   - LLM：`rendered = renderJudgePrompt(body, {seq, text})`（body 为 append 前卷宗；若 append
     成功且 body 含当前 seq，P10 按 seq 过滤）；`streamCeLlm` 收流拼文本；`onUsage` 记
     `llmUsage` 与 `latencyMs`；`finish` 非 stop → throw；`parseJudgeLlmOutput(text)` 失败 →
     error-fallback；成功 → 记 `trigger:'llm'`、decision/class；`cache.set(key, {decision,class})`；
     若 `appended !== body` 且 `class` 存在，`annotateDossier(appended, seq, class, 'auto', time)`
     后 CAS 写（失败 warn，不重试，避免放大写冲突）；
   - `judge-verdict`：仅当 `decision === 'new-task'` 且 auto 为 true 时发
     `judge-verdict`（数据 `toJudgeVerdictFactData(decision, seq)`），发射后同步
     `recordFact(sid, {type: JUDGE_VERDICT_FACT_TYPE, seq, time, data: ...})`；
   - 所有路径最终发 `judge-recorded` 并 push `JudgeRecord`，发射后同步 `recordFact`；
     error-fallback 额外发 `judge-error` 并同步入桶。
6. **sessionId(session)**：优先 `session.header?.id`，缺省 `String(session.id ?? 'session')`；
   保证同一会话稳定。
7. **异步队列**：`queue: Array<CeDomainEvents['input/user-message']>`；handler 只 push 并
   `void drain()`；`drain` 若 `processing` 为 true 则返回，否则循环 `shift` 处理；处理函数
   内部 try/catch 全量 fail-lazy（catch 发 `judge-error` + `judge-recorded` error-fallback）。
8. **零阻塞**：`input/user-message` handler 不 await、不读 storage、不调 LLM；重活都在
   `drain` 的异步循环中。

### 3.4a `src/core/t0.ts`（新，≤60 行；core 零 harness/platform import）

```ts
export interface T0Command {
  boundary: 'open' | 'close' | null
  description?: string
}
export function parseT0Command(text: string): T0Command
```

**语义**：trim 后匹配 `/task close` → `{boundary:'close'}`；匹配 `/task <非空描述>` →
`{boundary:'open', description}`；`/task`（无参）与 `/compact` 等其余输入 → `{boundary:null}`。
P12 与 P13 共用本函数；P13 不得另写一套 T0 语义。

### 3.5 `client/field-model.ts`（改，净增 ≤20 行）

- `EconomyCardSettingsShape.discriminator` 增加 `auto?: boolean`。
- `CLIENT_DEFAULTS.discriminator = { auto: false }`。
- `ECONOMY_FIELD_COPY['discriminator.auto'] = { label:'自动判别', hint:'开启后逐消息判断任务边界；默认关闭。', docs:'自动断面总开关；关闭时零成本，不挂载判别器。' }`。
- `ECONOMY_FIELD_SPECS` 增加 `economyBoolField('discriminator.auto', { visibility:'core', default:false, deflabel:'默认关闭' })`。
- `ECONOMY_FIELD_GROUPS` 的 `assembly` 组 `fields` 增加同一 spec 引用（保持字段注册唯一来源，
  具体实现可 `fields: [autoSpec]` 并在 `ECONOMY_FIELD_SPECS` 中登记）。

### 3.6 `src/index.ts`（改，净增 ≤35 行）

- `const getConfig = registerContextEconomySettings(...)` 保存返回函数。
- 事件泵外提：`const pump = createEventPump(ctx, ceLogger(ctx))`；`ctx.effect(() => () => pump.dispose())`。
- 在 storage 打开后的 `ctx.inject(['skills'], ...)` 旁，增加
  `ctx.inject(['llm'], (llmCtx) => { stopAuto = mountAutoDiscriminator(llmCtx as Context,
  { pump, storage: opened, getConfig, logger: ceLogger(llmCtx) }) })`；disposer 中调用 `stopAuto?.dispose()`。
- 保持 `skills` 子 fiber 与主插件无硬依赖不变；`llm` 同样为可选能力，缺失时不挂载自动断面。

### 3.7 `tests/input.spec.ts`（新，≤360 行；全部 fake，零 cordis 运行时 import）

用例（十一组，命名含 `auto discriminator` 或 `input`）：

1. **parseT0Command**：`/task close` → close；`/task 写测试` → open；`/task`、`/compact` → null。
2. **resolveJudgeModel**：config 缺省 → deepseek-official 预设；config 覆盖 → 覆盖值。
3. **auto=false 零行为**：fake storage/llm/pump，config auto=false，推入 input/user-message 后
   flush，断言 storage 未读、llm 未调、facts 未发。
4. **T0 记账**：auto=true，`/task close` 只发 judge-recorded（trigger t0），不发 judge-verdict。
5. **L0 记账**：auto=true，`'好的'` → judge-recorded trigger l0-continue，不调 LLM。
6. **L1 缓存**：同一消息两次到达，第一次走 LLM（fake 返回 action/continue），第二次 trigger
   l1-cache 且 class 与缓存一致；LLM 只调一次。
7. **dossier append**：auto=true，首条消息后 dossier 表 v1 含该消息；再一条同 task 后 v2 含两条；
   乱序 seq 不产生新版本（P9 append-only）。
8. **对表**：fake storage 返回含 `judgeTable` 的 `optimize_artifact:latest:<workspace>`，
   `judgeTable = {version:1, aspects:[], fileSignatures:[], keywords:['cache']}`；关键词命中 →
   trigger table，不调 LLM；缺失 version 时读表返回 undefined 并走 LLM。
9. **LLM 成功路径**：fake llm 输出 `{"decision":"continue","class":"action"}` →
   judge-recorded trigger llm、class action、dossier 标注为 auto action；usage 回执入 record。
10. **fail-lazy 路径**：fake llm 输出坏 JSON / finish error / stream 抛错 → judge-error +
    judge-recorded error-fallback、decision continue；不发 judge-verdict；异常不外溢。
11. **会话事实隔离**：两个 session 交替到达；session A 的 `judge-verdict` 只影响 A 的
    `factsBySession` 桶与后续 `taskId`，session B 的 `foldSegmentState` 仍从自己的事实桶取数，
    不跨会话串段；`recordFact` 去重（同一事实火线回灌不重复入列）。

### 3.8 `tests/events-pump.spec.ts`（追加，不重写存量）

新增用例：`context-economy/*` 事件透传为 `facts/session-event`（frozen 原事件引用）；
非 `context-economy/*` 事件不进入 facts/session-event。

### 3.9 `tests/field-model.spec.ts`（改）

- `ECONOMY_FIELD_SPECS` 数量断言 2→3；新增 `discriminator.auto` 为 bool、visibility core。
- `ECONOMY_FIELD_GROUPS.assembly.fields` 断言由 `[]` 改为含 `discriminator.auto` 一个字段。
- `CLIENT_DEFAULTS.discriminator.auto` 断言 false。

### 3.10 `scripts/verify-p12.mjs`（新，≤160 行；agent 自动化验收入口，轻量模式）

流程（确定性输出，exit 0/1；**只跑一次完整 gate**）：

1. **P10/P8/P9 专项门（轻量，不重跑 verify 全量）**：
   - `src/core/judge.ts` 含 `matchL0Continue` / `judgeL1CacheKey` / `renderJudgePrompt` /
     `parseJudgeLlmOutput` / `foldJudgeLedger`；
   - `src/core/units.ts` 含 `foldSegmentState`；`src/core/dossier.ts` 含 `dossierStorageKey` /
     `appendDossierMessage` / `annotateDossier`。
2. **build（有 checkout 则构建；缺 checkout 记录 SKIP 继续）**：`DSH_CHECKOUT=G:/deepseek-harness npm run build`。
3. **一次完整门禁**：`npm run gate` → 非 0 即 FAIL；`npm run typecheck:tests` → 非 0 即 FAIL。
4. **断言确定性**：`node scripts/assert-structure.mjs --json` 连跑两次，diff 非空即 FAIL。
5. **反向扫描（期望 0 命中）**：
   - `src/core/t0.ts`：`@deepseek-ai/`、`from 'cordis`、`platform/`、`ctx\.`、`session.append`、`context-economy/`；
   - `src/domains/input.ts`：`from '@deepseek-ai/dsh-session'` 仅允许 type-only；`session.append`
     字面量 0 命中（事实发射只经 `emitCeFact`）；`ctx.on('session/event')` 0 命中（泵订阅仍
     只在 platform/events.ts）；`setInterval(`、`fetch(`、`http.get`、`axios` 0 命中。
   - `src/config.ts` 不出现 `observe`、`mode`。
6. **正向扫描（期望 ≥1 命中）**：
   - `src/domains/input.ts`：`mountAutoDiscriminator` / `readJudgeTable` /
     `parseT0Command`（import 自 core/t0） /
     `judgeL1CacheKey` / `matchL0Continue` / `renderJudgePrompt` / `streamCeLlm` / `emitCeFact` /
     `factsBySession` / `recordFact` / `firstSeqBySession`；
   - `src/domains/judge-facts.ts`：`JUDGE_RECORDED_FACT_TYPE` / `JUDGE_ERROR_FACT_TYPE` /
     `JUDGE_VERDICT_FACT_TYPE` / `IgnorableSessionEventMap`；
   - `src/config.ts`：`auto: z.boolean()`；`client/field-model.ts`：`discriminator.auto`；
   - `src/index.ts`：`mountAutoDiscriminator`、`ctx.inject(['llm']`；
   - `tests/input.spec.ts`：`describe('auto discriminator`。
7. **事实声明双侧编译闸抽查**：`grep -n "IgnorableSessionEventMap" src/domains/judge-facts.ts`
   命中且同窗口含 `judge-recorded`/`judge-error`/`judge-verdict`。
8. **lib 新鲜度检查**：`lib/index.js` 存在、含 `ctx.inject(['skills']`、含 `mountAutoDiscriminator`
   或 `discriminator.auto`，且不含 `export const inject = ['skills']`（P8 防回归）。
9. **行数预算**：`src/core/t0.ts ≤60`、`src/domains/judge-facts.ts ≤120`、
   `src/domains/input.ts ≤340`、`tests/input.spec.ts ≤360`、`scripts/verify-p12.mjs ≤160`；`src/index.ts` 净增 ≤35；
   `src/platform/events.ts` 净增 ≤30；`src/config.ts` 净增 ≤15；`client/field-model.ts` 净增 ≤20。
10. 打印 `P12 VERIFY PASS` 或失败清单，exit 0/1。

### 3.11 `tsconfig.tests.json`（改）

`include` 数组追加 `"tests/input.spec.ts"`。

### 3.12 文档回写（实现后执行）

- `docs/implement/00-master.md`：P12 行标 `已施工 commit <hash>`；R2 状态行改为
  `P8/P9/P10/P11/P12 已施工`（P11 已施工，含本次短卷宗输出段修复）。
- `docs/11-structure.md` 状态行同步；`docs/10-wiring.md` H1/H12/H14 状态如涉及回写按事实更新。
- 不动 `docs/00–11` 设计正文、`datasets/`、`reports/`、`scripts/attic/`。

## 4. 实现要点（每步独立可验证；顺序执行）

### 阶段 0：基线确认（不重跑 verify 全量）

1. `grep -n "matchL0Continue\|renderJudgePrompt\|parseJudgeLlmOutput" src/core/judge.ts` 命中。
2. `grep -n "foldSegmentState" src/core/units.ts` 命中。
3. `grep -n "dossierStorageKey\|appendDossierMessage\|annotateDossier" src/core/dossier.ts` 命中。
4. `git diff --numstat -- src/index.ts src/config.ts` 为空（P12 开工前基线）。
5. 任一失败 → 停工上报。

### 阶段 1：P12 本体

1. **配置与 UI 字段先行**：改 `src/config.ts` + `client/field-model.ts` + `tests/field-model.spec.ts`
   → `npm run typecheck:client` 与 `npx vitest run tests/field-model.spec.ts --pool=threads` 绿。
2. **事实流与事实声明**：改 `src/platform/events.ts` 增加 `facts/session-event`；新建
   `src/domains/judge-facts.ts` 声明合并三事件；追加 `tests/events-pump.spec.ts` 用例 →
   `npm run typecheck` / `npm run typecheck:tests` 绿。
3. **写 `src/domains/input.ts`**（§3.4）→ `npm run typecheck` 绿（domains → core + platform 合规）。
4. **接线 `src/index.ts`**（§3.6）→ `npm run typecheck` 绿；`grep -n "mountAutoDiscriminator" src/index.ts` 命中。
5. **写 `tests/input.spec.ts`**（§3.7）→ `npx vitest run tests/input.spec.ts --pool=threads` 绿。
6. **改 `tsconfig.tests.json`**（§3.11）→ `npm run typecheck:tests` 绿。
7. **写 `scripts/verify-p12.mjs`**（§3.10）→ `node scripts/verify-p12.mjs` 输出 `P12 VERIFY PASS`。
8. **全链自验**：`DSH_CHECKOUT=G:/deepseek-harness npm run build`；`npm run gate`；
   `node scripts/assert-structure.mjs --json` 双跑 diff 空。
9. 对照 §5 清单逐条打勾；全部满足后执行 §3.12 文档回写，再进 §7。

## 5. 验收（全机械 + agent 自动化检查）

- [ ] `node scripts/verify-p12.mjs` 输出 `P12 VERIFY PASS`（§3.10 全部步骤通过）
- [ ] `DSH_CHECKOUT=G:/deepseek-harness npm run build` exit 0（P12 新文件进 lib/ 编译；checkout 缺失时脚本 SKIP 且不判 FAIL）
- [ ] `npm run gate` exit 0（typecheck + typecheck:client + vitest + assert 四段全绿）
- [ ] `npm run typecheck:tests` exit 0（`tests/input.spec.ts` 进 include）
- [ ] `node scripts/assert-structure.mjs --json` 连跑两次输出逐字节一致（diff 为空）
- [ ] `tests/input.spec.ts` §3.7 十一组用例齐全且绿（vitest 输出可见）
- [ ] `tests/events-pump.spec.ts` 新增 facts/session-event 用例绿；存量断言零改动
- [ ] `tests/field-model.spec.ts` 更新后绿（specs 数 3、assembly 组含 auto、CLIENT_DEFAULTS.auto=false）
- [ ] `grep -n "session.append" src/domains/input.ts src/domains/judge-facts.ts` 无命中（事实发射只经 `emitCeFact`）
- [ ] `grep -n "ctx.on('session/event'" src/domains/input.ts` 无命中（火线订阅仍只在 platform/events.ts）
- [ ] `grep -n "observe\|discriminator.mode" src/config.ts client/field-model.ts` 无命中（观察模式已取消）
- [ ] `git diff --numstat -- src/index.ts` 净增 ≤35；`src/platform/events.ts` 净增 ≤30；
      `src/config.ts` 净增 ≤15；`client/field-model.ts` 净增 ≤20
- [ ] 行数预算：`src/core/t0.ts ≤60`、`src/domains/judge-facts.ts ≤120`、`src/domains/input.ts ≤340`、
      `tests/input.spec.ts ≤360`、`scripts/verify-p12.mjs ≤160`（`wc -l`）

**agent 介入的自动化验证说明**：本单有真实接线面（index/config/events）。`verify-p12.mjs`
为自动化主入口；真机宿主检查（`dev_self_test` / `dev_build_plugin` / `dev_inject_plugin` /
宿主日志无 `cannot get property "llm" without inject`）在阶段 1 第 8 步之后尽量执行，
不可用则记录 SKIP 并在汇报中说明。

## 6. 禁区与注意（总纲 §2 全文继承，此处只列本单特有）

1. **可选服务只走 `ctx.inject`**：`llm` 与 `skills` 一样是可选能力；不得在主插件根 ctx 直接读
   `ctx.llm`，不得新增 `export const inject = ['llm']`（P8 教训）。
2. **不发射 `task-boundary`**：P12 只识别 T0 并记账；边界事实归 P13 命令面，避免双发。
3. **不直接 `session.append`**：所有事实只经 `emitCeFact` 发射（S2/D3 收口）；声明合并在
   `judge-facts.ts`，且三事件必须同时进 `IgnorableSessionEventMap`。
4. **false 零行为**：auto=false 时 handler 首行返回，不读 storage、不调 LLM、不发事实；
   缓存与 `factsBySession` 也不增长。
5. **不修改 P9 body**：`appendDossierMessage`/`annotateDossier` 返回新 body；CAS 写使用新对象；
   禁止原地 push/splice `messages`/`annotations`。
6. **不阻塞 append**：`input/user-message` handler 只入队；任何 await/LLM/存储访问都在
   `drain` 异步循环。
7. **fail-lazy 方向永远朝 continue**：任何异常 → error-fallback + continue；不重试 LLM；
   不把错误外溢到会话流。
8. **judge-verdict 仅 active**：只有 `auto===true` 且 `decision==='new-task'` 才发射；
   `continue` 不发射 verdict（P8 状态机只认 new-task）。
9. **停工上报触发器**：① P10/P8/P9 基线 grep 不过；② `streamCeLlm` 实际签名与 P5 工单不符；
   ③ `SessionEventMap` 声明合并无法通过 typecheck:tests；④ 行数预算超限且无法精简；
   ⑤ 任何未覆盖决策点。上报带证据（命令 + 输出 + file:line）。

## 7. 完成动作

- commit（单笔，验收全绿后）：
  `feat(p12): 自动断面服务——T0/L0/L1/对表/LLM/fail-lazy 决策链 + 卷宗追加 + judge 事实 + auto 开关`
- 账本快照：**本单不需要**（R2 出门时随 P14b 出 07 快照，见总纲 §4）。
- 汇报（**本单最后一步，执行者必须完成**）：按 §9 向用户报告修改内容、功能实现与文档对应表。

## 8. 对接面（P12 如何被后续计划消费）与后续计划修正

### 8.1 对接面

| 后续工单 | 消费方式（P12 提供） |
|---|---|
| P11 星标断面 | 已施工；P12 不直接 import P11。P11 的 `OptimizeParseResult.judgeTable` 产物经 P14b 包装 `version` 后写入 `optimize_artifact:latest:<workspace>`，再由 P12 `readJudgeTable` 读取 |
| P13 命令面 + init 项目帧 | T0 识别分工：P12 只记账不发射 `task-boundary`；P13 注册命令并发射边界事实。P13 必须 import `src/core/t0.ts` 的 `parseT0Command`（同源，不另写） |
| P14b 星标 host 方法 | 写入 `optimize_artifact:latest:<workspace>` 指针；`judgeTable` 必须包装为 `{ version: JUDGE_TABLE_VERSION, ...parseOptimizeOutput().judgeTable }` 后写入 body；回填卷宗走 P9 `backfillDossier` + P3 `putEntity`；P12 随后对表生效 |
| P15b 工具剪切调度 | 依赖 P12 的 `input/user-message` 消费链稳定运行；`cutTokensSaved` 入账走 P2 fold 扩展 |
| P21a/P21b 恢复与全链验收 | `judge-recorded` / `judge-error` / `judge-verdict` 事实重放为 `JudgeRecord[]` 后调用 P10 `foldJudgeLedger` 同一 fold |

### 8.2 对后续计划的修正（本计划先行记录，实现后回写总纲）

| 行 | 原依赖 | 修正为 | 理由 |
|---|---|---|---|
| P12 | P10,P3,P8,P9 | 不变（已含 P8/P9 直接依赖） | 本计划按总纲现状执行 |
| P11 | P8,P9,P5,P2 | 已施工；不变 | P11 与 P12 无直接依赖；P11 的 `judgeTable` 经 P14b 落盘后才与 P12 对表层发生关系 |
| P13 | P8,P9,P11,P3 | **P8,P9,P11,P3,P12**（复用 P12 交付的 `src/core/t0.ts`；P13 发射 `task-boundary`，P12 只记账） | 避免 T0 双发与 taskId 分叉 |
| P14b | P14a,P11,P13,P6,P3 | 不变（但正文必须写：① `optimize_artifact:latest:<workspace>` 指针写入；② 不原地修改 body/messages/annotations；③ `judgeTable` 必须包装为 `{ version: JUDGE_TABLE_VERSION, ...judgeTable }` 后再写入 body，与 P12 `readJudgeTable` 对齐） | P12 对表数据源依赖 P14b 写入契约 |
| P15b | P15a,P6,P7,P12,P2 | 不变 | P12 先行稳定自动断面服务 |

### 8.3 对既有审查发现的处理（本计划落实）

1. **taskId 唯一性**：P12 暂用 `foldSegmentState` 输出的 `task-<n>`（单会话 fold 内唯一）；
   跨会话共用 storage domain 的会话级唯一 taskId 决策仍归 P13 工单显式定稿；P12 不自行猜测。
2. **P9 不可变纪律**：P12 调用 `appendDossierMessage`/`annotateDossier` 后只读新对象、CAS 写
   新对象；不原地修改 body/messages/annotations。
3. **verify 轻量化**：P12 verify 采用"一次 gate + 专项扫描"，不重跑 verify-p8/p9/p10 全量。
4. **会话事实隔离**：P12 的 `factsBySession` 分桶与 `recordFact` 去重已在本计划固化；
   P21b 回放时仍按会话分组后 fold，不得跨会话合并。

## 9. 汇报模板（本单最后一步）

执行者在全绿后向用户报告，必须包含：

1. **修改内容**：列出新增/改动文件与行数；明确 `src/index.ts`、`src/config.ts`、
   `client/field-model.ts` 的净增行数与改动点；P12 commit 单独列出。
2. **功能实现**：
   - `domains/input.ts`：自动断面决策链（T0/L0/L1/对表/LLM/fail-lazy）、卷宗逐消息追加、
     L1 缓存、对表数据源、judge 事实发射；
   - `domains/judge-facts.ts`：三事件声明合并与事实数据映射；
   - `discriminator.auto` 配置/UI 开关与默认 false；
   - `platform/events.ts` 事实流接入；`src/index.ts` llm 子 fiber 接线；
   - `tests/input.spec.ts` 十一组用例与 `scripts/verify-p12.mjs` 结果。
3. **与文档对应表**：

| 功能 | 代码 | 文档 |
|---|---|---|
| 自动断面决策链 | `mountAutoDiscriminator` / `processOne` | docs/02 §3；docs/10 §1 H1 |
| T0 识别与记账 | `parseT0Command` + trigger t0 | docs/02 §3 决策链第 1 级 |
| L0 延续词表 | 调 P10 `matchL0Continue` | docs/02 §3 第 2 级；P10 工单 |
| L1 精确缓存 | `judgeL1CacheKey` + Map | docs/02 §3 第 3 级；P10 工单 |
| 对表层 | `readJudgeTable` + `matchJudgeTable` | docs/02 §3 校准后对表；P10 工单 |
| LLM 主路径 | `renderJudgePrompt` + `streamCeLlm` | docs/02 §3 第 4 级；docs/10 §1 H12；P5/P10 工单 |
| fail-lazy 兜底 | error-fallback + `FAIL_LAZY_JUDGE_DECISION` | docs/02 §3 第 5 级；docs/05 条文 8 |
| 卷宗追加 | `appendDossierMessage` + P3 `putEntity` | docs/02 §2；docs/09 §2；P9/P3 工单 |
| 判别事实发射 | `judge-facts.ts` + `emitCeFact` | docs/02 §6；docs/09 §1；docs/10 §1 H14 |
| auto 开关 | `src/config.ts` + `client/field-model.ts` | docs/11 §6；docs/11 §5 对应律 |
| 事实流接入 | `platform/events.ts` `'facts/session-event'` | docs/12 §2–§3；P1 工单 §8.3 |
| 自动化验收 | `scripts/verify-p12.mjs` | 总纲 §2 铁律 2 + §5 全机械验收 |

4. **后续计划修正已回写**：§8.2 的 P13 T0 同源、P14b `optimize_artifact:latest:<workspace>` 指针与
   `judgeTable` 契约、不可变禁区是否已核对并落笔。

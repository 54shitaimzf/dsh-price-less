/**
 * core/ledger 公共类型（docs/11 §2 core/ledger 行；本地重声明，零 harness import）。
 * 字段与 P1 事件面/H7 形状结构性兼容，core 侧不 import 任何平台/harness 符号。
 */

export interface LedgerSessionEvent {
  type: string
  seq: number
  time: number
  data?: unknown
  [key: string]: unknown
}

/**
 * replace `surfaceOp` 的**端点键名**（线格式单点常量；本仓唯一出处）。
 *
 * 为什么放在 core：表面 fold 是纯重放（`core/ledger/surface.ts`），它**读**的是真实 harness 事件里
 * 透传下来的 `surfaceOp`——写侧（`platform/history.ts`）与读侧必须同名，各留一份必然漂移，
 * 而 core 不能 import platform（S1）。故常量落在中性层，写侧反向 import。
 *
 * 取值随 harness 基线走：`startSeq`/`endSeq` = 上游 ≥ 0.1.5（现行基线 B+）；
 * `start`/`end` = 上游 ≤ 0.1.4。写侧另有 `ReplaceOpAnchor` 把本常量钉在 harness 权威
 * `SurfaceOp` 类型上（编译期，漂移先红）。
 *
 * 历史教训（2026-09-10）：本常量不存在时，读侧硬编码 `start`/`end`，基线一换**静默跳过每一次
 * replace**（被遮蔽节点复活成"可见"）——与 `docs/ledger-history.md` §2578 记载的
 * `foldSurfaceNodes` 静默跳过同型缺陷。见升级 runbook `docs/14`。
 */
export const REPLACE_OP_ENDPOINT_KEYS = { start: 'startSeq', end: 'endSeq' } as const

export interface LedgerFact {
  type: string
  seq?: number
  time: number
  data: unknown
}

export interface TokenUsageLike {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface PricingTable {
  inputPerToken: number
  outputPerToken: number
  cacheReadPerToken: number
  cacheWritePerToken?: number
}

export interface CommonLedger {
  eventCounts: {
    stepStart: number
    stepEnd: number
    assistantMessage: number
    requestHeader: number
    toolCall: number
    toolResult: number
  }
  taskCount: number
  roundsPerTask: number
  tokensPerRound: { inputTokens: number; outputTokens: number } | null
  toolCallsPerTask: number
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    totalTokens: number | null
  }
  compoundedVolume: number
  reDiscoveryTokens: number
  cost: {
    inputCost: number
    outputCost: number
    cacheReadCost: number
    cacheWriteCost: number
    totalCost: number
  } | null
  costPerSuccessfulTask: number | null
}


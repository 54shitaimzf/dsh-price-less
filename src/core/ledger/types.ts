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

/** 固定校准：体积类字段的 token 估算（AGENTS.md 决策点⑤；不进入模型路径）。 */
export const DEFAULT_CHARS_PER_TOKEN = 1.5

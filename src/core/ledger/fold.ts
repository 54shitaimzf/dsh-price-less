/**
 * core/ledger 通用族度量 fold（docs/07 §5 回放管道；docs/11 §2 core/ledger 行）。
 * 纯函数：同输入同账；不注册监听、不写事实、不触碰运行期。
 */
import type { CommonLedger, LedgerFact, LedgerSessionEvent, PricingTable } from './types.ts'
import { DEFAULT_CHARS_PER_TOKEN } from './types.ts'
import { TASK_BOUNDARY_FACT_TYPE, countFactsOfType } from './facts.ts'
export type { CommonLedger } from './types.ts'
export interface FoldOptions {
  facts?: LedgerFact[]
  pricing?: PricingTable
  successfulTaskCount?: number
  charsPerToken?: number
}
/** chars/1.5 向上取整；charsPerToken 可注入测试。 */
export function estimateTokens(text: string, charsPerToken: number = DEFAULT_CHARS_PER_TOKEN): number {
  const divisor = charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN
  return Math.ceil(text.length / divisor)
}

/** tool/result 事件 data → 首块 tool-result 内 text blocks 拼接；坏形状返回空串。 */
export function extractTextFromToolResult(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const root = data as { message?: { content?: unknown }; content?: unknown }
  const message = typeof root.message === 'object' && root.message !== null ? root.message : root
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content) || content.length === 0) return ''
  const block = content[0] as { content?: unknown } | null
  if (!block || typeof block !== 'object' || !Array.isArray(block.content)) return ''
  let text = ''
  for (const part of block.content) {
    if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text') {
      const t = (part as { text?: unknown }).text
      if (typeof t === 'string') text += t
    }
  }
  return text
}

function toolCallIdOfResult(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const root = data as { message?: { content?: unknown }; content?: unknown }
  const message = typeof root.message === 'object' && root.message !== null ? root.message : root
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content) || content.length === 0) return undefined
  const block = content[0] as { toolCallId?: unknown } | null
  return block && typeof block.toolCallId === 'string' ? block.toolCallId : undefined
}

export function foldCommon(events: LedgerSessionEvent[], options: FoldOptions = {}): CommonLedger {
  const facts = options.facts ?? []
  const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  const stepStarts: number[] = []
  const seenCalls = new Set<string>()
  const repeatedCallIds = new Set<string>()
  const results: Array<{ seq: number; text: string; callId?: string }> = []
  const eventCounts = { stepStart: 0, stepEnd: 0, assistantMessage: 0, requestHeader: 0, toolCall: 0, toolResult: 0 }
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  let totalTokens = 0
  let totalTokensMissing = false

  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined
    switch (event.type) {
      case 'step/start':
        eventCounts.stepStart++
        stepStarts.push(event.seq)
        break
      case 'step/end':
        eventCounts.stepEnd++
        break
      case 'assistant/message':
        eventCounts.assistantMessage++
        if (data && typeof data === 'object') {
          const u = data.usage as Record<string, unknown> | undefined
          if (u && typeof u === 'object') {
            usage.inputTokens += Number(u.inputTokens ?? 0)
            usage.outputTokens += Number(u.outputTokens ?? 0)
            usage.cacheReadTokens += Number(u.cacheReadTokens ?? 0)
            usage.cacheWriteTokens += Number(u.cacheWriteTokens ?? 0)
            usage.reasoningTokens += Number(u.reasoningTokens ?? 0)
            if (typeof u.totalTokens === 'number') totalTokens += u.totalTokens
            else totalTokensMissing = true
          } else {
            totalTokensMissing = true
          }
        }
        break
      case 'request/header':
        eventCounts.requestHeader++
        break
      case 'tool/call': {
        eventCounts.toolCall++
        const callId = String(data?.callId ?? '')
        const name = String(data?.name ?? '')
        const args = String(data?.arguments ?? '')
        const key = `${name}\0${args}`
        if (seenCalls.has(key)) repeatedCallIds.add(callId)
        else seenCalls.add(key)
        break
      }
      case 'tool/result':
        eventCounts.toolResult++
        results.push({ seq: event.seq, text: extractTextFromToolResult(data), callId: toolCallIdOfResult(data) })
        break
    }
  }

  const taskCount = Math.max(1, 1 + countFactsOfType(facts, TASK_BOUNDARY_FACT_TYPE))
  const stepStartCount = eventCounts.stepStart
  const totalUsage = {
    ...usage,
    totalTokens: totalTokensMissing ? null : totalTokens,
  }
  let compoundedVolume = 0
  for (const r of results) {
    const laterSteps = stepStarts.filter((seq) => seq > r.seq).length
    compoundedVolume += estimateTokens(r.text, charsPerToken) * Math.max(1, laterSteps)
  }
  let reDiscoveryTokens = 0
  for (const r of results) {
    if (r.callId && repeatedCallIds.has(r.callId)) reDiscoveryTokens += estimateTokens(r.text, charsPerToken)
  }

  let cost: CommonLedger['cost'] = null
  let costPerSuccessfulTask: number | null = null
  if (options.pricing) {
    const p = options.pricing
    const inputCost = usage.cacheReadTokens * p.cacheReadPerToken + Math.max(0, usage.inputTokens - usage.cacheReadTokens) * p.inputPerToken
    const outputCost = usage.outputTokens * p.outputPerToken
    const cacheReadCost = usage.cacheReadTokens * p.cacheReadPerToken
    const cacheWriteCost = usage.cacheWriteTokens * (p.cacheWritePerToken ?? 0)
    const totalCost = inputCost + outputCost + cacheWriteCost
    cost = { inputCost, outputCost, cacheReadCost, cacheWriteCost, totalCost }
    if (typeof options.successfulTaskCount === 'number' && Number.isInteger(options.successfulTaskCount) && options.successfulTaskCount > 0) {
      costPerSuccessfulTask = totalCost / options.successfulTaskCount
    }
  }

  return {
    eventCounts,
    taskCount,
    roundsPerTask: stepStartCount / taskCount,
    tokensPerRound: stepStartCount === 0 ? null : {
      inputTokens: usage.inputTokens / stepStartCount,
      outputTokens: usage.outputTokens / stepStartCount,
    },
    toolCallsPerTask: eventCounts.toolCall / taskCount,
    usage: totalUsage,
    compoundedVolume,
    reDiscoveryTokens,
    cost,
    costPerSuccessfulTask,
  }
}

/** 07 §6 报表模板子集：通用族 + 成本段（机制/断裂/误伤段留后续工单扩展）。 */
export function formatLedgerReport(ledger: CommonLedger, meta: { id?: string } = {}): string {
  const lines: string[] = [`== batch ${meta.id ?? 'unknown'} ==`, '通用：']
  lines.push(`  roundsPerTask: ${ledger.roundsPerTask}`)
  lines.push(`  tokensPerRound: ${ledger.tokensPerRound ? `${ledger.tokensPerRound.inputTokens}/${ledger.tokensPerRound.outputTokens}` : 'null'}`)
  lines.push(`  toolCallsPerTask: ${ledger.toolCallsPerTask}`)
  lines.push(`  compoundedVolume: ${ledger.compoundedVolume}`)
  lines.push(`  reDiscoveryTokens: ${ledger.reDiscoveryTokens}`)
  lines.push('成本：')
  if (ledger.cost) {
    lines.push(`  inputCost: ${ledger.cost.inputCost}`)
    lines.push(`  outputCost: ${ledger.cost.outputCost}`)
    lines.push(`  cacheReadCost: ${ledger.cost.cacheReadCost}`)
    lines.push(`  cacheWriteCost: ${ledger.cost.cacheWriteCost}`)
    lines.push(`  totalCost: ${ledger.cost.totalCost}`)
    lines.push(`  costPerSuccessfulTask: ${ledger.costPerSuccessfulTask}`)
  } else {
    lines.push('  cost: null')
    lines.push(`  costPerSuccessfulTask: ${ledger.costPerSuccessfulTask}`)
  }
  return lines.join('\n')
}

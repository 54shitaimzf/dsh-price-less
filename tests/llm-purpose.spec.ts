/**
 * llm-purpose 契约锚（docs/12 §1 C2）——宿主 purpose 未宽化前，插件侧适配单点。
 * 本 spec 锁住：purpose 词汇冻结、toHarnessGenerateOptions 是唯一收窄点、
 * llm 服务解析 fail-lazy（未装配 → undefined，不抛）。
 * P5 追加调用面断言：streamCeLlm 透传、usage 回执、服务缺失终止块。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  CE_AUX_PURPOSES,
  resolveLlmService,
  streamCeLlm,
  toCeLlmUsage,
  toHarnessGenerateOptions,
  type CeGenerateOptions,
  type CeLlmUsage,
  type CeLlmUsageReceipt,
} from '../src/platform/llm.ts'
import type { TokenUsageLike } from '../src/core/ledger/types.ts'

describe('辅助调用 purpose 契约锚（12 §1 C2）', () => {
  it('purpose 词汇冻结：三个域各一值，且只作为本地宽化存在', () => {
    expect(CE_AUX_PURPOSES).toEqual([
      'context-economy-judge',
      'context-economy-optimize',
      'context-economy-compaction',
    ])
  })

  it('宽化选项经单点收窄后逐字段保留（custom purpose 可进入宿主类型面）', () => {
    const options: CeGenerateOptions = {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: [],
      purpose: 'context-economy-judge',
    }
    const harnessOptions = toHarnessGenerateOptions(options)
    expect(harnessOptions).toEqual(options)
  })

  it('resolveLlmService：未装配 → undefined（fail-lazy 前提），有服务 → 原样返回', () => {
    expect(resolveLlmService({} as Context)).toBeUndefined()
    const service = { stream: async function* () {} }
    expect(resolveLlmService({ llm: service } as never)).toBe(service)
  })
})

describe('P5 辅助调用端口（streamCeLlm / toCeLlmUsage）', () => {
  const baseOptions = (purpose: CeGenerateOptions['purpose'] = 'context-economy-optimize'): CeGenerateOptions => ({
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    messages: [],
    purpose,
  })

  it('toCeLlmUsage 全字段：原样搬运且输出为新对象', () => {
    const source: TokenUsage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5, reasoningTokens: 6 }
    const usage = toCeLlmUsage(source)
    expect(usage).toEqual(source)
    expect(usage).not.toBe(source)
    usage.inputTokens = 99
    expect(source.inputTokens).toBe(1)
  })

  it('toCeLlmUsage 最小字段：可选键缺失时省略', () => {
    const usage = toCeLlmUsage({ inputTokens: 1, outputTokens: 2 })
    expect(usage).toEqual({ inputTokens: 1, outputTokens: 2 })
    expect(Object.hasOwn(usage, 'totalTokens')).toBe(false)
    expect(Object.hasOwn(usage, 'cacheReadTokens')).toBe(false)
    expect(Object.hasOwn(usage, 'cacheWriteTokens')).toBe(false)
    expect(Object.hasOwn(usage, 'reasoningTokens')).toBe(false)
  })

  it('streamCeLlm 透传全部流块并单次回执 usage', async () => {
    const text: StreamChunk = { type: 'text-delta', index: 0, text: 'hi' }
    const usageChunk: StreamChunk = { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 7, reasoningTokens: 2 } }
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
    const service = { stream: async function* () { yield text; yield usageChunk; yield finish } }
    const received: StreamChunk[] = []
    const receipts: CeLlmUsageReceipt[] = []
    for await (const chunk of streamCeLlm({ llm: service } as never, baseOptions(), {
      onUsage: (receipt) => receipts.push(receipt),
    })) {
      received.push(chunk)
    }
    expect(received).toStrictEqual([text, usageChunk, finish])
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toEqual({
      purpose: 'context-economy-optimize',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        cacheReadTokens: 5,
        cacheWriteTokens: 7,
        reasoningTokens: 2,
      },
    })
  })

  it('streamCeLlm custom purpose 进入宿主 GenerateOptions', async () => {
    let captured: GenerateOptions | undefined
    const service = { stream: async function* (options: GenerateOptions) { captured = options; yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk } }
    const received: StreamChunk[] = []
    for await (const chunk of streamCeLlm({ llm: service } as never, baseOptions('context-economy-compaction'))) {
      received.push(chunk)
    }
    expect(captured?.purpose).toBe('context-economy-compaction')
    expect(received).toHaveLength(1)
  })

  it('streamCeLlm 服务缺失：yield CE_LLM_UNAVAILABLE 终止块且不回调', async () => {
    const received: StreamChunk[] = []
    const receipts: CeLlmUsageReceipt[] = []
    const warns: unknown[][] = []
    for await (const chunk of streamCeLlm({} as never, baseOptions(), {
      onUsage: (receipt) => receipts.push(receipt),
      logger: { warn: (...args: unknown[]) => { warns.push(args) } },
    })) {
      received.push(chunk)
    }
    expect(received).toHaveLength(1)
    expect(received[0]).toStrictEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'context-economy: llm service unavailable (fail-lazy)', code: 'CE_LLM_UNAVAILABLE' } },
    } satisfies StreamChunk)
    expect(receipts).toHaveLength(0)
    expect(warns).toHaveLength(1)
  })

  it('streamCeLlm 重复 usage 只回执一次且两块都透传', async () => {
    const usageA: StreamChunk = { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }
    const usageB: StreamChunk = { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
    const service = { stream: async function* () { yield usageA; yield usageB; yield finish } }
    const received: StreamChunk[] = []
    const receipts: CeLlmUsageReceipt[] = []
    for await (const chunk of streamCeLlm({ llm: service } as never, baseOptions(), {
      onUsage: (receipt) => receipts.push(receipt),
    })) {
      received.push(chunk)
    }
    expect(received).toStrictEqual([usageA, usageB, finish])
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.usage.inputTokens).toBe(1)
  })

  it('streamCeLlm 无 usage 不回执', async () => {
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
    const service = { stream: async function* () { yield finish } }
    const receipts: CeLlmUsageReceipt[] = []
    for await (const chunk of streamCeLlm({ llm: service } as never, baseOptions(), {
      onUsage: (receipt) => receipts.push(receipt),
    })) {
      expect(chunk).toBe(finish)
    }
    expect(receipts).toHaveLength(0)
  })

  it('类型兼容：CeLlmUsage 可赋给 core TokenUsageLike', () => {
    const u: CeLlmUsage = { inputTokens: 1, outputTokens: 2 }
    const like: TokenUsageLike = u
    expect(like.inputTokens).toBe(1)
  })
})

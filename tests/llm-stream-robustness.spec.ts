/**
 * streamCeLlm 鲁棒性（P5.1 工单 §3.2，经 P6.1 执行）：锁住两项语义——
 * ① onUsage 抛错只 warn 不外溢（不中断辅助 LLM 流）；② 消费者提前 break：
 * usage 未到不回执，且内层流被关闭。全部 fake，零 cordis 运行时 import。
 */
import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { CE_LLM_TIMEOUT_CODE, streamCeLlm, type CeLlmUsageReceipt } from '../src/platform/llm.ts'

const baseOptions = () => ({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  messages: [],
})

describe('streamCeLlm 鲁棒性（P5.1）', () => {
  it('onUsage 抛错只 warn 不外溢：全部流块（含 usage）照常透传', async () => {
    const text: StreamChunk = { type: 'text-delta', index: 0, text: 'hi' }
    const usageChunk: StreamChunk = { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
    const service = { stream: async function* () { yield text; yield usageChunk; yield finish } }
    const received: StreamChunk[] = []
    const warns: unknown[][] = []
    for await (const chunk of streamCeLlm({ llm: service } as never, baseOptions(), {
      onUsage: () => { throw new Error('ledger boom') },
      logger: { warn: (...args: unknown[]) => { warns.push(args) } },
    })) {
      received.push(chunk)
    }
    expect(received).toStrictEqual([text, usageChunk, finish])
    expect(warns).toHaveLength(1)
    expect(String(warns[0]?.[0])).toContain('context-economy: llm usage receipt callback failed (contained)')
    expect(String(warns[0]?.[1])).toBe('ledger boom')
  })

  it('消费者提前 break：usage 未到不回执，且内层流被关闭', async () => {
    let closed = false
    const service = {
      stream: async function* () {
        try {
          yield { type: 'text-delta', index: 0, text: 'hi' }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } } as StreamChunk
        } finally {
          closed = true
        }
      },
    }
    const receipts: CeLlmUsageReceipt[] = []
    const it = streamCeLlm({ llm: service } as never, baseOptions(), {
      onUsage: (receipt) => receipts.push(receipt),
    })[Symbol.asyncIterator]()
    const first = await it.next()
    expect(first.done).toBe(false)
    expect(first.value).toStrictEqual({ type: 'text-delta', index: 0, text: 'hi' })
    const done = await it.return()
    expect(done.done).toBe(true)
    expect(receipts).toHaveLength(0)
    expect(closed).toBe(true)
  })
})

describe('streamCeLlm 硬超时（U10）', () => {
  it('永不产出任何块 + timeoutMs=20 → 及时收到 CE_LLM_TIMEOUT 终止块（宿主不响应 signal 也照样结束）', async () => {
    let hostSignal: AbortSignal | undefined
    const service = {
      stream: (options: { signal?: AbortSignal }) => {
        hostSignal = options.signal
        return (async function* () { await new Promise(() => {}) })()
      },
    }
    const started = Date.now()
    const chunks: StreamChunk[] = []
    for await (const chunk of streamCeLlm({ llm: service } as never, baseOptions(), { timeoutMs: 20 })) chunks.push(chunk)
    const elapsed = Date.now() - started
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      type: 'finish', reason: { kind: 'error', failure: { code: CE_LLM_TIMEOUT_CODE } },
    })
    expect(elapsed).toBeLessThan(1_000)
    // 同时 abort 宿主请求（宿主真响应 signal 就能真正释放连接）
    expect(hostSignal?.aborted).toBe(true)
  })

  it('调用方自带 signal 被转发：已中止 → 传给宿主的 signal 也是中止态', async () => {
    let hostSignal: AbortSignal | undefined
    const service = {
      stream: (options: { signal?: AbortSignal }) => {
        hostSignal = options.signal
        return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk })()
      },
    }
    const controller = new AbortController()
    controller.abort()
    const chunks: StreamChunk[] = []
    for await (const chunk of streamCeLlm({ llm: service } as never, { ...baseOptions(), signal: controller.signal } as never, { timeoutMs: 5_000 })) chunks.push(chunk)
    expect(chunks).toHaveLength(1)
    expect(hostSignal?.aborted).toBe(true)
  })
})

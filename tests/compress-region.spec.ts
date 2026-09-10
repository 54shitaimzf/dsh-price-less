/**
 * P19a 区间转写单测（docs/implement/archive/P19-boundary-path.md §5；docs/04 §2）。
 * 覆盖：四类表面节点转写 / 被遮蔽节点不入正文 / 区间过滤 / 坏形状不抛错 / 字节稳定 / 体量计量。
 */
import { describe, expect, it } from 'vitest'
import { expectedReplaceOp } from './replace-op.ts'
import { estimateTokens, flatDensity } from '../src/core/meter/index.ts'
import { REGION_TRANSCRIPT_VERSION, regionTokens, renderRegionTranscript, surfaceEventsInRange } from '../src/core/compress/index.ts'
import type { LedgerSessionEvent } from '../src/core/ledger/types.ts'

const user = (seq: number, text: string): LedgerSessionEvent => ({
  type: 'user/message', seq, time: seq, data: { content: [{ type: 'text', text }] }, surfaceOp: 'append',
})
const assistant = (seq: number, text: string): LedgerSessionEvent => ({
  type: 'assistant/message', seq, time: seq, data: { message: { content: [{ type: 'text', text }] } }, surfaceOp: 'append',
})
const call = (seq: number, name: string, callId: string, args: unknown): LedgerSessionEvent => ({
  type: 'tool/call', seq, time: seq, data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) }, surfaceOp: 'append',
})
const result = (seq: number, callId: string, text: string): LedgerSessionEvent => ({
  type: 'tool/result', seq, time: seq,
  data: { message: { content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } },
  surfaceOp: 'append',
})

describe('P19a 区间转写', () => {
  it('四类节点机械表头 + 逐字正文（transcript 序）', () => {
    const events = [
      user(0, '做 A'),
      assistant(1, '好的'),
      call(2, 'read', 'c1', { file_path: 'a.ts' }),
      result(3, 'c1', '1: old'),
    ]
    const text = renderRegionTranscript(events, { startSeq: 0, endSeq: 3 })
    expect(text).toBe([
      '[0] user/message\n做 A',
      '[1] assistant/message\n好的',
      '[2] tool/call read c1\n{"file_path":"a.ts"}',
      '[3] tool/result c1\n1: old',
    ].join('\n\n'))
    expect(REGION_TRANSCRIPT_VERSION).toBe(1)
  })

  it('被 replace 遮蔽的节点不入正文；区间端点含端点', () => {
    const events = [
      user(0, '旧'),
      user(1, '新'),
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '替换' }] }, surfaceOp: expectedReplaceOp(0, 0) } as LedgerSessionEvent,
    ]
    expect(renderRegionTranscript(events, { startSeq: 0, endSeq: 2 })).toBe('[1] user/message\n新\n\n[2] user/message\n替换')
    expect(surfaceEventsInRange(events, { startSeq: 1, endSeq: 1 }).map((e) => e.seq)).toEqual([1])
  })

  it('非表面事件类型跳过；坏形状不抛错', () => {
    const events = [
      { type: 'step/start', seq: 0, time: 0, data: {} } as LedgerSessionEvent,
      { type: 'user/message', seq: 1, time: 1, data: null, surfaceOp: 'append' } as LedgerSessionEvent,
      result(2, 'c9', ''),
    ]
    const text = renderRegionTranscript(events, { startSeq: 0, endSeq: 2 })
    expect(text).toBe('[1] user/message\n\n\n[2] tool/result c9\n')
  })

  it('体量计量按 policy cpt；双跑逐字节一致', () => {
    const events = [user(0, 'x'.repeat(30))]
    const text = renderRegionTranscript(events, { startSeq: 0, endSeq: 0 })
    expect(text).toBe(`[0] user/message\n${'x'.repeat(30)}`)
    expect(regionTokens(events, { startSeq: 0, endSeq: 0 })).toBe(estimateTokens(text))
    expect(regionTokens(events, { startSeq: 0, endSeq: 0 }, { version: 1, density: flatDensity(3), maxUnitListEntries: 0 })).toBe(Math.ceil(text.length / 3))
    expect(renderRegionTranscript(events, { startSeq: 0, endSeq: 0 })).toBe(text)
  })
})

/**
 * P6 改史端口单测（docs/implement/archive/P6-history.md §3.2）——全部 fake session，
 * 零 cordis 运行时/零真 harness 依赖。覆盖：
 * H4 replace 的 sourceEventSeqs 自动补全与合并、assistant 禁源、非法区间；
 * H5 begin/end 事务与防重入、ID/turn 校验；compaction/prune 影子计价；
 * 配对平衡守卫（注入 checker）与边界收缩。
 */
import { describe, expect, it } from 'vitest'
import type { Session, SessionEventMap, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  HistoryError,
  createHistoryPort,
  type PairBalanceChecker,
} from '../src/platform/history.ts'

interface FakeEvent {
  type: string
  seq: number
  time: number
  data: any
  surfaceOp?: any
  sourceEventSeqs?: unknown
}

class FakeSession {
  readonly events: FakeEvent[] = []
  nodes: number[] = []
  appended: Array<{ type: string; data: unknown; opts?: unknown }> = []

  get surface(): { nodes: SessionSeq[] } {
    return { nodes: this.nodes as unknown as SessionSeq[] }
  }

  append(type: string, data: unknown, opts?: unknown): FakeEvent {
    this.appended.push({ type, data, opts })
    const event: FakeEvent = { type, seq: this.events.length, time: 1000 + this.events.length, data }
    if (opts && typeof opts === 'object') {
      const o = opts as { surfaceOp?: unknown; sourceEventSeqs?: unknown }
      if (o.surfaceOp !== undefined) event.surfaceOp = o.surfaceOp
      if (o.sourceEventSeqs !== undefined) event.sourceEventSeqs = o.sourceEventSeqs
    }
    this.events.push(event)
    if (event.surfaceOp === 'append') this.nodes.push(event.seq)
    if (event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
      const start = event.surfaceOp.start as number
      const end = event.surfaceOp.end as number
      const si = this.nodes.indexOf(start)
      const ei = this.nodes.indexOf(end)
      if (si !== -1 && ei !== -1 && si <= ei) {
        this.nodes.splice(si, ei - si + 1, event.seq)
      }
    }
    return event
  }

  eventAt(seq: number): FakeEvent | undefined {
    return this.events[seq]
  }

  snapshotEvents(): readonly FakeEvent[] {
    return this.events.slice()
  }
}

const seq = (n: number): SessionSeq => n as unknown as SessionSeq

function catchCode(fn: () => unknown): HistoryError | undefined {
  try { fn(); return undefined } catch (e) { return e as HistoryError }
}

function makeSession(nodes: number[] = []): FakeSession {
  const s = new FakeSession()
  for (const n of nodes) {
    const type = n === 1 ? 'user/message' : n % 2 === 0 ? 'tool/result' : 'assistant/message'
    s.append(type, { turn: 1, step: 1, message: { content: [] } } as never)
    // append 已把非 surface 事件（assistant? assistant is surface) push；这里按 nodes 强制重建
  }
  // append 在构造时按事件是否 surface 自动 push；对 nodes 显式重置以精确模拟表面序
  s.nodes = [...nodes]
  return s
}

function makePort(session: FakeSession, checker?: PairBalanceChecker) {
  return createHistoryPort(session as unknown as Session, checker ? { balanceChecker: checker } : {})
}

describe('H4 surfaceOp replace（docs/10 §1 H4；docs/04 §1）', () => {
  it('自动补全 sourceEventSeqs = 被遮蔽表面节点，返回 replace 事件与 shadowedSeqs', () => {
    const session = makeSession([1, 2, 3])
    const port = makePort(session)
    const result = port.replaceSurface({
      type: 'user/message',
      data: { id: 's', role: 'user', content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' } } as never,
      range: { start: seq(2), end: seq(3) },
    })
    expect(result.shadowedSeqs.map(Number)).toEqual([2, 3])
    expect(result.event.surfaceOp).toEqual({ op: 'replace', start: seq(2), end: seq(3) })
    expect((result.event as FakeEvent & { sourceEventSeqs?: unknown }).sourceEventSeqs).toEqual([2, 3])
    expect(session.nodes.map(Number)).toEqual([1, 3])
  })

  it('额外 sourceEventSeqs 与被遮蔽集合合并、去重、升序', () => {
    const session = makeSession([1, 2, 3])
    const port = makePort(session)
    const result = port.replaceSurface({
      type: 'tool/result',
      data: { turn: 1, step: 1, message: { content: [] } } as never,
      range: { start: seq(2), end: seq(3) },
      sourceEventSeqs: [seq(1), seq(3)],
    })
    expect((result.event as FakeEvent & { sourceEventSeqs?: unknown }).sourceEventSeqs).toEqual([1, 2, 3])
  })

  it('非法区间：start/end 不在当前表面或顺序颠倒 → INVALID_RANGE', () => {
    const session = makeSession([1, 2, 3])
    const port = makePort(session)
    expect(() => port.replaceSurface({
      type: 'user/message',
      data: {} as never,
      range: { start: seq(9), end: seq(3) },
    })).toThrowError(HistoryError)
    expect(() => port.replaceSurface({
      type: 'user/message',
      data: {} as never,
      range: { start: seq(3), end: seq(1) },
    })).toThrowError(/INVALID_RANGE/)
  })

  it('assistant/message 禁止携带 sourceEventSeqs（harness 类型契约）', () => {
    const session = makeSession([1])
    const port = makePort(session)
    expect(() => port.replaceSurface({
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [] }, stream: [] } as never,
      range: { start: seq(1), end: seq(1) },
      sourceEventSeqs: [seq(0)],
    })).toThrowError(/ASSISTANT_SOURCE_SEQS/)
  })
})

describe('H5 compaction 事务（docs/10 §1 H5；docs/04 §1）', () => {
  it('begin → 日志出现 compaction/start；再次 begin 防重入', () => {
    const session = makeSession([])
    const port = makePort(session)
    const start = port.beginCompaction({ compactionId: 'c1', turn: null })
    expect(start.type).toBe('compaction/start')
    expect((start.data as { compactionId: string }).compactionId).toBe('c1')
    expect(port.findActiveCompaction()).toMatchObject({ compactionId: 'c1', turn: null })
    expect(() => port.beginCompaction({ compactionId: 'c2', turn: null })).toThrowError(/COMPACTION_ACTIVE/)
  })

  it('end 需要匹配活动事务 ID 与 turn；成功后无活动事务', () => {
    const session = makeSession([])
    const port = makePort(session)
    port.beginCompaction({ compactionId: 'c1', turn: 1 })
    expect(() => port.endCompaction({ compactionId: 'c2', turn: 1 })).toThrowError(/COMPACTION_ID_MISMATCH/)
    expect(() => port.endCompaction({ compactionId: 'c1', turn: null })).toThrowError(/COMPACTION_TURN_MISMATCH/)
    const end = port.endCompaction({ compactionId: 'c1', turn: 1 })
    expect(end.type).toBe('compaction/end')
    expect(port.findActiveCompaction()).toBeUndefined()
    expect(() => port.assertNoActiveCompaction()).not.toThrow()
  })

  it('从既有日志扫描活动事务：启动/恢复后可防重入', () => {
    const session = makeSession([])
    session.append('compaction/start', { compactionId: 'c-old', turn: null })
    const port = makePort(session)
    expect(port.findActiveCompaction()).toMatchObject({ compactionId: 'c-old', turn: null })
    expect(() => port.beginCompaction({ compactionId: 'c-new', turn: null })).toThrowError(/COMPACTION_ACTIVE/)
  })

  it('recordPrune 自动携带被遮蔽集合（compaction/prune 影子计价）', () => {
    const session = makeSession([1, 2, 3])
    const port = makePort(session)
    const prune = port.recordPrune({ start: seq(2), end: seq(3), shadowedTokenCount: 120 })
    expect(prune.type).toBe('compaction/prune')
    expect(prune.data).toMatchObject({
      shadowedRange: { start: seq(2), end: seq(3) },
      shadowedSeqs: [2, 3],
      shadowedTokenCount: 120,
    })
  })
})

describe('P19a 压缩检查点提交（docs/04 §1 + docs/10 §1 H4 紧邻契约）', () => {
  it('summary 紧邻 checkpoint 替换：官方 source + sourceEventSeqs 含事务起点与摘要', () => {
    const session = makeSession([1, 2, 3])
    const port = makePort(session)
    port.beginCompaction({ compactionId: 'c1', turn: 3 })
    const result = port.commitCheckpoint({
      compactionId: 'c1',
      text: '档案块正文',
      summary: '摘要原文',
      range: { start: seq(2), end: seq(3) },
      shadowedTokenCount: 120,
      provider: 'deepseek-official',
      model: 'm',
      usage: { inputTokens: 10, outputTokens: 2 },
      rawOutput: '原始输出',
    })
    expect(result.summaryEvent.type).toBe('compaction/summary')
    expect(result.summaryEvent.data).toMatchObject({
      compactionId: 'c1',
      summary: [{ type: 'text', text: '摘要原文' }],
      shadowedRange: { start: seq(2), end: seq(3) },
      shadowedSeqs: [2, 3],
      shadowedTokenCount: 120,
      provider: 'deepseek-official',
      model: 'm',
      usage: { inputTokens: 10, outputTokens: 2 },
      rawOutput: [{ type: 'text', text: '原始输出' }],
    })
    expect(result.landed.shadowedSeqs.map(Number)).toEqual([2, 3])
    expect(result.landed.event.type).toBe('user/message')
    expect((result.landed.event as unknown as { sourceEventSeqs: number[] }).sourceEventSeqs).toEqual([2, 3, 4])
    expect(result.landed.event.surfaceOp).toEqual({ op: 'replace', start: seq(2), end: seq(3) })
    const source = (result.landed.event.data as { source: { plugin?: string; compactionId?: string } }).source
    expect(source.plugin).toBe('compact')
    expect(source.compactionId).toBe('c1')
  })

  it('无活动事务 / ID 不符 → 拒绝（不产生半截替换）', () => {
    const session = makeSession([1, 2])
    const port = makePort(session)
    const input = { compactionId: 'c1', text: 't', summary: 's', range: { start: seq(1), end: seq(2) }, shadowedTokenCount: 1, provider: 'p', model: 'm' }
    expect(catchCode(() => port.commitCheckpoint(input))?.code).toBe('NO_ACTIVE_COMPACTION')
    port.beginCompaction({ compactionId: 'c-other', turn: null })
    expect(catchCode(() => port.commitCheckpoint(input))?.code).toBe('COMPACTION_ID_MISMATCH')
  })
})

describe('配对平衡守卫（docs/04 §1 / docs/05 守卫表）', () => {
  it('balanceRange 收缩到最近平衡边界；无平衡点返回 null', () => {
    const session = makeSession([1, 2, 3, 4, 5])
    const beforeFalse = new Set([1, 3])
    const afterFalse = new Set([2, 5])
    const checker: PairBalanceChecker = {
      before: (_s, x) => !beforeFalse.has(Number(x)),
      after: (_s, x) => !afterFalse.has(Number(x)),
    }
    const port = makePort(session, checker)
    const balanced = port.balanceRange({ start: seq(1), end: seq(5) })
    expect(balanced?.start).toBe(seq(2))
    expect(balanced?.end).toBe(seq(4))

    const none = port.balanceRange({ start: seq(3), end: seq(3) })
    expect(none).toBeNull()
  })

  it('pairBalancedBefore/After 委托注入守卫', () => {
    const session = makeSession([1, 2, 3])
    const checker: PairBalanceChecker = {
      before: (_s, x) => Number(x) === 1,
      after: (_s, x) => Number(x) === 3,
    }
    const port = makePort(session, checker)
    expect(port.pairBalancedBefore(seq(1))).toBe(true)
    expect(port.pairBalancedBefore(seq(2))).toBe(false)
    expect(port.pairBalancedAfter(seq(3))).toBe(true)
  })
})

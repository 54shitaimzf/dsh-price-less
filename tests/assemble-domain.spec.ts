/**
 * P17b 装配域单测（工单 §5）——fake pump + FakeSession + fake FilesPort，零 cordis 运行时。
 * 覆盖：通道 A 端到端（重映射 + 盘上取真）/ 通道 B / fs 缺失降级 / 事实发射 / 范围过滤 /
 * digest fatal 不发事实 / 共享事务原语（开闭配对、防重入、失败带 error 收尾、顺序校验）。
 */
import { describe, expect, it } from 'vitest'
import { replaceEndpoints } from './replace-op.ts'
import { mountAssembleDomain, runCompactionTxn } from '../src/domains/assemble.ts'
import { ASSEMBLE_RUN_FACT_TYPE } from '../src/domains/assemble-facts.ts'
import { planTxn } from '../src/core/assemble/txn.ts'
import type { HotTailDecl } from '../src/core/assemble/types.ts'
import { createHistoryPort, type HistoryPort } from '../src/platform/history.ts'
import type { FilesPort } from '../src/platform/files.ts'
import { ignorableChannelAvailable } from '../src/platform/ignorable-channel.ts'

// 测试进程内强制走 ignorable 通道直发路径（事实经 session.append 落 FakeSession）。
ignorableChannelAvailable({ SESSION_LOG_INTENT: 1 })

interface FakeEvent { type: string; seq: number; time: number; data: any; surfaceOp?: any; sourceEventSeqs?: unknown; ignorable?: true }

class FakeSession {
  readonly events: FakeEvent[] = []
  nodes: number[] = []
  generation = 0
  readonly header: { id: string; origin?: string } = { id: 's1' }
  readonly appends: Array<{ type: string; data: any; opts?: any }> = []
  get surface() { return { nodes: this.nodes, replaceGeneration: this.generation } }
  append(type: string, data: any, opts?: any): FakeEvent {
    this.appends.push({ type, data, opts })
    const event: FakeEvent = { type, seq: this.events.length, time: 1000 + this.events.length, data }
    if (opts?.surfaceOp !== undefined) event.surfaceOp = opts.surfaceOp
    if (opts?.sourceEventSeqs !== undefined) event.sourceEventSeqs = opts.sourceEventSeqs
    if (opts?.ignorable === true) event.ignorable = true
    this.events.push(event)
    if (event.surfaceOp === 'append') this.nodes.push(event.seq)
    else {
      const span = replaceEndpoints(event.surfaceOp)
      if (span !== undefined) {
        const si = this.nodes.indexOf(span.start)
        const ei = this.nodes.indexOf(span.end)
        if (si >= 0 && ei >= si) { this.nodes.splice(si, ei - si + 1, event.seq); this.generation++ }
      }
    }
    return event
  }
  snapshotEvents(): readonly FakeEvent[] { return this.events.slice() }
}

const textBlock = (text: string) => ({ type: 'text', text })

function makeEnv(options: { files?: FilesPort } = {}) {
  const pumpHandlers = new Map<string, Set<(payload: any) => void>>()
  const pump = {
    on(kind: string, fn: (payload: any) => void) {
      const set = pumpHandlers.get(kind) ?? new Set()
      set.add(fn)
      pumpHandlers.set(kind, set)
      return () => set.delete(fn)
    },
    dispose() {},
    stats() { return { enqueued: 0, dispatched: 0, listenerErrors: 0, dropped: 0, depth: 0 } },
  }
  const session = new FakeSession()
  const domain = mountAssembleDomain({
    pump: pump as never,
    logger: { info() {}, warn() {}, error() {} },
    ...(options.files === undefined ? {} : { getFiles: () => options.files }),
    now: () => 1000,
  })
  const emitEvent = (event: FakeEvent): void => {
    for (const fn of pumpHandlers.get('metrics/session-event') ?? []) fn({ session, event })
  }
  const appendCall = (callId: string, name: string, args: unknown): FakeEvent => {
    const event = session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
    emitEvent(event)
    return event
  }
  const appendResult = (callId: string, text: string, meta?: unknown): FakeEvent => {
    const event = session.append('tool/result', {
      turn: 1, step: 1,
      message: { id: `t${session.events.length}`, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [textBlock(text)] }] },
      ...(meta === undefined ? {} : { meta }),
    }, { surfaceOp: 'append' })
    emitEvent(event)
    return event
  }
  const readMeta = (path: string, lines: string[]) => ({
    path, offset: 1, lines: lines.map((text, index) => ({ number: index + 1, text })), totalLines: lines.length,
  })
  return { session, domain, appendCall, appendResult, readMeta }
}

const filesWith = (map: Record<string, string[]>): FilesPort => ({
  async readLines(path: string, range?: { start: number; end: number }) {
    const all = map[path]
    if (all === undefined) return null
    if (range === undefined) return { lines: all, totalLines: all.length }
    const start = Math.max(1, range.start)
    const end = Math.min(all.length, range.end)
    if (start > all.length || end < start) return null
    return { lines: all.slice(start - 1, end), totalLines: all.length }
  },
})

const rangeOf = (session: FakeSession) => ({ startSeq: 0, endSeq: session.events.length - 1 })

describe('P17b 装配域：双通道取真', () => {
  it('通道 A：read 窗口 + 后随 edit → 版本重映射 → 盘上取真', async () => {
    const env = makeEnv({ files: filesWith({ 'a.ts': ['old', 'extra'] }) })
    const call = env.appendCall('c1', 'read', { file_path: 'a.ts' })
    env.appendResult('c1', '1: old', env.readMeta('a.ts', ['old']))
    env.appendCall('c2', 'edit', { file_path: 'a.ts', old_string: 'old', new_string: 'old\nextra' })
    env.appendResult('c2', 'The file a.ts has been updated successfully.')
    const outcome = await env.domain.assemble({
      session: env.session as never,
      taskId: 'task-1',
      range: rangeOf(env.session),
      digest: { gist: '目标', steps: [] },
      hotTail: [{ unitId: 'c1', coord: { path: 'a.ts', version: 1, lineRange: { start: 1, end: 1 } } }],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const selection = outcome.result.hotTail.entries[0]!
    expect(selection.source).toBe('file')
    expect(selection.text).toBe('old\nextra')
    expect(selection.clipped).toBe(true)
    expect(outcome.result.hotTail.clipped).toBe(1)
    expect(env.domain.stats().assemblies).toBe(1)
  })

  it('通道 B：无坐标申报 → 取单元原文', async () => {
    const env = makeEnv()
    env.appendCall('c1', 'bash', { command: 'npm test' })
    env.appendResult('c1', '307 tests passed')
    const outcome = await env.domain.assemble({
      session: env.session as never, taskId: 'task-1', range: rangeOf(env.session), hotTail: [{ unitId: 'c1' }],
    })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.entries[0]!.source).toBe('span')
    expect(outcome.result.hotTail.entries[0]!.text).toBe('307 tests passed')
  })

  it('fs 缺失 = 通道 A 丢弃计数 + 兜底照常（不 fatal）', async () => {
    const env = makeEnv()
    env.appendCall('c1', 'read', { file_path: 'a.ts' })
    env.appendResult('c1', '1: old', env.readMeta('a.ts', ['old']))
    const outcome = await env.domain.assemble({
      session: env.session as never, taskId: 'task-1', range: rangeOf(env.session),
      hotTail: [{ unitId: 'c1', coord: { path: 'a.ts', version: 1, lineRange: { start: 1, end: 1 } } }],
    })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.dropped).toBe(1)
    expect(outcome.result.hotTail.source).toBe('positional-fallback')
    expect(outcome.result.hotTail.entries[0]!.source).toBe('span')
    expect(env.domain.stats().degraded).toBe(1)
  })

  it('软门接线：坏形状不抛错 + 只对 accepted 触盘（P17c）', async () => {
    const reads: string[] = []
    const files: FilesPort = {
      async readLines(path: string) { reads.push(path); return { lines: ['a'], totalLines: 1 } },
    }
    const env = makeEnv({ files })
    env.appendCall('c1', 'bash', { command: 'npm test' })
    env.appendResult('c1', 'ok')
    const bad = [null, { unitId: 'c1', coord: null }, { unitId: 'c1' }] as unknown as readonly HotTailDecl[]
    const outcome = await env.domain.assemble({ session: env.session as never, taskId: 'task-1', range: rangeOf(env.session), hotTail: bad })
    if (!outcome.ok) throw new Error('expected ok')
    expect(reads).toEqual([])
    expect(outcome.result.hotTail.dropReasons.badDecl).toBe(2)
    expect(outcome.result.hotTail.entries.length).toBe(1)
  })

  it('priorChain 续传 + archiveTruncate 透传入事实（P17c）', async () => {
    const env = makeEnv()
    env.appendCall('c1', 'bash', { command: 'npm test' })
    env.appendResult('c1', '307 tests passed')
    const outcome = await env.domain.assemble({
      session: env.session as never, taskId: 'task-1', range: rangeOf(env.session), hotTail: [{ unitId: 'c1' }],
      priorChain: [{ taskId: 'task-1', kind: 'checkpoint', text: 'C1' }],
      archiveTruncate: { count: 2, tokens: 700 },
    })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.archiveForm).toEqual({ form: 'chain', checkpointCount: 1 })
    expect(outcome.result.rendered.startsWith('C1\n\n')).toBe(true)
    const fact = env.session.appends.find((entry) => entry.type === ASSEMBLE_RUN_FACT_TYPE)
    expect(fact!.data.archiveTruncateCount).toBe(2)
    expect(fact!.data.archiveTruncateTokens).toBe(700)
    expect(fact!.data.dropReasons).toEqual({ badDecl: 0, unknownUnit: 0, remap: 0, fetch: 0, dup: 0, factReject: 0, error: 0 })
  })

  it('单元清单按范围过滤（供 P18 prompt 枚举）', () => {
    const env = makeEnv()
    env.appendCall('c1', 'read', { file_path: 'a.ts' })
    env.appendResult('c1', '1: old', env.readMeta('a.ts', ['old']))
    const firstEnd = env.session.events.length - 1
    env.appendCall('c2', 'bash', { command: 'npm test' })
    env.appendResult('c2', '307 tests passed')
    expect(env.domain.unitList(env.session as never, { startSeq: 0, endSeq: firstEnd }).map((u) => u.id)).toEqual(['c1'])
    expect(env.domain.unitList(env.session as never, rangeOf(env.session)).map((u) => u.id)).toEqual(['c1', 'c2'])
  })
})

describe('P17b 装配域：事实与失败语义', () => {
  it('装配成功 → assemble-run 事实（压缩族原料）', async () => {
    const env = makeEnv()
    env.appendCall('c1', 'bash', { command: 'npm test' })
    env.appendResult('c1', '307 tests passed')
    const outcome = await env.domain.assemble({
      session: env.session as never, taskId: 'task-1', range: rangeOf(env.session), hotTail: [{ unitId: 'c1' }], layer: 'pressure',
    })
    if (!outcome.ok) throw new Error('expected ok')
    const fact = env.session.appends.find((entry) => entry.type === ASSEMBLE_RUN_FACT_TYPE)
    expect(fact).toBeDefined()
    expect(fact!.opts?.ignorable).toBe(true)
    expect(fact!.data.layer).toBe('pressure')
    expect(fact!.data.hotTailSource).toBe('model')
    expect(fact!.data.hotTailTokens).toBeGreaterThan(0)
    expect(fact!.data.unitCount).toBe(1)
    expect(typeof fact!.data.at).toBe('number')
  })

  it('F9：摘要坏形状 = 机械修复（不 fatal、照常发事实）', async () => {
    const env = makeEnv()
    env.appendCall('c1', 'bash', { command: 'npm test' })
    env.appendResult('c1', '307 tests passed')
    const outcome = await env.domain.assemble({
      session: env.session as never, taskId: 'task-1', range: rangeOf(env.session),
      // 旧 schema（blocks/coords）与未知块型：一律归一为空摘要，不再 fatal。
      digest: { blocks: [{ type: 'bogus' as never, text: 'x' }], coords: [] },
      hotTail: [{ unitId: 'c1' }],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.digest).toEqual({ gist: '', steps: [] })
    const fact = env.session.appends.find((entry) => entry.type === ASSEMBLE_RUN_FACT_TYPE)
    expect(fact).toBeDefined()
    expect(fact!.data.stepCount).toBe(0)
    expect(env.domain.stats().failures).toBe(0)
  })

  it('dispose 后停止服务（不再装配、不发事实）', async () => {
    const env = makeEnv()
    env.appendCall('c1', 'bash', { command: 'npm test' })
    env.appendResult('c1', 'x')
    env.domain.dispose()
    const outcome = await env.domain.assemble({ session: env.session as never, taskId: 'task-1', range: rangeOf(env.session), hotTail: [{ unitId: 'c1' }] })
    expect(outcome).toEqual({ ok: false, reason: 'no-units' })
    expect(env.session.appends.some((entry) => entry.type === ASSEMBLE_RUN_FACT_TYPE)).toBe(false)
  })
})

describe('P17b 共享事务原语执行器', () => {
  const makeSurface = () => {
    const session = new FakeSession()
    session.append('user/message', { content: [] }, { surfaceOp: 'append' })
    session.append('assistant/message', { content: [] }, { surfaceOp: 'append' })
    session.append('tool/result', { content: [] }, { surfaceOp: 'append' })
    return session
  }

  it('open → prune → replace → close 顺序执行', () => {
    const session = makeSurface()
    const history = createHistoryPort(session as never)
    const plan = planTxn({ txnId: 'txn-1', layer: 'boundary', taskId: 'task-1', range: { start: 0, end: 2 }, shadowedTokenCount: 42, replaceKind: 'digest' })
    const result = runCompactionTxn(history, plan, (port: HistoryPort) => {
      // prune 先于 replace：影子计价引用被遮蔽原区间（platform/history 语义）。
      port.recordPrune({ start: 0, end: 2, shadowedTokenCount: 42 })
      port.replaceSurface({ type: 'user/message', data: { content: [] } as never, range: { start: 0, end: 2 } })
    })
    expect(result.ok).toBe(true)
    const types = session.appends.map((entry) => entry.type)
    expect(types).toEqual(['user/message', 'assistant/message', 'tool/result', 'compaction/start', 'compaction/prune', 'user/message', 'compaction/end'])
    expect(session.appends.at(-1)!.data.error).toBeUndefined()
  })

  it('U9：活动事务残留 → 自愈闭合 + 如实报失败；闭合后下一次正常开事务（防会话级永久瘫痪）', () => {
    const session = makeSurface()
    const history = createHistoryPort(session as never)
    history.beginCompaction({ compactionId: 'orphan-1', turn: null })
    const plan = planTxn({ txnId: 'txn-2', layer: 'boundary', taskId: 'task-1', range: { start: 0, end: 2 }, shadowedTokenCount: 1, replaceKind: 'digest' })
    const result = runCompactionTxn(history, plan, () => {})
    expect(result).toMatchObject({ ok: false, code: 'COMPACTION_ACTIVE_ORPHAN_CLOSED' })
    // 残留事务被带 error 闭合（可回放辨认），持锁状态解除
    const closes = session.appends.filter((entry) => entry.type === 'compaction/end')
    expect(closes).toHaveLength(1)
    expect(closes[0]!.data).toMatchObject({ compactionId: 'orphan-1', error: 'orphan-closed' })
    expect(history.findActiveCompaction()).toBeUndefined()
    // 旧行为 = 每次都被 TXN_ACTIVE 拒 → 该会话压缩永久瘫痪；自愈后同一 plan 正常开+闭
    const second = runCompactionTxn(history, plan, () => {})
    expect(second.ok).toBe(true)
    expect(session.appends.filter((entry) => entry.type === 'compaction/start').length).toBe(2)
  })

  it('业务失败 → 带 error 闭合事务（绝不半开标记）', () => {
    const session = makeSurface()
    const history = createHistoryPort(session as never)
    const plan = planTxn({ txnId: 'txn-3', layer: 'pressure', taskId: 'task-1', range: { start: 0, end: 2 }, shadowedTokenCount: 1, replaceKind: 'checkpoint' })
    const result = runCompactionTxn(history, plan, () => { throw new Error('boom') })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('TXN_BODY')
    const end = session.appends.at(-1)!
    expect(end.type).toBe('compaction/end')
    expect(end.data.error).toBe('boom')
    expect(history.findActiveCompaction()).toBeUndefined()
  })

  it('顺序违例 → 拒绝执行（TXN_ORDER）', () => {
    const session = makeSurface()
    const history = createHistoryPort(session as never)
    const plan = { ...planTxn({ txnId: 'txn-4', layer: 'boundary', taskId: 'task-1', range: { start: 0, end: 2 }, shadowedTokenCount: 1, replaceKind: 'digest' }), steps: [{ kind: 'open' as const }, { kind: 'close' as const }] }
    const result = runCompactionTxn(history, plan, () => {})
    expect(result.code).toBe('TXN_ORDER')
    expect(session.appends.some((entry) => entry.type === 'compaction/start')).toBe(false)
  })
})

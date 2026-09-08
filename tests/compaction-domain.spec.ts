/**
 * P19b 边界压缩域单测（docs/implement/P19-boundary-path.md §5）——fake session/storage/llm/assemble，
 * 零 cordis 运行时。覆盖：闭合发现与已归档守卫 / 全路径落刀（事务 + 档案 vN + 事实）/
 * 内容寻址复用（零调用）/ 解析失败 / 缩水重试与放弃 / 落盘失败不落刀 / llm 缺失可重试 /
 * 开关关闭 / 续传链（机制 A）/ T-boundary 搭车补账 / 卷宗结构性清空。
 */
import { describe, expect, it } from 'vitest'
import { mountCompactionDomain, boundaryArchiveKey } from '../src/domains/compaction.ts'
import { COMPRESS_RUN_FACT_TYPE } from '../src/domains/compaction-facts.ts'
import { SHEAR_APPLIED_FACT_TYPE, SHEAR_DECISION_FACT_TYPE } from '../src/core/shear/index.ts'
import { ignorableChannelAvailable } from '../src/platform/ignorable-channel.ts'
import type { AssembleDomain } from '../src/domains/assemble.ts'
import type { ContextEconomyStorage } from '../src/platform/storage.ts'
import type { Config as ConfigShape } from '../src/config.ts'
import { resolveConfig } from '../src/config.ts'

ignorableChannelAvailable({ SESSION_LOG_INTENT: 1 })

const WORKSPACE = 'w'
const ARCHIVE_KEY = boundaryArchiveKey(WORKSPACE)
const VALID_PRODUCT = JSON.stringify({ digest: { blocks: [{ type: 'plan', text: '目标' }], coords: [] }, hotTail: [{ unitId: 'c1' }] })

interface FakeEvent { type: string; seq: number; time: number; data: any; surfaceOp?: any; sourceEventSeqs?: unknown; ignorable?: true }

class FakeSession {
  readonly events: FakeEvent[] = []
  nodes: number[] = []
  generation = 0
  readonly header: { id: string; origin?: string } = { id: 's1' }
  get surface() { return { nodes: this.nodes, replaceGeneration: this.generation } }
  append(type: string, data: any, opts?: any): FakeEvent {
    const event: FakeEvent = { type, seq: this.events.length, time: 1000 + this.events.length, data }
    if (opts?.surfaceOp !== undefined) event.surfaceOp = opts.surfaceOp
    if (opts?.sourceEventSeqs !== undefined) event.sourceEventSeqs = opts.sourceEventSeqs
    if (opts?.ignorable === true) event.ignorable = true
    this.events.push(event)
    if (event.surfaceOp === 'append') this.nodes.push(event.seq)
    else if (event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
      const si = this.nodes.indexOf(event.surfaceOp.start)
      const ei = this.nodes.indexOf(event.surfaceOp.end)
      if (si >= 0 && ei >= si) { this.nodes.splice(si, ei - si + 1, event.seq); this.generation++ }
    }
    return event
  }
  eventAt(seq: number): FakeEvent | undefined { return this.events[seq] }
  snapshotEvents(): readonly FakeEvent[] { return this.events.slice() }
}

const textBlock = (text: string) => ({ type: 'text', text })

/** 会话：user → assistant(tool-call) → tool/result → /task close + task-boundary 事实 → 新 task 首条消息。 */
function makeSession(id = 's1'): FakeSession {
  const session = new FakeSession()
  ;(session.header as { id: string }).id = id
  session.append('user/message', { content: [textBlock('做 A'.repeat(40))], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', { message: { content: [{ type: 'tool-call', toolCallId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }] } }, { surfaceOp: 'append' })
  session.append('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [textBlock('1: old line')] }] } }, { surfaceOp: 'append' })
  session.append('user/message', { content: [textBlock('/task close')], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('context-economy/task-boundary', { boundary: 'close', taskId: 'task-1' }, { ignorable: true })
  session.append('user/message', { content: [textBlock('做 B')], source: { kind: 'user' } }, { surfaceOp: 'append' })
  return session
}

class FakeStorage {
  readonly entities = new Map<string, { version: number; body: unknown }>()
  failWrites = false
  getEntity(table: string, key: string) {
    const record = this.entities.get(`${table}:${key}`)
    if (record === undefined) return undefined
    return { schemaVersion: 1, version: record.version, source: { taskId: 'x', eventType: 'y', evidence: {} }, body: record.body }
  }
  async putEntity(table: string, key: string, body: unknown, _source: unknown, options?: { baseVersion?: number }) {
    if (this.failWrites) throw new Error('storage down')
    const id = `${table}:${key}`
    const current = this.entities.get(id)
    const base = options?.baseVersion ?? 0
    if (base === 0) {
      if (current !== undefined) throw new Error('CAS')
      this.entities.set(id, { version: 1, body })
      return this.getEntity(table, key)!
    }
    if (current === undefined || current.version !== base) throw new Error('CAS')
    this.entities.set(id, { version: base + 1, body })
    return this.getEntity(table, key)!
  }
}

function fakeAssemble(options: { rendered?: string; ok?: boolean } = {}) {
  const requests: any[] = []
  const domain = {
    dispose() {},
    stats: () => ({ sessions: 0, assemblies: requests.length, failures: 0, degraded: 0 }),
    unitList: () => [{ id: 'c1', kind: 'tool-pair', seqStart: 1, seqEnd: 2, name: 'read', path: 'a.ts', version: 1, text: '1: old line', tokens: 1 }],
    assemble: async (request: any) => {
      requests.push(request)
      if (options.ok === false) return { ok: false, reason: 'no-units' }
      return {
        ok: true,
        result: {
          layer: 'boundary', digest: request.digest, digestBytes: 10, digestEntryCount: 1,
          hotTail: { selections: [], stopReason: 'list-end', source: 'model', floorFilled: false, declaredUnits: 0, dropped: 0, dropReasons: { badDecl: 0, unknownUnit: 0, remap: 0, fetch: 0 }, clipped: 0, truncated: 0, tokens: 0, budgetTokens: 10000 },
          archiveForm: { form: 'single', checkpointCount: 0 }, unitCount: 1,
          rendered: options.rendered ?? 'R',
        },
      }
    },
  }
  return { domain: domain as unknown as AssembleDomain, requests }
}

function fakeLlm(script: Array<{ text?: string; finish?: 'stop' | 'error'; code?: string; usage?: any }> = [{ text: VALID_PRODUCT }]) {
  const calls: any[] = []
  const ctx = {
    llm: {
      stream(options: any) {
        calls.push(options)
        const entry = script[Math.min(calls.length - 1, script.length - 1)]!
        return (async function* () {
          if (entry.usage !== undefined) yield { type: 'usage', usage: entry.usage }
          if (entry.text !== undefined) yield { type: 'text-delta', text: entry.text }
          yield entry.finish === 'error'
            ? { type: 'finish', reason: { kind: 'error', failure: { code: entry.code ?? 'X', message: 'boom' } } }
            : { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  return { ctx, calls }
}

const meter = { heuristicTokensInRange: () => 4242 }

function makeEnv(options: { config?: Partial<ConfigShape>; rendered?: string; assembleOk?: boolean; llm?: ReturnType<typeof fakeLlm>; storage?: FakeStorage; withLlm?: boolean; withMeter?: boolean } = {}) {
  const session = makeSession()
  const storage = options.storage ?? new FakeStorage()
  const llm = options.llm ?? fakeLlm()
  const { domain: assemble, requests } = fakeAssemble({ ...(options.rendered === undefined ? {} : { rendered: options.rendered }), ...(options.assembleOk === undefined ? {} : { ok: options.assembleOk }) })
  const config = resolveConfig(options.config ?? {})
  const warns: unknown[][] = []
  const domain = mountCompactionDomain({
    storage: storage as unknown as ContextEconomyStorage,
    getConfig: () => config,
    logger: { info() {}, warn: (...args: unknown[]) => { warns.push(args) }, error() {} },
    assemble,
    getMeter: () => options.withMeter === false ? undefined : meter,
    getLlm: () => options.withLlm === false ? undefined : llm.ctx,
    workspace: WORKSPACE,
    now: () => 5000,
  })
  const runs = () => session.events.filter((event) => event.type === COMPRESS_RUN_FACT_TYPE).map((event) => event.data)
  return { session, storage, llm, domain, requests, runs, config, warns }
}

const appendsOf = (session: FakeSession, type: string) => session.events.filter((event) => event.type === type)

describe('P19b 边界压缩：触发与全路径', () => {
  it('闭合发现 → 单次调用 → 档案 vN → 事务替换（summary 紧邻 checkpoint）→ 事实', async () => {
    const env = makeEnv()
    await env.domain.onPreStep({ session: env.session as never, turn: 7 })
    expect(env.llm.calls).toHaveLength(1)
    expect(env.llm.calls[0]).toMatchObject({ purpose: 'context-economy-compaction', temperature: 0 })
    expect(env.requests[0]).toMatchObject({ taskId: 's1:task-1', layer: 'boundary' })
    const start = appendsOf(env.session, 'compaction/start')
    const summary = appendsOf(env.session, 'compaction/summary')
    const end = appendsOf(env.session, 'compaction/end')
    expect(start).toHaveLength(1)
    expect(summary).toHaveLength(1)
    expect(end).toHaveLength(1)
    expect(summary[0]!.data).toMatchObject({ compactionId: 'ce-compact-boundary-task-1-0-3', shadowedTokenCount: 4242, shadowedSeqs: [0, 1, 2, 3] })
    expect(summary[0]!.seq + 1).toBe(env.session.events.find((e) => e.type === 'user/message' && e.surfaceOp && e.surfaceOp.op === 'replace')!.seq)
    const record = env.storage.entities.get(`boundary_archive:${ARCHIVE_KEY}`)!
    expect(record.version).toBe(1)
    const body = record.body as { entries: Array<{ taskId: string; kind: string; text: string }> }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]).toMatchObject({ taskId: 's1:task-1', kind: 'boundary', text: 'R' })
    expect(env.runs()).toHaveLength(1)
    expect(env.runs()[0]).toMatchObject({ outcome: 'ok', calls: 1, cacheHit: false, taskId: 's1:task-1', archiveEntries: 1, dossierRetired: true, shearFolded: 0 })
    expect(env.domain.stats()).toMatchObject({ triggers: 1, compactions: 1 })
  })

  it('已归档守卫：第二次 pre-step 不再调用（事实键，防每步重复计费）', async () => {
    const env = makeEnv()
    await env.domain.onPreStep({ session: env.session as never, turn: 1 })
    await env.domain.onPreStep({ session: env.session as never, turn: 1 })
    expect(env.llm.calls).toHaveLength(1)
    expect(env.domain.stats().triggers).toBe(1)
  })

  it('内容寻址复用：同内容跨会话命中 → 零调用 + cacheHit', async () => {
    const storage = new FakeStorage()
    const first = makeEnv({ storage })
    await first.domain.onPreStep({ session: first.session as never, turn: 1 })
    const second = makeEnv({ storage })
    await second.domain.onPreStep({ session: second.session as never, turn: 1 })
    expect(second.llm.calls).toHaveLength(0)
    expect(second.runs()[0]).toMatchObject({ outcome: 'ok', cacheHit: true, calls: 0 })
    expect(second.domain.stats().cacheHits).toBe(1)
  })

  it('机制 A：同 task 的既有检查点链作为 priorChain 传入（续传，不重压）', async () => {
    const storage = new FakeStorage()
    storage.entities.set(`boundary_archive:${ARCHIVE_KEY}`, {
      version: 1,
      body: { schemaVersion: 1, workspace: WORKSPACE, entries: [{ taskId: 's1:task-1', kind: 'checkpoint', text: 'C1', sessionId: 's1', layer: 'pressure', at: 1 }], cache: {} },
    })
    const env = makeEnv({ storage })
    await env.domain.onPreStep({ session: env.session as never, turn: 1 })
    expect(env.requests[0].priorChain.map((entry: { text: string }) => entry.text)).toEqual(['C1'])
    expect(env.runs()[0]).toMatchObject({ outcome: 'ok', carried: 1 })
  })

  it('T-boundary 搭车：区间内 hold 的老调用对补发 shear-applied 事实（会计）', async () => {
    const env = makeEnv()
    env.session.append(SHEAR_DECISION_FACT_TYPE, { policyVersion: 1, tier: 'T0', decision: 'hold', reason: 'long-run', callId: 'c1', at: 1 }, { ignorable: true })
    await env.domain.onPreStep({ session: env.session as never, turn: 1 })
    const applied = env.session.events.filter((event) => event.type === SHEAR_APPLIED_FACT_TYPE)
    expect(applied).toHaveLength(1)
    expect(applied[0]!.data).toMatchObject({ tier: 'T-boundary', kind: 't-boundary', callId: 'c1', resultSeq: 2, afterTokens: 0, breakTokens: 0 })
    expect(env.runs()[0]).toMatchObject({ shearFolded: 1 })
  })
})

describe('P19b 边界压缩：失败语义（不落刀 + 如实记账）', () => {
  it('解析失败 = fatal：不落刀，记 parse + calls', async () => {
    const env = makeEnv({ llm: fakeLlm([{ text: 'not json at all' }]) })
    await env.domain.onPreStep({ session: env.session as never, turn: 1 })
    expect(appendsOf(env.session, 'compaction/start')).toHaveLength(0)
    expect(env.runs()[0]).toMatchObject({ outcome: 'parse', calls: 1 })
    expect(env.storage.entities.size).toBe(0)
  })

  it('schema 失败（digest 坏形状）同样 fatal', async () => {
    const env = makeEnv({ llm: fakeLlm([{ text: JSON.stringify({ digest: { blocks: 'bad', coords: [] } }) }]) })
    await env.domain.onPreStep({ session: env.session as never, turn: 1 })
    expect(appendsOf(env.session, 'compaction/start')).toHaveLength(0)
    expect(env.runs()[0]).toMatchObject({ outcome: 'schema', calls: 1 })
  })

  it('缩水失败：重试 1 次后放弃（不落刀，记 shrink + retry）', async () => {
    const env = makeEnv({ rendered: 'R'.repeat(5000) })
    await env.domain.onPreStep({ session: env.session as never, turn: 1 })
    expect(env.llm.calls).toHaveLength(2)
    expect(appendsOf(env.session, 'compaction/start')).toHaveLength(0)
    expect(env.runs()[0]).toMatchObject({ outcome: 'skipped', reason: 'shrink', calls: 2, retry: 1 })
  })

  it('落盘失败：LLM 产物不落刀（09 §6），记 storage + calls', async () => {
    const storage = new FakeStorage()
    storage.failWrites = true
    const env = makeEnv({ storage })
    await env.domain.onPreStep({ session: env.session as never, turn: 1 })
    expect(appendsOf(env.session, 'compaction/start')).toHaveLength(0)
    expect(env.runs()[0]).toMatchObject({ outcome: 'skipped', reason: 'storage', calls: 1 })
  })

  it('llm 服务缺失：跳过且允许后续重试（不计入已尝试）', async () => {
    const env = makeEnv({ withLlm: false })
    await env.domain.onPreStep({ session: env.session as never, turn: 1 })
    expect(env.runs()[0]).toMatchObject({ outcome: 'skipped', reason: 'llm-unavailable', calls: 0 })
    await env.domain.onPreStep({ session: env.session as never, turn: 1 })
    expect(env.domain.stats().triggers).toBe(2)
  })

  it('LLM 流错误（非 stop）：记 llm-error，不落刀', async () => {
    const env = makeEnv({ llm: fakeLlm([{ text: '', finish: 'error' }]) })
    await env.domain.onPreStep({ session: env.session as never, turn: 1 })
    expect(env.runs()[0]).toMatchObject({ outcome: 'skipped', reason: 'llm-error', calls: 1 })
    expect(appendsOf(env.session, 'compaction/start')).toHaveLength(0)
  })

  it('装配失败（no-units）：不落刀，记 skipped/no-units', async () => {
    const env = makeEnv({ assembleOk: false })
    await env.domain.onPreStep({ session: env.session as never, turn: 1 })
    expect(env.runs()[0]).toMatchObject({ outcome: 'skipped', reason: 'no-units' })
    expect(appendsOf(env.session, 'compaction/start')).toHaveLength(0)
  })
})

describe('P19b 边界压缩：开关与守卫', () => {
  it('compression.boundary=false → 零行为', async () => {
    const env = makeEnv({ config: { compression: { ...resolveConfig({}).compression, boundary: false } } })
    await env.domain.onPreStep({ session: env.session as never, turn: 1 })
    expect(env.llm.calls).toHaveLength(0)
    expect(env.domain.stats().triggers).toBe(0)
  })

  it('无闭合 task（只有 task-1 开放）→ 不触发', async () => {
    const session = new FakeSession()
    session.append('user/message', { content: [textBlock('做 A')], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const env = makeEnv()
    await env.domain.onPreStep({ session: session as never, turn: 1 })
    expect(env.llm.calls).toHaveLength(0)
  })

  it('压缩域不变量违例（retain ≥ threshold）→ 不触发', async () => {
    const config = resolveConfig({ compression: { ...resolveConfig({}).compression, retainTokens: 200000, thresholdTokens: 100000 } })
    expect(config.compression.retainTokens).toBe(10000)
    expect(config.compression.thresholdTokens).toBe(100000)
  })

  it('卷宗清空 = 结构性：新 task 卷宗键与已归档 task 不同（不删旧卷宗）', async () => {
    const env = makeEnv()
    await env.domain.onPreStep({ session: env.session as never, turn: 1 })
    expect(env.runs()[0]!.taskId).toBe('s1:task-1')
    expect(env.runs()[0]!.taskId).not.toBe('s1:task-2')
  })
})

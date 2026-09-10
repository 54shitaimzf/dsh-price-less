/**
 * P19b 边界压缩域单测（docs/implement/archive/P19-boundary-path.md §5）——fake session/storage/llm/assemble，
 * 零 cordis 运行时。覆盖：闭合发现与已归档守卫 / 全路径落刀（事务 + 档案 vN + 事实）/
 * 内容寻址复用（零调用）/ 解析失败 / 缩水重试与放弃 / 落盘失败不落刀 / llm 缺失可重试 /
 * 开关关闭 / 续传链（机制 A）/ T-boundary 搭车补账 / 卷宗结构性清空。
 */
import { describe, expect, it } from 'vitest'
import { mountCompactionDomain, boundaryArchiveKey } from '../src/domains/compaction.ts'
import { readArchiveStore } from '../src/core/compress/index.ts'
import { COMPRESS_RUN_FACT_TYPE, HARD_TRUNCATE_FACT_TYPE, PRESSURE_FIRED_FACT_TYPE } from '../src/domains/compaction-facts.ts'
import { SHEAR_APPLIED_FACT_TYPE, SHEAR_DECISION_FACT_TYPE } from '../src/core/shear/index.ts'
import { ignorableChannelAvailable } from '../src/platform/ignorable-channel.ts'
import type { AssembleDomain } from '../src/domains/assemble.ts'
import type { ContextEconomyStorage } from '../src/platform/storage.ts'
import type { Config as ConfigShape } from '../src/config.ts'
import { resolveConfig } from '../src/config.ts'

ignorableChannelAvailable({ SESSION_LOG_INTENT: 1 })

const WORKSPACE = 'w'
const ARCHIVE_KEY = boundaryArchiveKey(WORKSPACE)
const VALID_PRODUCT = JSON.stringify({ gist: '目标与方向', steps: [{ type: 'plan', text: '先做一' }], hotTail: [{ unitId: 'c1' }] })

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
          hotTail: { entries: [], stopReason: 'list-end', source: 'model', floorFilled: false, declaredUnits: 0, dropped: 0, dropReasons: { badDecl: 0, unknownUnit: 0, remap: 0, fetch: 0, dup: 0, factReject: 0, error: 0 }, clipped: 0, truncated: 0, quotaDrops: 0, archiveRef: 'v1', tokens: 0, budgetTokens: 10000 },
          archiveForm: { form: 'single', checkpointCount: 0 }, unitCount: 1,
          rendered: options.rendered ?? 'R', digestText: options.rendered ?? 'R',
        },
      }
    },
  }
  return { domain: domain as unknown as AssembleDomain, requests }
}

function fakeLlm(
  script: Array<{ text?: string; finish?: 'stop' | 'error'; code?: string; usage?: any }> = [{ text: VALID_PRODUCT }],
  options: { contextWindow?: number } = {},
) {
  const calls: any[] = []
  const ctx = {
    llm: {
      ...(options.contextWindow === undefined
        ? {}
        : { resolveModelInfo: async () => ({ context: { contextWindow: options.contextWindow } }) }),
      stream(options2: any) {
        calls.push(options2)
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

function makeEnv(options: { config?: Partial<ConfigShape>; rendered?: string; assembleOk?: boolean; llm?: ReturnType<typeof fakeLlm>; storage?: FakeStorage; withLlm?: boolean; withMeter?: boolean; session?: FakeSession; wireTokens?: number } = {}) {
  const session = options.session ?? makeSession()
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
    getMeter: () => options.withMeter === false
      ? undefined
      : { heuristicTokensInRange: () => 4242, wireTokens: () => options.wireTokens },
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

  it('F9：parse 失败有界重试——首次不永久封禁，重试可成功落刀', async () => {
    const env = makeEnv({ llm: fakeLlm([{ text: 'not json' }, { text: VALID_PRODUCT }]) })
    await env.domain.onPreStep({ session: env.session as never, turn: 1 })
    expect(appendsOf(env.session, 'compaction/start')).toHaveLength(0)
    expect(env.runs()[0]).toMatchObject({ outcome: 'parse', calls: 1 })
    // 第二次 pre-step：预算内可重试（原缺陷 = 一次坏输出永久封禁该 task）。
    await env.domain.onPreStep({ session: env.session as never, turn: 2 })
    expect(env.runs()[1]).toMatchObject({ outcome: 'ok', calls: 1 })
    expect(env.domain.stats().compactions).toBe(1)
  })

  it('F9：重试超预算后才永久归档（防每步重复计费）', async () => {
    const env = makeEnv({ llm: fakeLlm([{ text: 'not json' }]) })
    await env.domain.onPreStep({ session: env.session as never, turn: 1 })
    await env.domain.onPreStep({ session: env.session as never, turn: 2 })
    expect(env.llm.calls).toHaveLength(2)
    await env.domain.onPreStep({ session: env.session as never, turn: 3 })
    expect(env.llm.calls).toHaveLength(2)
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

  it('U6：事务失败（半开 TXN_ACTIVE）→ 档案补偿复位，幽灵条目不残留', async () => {
    const session = makeSession()
    // 预插半开事务：writeStore 成功后 beginCompaction 被拒 → txn 失败（= 档案已写未落刀的幽灵场景）
    session.append('compaction/start', { compactionId: 'orphan-1', turn: 1 })
    const env = makeEnv({ session })
    await env.domain.onPreStep({ session: session as never, turn: 2 })
    const run = env.runs().at(-1)!
    expect(run.outcome).toBe('skipped')
    expect(String(run.reason)).toContain('txn-')
    // 首建路径补偿：档案体复位为空档案——幽灵 boundary 条目不进续传链
    const rec = env.storage.getEntity('boundary_archive', ARCHIVE_KEY)
    expect(rec).toBeDefined()
    expect(readArchiveStore(rec!.body, WORKSPACE).entries).toEqual([])
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

const PRESSURE_PRODUCT = JSON.stringify({
  checkpoint: { progress: '已完成 A', currentState: 'B 已就绪', nextStep: '做 C', liveConstraints: ['不要改 D'] },
  cutPoint: { unitId: 'c2' },
})

/** 开 task（无边界事实）+ 两对工具调用；前段大、尾段小（缩水校验可过）。 */
function makePressureSession(id = 'sp'): FakeSession {
  const session = new FakeSession()
  ;(session.header as { id: string }).id = id
  session.append('user/message', { content: [textBlock('做 A '.repeat(200))], source: { kind: 'user' } }, { surfaceOp: 'append' })
  // 真机形状：tool/call 是**非表面**日志事件（surfaceOp 省略）；表面节点 = assistant/message + tool/result。
  // 配对平衡守卫按此折（tool/call 不参与配对计数）；F9a 前压力路径不查配对，故旧夹具用错形状也过。
  session.append('assistant/message', { message: { content: [{ type: 'tool-call', toolCallId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }] } }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' })
  session.append('tool/result', { turn: 1, step: 1, message: { id: 't1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [textBlock('x'.repeat(2000))] }] } }, { surfaceOp: 'append' })
  session.append('assistant/message', { message: { content: [{ type: 'tool-call', toolCallId: 'c2', name: 'read', arguments: '{"file_path":"b.ts"}' }] } }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: '{"file_path":"b.ts"}' })
  session.append('tool/result', { turn: 1, step: 1, message: { id: 't2', role: 'user', source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'tool-result', toolCallId: 'c2', content: [textBlock('y'.repeat(50))] }] } }, { surfaceOp: 'append' })
  session.append('user/message', { content: [textBlock('继续')], source: { kind: 'user' } }, { surfaceOp: 'append' })
  // 主会话路由（readSessionModel 倒序扫描；非表面事件，不影响表面序）——P20c 窗口探针输入。
  session.append('request/header', { header: { config: { provider: 'p', model: 'm' } } })
  return session
}

const firesOf = (session: FakeSession) => session.events.filter((event) => event.type === PRESSURE_FIRED_FACT_TYPE).map((event) => event.data)

describe('P20a 压力路径：触发与全路径', () => {
  it('wire 达阈 → 单次调用 → 检查点档案 → 事务替换 → pressure-fired + compress-run', async () => {
    const env = makeEnv({ session: makePressureSession(), wireTokens: 120000, llm: fakeLlm([{ text: PRESSURE_PRODUCT }]) })
    await env.domain.onPreStep({ session: env.session as never, turn: 3 })
    expect(env.llm.calls).toHaveLength(1)
    expect(env.llm.calls[0]).toMatchObject({ purpose: 'context-economy-compaction', temperature: 0 })
    const fires = firesOf(env.session)
    expect(fires).toHaveLength(1)
    expect(fires[0]).toMatchObject({ outcome: 'fired', chainDepth: 0, wireTokens: 120000, thresholdTokens: 43750, pressureRatio: 0.35, cutPointSeq: 5 })
    expect(env.runs()).toHaveLength(1)
    expect(env.runs()[0]).toMatchObject({ layer: 'pressure', outcome: 'ok', calls: 1, cutPointSeq: 5, carried: 0, archiveEntries: 1 })
    const record = env.storage.entities.get(`boundary_archive:${ARCHIVE_KEY}`)!
    const body = record.body as { entries: Array<Record<string, unknown>> }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]).toMatchObject({ taskId: 'sp:task-1', kind: 'checkpoint', cutPointSeq: 5, rangeEndSeq: 7, layer: 'pressure' })
    expect(String(body.entries[0]!.text)).toContain('进度：')
    const landed = env.session.events.find((event) => event.type === 'user/message' && event.surfaceOp && event.surfaceOp.op === 'replace')!
    const text = (landed.data as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('进度：')
    expect(text).toContain('[6] tool/result c2')
    expect(text).toContain('y'.repeat(50))
    expect(appendsOf(env.session, 'compaction/summary')[0]!.data).toMatchObject({ shadowedTokenCount: 4242 })
    expect(env.domain.stats()).toMatchObject({ compactions: 1 })
  })

  it('断路器：链深达上限 → breaker 事实，零调用', async () => {
    const storage = new FakeStorage()
    storage.entities.set(`boundary_archive:${ARCHIVE_KEY}`, {
      version: 1,
      body: {
        schemaVersion: 1, workspace: WORKSPACE,
        entries: [0, 1, 2].map((i) => ({ taskId: 'sp:task-1', kind: 'checkpoint', text: `C${i}`, sessionId: 'sp', layer: 'pressure', at: i, cutPointSeq: 1, rangeEndSeq: 2 })),
        cache: {},
      },
    })
    const env = makeEnv({ session: makePressureSession(), wireTokens: 120000, storage })
    await env.domain.onPreStep({ session: env.session as never, turn: 3 })
    expect(env.llm.calls).toHaveLength(0)
    expect(firesOf(env.session)[0]).toMatchObject({ outcome: 'breaker', chainDepth: 3 })
    expect(env.runs()).toHaveLength(0)
  })

  it('turn 守卫：同 turn 第二次 pre-step 不再尝试（防每步重复计费）', async () => {
    const env = makeEnv({ session: makePressureSession(), wireTokens: 120000, llm: fakeLlm([{ text: PRESSURE_PRODUCT }]) })
    await env.domain.onPreStep({ session: env.session as never, turn: 3 })
    await env.domain.onPreStep({ session: env.session as never, turn: 3 })
    expect(env.llm.calls).toHaveLength(1)
  })

  it('低于阈值 / meter 缺失 → 零压力行为（boundary 无闭合段亦不动）', async () => {
    const low = makeEnv({ session: makePressureSession(), wireTokens: 40000 })
    await low.domain.onPreStep({ session: low.session as never, turn: 3 })
    expect(firesOf(low.session)).toHaveLength(0)
    expect(low.llm.calls).toHaveLength(0)
    const noMeter = makeEnv({ session: makePressureSession(), withMeter: false })
    await noMeter.domain.onPreStep({ session: noMeter.session as never, turn: 3 })
    expect(firesOf(noMeter.session)).toHaveLength(0)
    expect(noMeter.llm.calls).toHaveLength(0)
  })

  it('机制 A/B：续传旧检查点 C1，折叠区 = 上次缝之后的原文（含被遮蔽材料）', async () => {
    const session = new FakeSession()
    ;(session.header as { id: string }).id = 'sp'
    session.append('user/message', { content: [textBlock('做 A')], source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('assistant/message', { message: { content: [{ type: 'tool-call', toolCallId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }] } }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' })
    session.append('tool/result', { turn: 1, step: 1, message: { id: 't1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [textBlock('x'.repeat(2000))] }] } }, { surfaceOp: 'append' })
    // 模拟上一次压力折叠：replace [0..3] → 检查点节点（plugin:compact）
    session.append('user/message', { content: [textBlock('C1')], source: { kind: 'plugin', plugin: 'compact' } }, { surfaceOp: { op: 'replace', start: 0, end: 3 }, sourceEventSeqs: [0, 1, 2, 3] })
    session.append('assistant/message', { message: { content: [{ type: 'tool-call', toolCallId: 'c2', name: 'read', arguments: '{"file_path":"b.ts"}' }] } }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: '{"file_path":"b.ts"}' })
    session.append('tool/result', { turn: 1, step: 1, message: { id: 't2', role: 'user', source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'tool-result', toolCallId: 'c2', content: [textBlock('y'.repeat(50))] }] } }, { surfaceOp: 'append' })
    session.append('user/message', { content: [textBlock('继续')], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const storage = new FakeStorage()
    storage.entities.set(`boundary_archive:${ARCHIVE_KEY}`, {
      version: 1,
      body: { schemaVersion: 1, workspace: WORKSPACE, entries: [{ taskId: 'sp:task-1', kind: 'checkpoint', text: 'C1', sessionId: 'sp', layer: 'pressure', at: 1, cutPointSeq: 1, rangeEndSeq: 2 }], cache: {} },
    })
    const env = makeEnv({ session, storage, wireTokens: 120000, llm: fakeLlm([{ text: PRESSURE_PRODUCT }]) })
    await env.domain.onPreStep({ session: env.session as never, turn: 3 })
    expect(env.runs()[0]).toMatchObject({ outcome: 'ok', carried: 1 })
    const prompt = env.llm.calls[0].messages[0].content[0].text as string
    expect(prompt).toContain('C1')
    expect(prompt).toContain('x'.repeat(2000))
    const landed = env.session.events.find((event) => event.type === 'user/message' && event.surfaceOp && event.surfaceOp.op === 'replace')!
    const text = (landed.data as { content: Array<{ text: string }> }).content[0]!.text
    expect(text.startsWith('C1')).toBe(true)
  })

  it('内容寻址复用：同内容跨会话命中 → 零调用 + cacheHit', async () => {
    const storage = new FakeStorage()
    const first = makeEnv({ session: makePressureSession('sp'), storage, wireTokens: 120000, llm: fakeLlm([{ text: PRESSURE_PRODUCT }]) })
    await first.domain.onPreStep({ session: first.session as never, turn: 3 })
    const second = makeEnv({ session: makePressureSession('sp2'), storage, wireTokens: 120000, llm: fakeLlm([{ text: PRESSURE_PRODUCT }]) })
    await second.domain.onPreStep({ session: second.session as never, turn: 3 })
    expect(second.llm.calls).toHaveLength(0)
    expect(second.runs()[0]).toMatchObject({ outcome: 'ok', cacheHit: true, calls: 0 })
    expect(second.domain.stats().cacheHits).toBe(1)
  })

  it('压力开关关闭 → 零行为', async () => {
    const config = resolveConfig({ compression: { ...resolveConfig({}).compression, pressure: false } })
    const env = makeEnv({ session: makePressureSession(), wireTokens: 120000, config })
    await env.domain.onPreStep({ session: env.session as never, turn: 3 })
    expect(env.llm.calls).toHaveLength(0)
    expect(firesOf(env.session)).toHaveLength(0)
  })
})

const hardFactsOf = (session: FakeSession) => session.events.filter((event) => event.type === HARD_TRUNCATE_FACT_TYPE).map((event) => event.data)

describe('P20b 保险丝：地板以上自动折叠 + 溢出接管', () => {
  it('断路器耗尽后：保险丝越过断路器紧急折叠 + hard-truncate{fuse-fold}', async () => {
    const storage = new FakeStorage()
    storage.entities.set(`boundary_archive:${ARCHIVE_KEY}`, {
      version: 1,
      body: {
        schemaVersion: 1, workspace: WORKSPACE,
        entries: [0, 1, 2].map((i) => ({ taskId: 'sp:task-1', kind: 'checkpoint', text: `C${i}`, sessionId: 'sp', layer: 'pressure', at: i, cutPointSeq: 1, rangeEndSeq: 2 })),
        cache: {},
      },
    })
    const env = makeEnv({
      session: makePressureSession(), storage, wireTokens: 90000,
      llm: fakeLlm([{ text: PRESSURE_PRODUCT }], { contextWindow: 100000 }),
    })
    await env.domain.onPreStep({ session: env.session as never, turn: 3, step: 1 })
    expect(firesOf(env.session)[0]).toMatchObject({ outcome: 'breaker', chainDepth: 3 })
    const hard = hardFactsOf(env.session)
    expect(hard).toHaveLength(1)
    expect(hard[0]).toMatchObject({ outcome: 'fuse-fold', landed: true, wireTokens: 90000, floorTokens: 80000, contextWindow: 100000 })
    expect(env.runs()[0]).toMatchObject({ layer: 'pressure', outcome: 'ok', emergency: true, carried: 3 })
  })

  it('低于地板 → 严格 no-op（零事实 / 零调用 / 零改史）', async () => {
    const session = makePressureSession()
    const before = session.events.length
    const config = resolveConfig({ compression: { ...resolveConfig({}).compression, pressureRatio: 0.75 } })
    const env = makeEnv({
      session, wireTokens: 70000, config,
      llm: fakeLlm([{ text: PRESSURE_PRODUCT }], { contextWindow: 100000 }),
    })
    await env.domain.onPreStep({ session: session as never, turn: 3, step: 1 })
    expect(session.events.length).toBe(before)
    expect(env.llm.calls).toHaveLength(0)
    expect(hardFactsOf(session)).toHaveLength(0)
    expect(firesOf(session)).toHaveLength(0)
  })

  it('溢出接管：CONTEXT_WINDOW_EXCEEDED → 紧急折叠 → retry + hard-truncate{overflow-retry}', async () => {
    const env = makeEnv({ session: makePressureSession(), wireTokens: 150000, llm: fakeLlm([{ text: PRESSURE_PRODUCT }]) })
    const action = await env.domain.onRequestError({ session: env.session as never, turn: 3, step: 1, failureCode: 'CONTEXT_WINDOW_EXCEEDED' })
    expect(action).toBe('retry')
    expect(hardFactsOf(env.session)[0]).toMatchObject({ outcome: 'overflow-retry', landed: true })
    expect(env.runs()[0]).toMatchObject({ layer: 'pressure', outcome: 'ok', emergency: true })
  })

  it('非溢出码 → pass 零行为；同 (turn,step) 二次接管 → pass（不重复折叠）', async () => {
    const env = makeEnv({ session: makePressureSession(), wireTokens: 150000, llm: fakeLlm([{ text: PRESSURE_PRODUCT }]) })
    expect(await env.domain.onRequestError({ session: env.session as never, turn: 3, step: 1, failureCode: 'OTHER' })).toBe('pass')
    expect(env.llm.calls).toHaveLength(0)
    expect(await env.domain.onRequestError({ session: env.session as never, turn: 3, step: 1, failureCode: 'CONTEXT_WINDOW_EXCEEDED' })).toBe('retry')
    expect(await env.domain.onRequestError({ session: env.session as never, turn: 3, step: 1, failureCode: 'CONTEXT_WINDOW_EXCEEDED' })).toBe('pass')
    expect(env.llm.calls).toHaveLength(1)
  })

  it('接管未落刀（解析失败）→ pass + overflow-declined（原始错误交上游）', async () => {
    const env = makeEnv({ session: makePressureSession(), wireTokens: 150000, llm: fakeLlm([{ text: 'not json' }]) })
    expect(await env.domain.onRequestError({ session: env.session as never, turn: 3, step: 1, failureCode: 'CONTEXT_WINDOW_EXCEEDED' })).toBe('pass')
    expect(hardFactsOf(env.session)[0]).toMatchObject({ outcome: 'overflow-declined', landed: false })
  })

  it('压力开关关闭 → 接管不生效（pass 零行为）', async () => {
    const config = resolveConfig({ compression: { ...resolveConfig({}).compression, pressure: false } })
    const env = makeEnv({ session: makePressureSession(), wireTokens: 150000, config, llm: fakeLlm([{ text: PRESSURE_PRODUCT }]) })
    expect(await env.domain.onRequestError({ session: env.session as never, turn: 3, step: 1, failureCode: 'CONTEXT_WINDOW_EXCEEDED' })).toBe('pass')
    expect(env.llm.calls).toHaveLength(0)
  })
})

describe('F9a 压力区间守卫（INVALID_RANGE 回归，2026-09-09 真机缺陷）', () => {
  it('表面损坏（配对守卫抛错）→ 干净 skip(range)，不抛错不半开事务', async () => {
    const session = makePressureSession()
    // 真机缺陷模型：事件窗被截断时从原始事件自折会复活已遮蔽节点，选到非表面端点 → INVALID_RANGE。
    // 这里直接构造权威表面损坏（tool/result 失去配对的 assistant/message）：守卫抛错必须被吸收成 skip。
    session.nodes = session.nodes.filter((seq) => seq !== 4)
    const env = makeEnv({ session, wireTokens: 120000, llm: fakeLlm([{ text: PRESSURE_PRODUCT }]) })
    await env.domain.onPreStep({ session: session as never, turn: 3 })
    expect(env.domain.stats().errors).toBe(0)
    expect(env.llm.calls).toHaveLength(0)
    expect(firesOf(session)[0]).toMatchObject({ outcome: 'skip', reason: 'range' })
    expect(appendsOf(session, 'compaction/start')).toHaveLength(0)
    expect(env.runs()).toHaveLength(0)
  })

  it('权威表面 = 真源：端点必落在 session.surface.nodes（越界即 skip，不抛 INVALID_RANGE）', async () => {
    const session = makePressureSession()
    const storage = new FakeStorage()
    storage.entities.set(`boundary_archive:${ARCHIVE_KEY}`, {
      version: 1,
      body: {
        schemaVersion: 1, workspace: WORKSPACE,
        entries: [{ taskId: 'sp:task-1', kind: 'checkpoint', text: 'C1', sessionId: 'sp', layer: 'pressure', at: 1, cutPointSeq: 1, rangeEndSeq: 99 }],
        cache: {},
      },
    })
    const env = makeEnv({ session, storage, wireTokens: 120000, llm: fakeLlm([{ text: PRESSURE_PRODUCT }]) })
    await env.domain.onPreStep({ session: session as never, turn: 3 })
    expect(env.domain.stats().errors).toBe(0)
    // rangeEndSeq=99 不在表面 → rawStart 找不到 > 99 的节点 → skip(range)，绝不把 99 送进 replace。
    expect(firesOf(session)[0]).toMatchObject({ outcome: 'skip', reason: 'range' })
    expect(appendsOf(session, 'compaction/start')).toHaveLength(0)
  })

  it('尾部未配对（悬挂 tool-call）→ 配对平衡收窄替换区间，不把未配对节点折进去', async () => {
    const session = makePressureSession()
    session.append('assistant/message', { message: { content: [{ type: 'tool-call', toolCallId: 'c3', name: 'read', arguments: '{"file_path":"c.ts"}' }] } }, { surfaceOp: 'append' })
    const dangling = session.nodes.at(-1)!
    const env = makeEnv({ session, wireTokens: 120000, llm: fakeLlm([{ text: PRESSURE_PRODUCT }]) })
    await env.domain.onPreStep({ session: session as never, turn: 3 })
    expect(env.domain.stats().errors).toBe(0)
    const entry = (env.storage.entities.get(`boundary_archive:${ARCHIVE_KEY}`)!.body as { entries: Array<{ rangeEndSeq?: number }> }).entries[0]!
    expect(entry.rangeEndSeq).not.toBe(dangling)
    expect(entry.rangeEndSeq).toBeLessThan(dangling)
  })

  it('表面为空 → skip(range)，零调用零改史', async () => {
    const session = makePressureSession()
    session.nodes = []
    const env = makeEnv({ session, wireTokens: 120000, llm: fakeLlm([{ text: PRESSURE_PRODUCT }]) })
    await env.domain.onPreStep({ session: session as never, turn: 3 })
    expect(env.llm.calls).toHaveLength(0)
    expect(firesOf(session)[0]).toMatchObject({ outcome: 'skip', reason: 'range' })
    expect(appendsOf(session, 'compaction/start')).toHaveLength(0)
  })
})



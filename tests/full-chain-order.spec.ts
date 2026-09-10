/**
 * P21b 四触发次序交错闭合（docs/04 §3 生产/消费不对称律 + §8 验收；P21b 进 CI）。
 * ① 共享模块闭合表（边→边 / 边→压 / 压→边 / 压→压；纯核，04 §8「共享模块用例」）；
 * ② 域侧交错 e2e（边→边 / 压→边 真 mountCompactionDomain，档案只追加）；
 * ③ 层隔离（docs/10 §8：关闭任一层其余功能完整）。
 */
import { describe, expect, it } from 'vitest'
import { mountCompactionDomain, boundaryArchiveKey } from '../src/domains/compaction.ts'
import { COMPRESS_RUN_FACT_TYPE, PRESSURE_FIRED_FACT_TYPE } from '../src/domains/compaction-facts.ts'
import { planTailConsumption, TAIL_CONSUME_OPS } from '../src/core/compress/index.ts'
import { archiveChainAppendOnly, archiveChainShape } from '../src/core/assemble/index.ts'
import { ignorableChannelAvailable } from '../src/platform/ignorable-channel.ts'
import type { AssembleDomain } from '../src/domains/assemble.ts'
import type { ContextEconomyStorage } from '../src/platform/storage.ts'
import { resolveConfig, type Config as ConfigShape } from '../src/config.ts'

ignorableChannelAvailable({ SESSION_LOG_INTENT: 1 })

const WORKSPACE = 'w'
const ARCHIVE_KEY = boundaryArchiveKey(WORKSPACE)
const VALID_PRODUCT = JSON.stringify({ gist: '目标与方向', steps: [{ type: 'plan', text: '先做一' }], hotTail: [{ unitId: 'c1' }] })
const PRESSURE_PRODUCT = JSON.stringify({
  checkpoint: { progress: '已完成 A', currentState: 'B 已就绪', nextStep: '做 C', liveConstraints: ['不要改 D'] },
  cutPoint: { unitId: 'c2' },
})
const textBlock = (text: string) => [{ type: 'text', text }]

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

class FakeStorage {
  readonly entities = new Map<string, { version: number; body: unknown }>()
  getEntity(table: string, key: string) {
    const record = this.entities.get(table + ':' + key)
    if (record === undefined) return undefined
    return { schemaVersion: 1, version: record.version, source: { taskId: 'x', eventType: 'y', evidence: {} }, body: record.body }
  }
  async putEntity(table: string, key: string, body: unknown, _source: unknown, options?: { baseVersion?: number }) {
    const id = table + ':' + key
    const current = this.entities.get(id)
    const base = options?.baseVersion ?? 0
    if (base === 0) { if (current !== undefined) throw new Error('CAS') }
    else if (current === undefined || current.version !== base) throw new Error('CAS')
    this.entities.set(id, { version: base === 0 ? 1 : base + 1, body })
    return this.getEntity(table, key)!
  }
}

function fakeAssemble() {
  const requests: any[] = []
  const domain = {
    dispose() {},
    stats: () => ({ sessions: 0, assemblies: requests.length, failures: 0, degraded: 0 }),
    unitList: () => [
      { id: 'c1', kind: 'tool-pair', seqStart: 1, seqEnd: 2, name: 'read', path: 'a.ts', version: 1, text: '1: old line', tokens: 1 },
      { id: 'c2', kind: 'tool-pair', seqStart: 3, seqEnd: 4, name: 'read', path: 'b.ts', version: 1, text: '2: b', tokens: 1 },
    ],
    assemble: async (request: any) => {
      requests.push(request)
      return {
        ok: true,
        result: {
          layer: request.layer, digest: request.digest, digestBytes: 10, digestEntryCount: 1,
          hotTail: { entries: [], stopReason: 'list-end', source: 'model', floorFilled: false, declaredUnits: 0, dropped: 0, dropReasons: { badDecl: 0, unknownUnit: 0, remap: 0, fetch: 0, dup: 0, factReject: 0, error: 0 }, clipped: 0, truncated: 0, quotaDrops: 0, archiveRef: 'v1', tokens: 0, budgetTokens: 10000 },
          archiveForm: { form: 'single', checkpointCount: 0 }, unitCount: 2, rendered: 'R', digestText: 'R',
        },
      }
    },
  }
  return { domain: domain as unknown as AssembleDomain, requests }
}

function fakeLlm(script: string[]) {
  const calls: any[] = []
  const ctx = {
    llm: {
      stream(options: any) {
        calls.push(options)
        const entry = script[Math.min(calls.length - 1, script.length - 1)]!
        return (async function* () {
          yield { type: 'text-delta', text: entry }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  return { ctx, calls }
}

function makeEnv(options: { config?: Partial<ConfigShape>; llm?: ReturnType<typeof fakeLlm>; session: FakeSession; storage?: FakeStorage; wireTokens?: number }) {
  const storage = options.storage ?? new FakeStorage()
  const llm = options.llm ?? fakeLlm([VALID_PRODUCT])
  const { domain: assemble, requests } = fakeAssemble()
  const config = resolveConfig(options.config ?? {})
  const domain = mountCompactionDomain({
    storage: storage as unknown as ContextEconomyStorage,
    getConfig: () => config,
    logger: { info() {}, warn() {}, error() {} },
    assemble,
    getMeter: () => ({ heuristicTokensInRange: () => 4242, wireTokens: () => options.wireTokens }),
    getLlm: () => llm.ctx,
    workspace: WORKSPACE,
    now: () => 5000,
  })
  return { session: options.session, storage, llm, domain, requests, config, runs: () => options.session.events.filter((e) => e.type === COMPRESS_RUN_FACT_TYPE).map((e) => e.data) }
}

/** task-1 内容 + 闭合事实（真实时序：闭合即压，之后才有 task-2 的事件）。 */
const appendTaskOne = (session: FakeSession): void => {
  session.append('user/message', { content: textBlock('做 A'.repeat(40)), source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', { message: { content: [{ type: 'tool-call', toolCallId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }] } }, { surfaceOp: 'append' })
  session.append('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: textBlock('1: old line') }] } }, { surfaceOp: 'append' })
  session.append('context-economy/task-boundary', { boundary: 'close', taskId: 'task-1' }, { ignorable: true })
}

/** task-2 内容 + 闭合事实 + 新 task 首条消息（在 task-1 压缩落刀之后追加）。 */
const appendTaskTwo = (session: FakeSession): void => {
  session.append('user/message', { content: textBlock('做 B'.repeat(40)), source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', { message: { content: [{ type: 'tool-call', toolCallId: 'c2', name: 'read', arguments: '{"file_path":"b.ts"}' }] } }, { surfaceOp: 'append' })
  session.append('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'c2', content: textBlock('2: b line') }] } }, { surfaceOp: 'append' })
  session.append('context-economy/task-boundary', { boundary: 'close', taskId: 'task-2' }, { ignorable: true })
  session.append('user/message', { content: textBlock('做 C'), source: { kind: 'user' } }, { surfaceOp: 'append' })
}

const makeTwoClosedTasks = (): FakeSession => {
  const session = new FakeSession()
  appendTaskOne(session)
  appendTaskTwo(session)
  return session
}

const makePressureSession = (id = 'sp'): FakeSession => {
  const session = new FakeSession()
  ;(session.header as { id: string }).id = id
  session.append('user/message', { content: textBlock('做 A '.repeat(200)), source: { kind: 'user' } }, { surfaceOp: 'append' })
  // 真机形状：tool/call 非表面日志事件；表面节点 = assistant/message + tool/result（F9a 配对守卫需要）。
  session.append('assistant/message', { message: { content: [{ type: 'tool-call', toolCallId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }] } }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' })
  session.append('tool/result', { turn: 1, step: 1, message: { id: 't1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: textBlock('x'.repeat(2000)) }] } }, { surfaceOp: 'append' })
  session.append('assistant/message', { message: { content: [{ type: 'tool-call', toolCallId: 'c2', name: 'read', arguments: '{"file_path":"b.ts"}' }] } }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: '{"file_path":"b.ts"}' })
  session.append('tool/result', { turn: 1, step: 1, message: { id: 't2', role: 'user', source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'tool-result', toolCallId: 'c2', content: textBlock('y'.repeat(50)) }] } }, { surfaceOp: 'append' })
  session.append('user/message', { content: textBlock('继续'), source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('request/header', { header: { config: { provider: 'p', model: 'm' } } })
  return session
}

const archiveEntriesOf = (storage: FakeStorage) =>
  ((storage.entities.get('boundary_archive:' + ARCHIVE_KEY)?.body as { entries?: any[] } | undefined)?.entries ?? [])

describe('P21b 四触发次序：共享模块闭合表（04 §8「共享模块用例」）', () => {
  const chain = (kind: 'checkpoint' | 'boundary') => [{ taskId: 't', kind, text: kind === 'checkpoint' ? 'C1' : 'D' }]

  it('尾部消费表：checkpoint/boundary → 续传；material → 折叠', () => {
    expect(TAIL_CONSUME_OPS).toEqual({ checkpoint: 'continue', boundary: 'continue', material: 'fold' })
  })

  it('边→边：空链 + boundary → single / carry 0 / 追加 boundary / 不折材料', () => {
    expect(planTailConsumption({ priorChain: [], layer: 'boundary' })).toEqual({
      ok: true, form: 'single', carryCount: 0, appendKind: 'boundary', foldMaterial: false,
    })
  })

  it('边→压：boundary 链 + pressure → chain / carry 1 / 追加 checkpoint / 折材料（机制 B）', () => {
    expect(planTailConsumption({ priorChain: chain('boundary'), layer: 'pressure' })).toEqual({
      ok: true, form: 'chain', carryCount: 1, appendKind: 'checkpoint', foldMaterial: true,
    })
  })

  it('压→边：checkpoint 链 + boundary → chain / carry 1 / 追加 boundary / 不折材料', () => {
    expect(planTailConsumption({ priorChain: chain('checkpoint'), layer: 'boundary' })).toEqual({
      ok: true, form: 'chain', carryCount: 1, appendKind: 'boundary', foldMaterial: false,
    })
  })

  it('压→压：checkpoint 链 + pressure → chain / carry 1 / 追加 checkpoint / 折材料', () => {
    expect(planTailConsumption({ priorChain: chain('checkpoint'), layer: 'pressure' })).toEqual({
      ok: true, form: 'chain', carryCount: 1, appendKind: 'checkpoint', foldMaterial: true,
    })
  })

  it('非法链形态（跨 task）→ ok:false chain-invalid（调用侧 fatal，不落刀）', () => {
    const invalid = [{ taskId: 't1', kind: 'checkpoint' as const, text: 'C1' }, { taskId: 't2', kind: 'boundary' as const, text: 'D' }]
    expect(planTailConsumption({ priorChain: invalid, layer: 'pressure' })).toEqual({ ok: false, reason: 'chain-invalid' })
  })
})

describe('P21b 四触发次序：域侧交错 e2e（档案只追加）', () => {
  it('边→边：两个闭合 task 各自成档；既有条目逐字节不变（真实时序：压完 task-1 才有 task-2 事件）', async () => {
    const session = new FakeSession()
    appendTaskOne(session)
    const env = makeEnv({ session, llm: fakeLlm([VALID_PRODUCT, VALID_PRODUCT]), wireTokens: 0 })
    await env.domain.onPreStep({ session: session as never, turn: 1 })
    const afterFirst = JSON.stringify(archiveEntriesOf(env.storage))
    appendTaskTwo(session)
    await env.domain.onPreStep({ session: session as never, turn: 2 })
    const entries = archiveEntriesOf(env.storage)
    expect(entries.map((entry) => entry.kind)).toEqual(['boundary', 'boundary'])
    expect(entries.map((entry) => entry.taskId)).toEqual(['s1:task-1', 's1:task-2'])
    expect(JSON.stringify(entries.slice(0, 1))).toBe(afterFirst)
    expect(archiveChainAppendOnly([entries[0]], entries)).toBe(true)
    expect(env.runs().map((run) => run.layer)).toEqual(['boundary', 'boundary'])
    expect(env.runs().map((run) => run.carried)).toEqual([0, 0])
  })

  it('边→边（F2 真机时序）：task-2 首条消息先于 task-1 压缩入账 → 第二次压缩"进产物 ⇔ 被遮蔽"（U1 P0 回归）', async () => {
    const session = new FakeSession()
    appendTaskOne(session)
    // F2 真机时序：pre-step 等判词期间 task-2 已开（首条用户消息先入账），然后才压 task-1——
    // 第一次压缩的 checkpoint 节点 seq 高于 userB、位置却早于 userB（replace 原位 splice）。
    const userB = session.append('user/message', { content: textBlock('做 B'.repeat(40)), source: { kind: 'user' } }, { surfaceOp: 'append' })
    const env = makeEnv({ session, llm: fakeLlm([VALID_PRODUCT, VALID_PRODUCT]), wireTokens: 0 })
    await env.domain.onPreStep({ session: session as never, turn: 1 })
    const checkpoint = session.events.find((e) => e.type === 'user/message' && (e.data as { source?: { kind?: string } })?.source?.kind === 'plugin')
    expect(checkpoint).toBeDefined()
    expect(Number(checkpoint!.seq)).toBeGreaterThan(Number(userB.seq))
    expect(session.nodes.indexOf(Number(checkpoint!.seq))).toBeLessThan(session.nodes.indexOf(Number(userB.seq)))
    // 补完 task-2 材料 + 闭合 + task-3 首条消息，第二次压缩 task-2。
    session.append('assistant/message', { message: { content: [{ type: 'tool-call', toolCallId: 'c2', name: 'read', arguments: '{"file_path":"b.ts"}' }] } }, { surfaceOp: 'append' })
    session.append('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'c2', content: textBlock('2: b line') }] } }, { surfaceOp: 'append' })
    session.append('context-economy/task-boundary', { boundary: 'close', taskId: 'task-2' }, { ignorable: true })
    session.append('user/message', { content: textBlock('做 C'), source: { kind: 'user' } }, { surfaceOp: 'append' })
    await env.domain.onPreStep({ session: session as never, turn: 2 })
    expect(env.runs().filter((run) => run.outcome === 'ok')).toHaveLength(2)
    const summaries = session.events.filter((e) => e.type === 'compaction/summary')
    expect(summaries).toHaveLength(2)
    const second = summaries[1]!.data as { shadowedSeqs?: number[] }
    // ① userB 进第二次产物才允许被遮蔽（旧实现：被遮蔽却不在 prompt 里 = 静默丢失）
    expect(second.shadowedSeqs).toContain(Number(userB.seq))
    // ② 压缩器输入含 userB 正文
    expect(String(env.llm.calls[1]!.messages[0]!.content[0]!.text)).toContain('做 B')
    // ③ 第一次 checkpoint（plugin 产物节点）不被第二次复消化
    expect(second.shadowedSeqs).not.toContain(Number(checkpoint!.seq))
  })

  it('积压多闭合段（恢复/曾关开关）→ 逐次 pre-step 各压一个，不被新节点卡死（P21b 验收发现缺陷的回归）', async () => {
    const session = makeTwoClosedTasks() // 两个闭合段的事件都已存在，压缩发生在事件之后
    const env = makeEnv({ session, llm: fakeLlm([VALID_PRODUCT, VALID_PRODUCT]), wireTokens: 0 })
    await env.domain.onPreStep({ session: session as never, turn: 1 })
    await env.domain.onPreStep({ session: session as never, turn: 2 })
    const entries = archiveEntriesOf(env.storage)
    expect(entries.map((entry) => entry.taskId)).toEqual(['s1:task-1', 's1:task-2'])
    expect(entries.map((entry) => entry.kind)).toEqual(['boundary', 'boundary'])
    expect(env.domain.stats().rangeSkips).toBe(0)
    expect(env.runs().filter((run) => run.outcome === 'ok')).toHaveLength(2)
  })

  it('压→边：同 task 先检查点后边界 → 链 [checkpoint, boundary]（机制 A 续传；U1：检查点只经 priorChain 进 prompt 一次）', async () => {
    const session = makePressureSession('sp')
    const env = makeEnv({ session, llm: fakeLlm([PRESSURE_PRODUCT, VALID_PRODUCT]), wireTokens: 120000 })
    await env.domain.onPreStep({ session: session as never, turn: 3 })
    expect(archiveEntriesOf(env.storage).map((entry) => entry.kind)).toEqual(['checkpoint'])
    // 压力折叠后 task 表面只剩 checkpoint 节点 → 补入真实新材料再闭合：
    // 边界压缩新材料、以检查点链续传；检查点文本不再作为区间材料复消化（digest∘digest 修复）。
    session.append('user/message', { content: textBlock('收尾：改配置'), source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('assistant/message', { message: { content: [{ type: 'tool-call', toolCallId: 'c3', name: 'edit', arguments: '{"file_path":"c.ts"}' }] } }, { surfaceOp: 'append' })
    session.append('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'c3', content: textBlock('3: done') }] } }, { surfaceOp: 'append' })
    session.append('context-economy/task-boundary', { boundary: 'close', taskId: 'task-1' }, { ignorable: true })
    env.storage.getEntity = env.storage.getEntity.bind(env.storage)
    const lowWire = makeEnv({ session, storage: env.storage, llm: env.llm, wireTokens: 0 })
    await lowWire.domain.onPreStep({ session: session as never, turn: 4 })
    const entries = archiveEntriesOf(env.storage)
    expect(entries.map((entry) => entry.kind)).toEqual(['checkpoint', 'boundary'])
    expect(entries.every((entry) => entry.taskId === 'sp:task-1')).toBe(true)
    expect(archiveChainShape(entries).shape).toBe('chain')
    expect(archiveChainAppendOnly([entries[0]], entries)).toBe(true)
    const boundaryRun = lowWire.runs().find((run) => run.layer === 'boundary')!
    expect(boundaryRun).toMatchObject({ outcome: 'ok', carried: 1 })
    expect(lowWire.requests[0].priorChain.map((entry: { text: string }) => entry.text)).toEqual(['进度：已完成 A\n当前状态：B 已就绪\n下一步：做 C\n仍生效的约束：\n- 不要改 D'])
    // 边界 prompt：新材料进转写；检查点文本只出现一次（priorChain），不进区间转写
    const prompt = String(env.llm.calls[1]!.messages[0]!.content[0]!.text)
    expect(prompt).toContain('收尾：改配置')
    expect(prompt.split('已完成 A').length - 1).toBe(1)
  })
})

describe('P21b 层隔离（docs/10 §8：关闭任一层其余功能完整）', () => {
  it('关 boundary → 压力仍工作', async () => {
    const session = makePressureSession('sp')
    const config = resolveConfig({ compression: { ...resolveConfig({}).compression, boundary: false } })
    const env = makeEnv({ session, config, llm: fakeLlm([PRESSURE_PRODUCT]), wireTokens: 120000 })
    await env.domain.onPreStep({ session: session as never, turn: 3 })
    expect(session.events.some((event) => event.type === PRESSURE_FIRED_FACT_TYPE)).toBe(true)
    expect(archiveEntriesOf(env.storage).map((entry) => entry.kind)).toEqual(['checkpoint'])
  })

  it('关 pressure → 边界仍工作', async () => {
    const session = makeTwoClosedTasks()
    const config = resolveConfig({ compression: { ...resolveConfig({}).compression, pressure: false } })
    const env = makeEnv({ session, config, llm: fakeLlm([VALID_PRODUCT]), wireTokens: 120000 })
    await env.domain.onPreStep({ session: session as never, turn: 1 })
    expect(archiveEntriesOf(env.storage).map((entry) => entry.kind)).toEqual(['boundary'])
    expect(session.events.some((event) => event.type === PRESSURE_FIRED_FACT_TYPE)).toBe(false)
  })

  it('两层全关 → 零行为、零事实、不抛错', async () => {
    const session = makeTwoClosedTasks()
    const config = resolveConfig({ compression: { ...resolveConfig({}).compression, boundary: false, pressure: false } })
    const env = makeEnv({ session, config, llm: fakeLlm([VALID_PRODUCT]), wireTokens: 120000 })
    await expect(env.domain.onPreStep({ session: session as never, turn: 1 })).resolves.toBeUndefined()
    expect(env.llm.calls).toHaveLength(0)
    expect(env.runs()).toHaveLength(0)
    expect(env.storage.entities.size).toBe(0)
  })
})

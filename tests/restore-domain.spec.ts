/**
 * P21a 恢复域单测（docs/implement/archive/P21a-restore.md §5）——fake session/storage，零 cordis 运行时。
 * 覆盖：fresh 会话零动作 / 卷宗缺失重放写回 / 卷宗 ok 不动 / 演练注入损坏覆盖写 / 项目帧快照回退 /
 * 项目帧无快照降级 / 档案与产物只降级 / 结构版本不符记账 / 双源漂移 / 幂等 / 事实全部 ignorable / 账本 fold。
 */
import { describe, expect, it } from 'vitest'
import { mountRestoreDomain } from '../src/domains/restore.ts'
import {
  RESTORE_DEGRADED_FACT_TYPE,
  RESTORE_DONE_FACT_TYPE,
  RESTORE_STEP_FACT_TYPE,
  foldRestoreLedger,
} from '../src/core/restore/index.ts'
import { dossierStorageKey, sessionScopedTaskId } from '../src/core/dossier.ts'
import { projectFrameStorageKey } from '../src/core/prefix.ts'
import { boundaryArchiveKey } from '../src/domains/compaction.ts'
import { optimizeArtifactStorageKey } from '../src/domains/star.ts'
import { ignorableChannelAvailable } from '../src/platform/ignorable-channel.ts'
import type { ContextEconomyStorage } from '../src/platform/storage.ts'
import type { Session } from '@deepseek-ai/dsh-session'

ignorableChannelAvailable({ SESSION_LOG_INTENT: 1 })

const WORKSPACE = 'w'
const SESSION_ID = 'sess-1'
const DOSSIER_1 = dossierStorageKey(sessionScopedTaskId(SESSION_ID, 'task-1'))
const DOSSIER_2 = dossierStorageKey(sessionScopedTaskId(SESSION_ID, 'task-2'))
const FRAME_KEY = projectFrameStorageKey(WORKSPACE)
const ARCHIVE_KEY = boundaryArchiveKey(WORKSPACE)
const ARTIFACT_KEY = optimizeArtifactStorageKey(WORKSPACE)

interface FakeEvent { type: string; seq: number; time: number; data: any; surfaceOp?: string; ignorable?: true }

class FakeSession {
  readonly events: FakeEvent[] = []
  readonly header = { id: SESSION_ID }
  firstLiveSeq: number
  constructor(firstLiveSeq: number) { this.firstLiveSeq = firstLiveSeq }
  append(type: string, data: any, opts?: { ignorable?: true; surfaceOp?: string }): FakeEvent {
    const event: FakeEvent = { type, seq: this.events.length, time: 1000 + this.events.length, data }
    if (opts?.surfaceOp !== undefined) event.surfaceOp = opts.surfaceOp
    if (opts?.ignorable === true) event.ignorable = true
    this.events.push(event)
    return event
  }
  snapshotEvents(): readonly FakeEvent[] { return this.events.slice() }
  eventAt(seq: number): FakeEvent | undefined { return this.events[seq] }
}

/** 持久化种子会话：user(A) → task close(task-1) → user(B) → judge-recorded 标注 A。 */
function makeResumedSession(): FakeSession {
  const session = new FakeSession(4)
  const text = (value: string) => ({ type: 'text', text: value })
  session.events.push(
    { type: 'user/message', seq: 0, time: 100, data: { content: [text('做 A')], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'context-economy/task-boundary', seq: 1, time: 101, data: { boundary: 'close', taskId: 'task-1' } },
    { type: 'user/message', seq: 2, time: 102, data: { content: [text('做 B')], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'context-economy/judge-recorded', seq: 3, time: 103, data: { seq: 0, time: 100, trigger: 'turn-end', decision: 'pureQ', class: 'action' } },
  )
  return session
}

interface StoredRecord { schemaVersion: number; version: number; source: any; body: unknown }

class FakeStorage {
  readonly entities = new Map<string, StoredRecord>()
  readonly snapshots = new Map<string, StoredRecord[]>()
  readonly writes: Array<{ table: string; key: string; body: unknown; source: any; baseVersion: number }> = []
  readonly rollbacks: Array<{ table: string; key: string; target: number }> = []
  mirror: Array<{ type: string; seq?: number; sessionId?: string; time: number; data: unknown }> = []
  private id(table: string, key: string): string { return table + ':' + key }
  seed(table: string, key: string, body: unknown, version = 1, schemaVersion = 1): void {
    const id = this.id(table, key)
    const current = this.entities.get(id)
    if (current !== undefined) this.snapshots.set(id, [...(this.snapshots.get(id) ?? []), current])
    this.entities.set(id, {
      schemaVersion, version, source: { taskId: 'seed', eventType: 'seed' }, body,
    })
  }
  getEntity(table: any, key: string): StoredRecord | undefined { return this.entities.get(this.id(table, key)) }
  async putEntity(table: any, key: string, body: unknown, source: any, options?: { baseVersion?: number }): Promise<StoredRecord> {
    const id = this.id(table, key)
    const current = this.entities.get(id)
    const base = options?.baseVersion ?? 0
    if (base === 0) { if (current !== undefined) throw new Error('CAS') }
    else if (current === undefined || current.version !== base) throw new Error('CAS')
    this.writes.push({ table, key, body, source, baseVersion: base })
    if (current !== undefined) this.snapshots.set(id, [...(this.snapshots.get(id) ?? []), current])
    const next: StoredRecord = { schemaVersion: 1, version: base === 0 ? 1 : base + 1, source, body }
    this.entities.set(id, next)
    return next
  }
  async rollbackEntity(table: any, key: string, targetVersion: number): Promise<StoredRecord> {
    const id = this.id(table, key)
    const current = this.entities.get(id)
    if (current === undefined) throw new Error('no current')
    this.rollbacks.push({ table, key, target: targetVersion })
    const target = (this.snapshots.get(id) ?? []).find((snap) => snap.version === targetVersion)
    if (target === undefined) throw new Error('no snapshot')
    this.snapshots.set(id, [...(this.snapshots.get(id) ?? []), current])
    this.entities.set(id, { ...target, version: targetVersion, source: { taskId: 'rollback', eventType: 'rollback' } })
    return this.entities.get(id)!
  }
  auditEntity(table: any, key: string): StoredRecord[] {
    const id = this.id(table, key)
    const all = [...(this.snapshots.get(id) ?? [])]
    const current = this.entities.get(id)
    if (current !== undefined) all.push(current)
    return all.sort((a, b) => a.version - b.version)
  }
  listFactMirror(sessionId?: string) {
    return [...this.mirror].filter((record) => sessionId === undefined || record.sessionId === sessionId)
  }
  writeFactMirror(type: string, data: unknown, meta?: { sessionId?: string }): void { this.mirror.push({ type, time: 1, ...(meta?.sessionId === undefined ? {} : { sessionId: meta.sessionId }), data }) }
  stats() { return { factMirrorCount: this.mirror.length, factMirrorDurabilityErrors: 0, entityCounts: {} as any } }
  async close(): Promise<void> {}
}

function mount(storage: FakeStorage, drill?: any) {
  const warns: unknown[][] = []
  const domain = mountRestoreDomain({
    storage: storage as unknown as ContextEconomyStorage,
    logger: { info() {}, warn: (...args: unknown[]) => { warns.push(args) }, error() {} },
    workspace: WORKSPACE,
    now: () => 500,
    ...(drill === undefined ? {} : { drill }),
  })
  return { domain, warns }
}

const stepOf = (result: any, step: string) => result.steps.find((item: any) => item.step === step)
const degradationsOf = (result: any, step: string) => result.degraded.filter((item: any) => item.step === step)

describe('P21a 恢复域端到端', () => {
  it('fresh 会话（firstLiveSeq = 0）零动作零事实', async () => {
    const storage = new FakeStorage()
    const session = new FakeSession(0)
    const { domain } = mount(storage)
    const result = await domain.onSessionStart({ session: session as unknown as Session, source: 'startup' })
    expect(result.ran).toBe(false)
    expect(session.events).toHaveLength(0)
    expect(domain.stats().skipped).toBe(1)
  })

  it('KV 全空 + 种子会话：卷宗重放写回、项目帧无快照降级、档案/产物降级、段与度量重算', async () => {
    const storage = new FakeStorage()
    const session = makeResumedSession()
    const { domain } = mount(storage)
    const result = await domain.onSessionStart({ session: session as unknown as Session, source: 'resume' })
    expect(result.ran).toBe(true)
    expect(result.steps).toHaveLength(6)
    expect(stepOf(result, 'dossier').outcome).toBe('rebuilt')
    expect(stepOf(result, 'dossier').rebuilt).toBe(2)
    expect(stepOf(result, 'project_frame').outcome).toBe('degraded')
    expect(stepOf(result, 'boundary_archive').outcome).toBe('degraded')
    expect(stepOf(result, 'optimize_artifact').outcome).toBe('degraded')
    expect(stepOf(result, 'segment_state').outcome).toBe('rebuilt')
    expect(stepOf(result, 'segment_state').rebuilt).toBe(2)
    expect(stepOf(result, 'metrics_cache').outcome).toBe('rebuilt')

    const dossierWrites = storage.writes.filter((write) => write.table === 'dossier')
    expect(dossierWrites.map((write) => write.key).sort()).toEqual([DOSSIER_1, DOSSIER_2].sort())
    expect(dossierWrites.every((write) => write.source.eventType === 'restore-rebuild' && write.baseVersion === 0)).toBe(true)
    const rebuilt1 = dossierWrites.find((write) => write.key === DOSSIER_1)!
    expect((rebuilt1.body as any).messages.map((m: any) => m.seq)).toEqual([0])
    expect((rebuilt1.body as any).annotations['0']![0]).toMatchObject({ class: 'action', by: 'auto' })

    expect(degradationsOf(result, 'project_frame').map((item: any) => item.code)).toEqual(['missing'])
    expect(degradationsOf(result, 'boundary_archive').map((item: any) => item.code)).toEqual(['missing'])
    expect(storage.writes.some((write) => write.table === 'boundary_archive')).toBe(false)
  })

  it('盘上卷宗可用 → 步 ok 且零写', async () => {
    const storage = new FakeStorage()
    storage.seed('dossier', DOSSIER_1, { taskId: 'sess-1:task-1', messages: [{ seq: 0, time: 100, text: '做 A' }], annotations: {} })
    storage.seed('dossier', DOSSIER_2, { taskId: 'sess-1:task-2', messages: [{ seq: 2, time: 102, text: '做 B' }], annotations: {} })
    const session = makeResumedSession()
    const { domain } = mount(storage)
    const result = await domain.run({ session: session as unknown as Session, source: 'resume' })
    expect(stepOf(result, 'dossier').outcome).toBe('ok')
    expect(storage.writes.filter((write) => write.table === 'dossier')).toHaveLength(0)
  })

  it('演练注入损坏卷宗 → 覆盖写（CAS 前进 + 损毁版留快照）', async () => {
    const storage = new FakeStorage()
    storage.seed('dossier', DOSSIER_1, { taskId: 'broken' }, 3)
    storage.seed('dossier', DOSSIER_2, { taskId: 'sess-1:task-2', messages: [{ seq: 2, time: 102, text: '做 B' }], annotations: {} })
    const session = makeResumedSession()
    const { domain } = mount(storage, { damaged: { [DOSSIER_1]: 'corrupt' } })
    const result = await domain.run({ session: session as unknown as Session, source: 'resume' })
    expect(stepOf(result, 'dossier').outcome).toBe('rebuilt')
    const write = storage.writes.find((item) => item.key === DOSSIER_1)!
    expect(write.baseVersion).toBe(3)
    expect(storage.getEntity('dossier', DOSSIER_1)!.version).toBe(4)
    expect(storage.auditEntity('dossier', DOSSIER_1).map((record) => record.version)).toEqual([3, 4])
    expect(degradationsOf(result, 'dossier').map((item: any) => item.code)).toEqual(['corrupt'])
  })

  it('项目帧损坏 + 存在合法快照 → 快照回退（rollbackEntity）', async () => {
    const storage = new FakeStorage()
    storage.seed('project_frame', FRAME_KEY, { goal: '旧', aspects: [], skillCatalog: { skills: [], complete: true } }, 1)
    storage.seed('project_frame', FRAME_KEY, { broken: true }, 2)
    const session = makeResumedSession()
    const { domain } = mount(storage)
    const result = await domain.run({ session: session as unknown as Session, source: 'resume' })
    expect(stepOf(result, 'project_frame').outcome).toBe('rebuilt')
    expect(storage.rollbacks).toEqual([{ table: 'project_frame', key: FRAME_KEY, target: 1 }])
    expect((storage.getEntity('project_frame', FRAME_KEY)!.body as any).goal).toBe('旧')
  })

  it('档案损坏 / 产物缺失 → 只降级，盘上字节不动', async () => {
    const storage = new FakeStorage()
    storage.seed('boundary_archive', ARCHIVE_KEY, { schemaVersion: 1, workspace: WORKSPACE, entries: [{ taskId: 't', kind: 'bogus', text: 'x' }] })
    const session = makeResumedSession()
    const { domain } = mount(storage)
    const result = await domain.run({ session: session as unknown as Session, source: 'resume' })
    expect(degradationsOf(result, 'boundary_archive').map((item: any) => item.code)).toEqual(['corrupt'])
    expect(degradationsOf(result, 'optimize_artifact').map((item: any) => item.code)).toEqual(['missing'])
    expect(storage.writes.filter((write) => write.table !== 'dossier')).toHaveLength(0)
    expect((storage.getEntity('boundary_archive', ARCHIVE_KEY)!.body as any).entries).toHaveLength(1)
  })

  it('F3：恢复键按会话 header.cwd（跨项目会话不互踩）', async () => {
    const storage = new FakeStorage()
    const session = makeResumedSession()
    ;(session.header as { id: string; cwd?: string }).cwd = 'C:\\proj\\a\\'
    const { domain } = mount(storage)
    const result = await domain.onSessionStart({ session: session as unknown as Session, source: 'resume' })
    expect(stepOf(result, 'boundary_archive').entityKey).toBe(boundaryArchiveKey('C:/proj/a'))
    expect(stepOf(result, 'optimize_artifact').entityKey).toBe(optimizeArtifactStorageKey('C:/proj/a'))
    expect(stepOf(result, 'project_frame').entityKey).toBe(projectFrameStorageKey('C:/proj/a'))
  })

  it('U7：双源真矛盾（同 type+time 不同内容）→ mirror-divergence 降级；降级模式单侧镜像不再常真告警', async () => {
    // 真矛盾：镜像与日志同身份（task-boundary @ time 101）但内容不同
    const storage = new FakeStorage()
    storage.mirror = [{ type: 'context-economy/task-boundary', sessionId: SESSION_ID, time: 101, data: { boundary: 'open', taskId: 'task-1' } }]
    const session = makeResumedSession()
    const { domain } = mount(storage)
    const result = await domain.run({ session: session as unknown as Session, source: 'resume' })
    expect(degradationsOf(result, 'metrics_cache').map((item: any) => item.code)).toEqual(['mirror-divergence'])
    expect(stepOf(result, 'metrics_cache').outcome).toBe('degraded')
  })

  it('U7：降级模式（镜像单侧持有事实）→ 不判漂移（旧实现 = 镜像非空即常真告警）', async () => {
    const storage = new FakeStorage()
    storage.mirror = [
      { type: 'context-economy/judge-recorded', sessionId: SESSION_ID, time: 900, data: { seq: 0, decision: 'continue', class: 'action' } },
      { type: 'context-economy/judge-recorded', sessionId: 'other-session', time: 101, data: { seq: 0, decision: 'new-task' } },
    ]
    const session = makeResumedSession()
    const { domain } = mount(storage)
    const result = await domain.run({ session: session as unknown as Session, source: 'resume' })
    expect(degradationsOf(result, 'metrics_cache')).toEqual([])
    expect(stepOf(result, 'metrics_cache').outcome).toBe('rebuilt')
  })

  it('事实全部 ignorable + 账本 fold 可回放（restoreDegraded）', async () => {
    const storage = new FakeStorage()
    const session = makeResumedSession()
    const { domain } = mount(storage)
    await domain.onSessionStart({ session: session as unknown as Session, source: 'resume' })
    const facts = session.events.slice(4).filter((event) => event.type.startsWith('context-economy/'))
    expect(facts.length).toBeGreaterThan(6)
    expect(facts.every((event) => event.ignorable === true)).toBe(true)
    expect(facts.some((event) => event.type === RESTORE_STEP_FACT_TYPE)).toBe(true)
    expect(facts.some((event) => event.type === RESTORE_DEGRADED_FACT_TYPE)).toBe(true)
    expect(facts.some((event) => event.type === RESTORE_DONE_FACT_TYPE)).toBe(true)
    const ledger = foldRestoreLedger(facts.map((event) => ({ type: event.type, seq: event.seq, time: event.time, data: event.data })))
    expect(ledger.restoreRuns).toBe(1)
    expect(ledger.restoreSteps.dossier).toBe(1)
    expect(ledger.restoreDegraded).toBeGreaterThan(0)
    expect(ledger.lastDone!.steps).toBe(6)
  })

  it('同会话重复 session-start 幂等（第二次不跑）', async () => {
    const storage = new FakeStorage()
    const session = makeResumedSession()
    const { domain } = mount(storage)
    const first = await domain.onSessionStart({ session: session as unknown as Session, source: 'resume' })
    const second = await domain.onSessionStart({ session: session as unknown as Session, source: 'resume' })
    expect(first.ran).toBe(true)
    expect(second.ran).toBe(false)
    expect(domain.stats().runs).toBe(1)
  })

  it('结构版本不符（schemaVersion=2）→ version-mismatch 记账', async () => {
    const storage = new FakeStorage()
    storage.seed('optimize_artifact', ARTIFACT_KEY, { taskId: 't', sessionId: 's', judgeTable: { version: 1, aspects: [], fileSignatures: [], keywords: [] } }, 1, 2)
    const session = makeResumedSession()
    const { domain } = mount(storage)
    const result = await domain.run({ session: session as unknown as Session, source: 'resume' })
    expect(degradationsOf(result, 'optimize_artifact').map((item: any) => item.code)).toEqual(['version-mismatch'])
    const facts = session.events.filter((event) => event.type.startsWith('context-economy/'))
    expect(foldRestoreLedger(facts.map((event) => ({ type: event.type, seq: event.seq, time: event.time, data: event.data }))).versionMismatches).toBe(1)
  })
})

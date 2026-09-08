/**
 * P9 卷宗纯核测试（docs/implement/archive/P9-dossier.md §3.2）。
 * 九组用例：纯核语义、P8 集成、确定性、P3 持久契约；fake 域，零 cordis 运行时。
 */
import { describe, expect, it } from 'vitest'
import {
  DOSSIER_CLASSES,
  appendDossierMessage,
  annotateDossier,
  backfillDossier,
  createDossier,
  dossierStorageKey,
  sessionScopedTaskId,
  foldDossierLedger,
  isDossierShort,
  type DossierBody,
  type DossierMessage,
} from '../src/core/dossier.ts'
import { estimateTokens } from '../src/core/ledger/fold.ts'
import { TASK_BOUNDARY_FACT_TYPE } from '../src/core/ledger/index.ts'
import { foldSegmentState } from '../src/core/units.ts'
import {
  CasMismatchError,
  ENTITY_TABLES,
  openContextEconomyStorage,
  type ContextEconomyStorage,
} from '../src/platform/storage.ts'

class FakeTable<V> {
  private readonly map = new Map<string, V>()
  get(key: string): V | undefined { return this.map.get(key) }
  entries(): IterableIterator<[string, V]> { return this.map.entries() }
  keys(): IterableIterator<string> { return this.map.keys() }
  get size(): number { return this.map.size }
  async put(key: string, value: V): Promise<void> { this.map.set(key, value) }
  async delete(key: string): Promise<boolean> { return this.map.delete(key) }
  async update(key: string, fn: (current: V) => V): Promise<V> {
    if (!this.map.has(key)) throw new Error('missing-key')
    const next = fn(this.map.get(key)!)
    this.map.set(key, next)
    return next
  }
}

class FakeDomain {
  readonly tables = new Map<string, FakeTable<unknown>>()
  constructor() {
    for (const name of [...ENTITY_TABLES, 'fact_mirror', 'entity_snapshots']) this.tables.set(name, new FakeTable())
  }
  table(name: string): FakeTable<unknown> {
    const table = this.tables.get(name)
    if (!table) throw new Error(`no table ${name}`)
    return table
  }
  async close(): Promise<void> {}
}

async function makeStorage(): Promise<{ storage: ContextEconomyStorage }> {
  const domain = new FakeDomain()
  const ctx = { storageDomain: { open: async () => domain } }
  const storage = await openContextEconomyStorage(ctx as never)
  return { storage }
}

const msg = (seq: number, text: string, time = seq): DossierMessage => ({ seq, time, text })
const bodyWith = (messages: DossierMessage[]): DossierBody => {
  let body = createDossier('task-1')
  for (const m of messages) body = appendDossierMessage(body, m)
  return body
}

describe('dossier', () => {
  it('dossier create/storageKey: 空卷宗与 key 映射', () => {
    expect(createDossier('task-1')).toEqual({ taskId: 'task-1', messages: [], annotations: {} })
    expect(dossierStorageKey('task-1')).toBe('dossier:task-1')
    expect(sessionScopedTaskId('s1', 'task-1')).toBe('s1:task-1')
    expect(dossierStorageKey(sessionScopedTaskId('s1', 'task-1'))).toBe('dossier:s1:task-1')
    expect(DOSSIER_CLASSES).toEqual(['action', 'pureQ', 'verifyQ'])
  })

  it('dossier append: 正序新增对象、原对象不变、乱序/重复/空文本 no-op', () => {
    const base = createDossier('task-1')
    const v1 = appendDossierMessage(base, msg(1, 'hello'))
    expect(v1).not.toBe(base)
    expect(base.messages).toEqual([])
    expect(v1.messages).toEqual([msg(1, 'hello')])
    const v2 = appendDossierMessage(v1, msg(2, 'world'))
    expect(v2.messages).toHaveLength(2)
    expect(appendDossierMessage(v2, msg(1, 'dup'))).toBe(v2)
    expect(appendDossierMessage(v2, msg(2, 'repeat'))).toBe(v2)
    expect(appendDossierMessage(v2, msg(3, ''))).toBe(v2)
  })

  it('dossier annotate: 命中追加、未知 seq no-op、同 class+by 幂等', () => {
    const body = bodyWith([msg(1, 'a'), msg(2, 'b')])
    const a1 = annotateDossier(body, 1, 'action', 'auto', 10)
    expect(a1.annotations['1']).toEqual([{ class: 'action', by: 'auto', at: 10 }])
    expect(annotateDossier(body, 99, 'action', 'auto', 10)).toBe(body)
    const a2 = annotateDossier(a1, 1, 'action', 'auto', 20)
    expect(a2).toBe(a1)
    const a3 = annotateDossier(a1, 1, 'pureQ', 'auto', 20)
    expect(a3.annotations['1']).toHaveLength(2)
    expect(a3.annotations['1']!.at(-1)).toEqual({ class: 'pureQ', by: 'auto', at: 20 })
  })

  it('dossier backfill: 三态冲突计数与终审替换', () => {
    const noAuto = bodyWith([msg(1, 'a')])
    const r1 = backfillDossier(noAuto, { verdicts: { 1: 'action' }, at: 5 })
    expect(r1.conflicts).toBe(0)
    expect(r1.body.annotations['1']).toEqual([{ class: 'action', by: 'backfill', at: 5 }])

    const same = annotateDossier(bodyWith([msg(1, 'a')]), 1, 'action', 'auto', 1)
    const r2 = backfillDossier(same, { verdicts: { 1: 'action' }, at: 5 })
    expect(r2.conflicts).toBe(0)
    expect(r2.body.annotations['1']).toEqual([{ class: 'action', by: 'backfill', at: 5 }])

    const diff = annotateDossier(bodyWith([msg(1, 'a')]), 1, 'action', 'auto', 1)
    const r3 = backfillDossier(diff, { verdicts: { 1: 'pureQ' }, at: 5 })
    expect(r3.conflicts).toBe(1)
    expect(r3.body.annotations['1']).toEqual([{ class: 'pureQ', by: 'backfill', at: 5 }])

    const original = bodyWith([msg(1, 'a')])
    const ignore = backfillDossier(original, { verdicts: { 99: 'action' }, at: 5 })
    expect(ignore.conflicts).toBe(0)
    expect(ignore.body).toBe(original)
  })

  it('dossier leader: 手算计数/token/annotationCounts 只看每 seq 最后一条', () => {
    let body = bodyWith([msg(1, 'abc'), msg(2, 'de')])
    body = annotateDossier(body, 1, 'action', 'auto', 1)
    body = annotateDossier(body, 1, 'pureQ', 'auto', 2)
    body = annotateDossier(body, 2, 'verifyQ', 'auto', 3)
    const ledger = foldDossierLedger(body)
    expect(ledger.messageCount).toBe(2)
    expect(ledger.textLength).toBe(5)
    expect(ledger.ctxTokens).toBe(estimateTokens('abc\nde'))
    expect(ledger.annotationCounts).toEqual({ action: 0, pureQ: 1, verifyQ: 1 })
    const after = backfillDossier(body, { verdicts: { 1: 'action' }, at: 4 }).body
    expect(foldDossierLedger(after).annotationCounts).toEqual({ action: 1, pureQ: 0, verifyQ: 1 })
  })

  it('dossier short: 门控按消息数或文本长度任一不足', () => {
    const gate = { minMessages: 2, minTextLength: 10 }
    expect(isDossierShort(bodyWith([msg(1, 'long enough text')]), gate)).toBe(true)
    expect(isDossierShort(bodyWith([msg(1, 'hi'), msg(2, 'ok')]), gate)).toBe(true)
    expect(isDossierShort(bodyWith([msg(1, 'hello world'), msg(2, 'second text')]), gate)).toBe(false)
  })

  it('dossier P8 integration: foldSegmentState 两个 task 各自卷宗边界清空', () => {
    const state = foldSegmentState([
      { type: TASK_BOUNDARY_FACT_TYPE, seq: 1, time: 1, data: { taskId: 'task-1' } },
    ])
    expect(state.segments.map((s) => s.taskId)).toEqual(['task-1', 'task-2'])
    const k1 = dossierStorageKey('task-1')
    const k2 = dossierStorageKey('task-2')
    expect(k1).not.toBe(k2)
    const d1 = appendDossierMessage(createDossier('task-1'), msg(1, 'task one'))
    expect(d1.messages).toHaveLength(1)
    expect(createDossier('task-2').messages).toEqual([])
  })

  it('dossier deterministic: foldDossierLedger 连续三次字节一致', () => {
    const body = annotateDossier(bodyWith([msg(1, 'a'), msg(2, 'b')]), 1, 'action', 'auto', 1)
    const a = JSON.stringify(foldDossierLedger(body))
    expect(JSON.stringify(foldDossierLedger(body))).toBe(a)
    expect(JSON.stringify(foldDossierLedger(body))).toBe(a)
  })

  it('dossier P3 persistence: putEntity 版本链/CAS/审计闭合', async () => {
    const { storage } = await makeStorage()
    const source = { taskId: 'task-1', eventType: 'dossier-append', evidence: { n: 1 } }
    const key = dossierStorageKey('task-1')
    const v1 = await storage.putEntity('dossier', key, createDossier('task-1'), source)
    expect(v1.version).toBe(1)
    const v2body = appendDossierMessage(v1.body as DossierBody, msg(1, 'hello'))
    const v2 = await storage.putEntity('dossier', key, v2body, source, { baseVersion: 1 })
    expect(v2.version).toBe(2)
    const v3body = backfillDossier(v2.body as DossierBody, { verdicts: { 1: 'action' }, at: 9 }).body
    const v3 = await storage.putEntity('dossier', key, v3body, source, { baseVersion: 2 })
    expect(v3.version).toBe(3)
    const audit = storage.auditEntity('dossier', key)
    expect(audit.map((r) => r.version)).toEqual([1, 2, 3])
    expect((audit[1]!.body as DossierBody).messages).toHaveLength(1)
    expect((audit[2]!.body as DossierBody).annotations['1']).toEqual([{ class: 'action', by: 'backfill', at: 9 }])
    await expect(storage.putEntity('dossier', key, {}, source, { baseVersion: 1 }))
      .rejects.toBeInstanceOf(CasMismatchError)
  })
})

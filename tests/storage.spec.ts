/**
 * P3 持久面单测（docs/implement/P3-storage.md §3.3）——全部 fake，零 cordis 运行时直连。
 * 覆盖：域声明合法、无 source 拒绝、CAS 创建/更新/冲突、快照与审计、回滚、
 * 事实镜像（同毫秒不覆盖）、FactMirrorRecord ↔ LedgerFact 类型级等价。
 */
import { describe, expect, it } from 'vitest'
import {
  CasMismatchError,
  CE_STORAGE_DOMAIN,
  CE_STORAGE_SCHEMA_VERSION,
  CE_STORAGE_SPEC,
  ENTITY_TABLES,
  SNAPSHOT_LIMIT,
  openContextEconomyStorage,
  type ContextEconomyStorage,
  type FactMirrorRecord,
} from '../src/platform/storage.ts'
import type { LedgerFact } from '../src/core/ledger/types.ts'

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
    for (const name of [...ENTITY_TABLES, 'fact_mirror', 'entity_snapshots']) {
      this.tables.set(name, new FakeTable())
    }
  }
  table(name: string): FakeTable<unknown> {
    const table = this.tables.get(name)
    if (!table) throw new Error(`no table ${name}`)
    return table
  }
  async close(): Promise<void> {}
}

async function makeStorage(now: () => number = () => 0): Promise<{ storage: ContextEconomyStorage; domain: FakeDomain; opened: unknown[] }> {
  const domain = new FakeDomain()
  const opened: unknown[] = []
  const ctx = {
    storageDomain: {
      open: async (spec: unknown) => {
        opened.push(spec)
        return domain
      },
    },
  }
  const storage = await openContextEconomyStorage(ctx as never, { now })
  return { storage, domain, opened }
}

const source = { taskId: 'task-1', eventType: 'init', evidence: { n: 1 } }

describe('P3 持久面', () => {
  it('1. 域声明合法：名称/版本/表集合/N=50', () => {
    expect(CE_STORAGE_DOMAIN).toBe('context_economy')
    expect(CE_STORAGE_SCHEMA_VERSION).toBe(1)
    expect(SNAPSHOT_LIMIT).toBe(50)
    expect(() => CE_STORAGE_SPEC).not.toThrow()
    expect(Object.keys(CE_STORAGE_SPEC.tables).sort()).toEqual(
      [...ENTITY_TABLES, 'fact_mirror', 'entity_snapshots'].sort(),
    )
  })

  it('2. 无 source 拒绝：taskId/eventType 空白均抛 SOURCE_REQUIRED', async () => {
    const { storage } = await makeStorage()
    await expect(storage.putEntity('dossier', 'k', {}, { taskId: '', eventType: 'x', evidence: null }))
      .rejects.toMatchObject({ code: 'SOURCE_REQUIRED' })
    await expect(storage.putEntity('dossier', 'k', {}, { taskId: 't', eventType: '  ', evidence: null }))
      .rejects.toMatchObject({ code: 'SOURCE_REQUIRED' })
  })

  it('3. 创建 v1：写入/读取/计数', async () => {
    const { storage } = await makeStorage()
    const rec = await storage.putEntity('dossier', 'k', { a: 1 }, source)
    expect(rec).toEqual({ schemaVersion: 1, version: 1, source, body: { a: 1 } })
    expect(storage.getEntity('dossier', 'k')).toEqual(rec)
    expect(storage.stats().entityCounts.dossier).toBe(1)
  })

  it('4. CAS 创建冲突：baseVersion:0 对已存在 key 拒绝且记录不变', async () => {
    const { storage } = await makeStorage()
    await storage.putEntity('dossier', 'k', { a: 1 }, source)
    await expect(storage.putEntity('dossier', 'k', { a: 2 }, source, { baseVersion: 0 }))
      .rejects.toBeInstanceOf(CasMismatchError)
    expect(storage.getEntity('dossier', 'k')?.version).toBe(1)
  })

  it('5. CAS 更新 + 快照：v2 可读，审计 [v1,v2]，快照含 v1', async () => {
    const { storage, domain } = await makeStorage()
    await storage.putEntity('dossier', 'k', { a: 1 }, source)
    await storage.putEntity('dossier', 'k', { a: 2 }, source, { baseVersion: 1 })
    expect(storage.getEntity('dossier', 'k')?.body).toEqual({ a: 2 })
    const audit = storage.auditEntity('dossier', 'k')
    expect(audit.map((r) => r.version)).toEqual([1, 2])
    expect(audit[0]!.body).toEqual({ a: 1 })
    expect(audit[1]!.body).toEqual({ a: 2 })
    const snapshots = domain.table('entity_snapshots')
    expect(snapshots.size).toBe(1)
    const snap = [...snapshots.entries()][0]![1] as { record: { version: number; body: unknown } }
    expect(snap.record.version).toBe(1)
    expect(snap.record.body).toEqual({ a: 1 })
  })

  it('6. CAS 版本冲突：baseVersion 非当前拒绝且写不穿透', async () => {
    const { storage } = await makeStorage()
    await storage.putEntity('dossier', 'k', { a: 1 }, source)
    await storage.putEntity('dossier', 'k', { a: 2 }, source, { baseVersion: 1 })
    await expect(storage.putEntity('dossier', 'k', { a: 3 }, source, { baseVersion: 1 }))
      .rejects.toMatchObject({ code: 'CAS_MISMATCH' })
    expect(storage.getEntity('dossier', 'k')?.version).toBe(2)
    expect(storage.getEntity('dossier', 'k')?.body).toEqual({ a: 2 })
  })

  it('7. 回滚：目标版本恢复、source 为 rollback、no-op、不存在目标、审计仍见历史', async () => {
    const { storage } = await makeStorage()
    await storage.putEntity('dossier', 'k', { v: 1 }, source)
    await storage.putEntity('dossier', 'k', { v: 2 }, source, { baseVersion: 1 })
    await storage.putEntity('dossier', 'k', { v: 3 }, source, { baseVersion: 2 })
    const rolled = await storage.rollbackEntity('dossier', 'k', 1)
    expect(rolled.version).toBe(1)
    expect(rolled.body).toEqual({ v: 1 })
    expect(rolled.source.eventType).toBe('rollback')
    expect(rolled.source.evidence).toEqual({ fromVersion: 3, toVersion: 1 })
    const noop = await storage.rollbackEntity('dossier', 'k', 1)
    expect(noop.version).toBe(1)
    await expect(storage.rollbackEntity('dossier', 'k', 99))
      .rejects.toMatchObject({ code: 'ROLLBACK_TARGET_NOT_FOUND' })
    const audit = storage.auditEntity('dossier', 'k')
    expect(audit.map((r) => r.version)).toEqual([1, 2, 3])
    expect(audit[1]!.body).toEqual({ v: 2 })
    expect(audit[2]!.body).toEqual({ v: 3 })
  })

  it('8. 事实镜像：固定 now、同 type 同 time 不互相覆盖、seq 缺省', async () => {
    const { storage } = await makeStorage(() => 1234)
    storage.writeFactMirror('context-economy/task-boundary', { x: 1 })
    storage.writeFactMirror('context-economy/task-boundary', { x: 2 })
    const list = storage.listFactMirror()
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({ type: 'context-economy/task-boundary', time: 1234, data: { x: 1 } })
    expect(list[1]).toEqual({ type: 'context-economy/task-boundary', time: 1234, data: { x: 2 } })
    expect(list[0]!.seq).toBeUndefined()
    expect(storage.stats().factMirrorCount).toBe(2)
  })

  it('9. type-level 等价：FactMirrorRecord ↔ LedgerFact 双向结构等价', () => {
    const toLedger: LedgerFact = null as unknown as FactMirrorRecord
    const toMirror: FactMirrorRecord = null as unknown as LedgerFact
    void toLedger
    void toMirror
  })
})

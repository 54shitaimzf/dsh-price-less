/**
 * 持久面（docs/11 §2 storage.ts / docs/09 §1–§6 / docs/13 §3.6）。
 * storageDomain 封装：四实体表 + fact_mirror + entity_snapshots，source 强制、
 * CAS 版本写、快照回滚（N=50）、审计、事实镜像失败计数。不 import core、无 timer。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import type { CeLogger } from './events.ts'

export const CE_STORAGE_DOMAIN = 'context_economy'
export const CE_STORAGE_SCHEMA_VERSION = 1
export const ENTITY_TABLES = ['dossier', 'project_frame', 'boundary_archive', 'optimize_artifact'] as const
export type EntityTableName = (typeof ENTITY_TABLES)[number]
export const SNAPSHOT_LIMIT = 50

const entityEnvelopeSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  source: z.object({ taskId: z.string(), eventType: z.string(), evidence: z.unknown() }),
  body: z.unknown(),
})
const factMirrorRecordSchema = z.object({
  type: z.string(),
  seq: z.number().int().nonnegative().optional(),
  time: z.number(),
  data: z.unknown(),
})
const entitySnapshotSchema = z.object({
  entityType: z.string(),
  entityKey: z.string(),
  record: entityEnvelopeSchema,
  savedAt: z.number(),
})

/** context_economy storageDomain 静态声明（harness 在 open 时按表 zod 校验）。 */
export const CE_STORAGE_SPEC = defineDomain({
  name: CE_STORAGE_DOMAIN,
  version: CE_STORAGE_SCHEMA_VERSION,
  tables: {
    dossier: domainTable<string, EntityRecord>(entityEnvelopeSchema),
    project_frame: domainTable<string, EntityRecord>(entityEnvelopeSchema),
    boundary_archive: domainTable<string, EntityRecord>(entityEnvelopeSchema),
    optimize_artifact: domainTable<string, EntityRecord>(entityEnvelopeSchema),
    fact_mirror: domainTable<string, FactMirrorRecord>(factMirrorRecordSchema),
    entity_snapshots: domainTable<string, EntitySnapshotRecord>(entitySnapshotSchema),
  },
})

export interface EntitySource { taskId: string; eventType: string; evidence: unknown }
export interface EntityRecord { schemaVersion: number; version: number; source: EntitySource; body: unknown }
export interface FactMirrorRecord { type: string; seq?: number; time: number; data: unknown }
export interface EntitySnapshotRecord { entityType: string; entityKey: string; record: EntityRecord; savedAt: number }

export type StorageErrorCode = 'SOURCE_REQUIRED' | 'CAS_MISMATCH' | 'ROLLBACK_TARGET_NOT_FOUND'

export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, message: string) { super(message) }
}

export class CasMismatchError extends StorageError {
  constructor(message: string) { super('CAS_MISMATCH', message) }
}

export interface ContextEconomyStorage {
  getEntity(table: EntityTableName, key: string): EntityRecord | undefined
  putEntity(table: EntityTableName, key: string, body: unknown, source: EntitySource, options?: { baseVersion?: number }): Promise<EntityRecord>
  rollbackEntity(table: EntityTableName, key: string, targetVersion: number): Promise<EntityRecord>
  auditEntity(table: EntityTableName, key: string): EntityRecord[]
  listFactMirror(): FactMirrorRecord[]
  writeFactMirror(type: string, data: unknown): void
  stats(): { factMirrorCount: number; factMirrorDurabilityErrors: number; entityCounts: Record<EntityTableName, number> }
  close(): Promise<void>
}

function cloneRecord(record: EntityRecord): EntityRecord {
  return { ...record, source: { ...record.source }, body: record.body }
}
function cloneEntityRecords(records: EntityRecord[]): EntityRecord[] { return records.map(cloneRecord) }

export async function openContextEconomyStorage(
  ctx: Pick<Context, 'storageDomain'>,
  options: { logger?: CeLogger; now?: () => number } = {},
): Promise<ContextEconomyStorage> {
  const domain = await ctx.storageDomain.open(CE_STORAGE_SPEC)
  const now = options.now ?? Date.now
  const logger = options.logger

  const entityTables = new Map<EntityTableName, KvTable<string, EntityRecord>>()
  for (const name of ENTITY_TABLES) entityTables.set(name, domain.table(name) as unknown as KvTable<string, EntityRecord>)
  const factMirrorTable = domain.table('fact_mirror') as unknown as KvTable<string, FactMirrorRecord>
  const snapshotTable = domain.table('entity_snapshots') as unknown as KvTable<string, EntitySnapshotRecord>

  const durability = { factMirrorDurabilityErrors: 0 }
  let mirrorSeq = 0

  const snapshotKey = (table: string, version: number, key: string): string => JSON.stringify([table, version, key])

  const snapshotMatches = (table: EntityTableName, key: string): Array<{ snapKey: string; snap: EntitySnapshotRecord }> => {
    const out: Array<{ snapKey: string; snap: EntitySnapshotRecord }> = []
    for (const [snapKey, snap] of snapshotTable.entries()) {
      if (snap.entityType === table && snap.entityKey === key) out.push({ snapKey, snap })
    }
    return out
  }

  const pruneSnapshots = async (table: EntityTableName, key: string): Promise<void> => {
    const matches = snapshotMatches(table, key)
    if (matches.length <= SNAPSHOT_LIMIT) return
    matches.sort((a, b) => a.snap.savedAt - b.snap.savedAt)
    for (const { snapKey } of matches.slice(0, matches.length - SNAPSHOT_LIMIT)) await snapshotTable.delete(snapKey)
  }

  const getEntity = (table: EntityTableName, key: string): EntityRecord | undefined => entityTables.get(table)?.get(key)

  const putEntity = async (
    table: EntityTableName,
    key: string,
    body: unknown,
    source: EntitySource,
    options: { baseVersion?: number } = {},
  ): Promise<EntityRecord> => {
    if (typeof source?.taskId !== 'string' || source.taskId.trim() === ''
      || typeof source?.eventType !== 'string' || source.eventType.trim() === '') {
      throw new StorageError('SOURCE_REQUIRED', 'putEntity requires non-empty source.taskId and source.eventType')
    }
    const tableHandle = entityTables.get(table)!
    const current = tableHandle.get(key)
    const baseVersion = options.baseVersion ?? 0
    let version: number
    if (baseVersion === 0) {
      if (current !== undefined) throw new CasMismatchError(`cannot create '${key}': record already exists (version ${current.version})`)
      version = 1
    } else {
      if (current === undefined || current.version !== baseVersion) {
        throw new CasMismatchError(`CAS mismatch for '${key}': expected baseVersion ${baseVersion}, got ${current?.version ?? 'absent'}`)
      }
      version = baseVersion + 1
    }
    const next: EntityRecord = { schemaVersion: CE_STORAGE_SCHEMA_VERSION, version, source, body }
    if (current !== undefined) {
      const snap: EntitySnapshotRecord = { entityType: table, entityKey: key, record: current, savedAt: now() }
      await snapshotTable.put(snapshotKey(table, current.version, key), snap)
    }
    await tableHandle.put(key, next)
    await pruneSnapshots(table, key)
    return cloneRecord(next)
  }

  const rollbackEntity = async (
    table: EntityTableName,
    key: string,
    targetVersion: number,
  ): Promise<EntityRecord> => {
    const tableHandle = entityTables.get(table)!
    const current = tableHandle.get(key)
    if (current === undefined) throw new StorageError('ROLLBACK_TARGET_NOT_FOUND', `no current record for '${key}' to rollback`)
    if (targetVersion === current.version) return cloneRecord(current)
    if (targetVersion < 1 || targetVersion > current.version) {
      throw new StorageError('ROLLBACK_TARGET_NOT_FOUND', `target version ${targetVersion} out of range for '${key}' (current ${current.version})`)
    }
    const target = snapshotMatches(table, key)
      .filter(({ snap }) => snap.record.version === targetVersion)
      .sort((a, b) => b.snap.savedAt - a.snap.savedAt)[0]
    if (target === undefined) throw new StorageError('ROLLBACK_TARGET_NOT_FOUND', `no snapshot at version ${targetVersion} for '${key}'`)
    const snap: EntitySnapshotRecord = { entityType: table, entityKey: key, record: current, savedAt: now() }
    await snapshotTable.put(snapshotKey(table, current.version, key), snap)
    const rolled: EntityRecord = {
      schemaVersion: CE_STORAGE_SCHEMA_VERSION,
      version: targetVersion,
      source: { taskId: 'rollback', eventType: 'rollback', evidence: { fromVersion: current.version, toVersion: targetVersion } },
      body: target.snap.record.body,
    }
    await tableHandle.put(key, rolled)
    await pruneSnapshots(table, key)
    return cloneRecord(rolled)
  }

  const auditEntity = (table: EntityTableName, key: string): EntityRecord[] => {
    const current = getEntity(table, key)
    const byVersion = new Map<number, { record: EntityRecord; savedAt: number }>()
    if (current !== undefined) byVersion.set(current.version, { record: current, savedAt: Number.POSITIVE_INFINITY })
    for (const { snap } of snapshotMatches(table, key)) {
      const existing = byVersion.get(snap.record.version)
      if (existing === undefined || snap.savedAt > existing.savedAt) byVersion.set(snap.record.version, { record: snap.record, savedAt: snap.savedAt })
    }
    return cloneEntityRecords([...byVersion.values()].sort((a, b) => a.record.version - b.record.version).map((x) => x.record))
  }

  const listFactMirror = (): FactMirrorRecord[] =>
    [...factMirrorTable.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, record]) => ({ ...record }))

  const writeFactMirror = (type: string, data: unknown): void => {
    const time = now()
    const key = JSON.stringify([type, time, mirrorSeq++])
    const record: FactMirrorRecord = { type, time, data }
    void factMirrorTable.put(key, record).catch((e: unknown) => {
      durability.factMirrorDurabilityErrors++
      logger?.warn('context-economy: fact mirror durable write failed (contained, fail-lazy)', type, e instanceof Error ? e.message : String(e))
    })
  }

  const stats = (): { factMirrorCount: number; factMirrorDurabilityErrors: number; entityCounts: Record<EntityTableName, number> } => {
    const entityCounts = {} as Record<EntityTableName, number>
    for (const name of ENTITY_TABLES) entityCounts[name] = entityTables.get(name)?.size ?? 0
    return { factMirrorCount: factMirrorTable.size, factMirrorDurabilityErrors: durability.factMirrorDurabilityErrors, entityCounts }
  }

  return {
    getEntity, putEntity, rollbackEntity, auditEntity, listFactMirror, writeFactMirror, stats,
    close: async () => { await domain.close() },
  }
}

/**
 * 恢复序纯核：步序词表与实体审计（docs/09 §4 恢复契约 + docs/10 §1 H9；P21a）。
 * 纯函数：恢复步序（09 §4 顺序 + 第四实体补入）、KV 记录审计（missing / version-mismatch / corrupt）、
 * 各实体体形状校验器。**零模型、零 IO、零 harness import**（S1）；`at` 一律由域侧传入（D17）。
 *
 * 模块: core 恢复纯核（步序与审计）
 * 平面: L0（确定性判定；不读盘、不写 KV、不改史）
 * 回退链步数: 1（形状校验失败 → corrupt，调用侧降级不覆盖盘上字节）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D17）；不写事实、不改史。
 * 度量: 审计结果由域侧落 `restore-step` / `restore-degraded` 事实（07 `restoreDegraded`）。
 */
import { ARCHIVE_STORE_VERSION } from '../compress/store.ts'

/**
 * 恢复序（09 §4 顺序 + 本单补入第四实体 `optimize_artifact`，见工单 §8-1）。
 * 前四项 = durable KV 实体（可回退/可重放/只降级），后两项 = 纯函数重算。
 */
export const RESTORE_STEPS = [
  'project_frame',
  'dossier',
  'boundary_archive',
  'optimize_artifact',
  'segment_state',
  'metrics_cache',
] as const

export type RestoreStepName = (typeof RESTORE_STEPS)[number]

export type RestoreStepStrategy =
  | 'snapshot-rollback' // 项目帧：回退最新合法快照
  | 'log-replay'        // 卷宗：日志重放重建后写回
  | 'degrade-only'      // 边界档案：LLM 产物不可确定性再生 → 只降级
  | 'audit-only'        // 优化产物：只读校验 → 坏则降级
  | 'fold-recompute'    // 段状态机 / 度量缓存：纯函数重算

export interface RestoreStepSpec {
  readonly step: RestoreStepName
  readonly strategy: RestoreStepStrategy
  readonly entityTable?: 'project_frame' | 'dossier' | 'boundary_archive' | 'optimize_artifact'
  readonly canon: string
}

/** 恢复步序（只读常量；顺序 = 09 §4「先救最贵且全局的」）。 */
export const RESTORE_PLAN: readonly RestoreStepSpec[] = [
  { step: 'project_frame', strategy: 'snapshot-rollback', entityTable: 'project_frame', canon: '09 §4 项目帧：读盘 + 校验；退回上一版本；无版本 → 重新 init' },
  { step: 'dossier', strategy: 'log-replay', entityTable: 'dossier', canon: '09 §4 卷宗：读盘 + 版本校验；损毁 → 日志重放' },
  { step: 'boundary_archive', strategy: 'degrade-only', entityTable: 'boundary_archive', canon: '09 §4 边界档案：读盘 + hash；回退上一版本' },
  { step: 'optimize_artifact', strategy: 'audit-only', entityTable: 'optimize_artifact', canon: '09 §2 第四实体；09 §4 漏列 → 本单补入只读审计' },
  { step: 'segment_state', strategy: 'fold-recompute', canon: '09 §4 段状态机：会话日志 fold 回放重建；当作新 task' },
  { step: 'metrics_cache', strategy: 'fold-recompute', canon: '09 §4 度量加速缓存：重放重算；无损（账本在 JSONL）' },
]

export type EntityDamageCode = 'missing' | 'version-mismatch' | 'corrupt'

export interface EntityAudit {
  /** ok = 盘上记录可用；其余 = 损伤码（失败方向：调用侧按策略回退/重建/降级）。 */
  readonly state: 'ok' | EntityDamageCode
  readonly version?: number
  readonly reason?: string
}

/** KV 实体记录最小结构面（core 本地重声明；零 platform import，S1）。 */
export interface RestoreEntityRecord {
  readonly schemaVersion: number
  readonly version: number
  readonly source?: { readonly taskId?: unknown; readonly eventType?: unknown }
  readonly body: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 单条 KV 记录审计（顺序：缺失 → 结构版本 → 记录结构/source → 实体体形状）。
 * `source` 为空 = 无来源写入（09 §2 规则 2）→ corrupt。
 */
export function auditEntityRecord(
  record: RestoreEntityRecord | undefined,
  options: { schemaVersion: number; validate?: (body: unknown) => boolean; key?: string },
): EntityAudit {
  if (record === undefined) return { state: 'missing' }
  const version = record.version
  if (!Number.isInteger(version) || version < 1) {
    return { state: 'corrupt', version, reason: `invalid version ${String(version)}` }
  }
  if (record.schemaVersion !== options.schemaVersion) {
    return {
      state: 'version-mismatch',
      version,
      reason: `schemaVersion ${String(record.schemaVersion)} != ${options.schemaVersion}`,
    }
  }
  const source = record.source
  if (!isRecord(source) || typeof source.taskId !== 'string' || source.taskId.trim() === ''
    || typeof source.eventType !== 'string' || source.eventType.trim() === '') {
    return { state: 'corrupt', version, reason: 'missing or empty source (09 §2 rule 2)' }
  }
  if (options.validate !== undefined && !options.validate(record.body)) {
    return { state: 'corrupt', version, reason: 'body failed shape validation' }
  }
  return { state: 'ok', version }
}

/** 卷宗体形状（DossierBody：taskId + messages[{seq,time,text}] + annotations 记录）。 */
export function validateDossierBody(body: unknown): boolean {
  if (!isRecord(body)) return false
  if (typeof body.taskId !== 'string' || body.taskId === '') return false
  if (!Array.isArray(body.messages)) return false
  for (const message of body.messages) {
    if (!isRecord(message)) return false
    if (!Number.isInteger(message.seq) || typeof message.time !== 'number' || typeof message.text !== 'string') return false
  }
  return body.annotations === undefined || isRecord(body.annotations)
}

/** 项目帧体形状（ProjectFrameBody：goal + aspects[] + skillCatalog 快照）。 */
export function validateProjectFrameBody(body: unknown): boolean {
  if (!isRecord(body)) return false
  if (typeof body.goal !== 'string') return false
  if (!Array.isArray(body.aspects) || body.aspects.some((item) => typeof item !== 'string')) return false
  const catalog = body.skillCatalog
  if (!isRecord(catalog) || !Array.isArray(catalog.skills) || typeof catalog.complete !== 'boolean') return false
  return true
}

/** 边界档案体形状（ArchiveStoreBody：schemaVersion + workspace + entries[]；P20c 检查点字段可选）。 */
export function validateArchiveBody(body: unknown, workspace: string): boolean {
  if (!isRecord(body)) return false
  if (body.schemaVersion !== ARCHIVE_STORE_VERSION || body.workspace !== workspace) return false
  if (!Array.isArray(body.entries)) return false
  return body.entries.every((entry) => isRecord(entry)
    && typeof entry.taskId === 'string'
    && (entry.kind === 'checkpoint' || entry.kind === 'boundary')
    && typeof entry.text === 'string')
}

/** 优化产物体形状（OptimizeArtifactBody：judgeTable + product + taskId/sessionId）。 */
export function validateOptimizeArtifactBody(body: unknown): boolean {
  if (!isRecord(body)) return false
  if (typeof body.taskId !== 'string' || typeof body.sessionId !== 'string') return false
  const judgeTable = body.judgeTable
  if (!isRecord(judgeTable) || !Number.isInteger(judgeTable.version)) return false
  if (!Array.isArray(judgeTable.aspects) || !Array.isArray(judgeTable.fileSignatures) || !Array.isArray(judgeTable.keywords)) return false
  return true
}

/** 审计器按表取（未列出的表 = 无形状校验，只做版本/source 审计）。 */
export function bodyValidatorFor(table: RestoreStepSpec['entityTable'], workspace: string): ((body: unknown) => boolean) | undefined {
  switch (table) {
    case 'dossier': return validateDossierBody
    case 'project_frame': return validateProjectFrameBody
    case 'boundary_archive': return (body) => validateArchiveBody(body, workspace)
    case 'optimize_artifact': return validateOptimizeArtifactBody
    default: return undefined
  }
}

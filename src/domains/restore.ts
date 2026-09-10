/**
 * P21a 恢复编排（docs/09 §4 恢复契约 + docs/10 §1 H9；docs/11 §2 domains/restore.ts 行）。
 *
 * 一次恢复（H9 session-start 且 `firstLiveSeq > 0`）：
 *   全史自扫（`snapshotEvents`，种子不上 firehose）→ 按 09 §4 顺序逐项审计
 *   → 项目帧快照回退 / 卷宗日志重放写回 / 边界档案与优化产物降级 / 段状态机与度量缓存纯函数重算
 *   → `restore-step` + `restore-degraded` + `restore-done` 事实入账（07 `restoreDegraded`）。
 *
 * 模块: domains 恢复编排（core 纯核 + platform 端口）
 * 平面: L0（机械审计 + 确定性重放；**零模型调用**、零改史）
 * 回退链步数: 2（快照回退 → 日志重放写回 → 降级计数；失败默认保留盘上字节）
 * 审查清单: H9 只经 platform/agent-step（D16）；事实只经 logger.emitCeFact（S3/D3）；
 *           不 import llm/history/tools（恢复期零模型、零改史）；无 timer（S5）；纯核无时钟随机（D17）。
 * 度量: context-economy/restore-step|restore-degraded|restore-done（fold 见 core/restore/ledger.ts）。
 */
import type { Session } from '@deepseek-ai/dsh-session'
import { DOSSIER_CLASSES, type DossierClass, type DossierMessage } from '../core/dossier.ts'
import { projectFrameStorageKey } from '../core/prefix.ts'
import { factsFromSessionEvents } from '../core/ledger/facts.ts'
import type { LedgerFact, LedgerSessionEvent } from '../core/ledger/types.ts'
import { foldSegmentState } from '../core/units.ts'
import {
  RESTORE_PLAN,
  auditEntityRecord,
  bodyValidatorFor,
  mirrorDiverges,
  mirrorFactsOf,
  rebuildDossiers,
  type EntityDamageCode,
  type RestoreDegradedCode,
  type RestoreEntityRecord,
  type RestoreOutcome,
  type RestoreStepFactData,
  type RestoreSource,
  type RestoreStepName,
  type RestoreStepSpec,
} from '../core/restore/index.ts'
import { emitCeFact } from '../platform/logger.ts'
import { readSessionUserMessages, type CeLogger } from '../platform/events.ts'
import { CE_STORAGE_SCHEMA_VERSION, type ContextEconomyStorage } from '../platform/storage.ts'
import { boundaryArchiveKey } from './compaction.ts'
import { workspaceOf } from './workspace.ts'
import { optimizeArtifactStorageKey } from './star.ts'
import { JUDGE_RECORDED_FACT_TYPE } from './judge-facts.ts'
import {
  RESTORE_DEGRADED_FACT_TYPE,
  RESTORE_DONE_FACT_TYPE,
  RESTORE_STEP_FACT_TYPE,
  type RestoreDegradedFactData,
  type RestoreDoneFactData,
} from './restore-facts.ts'

/** 演练注入：把指定实体键当损毁（键 → 损伤码）；生产路径不传。 */
export interface RestoreDrillOptions {
  readonly damaged?: Readonly<Record<string, EntityDamageCode>>
}

export interface RestoreDomainDeps {
  storage: ContextEconomyStorage
  logger: CeLogger
  /** F3：仅作回落；键优先取会话 header.cwd。 */
  workspace?: string
  now?: () => number
  drill?: RestoreDrillOptions
}

export interface RestoreRunResult {
  readonly ran: boolean
  readonly source: RestoreSource
  readonly steps: readonly RestoreStepFactData[]
  readonly degraded: readonly RestoreDegradedFactData[]
  readonly rebuilt: number
}

export interface RestoreDomainStats {
  runs: number
  steps: number
  rebuilt: number
  degraded: number
  skipped: number
  internalErrors: number
}

export interface RestoreDomain {
  dispose(): void
  stats(): RestoreDomainStats
  /** H9 回调体：`firstLiveSeq > 0` 才跑；同会话幂等（WeakSet）。 */
  onSessionStart(payload: { session: Session; source: RestoreSource }): Promise<RestoreRunResult>
  /** 直接运行（演练/验收；不做 fresh/幂等门控）。 */
  run(payload: { session: Session; source: RestoreSource }): Promise<RestoreRunResult>
}

const NO_STEPS: readonly RestoreStepFactData[] = []
const INTERNAL_SPEC: RestoreStepSpec = { step: 'metrics_cache', strategy: 'fold-recompute', canon: 'P21a §4-9 失败遏制' }

function sessionIdOf(session: Session): string {
  const candidate = session as unknown as { header?: { id?: unknown }; id?: unknown }
  const header = candidate.header?.id
  return typeof header === 'string' ? header : String(candidate.id ?? 'session')
}

function firstLiveSeqOf(session: Session): number {
  const value = (session as unknown as { firstLiveSeq?: unknown }).firstLiveSeq
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function ledgerEventsOf(session: Session): LedgerSessionEvent[] {
  const snapshot = (session as unknown as { snapshotEvents?: () => readonly unknown[] }).snapshotEvents?.() ?? []
  const out: LedgerSessionEvent[] = []
  for (const raw of snapshot) {
    const event = raw as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown; surfaceOp?: unknown }
    if (typeof event.type !== 'string' || typeof event.seq !== 'number') continue
    out.push({
      type: event.type,
      seq: event.seq,
      time: typeof event.time === 'number' ? event.time : 0,
      data: event.data,
      ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
    })
  }
  return out
}

function firstUserSeq(events: readonly LedgerSessionEvent[]): number {
  for (const event of events) if (event.type === 'user/message' && event.surfaceOp === 'append') return event.seq
  return events[0]?.seq ?? 0
}

/** judge-recorded 事实 → 卷宗标注（`class` 合法的才回放；`by:'auto'`）。 */
function annotationsFromFacts(facts: readonly LedgerFact[]): Array<{ seq: number; class: DossierClass; at: number }> {
  const out: Array<{ seq: number; class: DossierClass; at: number }> = []
  for (const fact of facts) {
    if (fact.type !== JUDGE_RECORDED_FACT_TYPE) continue
    const data = fact.data as { seq?: unknown; time?: unknown; class?: unknown } | null | undefined
    if (data === null || typeof data !== 'object') continue
    if (!Number.isInteger(data.seq) || (data.seq as number) < 0) continue
    if (typeof data.class !== 'string' || !(DOSSIER_CLASSES as readonly string[]).includes(data.class)) continue
    out.push({
      seq: data.seq as number,
      class: data.class as DossierClass,
      at: typeof data.time === 'number' ? data.time : fact.time,
    })
  }
  return out
}

function asRestoreRecord(record: ReturnType<ContextEconomyStorage['getEntity']>): RestoreEntityRecord | undefined {
  if (record === undefined) return undefined
  return {
    schemaVersion: record.schemaVersion,
    version: record.version,
    source: record.source as { taskId?: unknown; eventType?: unknown },
    body: record.body,
  }
}

function entityKeyOf(spec: RestoreStepSpec, workspace: string): string {
  switch (spec.entityTable) {
    case 'project_frame': return projectFrameStorageKey(workspace)
    case 'boundary_archive': return boundaryArchiveKey(workspace)
    case 'optimize_artifact': return optimizeArtifactStorageKey(workspace)
    default: return ''
  }
}

/**
 * 创建恢复域。零模型、零改史：唯一写动作 = 卷宗重建写回 / 项目帧快照回退（均带 source）。
 */
export function mountRestoreDomain(deps: RestoreDomainDeps): RestoreDomain {
  const now = deps.now ?? Date.now
  const { storage, logger } = deps
  const drill = deps.drill?.damaged ?? {}
  const counters: RestoreDomainStats = { runs: 0, steps: 0, rebuilt: 0, degraded: 0, skipped: 0, internalErrors: 0 }
  const seen = new WeakSet<Session>()
  let disposed = false

  const run = async (payload: { session: Session; source: RestoreSource }): Promise<RestoreRunResult> => {
    const { session, source } = payload
    // F3：恢复键 = 会话工作区（跨项目会话不再互踩）。
    const workspace = workspaceOf(session, deps.workspace)
    const startedAt = now()
    const steps: RestoreStepFactData[] = []
    const degraded: RestoreDegradedFactData[] = []
    let rebuilt = 0

    const emitStep = (spec: RestoreStepSpec, outcome: RestoreOutcome, extra: Partial<RestoreStepFactData> = {}): void => {
      const fact: RestoreStepFactData = { at: now(), source, step: spec.step, outcome, ...extra }
      steps.push(fact)
      emitCeFact(session, RESTORE_STEP_FACT_TYPE, fact, logger)
    }
    const emitDegraded = (spec: RestoreStepSpec, code: RestoreDegradedCode, extra: Partial<RestoreDegradedFactData> = {}): void => {
      const fact: RestoreDegradedFactData = { at: now(), source, step: spec.step, code, ...extra }
      degraded.push(fact)
      emitCeFact(session, RESTORE_DEGRADED_FACT_TYPE, fact, logger)
    }

    const events = ledgerEventsOf(session)
    const facts = factsFromSessionEvents(events)
    const sessionId = sessionIdOf(session)
    const foldOptions = { sessionFirstSeq: firstUserSeq(events), sessionLastSeq: events.at(-1)?.seq }

    /** 卷宗步：逐键审计 + 日志重放重建写回（唯一多键步）。 */
    const runDossierStep = async (spec: RestoreStepSpec): Promise<void> => {
      const messages = readSessionUserMessages(session) as readonly DossierMessage[]
      const state = foldSegmentState([...facts], foldOptions)
      const rebuilds = rebuildDossiers({
        sessionId,
        segments: state.segments,
        messages,
        annotations: annotationsFromFacts(facts),
      })
      let wrote = 0
      let damaged = 0
      let writeFailed = 0
      for (const item of rebuilds) {
        const forced = drill[item.key]
        const current = forced === 'missing' ? undefined : storage.getEntity('dossier', item.key)
        const audit = forced !== undefined
          ? { state: forced }
          : auditEntityRecord(asRestoreRecord(current), {
            schemaVersion: CE_STORAGE_SCHEMA_VERSION,
            validate: bodyValidatorFor('dossier', workspace),
          })
        if (audit.state === 'ok') continue
        damaged++
        if (audit.state !== 'missing') {
          emitDegraded(spec, audit.state, { entityKey: item.key, detail: 'log-replay-rebuild' })
        }
        try {
          await storage.putEntity('dossier', item.key, item.body, {
            taskId: item.taskId,
            eventType: 'restore-rebuild',
            evidence: { messages: item.messageCount, annotations: item.annotationCount, cause: audit.state },
          }, { baseVersion: current?.version ?? 0 })
          wrote++
        } catch (e) {
          writeFailed++
          logger.warn('context-economy: restore dossier rebuild write failed (contained, fail-lazy)',
            item.key, e instanceof Error ? e.message : String(e))
        }
      }
      if (wrote > 0) {
        rebuilt += wrote
        emitStep(spec, 'rebuilt', { rebuilt: wrote, ...(writeFailed > 0 ? { reason: `write-failed=${writeFailed}` } : {}) })
      } else if (writeFailed > 0) {
        emitDegraded(spec, 'corrupt', { detail: `write-failed=${writeFailed}` })
        emitStep(spec, 'degraded', { rebuilt: 0 })
      } else if (damaged === 0) {
        emitStep(spec, 'ok', { rebuilt: 0 })
      } else {
        emitStep(spec, 'skipped', { rebuilt: 0, reason: 'no-log-material' })
      }
    }

    const runStep = async (spec: RestoreStepSpec): Promise<void> => {
      if (spec.step === 'segment_state') {
        const state = foldSegmentState([...facts], foldOptions)
        emitStep(spec, 'rebuilt', { rebuilt: state.taskCount })
        rebuilt++
        return
      }
      if (spec.step === 'metrics_cache') {
        const mirror = mirrorFactsOf(storage.listFactMirror(sessionId))
        if (mirrorDiverges(facts, mirror)) {
          emitDegraded(spec, 'mirror-divergence', { detail: `mirror=${mirror.length} log=${facts.length}` })
          emitStep(spec, 'degraded', { rebuilt: facts.length })
          return
        }
        emitStep(spec, 'rebuilt', { rebuilt: facts.length })
        rebuilt++
        return
      }
      if (spec.step === 'dossier') {
        await runDossierStep(spec)
        return
      }

      const key = entityKeyOf(spec, workspace)
      const forced = drill[key]
      const stored = forced === 'missing' ? undefined : asRestoreRecord(
        spec.entityTable === undefined ? undefined : storage.getEntity(spec.entityTable, key),
      )
      const validate = bodyValidatorFor(spec.entityTable, workspace)
      const audit = forced !== undefined
        ? { state: forced }
        : auditEntityRecord(stored, {
          schemaVersion: CE_STORAGE_SCHEMA_VERSION,
          ...(validate === undefined ? {} : { validate }),
        })
      if (audit.state === 'ok') {
        emitStep(spec, 'ok', { version: audit.version, entityKey: key })
        return
      }
      if (audit.state !== 'missing') {
        emitDegraded(spec, audit.state, { entityKey: key, ...(audit.reason === undefined ? {} : { detail: audit.reason }) })
      }

      if (spec.strategy === 'snapshot-rollback' && spec.entityTable !== undefined && stored !== undefined) {
        const target = storage.auditEntity(spec.entityTable, key)
          .filter((candidate) => candidate.version !== stored.version)
          .sort((a, b) => b.version - a.version)
          .find((candidate) => auditEntityRecord({
            schemaVersion: candidate.schemaVersion,
            version: candidate.version,
            source: candidate.source,
            body: candidate.body,
          }, { schemaVersion: CE_STORAGE_SCHEMA_VERSION, ...(validate === undefined ? {} : { validate }) }).state === 'ok')
        if (target !== undefined) {
          try {
            await storage.rollbackEntity(spec.entityTable, key, target.version)
            rebuilt++
            emitStep(spec, 'rebuilt', { version: target.version, entityKey: key, rebuilt: 1 })
            return
          } catch (e) {
            logger.warn('context-economy: restore rollback failed (contained, fail-lazy)',
              key, e instanceof Error ? e.message : String(e))
          }
        }
        emitDegraded(spec, 'rollback-unavailable', { entityKey: key })
        emitStep(spec, 'degraded', { version: stored.version, entityKey: key, rebuilt: 0 })
        return
      }

      // 只降级 / 缺失（不可确定性再生：边界档案、优化产物）。
      if (audit.state === 'missing') emitDegraded(spec, 'missing', { entityKey: key })
      emitStep(spec, 'degraded', { entityKey: key, rebuilt: 0 })
    }

    try {
      for (const spec of RESTORE_PLAN) {
        if (disposed) break
        await runStep(spec)
      }
    } catch (e) {
      counters.internalErrors++
      emitDegraded(INTERNAL_SPEC, 'internal', { detail: e instanceof Error ? e.message : String(e) })
      logger.warn('context-economy: restore run failed (contained, fail-lazy)', e instanceof Error ? e.message : String(e))
    }

    const doneFact: RestoreDoneFactData = {
      at: now(),
      source,
      steps: steps.length,
      rebuilt,
      degraded: degraded.length,
      durationMs: Math.max(0, now() - startedAt),
    }
    emitCeFact(session, RESTORE_DONE_FACT_TYPE, doneFact, logger)

    counters.runs++
    counters.steps += steps.length
    counters.rebuilt += rebuilt
    counters.degraded += degraded.length
    return { ran: true, source, steps, degraded, rebuilt }
  }

  const onSessionStart = async (payload: { session: Session; source: RestoreSource }): Promise<RestoreRunResult> => {
    if (disposed || firstLiveSeqOf(payload.session) === 0 || seen.has(payload.session)) {
      counters.skipped++
      return { ran: false, source: payload.source, steps: NO_STEPS, degraded: [], rebuilt: 0 }
    }
    seen.add(payload.session)
    return run(payload)
  }

  return { dispose() { disposed = true }, stats: () => ({ ...counters }), onSessionStart, run }
}

/** 恢复序步名（供验收/文档引用；顺序即执行序）。 */
export function restoreStepNames(): RestoreStepName[] {
  return RESTORE_PLAN.map((spec) => spec.step)
}

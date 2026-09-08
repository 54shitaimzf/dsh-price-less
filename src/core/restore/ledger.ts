/**
 * 恢复事实账本 fold（docs/09 §4 + docs/07 §0.5 缓存/守卫族 `restoreDegraded`；P21a 度量先行）。
 * 纯函数：同输入同账；输入 = `restore-step` / `restore-degraded` / `restore-done` 三类事实。
 *
 * 模块: core 恢复纯核（事实账本）
 * 平面: L0（确定性重放；无模型、无 IO）
 * 回退链步数: 0（坏载荷跳过，绝不抛错）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D17）；不写事实、不改史、不读盘。
 * 度量: 本文件即恢复族口径（07 `restoreDegraded` + 自持观测位）。
 */
import type { LedgerFact } from '../ledger/types.ts'
import { RESTORE_STEPS, type EntityDamageCode, type RestoreStepName } from './plan.ts'

/** 恢复步事实（ignorable log-only；声明合并随 domains/restore-facts.ts）。 */
export const RESTORE_STEP_FACT_TYPE = 'context-economy/restore-step' // ignorable
/** 恢复降级事实（每项损伤一条；07 `restoreDegraded` 生产者）。 */
export const RESTORE_DEGRADED_FACT_TYPE = 'context-economy/restore-degraded' // ignorable
/** 恢复完成事实（每轮一条）。 */
export const RESTORE_DONE_FACT_TYPE = 'context-economy/restore-done' // ignorable

/** H9 session-start 来源（harness 启动来源枚举本地重声明；字面收口见 platform/agent-step.ts）。 */
export type RestoreSource = 'startup' | 'resume' | 'clear' | 'compact'

/** 单步结果：ok = 盘上可用；rebuilt = 已重建/回退；degraded = 降级；skipped = 不适用。 */
export type RestoreOutcome = 'ok' | 'rebuilt' | 'degraded' | 'skipped'

/** 降级码 = 实体损伤码 + 回退不可用 + 双源漂移 + 内部异常。 */
export type RestoreDegradedCode = EntityDamageCode | 'rollback-unavailable' | 'mirror-divergence' | 'internal'

export interface RestoreStepFactData {
  readonly at: number
  readonly source: RestoreSource
  readonly step: RestoreStepName
  readonly outcome: RestoreOutcome
  /** 审计到的记录版本（可空 = 实体缺失）。 */
  readonly version?: number
  /** 实体键（durable 步；段状态机/度量缓存无键）。 */
  readonly entityKey?: string
  /** 重建/回退出的条数（卷宗 = 消息数；段状态机 = taskCount；度量 = 事实条数）。 */
  readonly rebuilt?: number
  readonly reason?: string
}

export interface RestoreDegradedFactData {
  readonly at: number
  readonly source: RestoreSource
  readonly step: RestoreStepName
  readonly code: RestoreDegradedCode
  readonly entityKey?: string
  readonly detail?: string
}

export interface RestoreDoneFactData {
  readonly at: number
  readonly source: RestoreSource
  readonly steps: number
  readonly rebuilt: number
  readonly degraded: number
  readonly durationMs?: number
}

export interface RestoreLedger {
  /** 完成事实条数（恢复轮数）。 */
  restoreRuns: number
  /** 各步执行次数（自持观测位）。 */
  restoreSteps: Record<RestoreStepName, number>
  /** 重建/回退成功项数（自持观测位）。 */
  restoreRebuilt: number
  /** 07 字段：降级项数。 */
  restoreDegraded: number
  /** 结构版本不符项数（version-mismatch 细分）。 */
  versionMismatches: number
  lastDone: RestoreDoneFactData | null
}

export function emptyRestoreLedger(): RestoreLedger {
  const steps = {} as Record<RestoreStepName, number>
  for (const step of RESTORE_STEPS) steps[step] = 0
  return { restoreRuns: 0, restoreSteps: steps, restoreRebuilt: 0, restoreDegraded: 0, versionMismatches: 0, lastDone: null }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function isStepName(value: unknown): value is RestoreStepName {
  return typeof value === 'string' && (RESTORE_STEPS as readonly string[]).includes(value)
}

/** 事实 fold（坏载荷跳过；只统计，不做语义解析）。 */
export function foldRestoreLedger(facts: readonly LedgerFact[]): RestoreLedger {
  const ledger = emptyRestoreLedger()
  for (const fact of facts) {
    const data = recordOf(fact.data)
    if (data === undefined) continue
    if (fact.type === RESTORE_STEP_FACT_TYPE) {
      if (!isStepName(data.step)) continue
      ledger.restoreSteps[data.step]++
      if (data.outcome === 'rebuilt') ledger.restoreRebuilt++
    } else if (fact.type === RESTORE_DEGRADED_FACT_TYPE) {
      ledger.restoreDegraded++
      if (data.code === 'version-mismatch') ledger.versionMismatches++
    } else if (fact.type === RESTORE_DONE_FACT_TYPE) {
      ledger.restoreRuns++
      ledger.lastDone = {
        at: typeof data.at === 'number' ? data.at : fact.time,
        source: (data.source ?? 'startup') as RestoreSource,
        steps: typeof data.steps === 'number' ? data.steps : 0,
        rebuilt: typeof data.rebuilt === 'number' ? data.rebuilt : 0,
        degraded: typeof data.degraded === 'number' ? data.degraded : 0,
        ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
      }
    }
  }
  return ledger
}

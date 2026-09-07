/**
 * 分划单位状态机（docs/01 §3.5 / docs/02 §3 / docs/12 §3）。
 * 纯函数 fold：将 task-boundary / judge-verdict 事实归并为 task 段序列。
 * core 零 harness import；只消费 LedgerFact 事实源抽象，不感知通道来源。
 */
import type { LedgerFact } from './ledger/types.ts'
import { TASK_BOUNDARY_FACT_TYPE } from './ledger/facts.ts'

/** 判别 verdict 事实名（ignorable 事件；S3 窗口纪律：本行附近须保留 ignorable 字样）。 */
export const JUDGE_VERDICT_FACT_TYPE = 'context-economy/judge-verdict'

export interface TaskBoundaryFactData {
  taskId?: string
  boundary?: 'open' | 'close'
  reason?: string
}

export interface JudgeVerdictFactData {
  verdict?: string
  anchorSeq?: number
  taskId?: string
}

export type SegmentSwitchReason = 'implicit-open' | 't0-open' | 't0-close' | 'verdict-new-task' | null

export interface TaskSegment {
  taskId: string
  startSeq: number | null
  endSeq: number | null
  closed: boolean
  switchReason: SegmentSwitchReason
}

export interface SegmentState {
  segments: TaskSegment[]
  taskCount: number
  segmentsPerSession: number
  taskSwitchRate: number
}

export interface SegmentFoldOptions {
  stepStartCount?: number
  sessionFirstSeq?: number
  sessionLastSeq?: number
}

interface SwitchEvent {
  seq: number
  priority: number
  time: number
  dataJson: string
  kind: 't0' | 'verdict'
  t0?: TaskBoundaryFactData
  verdict?: JudgeVerdictFactData
}

export function foldSegmentState(facts: LedgerFact[], options: SegmentFoldOptions = {}): SegmentState {
  const switches: SwitchEvent[] = []
  let firstT0Seq: number | undefined

  for (const fact of facts) {
    const data = (fact.data ?? {}) as Record<string, unknown>
    if (fact.type === TASK_BOUNDARY_FACT_TYPE) {
      const t0 = data as TaskBoundaryFactData
      const seq = fact.seq ?? fact.time
      switches.push({ seq, priority: 0, time: fact.time, dataJson: JSON.stringify(data), kind: 't0', t0 })
      if (firstT0Seq === undefined) firstT0Seq = seq
    } else if (fact.type === JUDGE_VERDICT_FACT_TYPE) {
      const verdict = data as JudgeVerdictFactData
      if (verdict.verdict !== 'new-task') continue
      if (!Number.isInteger(verdict.anchorSeq) || (verdict.anchorSeq ?? 0) <= 0) continue
      const anchor = verdict.anchorSeq as number
      switches.push({ seq: anchor, priority: 1, time: fact.time, dataJson: JSON.stringify(data), kind: 'verdict', verdict })
    }
  }

  switches.sort((a, b) => a.seq - b.seq || a.priority - b.priority || a.time - b.time || a.dataJson.localeCompare(b.dataJson))

  const segments: TaskSegment[] = []
  let current: TaskSegment = {
    taskId: 'task-1',
    startSeq: options.sessionFirstSeq ?? firstT0Seq ?? null,
    endSeq: null,
    closed: false,
    switchReason: options.sessionFirstSeq != null ? 'implicit-open' : null,
  }

  for (const sw of switches) {
    if (sw.kind === 't0') {
      const t0 = sw.t0!
      if (t0.boundary === 'open') {
        current.endSeq = sw.seq
        current.closed = true
        current.switchReason = 't0-open'
        segments.push(current)
        const n = segments.length + 1
        current = {
          taskId: t0.taskId ?? `task-${n}`,
          startSeq: sw.seq,
          endSeq: null,
          closed: false,
          switchReason: 't0-open',
        }
      } else {
        if (t0.taskId !== undefined) current.taskId = t0.taskId
        current.endSeq = sw.seq
        current.closed = true
        current.switchReason = 't0-close'
        segments.push(current)
        const n = segments.length + 1
        current = {
          taskId: `task-${n}`,
          startSeq: sw.seq,
          endSeq: null,
          closed: false,
          switchReason: 't0-close',
        }
      }
    } else {
      const verdict = sw.verdict!
      const anchor = verdict.anchorSeq as number
      if (current.startSeq != null && anchor <= current.startSeq) continue
      current.endSeq = anchor - 1
      current.closed = true
      current.switchReason = 'verdict-new-task'
      segments.push(current)
      const n = segments.length + 1
      current = {
        taskId: verdict.taskId ?? `task-${n}`,
        startSeq: anchor,
        endSeq: null,
        closed: false,
        switchReason: 'verdict-new-task',
      }
    }
  }

  current.endSeq = options.sessionLastSeq ?? null
  segments.push(current)

  const taskCount = segments.length
  const taskSwitchRate = (taskCount - 1) / Math.max(1, options.stepStartCount ?? 0)
  return {
    segments,
    taskCount,
    segmentsPerSession: taskCount,
    taskSwitchRate,
  }
}

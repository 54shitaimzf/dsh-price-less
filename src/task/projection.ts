/**
 * task 记忆投影单元：纯同步 fold，从 session 日志事件重建 task 状态机。
 *
 * 模块: task 状态机投影单元（contextEconomyTask）
 * 平面: L0（事件观测 + 纯规则 fold）——无 L1/L2、无 LLM 调用
 * 回退链步数: 2（代码分支：T0/T1 信号）→ 3（机械字符匹配：'/task'、路径签名）
 * 审查清单: 信号取自会话日志确定性事件；**不读 event.time（时间戳非判据）**；
 *           apply 纯同步/无副作用/状态 plain JSON；无兴趣事件返回同一引用
 *           （Object.is 门控）；模块自证附于本注释；无 harness 环境可测。
 * 度量: roundsPerTask / taskSwitchRate / taskDefinitionBytes（docs/07）
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  classifyExplicitUserMessage,
  decideBoundary,
  evaluateClusterShift,
  extractTaskName,
  fileDirKey,
  filePathInfo,
  hasLexicalBoundaryHint,
  isTodoAllCompleted,
  makeTaskId,
  touchTaskSurface,
  userMessageText,
  isUserCorrection,
  type SignalName,
} from './boundary.ts'
import {
  TASK_PROJECTION_KEY,
  type ContextEconomyTaskState,
  type TaskProjectionDefinition,
  type TaskRecord,
} from './types.ts'

/** 状态 schema（zod；validate 持久化 checkpoint 行——`ver` 门后的输入边界）。 */
const signalNameSchema = z.enum([
  'file-cluster-shift',
  'user-correction',
  'todo-completed',
  'lexical-hint',
  'implicit-start',
])

const taskRecordSchema = z.object({
  taskId: z.string(),
  startSeq: z.number().int().nonnegative(),
  lastSurfaceSeq: z.number().int().nonnegative(),
  kind: z.enum(['explicit', 'signals']),
  evidence: z.array(z.string()),
  summary: z.string().nullable(),
  status: z.enum(['active', 'closed']),
})

const currentRefSchema = z.object({
  taskId: z.string(),
  startSeq: z.number().int().nonnegative(),
  lastSurfaceSeq: z.number().int().nonnegative(),
})

const stateSchema = z.object({
  tasks: z.array(taskRecordSchema),
  current: currentRefSchema.nullable(),
  surfaceIndex: z.record(z.string(), z.number().int().nonnegative()),
  /** 当前 turn 内待转正的候选信号（分数制；同信号只记一次，turn 作用域）。 */
  pendingEvidence: z.array(signalNameSchema),
  /** 本 task 内已见目录集合（文件簇，规范化）。 */
  seenDirs: z.array(z.string()),
  /** 正在累积的簇迁移候选目录名（null = 无候选）。 */
  pendingDir: z.string().nullable(),
  /** 累计到的连续新目录文件数。 */
  pendingDirCount: z.number().int().nonnegative(),
  lastBoundarySeq: z.number().int().nonnegative().nullable(),
  compactedTaskIds: z.array(z.string()),
  lastBoundary: z.object({
    taskId: z.string(),
    kind: z.enum(['explicit', 'signals']),
    evidence: z.array(z.string()),
  }).nullable(),
}).strict()

/** 空日志初始状态。 */
function init(): ContextEconomyTaskState {
  return {
    tasks: [],
    current: null,
    surfaceIndex: {},
    pendingEvidence: [],
    seenDirs: [],
    pendingDir: null,
    pendingDirCount: 0,
    lastBoundarySeq: null,
    compactedTaskIds: [],
    lastBoundary: null,
  }
}

/** 在 task 表中找到指定 id 的 task；找不到则返回 undefined。 */
function findTask(state: ContextEconomyTaskState, taskId: string): TaskRecord | undefined {
  return state.tasks.find(task => task.taskId === taskId)
}

/** 更新 task 表中的一个 task（不可变更新）。 */
function updateTask(state: ContextEconomyTaskState, task: TaskRecord): ContextEconomyTaskState {
  return {
    ...state,
    tasks: state.tasks.map(entry => (entry.taskId === task.taskId ? task : entry)),
  }
}

/** 追加候选信号（按名去重：同一信号在同一 turn 内只记一次）。 */
function addSignal(state: ContextEconomyTaskState, signal: SignalName): ContextEconomyTaskState {
  if (state.pendingEvidence.includes(signal)) return state
  return { ...state, pendingEvidence: [...state.pendingEvidence, signal] }
}

/** 批量追加候选信号（按名去重）。 */
function addSignals(state: ContextEconomyTaskState, signals: SignalName[]): ContextEconomyTaskState {
  let next = state
  for (const signal of signals) next = addSignal(next, signal)
  return next
}

/**
 * 转正边界：关闭当前 task（如有）、开新 task（kind 归因），更新指针。
 * 这是唯一会改变 tasks/current 的地方。新 task 清空簇上下文。
 */
function commitBoundary(
  state: ContextEconomyTaskState,
  seq: number,
  kind: 'explicit' | 'signals',
  evidence: string[],
  explicitName?: string,
): ContextEconomyTaskState {
  const oldCurrent = state.current
  const tasks = state.tasks.map(task => (
    oldCurrent !== null && task.taskId === oldCurrent.taskId
      ? { ...task, status: 'closed' as const }
      : task
  ))
  const taskId = makeTaskId(seq, explicitName)
  const newTask: TaskRecord = {
    taskId,
    startSeq: seq,
    lastSurfaceSeq: seq,
    kind,
    evidence,
    summary: null,
    status: 'active',
  }
  return {
    ...state,
    tasks: [...tasks, newTask],
    current: { taskId, startSeq: seq, lastSurfaceSeq: seq },
    pendingEvidence: [],
    seenDirs: [],
    pendingDir: null,
    pendingDirCount: 0,
    lastBoundarySeq: seq,
    lastBoundary: { taskId, kind, evidence },
  }
}

/** 显式闭合当前 task（不产生新 task）。 */
function closeCurrent(
  state: ContextEconomyTaskState,
  seq: number,
  evidence: string[],
): ContextEconomyTaskState {
  const current = state.current
  if (current === null) return state
  const tasks = state.tasks.map(task => (
    task.taskId === current.taskId ? { ...task, status: 'closed' as const } : task
  ))
  return {
    ...state,
    tasks,
    current: null,
    pendingEvidence: [],
    lastBoundarySeq: seq,
    lastBoundary: { taskId: current.taskId, kind: 'explicit', evidence },
  }
}

/** 新 surface 事件进入当前 task：推进 current 与 surfaceIndex。 */
function advanceSurface(
  state: ContextEconomyTaskState,
  seq: number,
): ContextEconomyTaskState {
  if (state.current === null) return state
  const task = findTask(state, state.current.taskId)
  if (task === undefined) return state
  const nextTask = touchTaskSurface(task, seq)
  return {
    ...state,
    tasks: state.tasks.map(entry => (entry.taskId === task.taskId ? nextTask : entry)),
    current: { ...state.current, lastSurfaceSeq: seq },
    surfaceIndex: { ...state.surfaceIndex, [String(seq)]: surfacePosition(state, seq) },
  }
}

/** surface 位置计算：有记录取现；否则取当前最大位置 + 1（追加语义）。 */
function surfacePosition(state: ContextEconomyTaskState, seq: number): number {
  const existing = state.surfaceIndex[String(seq)]
  if (existing !== undefined) return existing
  const maxPos = Object.values(state.surfaceIndex).reduce((max, pos) => Math.max(max, pos), -1)
  return maxPos + 1
}

/** 文件目录访问：簇迁移候选评估 + 加入 seenDirs。 */
function applyDirAccess(
  state: ContextEconomyTaskState,
  dir: string,
): { next: ContextEconomyTaskState; shifted: boolean } {
  const { next: clusterCtx, shifted } = evaluateClusterShift(
    { seenDirs: state.seenDirs, pendingDir: state.pendingDir, pendingDirCount: state.pendingDirCount },
    dir,
  )
  // 触发迁移时：该目录已"进入"簇（加进 seenDirs，重置候选）。
  const seenDirs = shifted
    ? [...clusterCtx.seenDirs, dir]
    : clusterCtx.seenDirs
  const next: ContextEconomyTaskState = {
    ...state,
    seenDirs,
    pendingDir: shifted ? null : clusterCtx.pendingDir,
    pendingDirCount: shifted ? 0 : clusterCtx.pendingDirCount,
    pendingEvidence: shifted ? addSignal(state, 'file-cluster-shift').pendingEvidence : state.pendingEvidence,
  }
  return { next, shifted }
}

/**
 * 纯状态转移：前态 + 一个已提交事件 → 后态。
 * 规则（全部无副作用、不读 event.time；无兴趣事件返回同一引用）：
 * - user/message（surface append）→ T0 显式边界 / 当前 task 推进 + lexical/correction 候选；
 * - user/message surface replace → surfaceIndex 重映射 + 受影响 task 标记；
 * - tool/call → 文件目录访问：簇迁移候选；
 * - todo/write → 全完成候选（弱信号）；
 * - turn/end → 分数制合议转正，或 fail-lazy 丢弃；
 * - compaction/summary → 摘要提取归入所属 task。
 */
function apply(state: ContextEconomyTaskState, event: SessionEvent): ContextEconomyTaskState {
  switch (event.type) {
    case 'user/message': {
      const surfaceOp = event.surfaceOp
      if (surfaceOp !== undefined && typeof surfaceOp === 'object' && surfaceOp.op === 'replace') {
        return applyReplace(state, event, surfaceOp)
      }
      const text = userMessageText(event)
      const explicit = classifyExplicitUserMessage(text)
      if (explicit === 'open') {
        return commitBoundary(state, event.seq, 'explicit', ['user:/task'], extractTaskName(text))
      }
      if (explicit === 'close') {
        return closeCurrent(state, event.seq, ['user:/task-close'])
      }
      let next = state
      if (state.current === null) {
        // 会话首条（或关闭后）非显式消息：隐式开新 task（evidence 标记 implicit-start）。
        next = commitBoundary(state, event.seq, 'signals', ['implicit-start'])
      } else {
        next = advanceSurface(state, event.seq)
      }
      const signals: SignalName[] = []
      if (isUserCorrection(text)) signals.push('user-correction')
      if (hasLexicalBoundaryHint(text)) signals.push('lexical-hint')
      return addSignals(next, signals)
    }

    case 'tool/call': {
      const info = filePathInfo(event)
      if (info === null) return state
      const dir = fileDirKey(info)
      return applyDirAccess(state, dir).next
    }

    case 'todo/write': {
      if (!isTodoAllCompleted(event)) return state
      return addSignal(state, 'todo-completed')
    }

    case 'turn/start':
      // 信号作用域 = 一个 turn：新 turn 开始即重置候选（防跨 turn 信号误合议）。
      return state.pendingEvidence.length === 0 ? state : { ...state, pendingEvidence: [] }

    case 'turn/end': {
      const pending = state.pendingEvidence as SignalName[]
      if (pending.length === 0) return state
      // 分数制合议：达标且含强信号 → 边界；有信号未达标 → fail-lazy 丢弃（维持当前 task）。
      const verdict = decideBoundary(pending)
      if (verdict === 'boundary') return commitBoundary(state, event.seq, 'signals', pending)
      return { ...state, pendingEvidence: [] }
    }

    case 'compaction/summary':
      return applyCompactionSummary(state, event)

    default:
      return state
  }
}

/** 压缩替换事件：重映射 surfaceIndex，并把"范围与替换区间相交的 task"标记 closed。 */
function applyReplace(
  state: ContextEconomyTaskState,
  event: SessionEvent<'user/message'>,
  surfaceOp: { op: 'replace'; start: number; end: number },
): ContextEconomyTaskState {
  const { start, end } = surfaceOp
  const nextSurfaceIndex: Record<string, number> = {}
  let replacementPos = surfacePosition(state, start)
  for (const [seqStr, pos] of Object.entries(state.surfaceIndex)) {
    const seq = Number(seqStr)
    if (seq >= start && seq <= end) {
      replacementPos = Math.min(replacementPos, pos)
      continue
    }
    nextSurfaceIndex[seqStr] = pos
  }
  nextSurfaceIndex[String(event.seq)] = replacementPos

  const tasks = state.tasks.map(task => {
    const overlaps = Number(start) <= task.lastSurfaceSeq && Number(end) >= task.startSeq
    return overlaps ? { ...task, status: 'closed' as const } : task
  })
  const newlyClosed = tasks.filter(task => task.status === 'closed').map(task => task.taskId)
  return {
    ...state,
    tasks,
    surfaceIndex: nextSurfaceIndex,
    compactedTaskIds: [...new Set([...state.compactedTaskIds, ...newlyClosed])],
  }
}

/** 压缩摘要事件：提取 summary 文本，按 shadowedSeqs 归属到 task。 */
function applyCompactionSummary(
  state: ContextEconomyTaskState,
  event: SessionEvent<'compaction/summary'>,
): ContextEconomyTaskState {
  const summaryText = event.data.summary
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim()
  if (summaryText.length === 0) return state
  const tasks = state.tasks.map(task => {
    const belongs = event.data.shadowedSeqs.some(seq => (
      seq >= task.startSeq && seq <= task.lastSurfaceSeq
    ))
    return belongs ? { ...task, summary: summaryText, status: 'closed' as const } : task
  })
  return { ...state, tasks }
}

/** 注册到投影 registry 的定义（types.ts 的 satisfies 校验入口）。 */
export const taskProjectionDefinition = {
  key: TASK_PROJECTION_KEY,
  stateVersion: 2,
  stateSchema,
  init,
  apply,
} satisfies TaskProjectionDefinition

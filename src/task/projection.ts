/**
 * task 记忆投影单元：纯同步 fold，从 session 日志事件重建 task 状态机。
 *
 * 模块: task 状态机投影单元（contextEconomyTask）
 * 平面: L0（事件观测 + 纯规则 fold）——L1 语义经 voteTable 注入（fold 无 IO/无模型调用）
 * 回退链步数: 2（代码分支：T0/T1 信号）→ 3（机械字符匹配：'/task'、路径签名）
 *            → 4（语义票：turn/end 查 voteTable，'off' 档降级机械，见 docs/11）
 * 审查清单: 信号取自会话日志确定性事件；**不读 event.time（时间戳非判据）**；
 *           apply 纯同步/无副作用/状态 plain JSON；无兴趣事件返回同一引用
 *           （Object.is 门控）；语义票表只读注入（投票方=指挥半边，见 orchestrator）；
 *           模块自证附于本注释；无 harness 环境可测。
 * 度量: roundsPerTask / taskSwitchRate / taskDefinitionBytes（docs/07）
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  classifyExplicitUserMessage,
  decideBoundaryWithSemantic,
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
  type SemanticMode,
  type SignalName,
} from './boundary.ts'
import {
  TASK_PROJECTION_KEY,
  type ContextEconomyTaskState,
  type SemanticVoteTable,
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
  anchorText: z.string(),
})

const lastUserMsgSchema = z.object({
  seq: z.number().int().nonnegative(),
  text: z.string(),
}).nullable()

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
  lastUserMsg: lastUserMsgSchema,
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
    lastUserMsg: null,
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
  anchorText: string,
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
    anchorText,
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

/** 运行时选项（createTaskProjection 捕获；折叠对 (选项, 状态, 事件) 三者纯函数）。
 * votes 为可选的运行时语义票表——fold 只读，不持有会话外引用。
 */
export interface ProjectionRuntimeOptions {
  /** 语义票档位。 */
  mode: SemanticMode
  /** 语义漂移阈值（cosine 低于该值 = 语义离开当前 task）。 */
  threshold: number
  /** 语义票表（mode 'on' 时必填；null 票 = 机械降级）。 */
  votes?: SemanticVoteTable
}

/**
 * 纯状态转移：前态 + 一个已提交事件 → 后态。
 * 规则（全部无副作用、不读 event.time；无兴趣事件返回同一引用）：
 * - user/message（surface append）→ T0 显式边界 / 当前 task 推进 + lexical/correction 候选；
 * - user/message surface replace → surfaceIndex 重映射 + 受影响 task 标记；
 * - tool/call → 文件目录访问：簇迁移候选；
 * - todo/write → 全完成候选（弱信号）；
 * - turn/end → 分数制合议 + 语义票转正，或 fail-lazy 丢弃；
 * - compaction/summary → 摘要提取归入所属 task。
 */
function makeApply(options: ProjectionRuntimeOptions) {
  return function apply(state: ContextEconomyTaskState, event: SessionEvent): ContextEconomyTaskState {
  switch (event.type) {
    case 'user/message': {
      const surfaceOp = event.surfaceOp
      if (surfaceOp !== undefined && typeof surfaceOp === 'object' && surfaceOp.op === 'replace') {
        return applyReplace(state, event, surfaceOp)
      }
      const text = userMessageText(event)
      // 记录最近用户消息（语义票与隐式锚的输入；replace 语义事件不更新）。
      let next: ContextEconomyTaskState = { ...state, lastUserMsg: { seq: event.seq, text } }
      const explicit = classifyExplicitUserMessage(text)
      if (explicit === 'open') {
        return commitBoundary(next, event.seq, 'explicit', ['user:/task'], text, extractTaskName(text))
      }
      if (explicit === 'close') {
        return closeCurrent(next, event.seq, ['user:/task-close'])
      }
      if (next.current === null) {
        // 会话首条（或关闭后）非显式消息：隐式开新 task（evidence 标记 implicit-start）。
        next = commitBoundary(next, event.seq, 'signals', ['implicit-start'], text)
      } else {
        next = advanceSurface(next, event.seq)
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
      // 语义票：mode 'on' 时无论机械信号与否都查票（embedding 主判据 = 抓无机械信号的
      // 正常新指令换向）；票来自 voteTable（异步写入先于 turn/end 落定）。
      const semantic = options.mode === 'off' || state.lastUserMsg === null
        ? null
        : options.votes === undefined ? null : (() => {
          const score = options.votes.scoreOf(state.lastUserMsg!.seq)
          return score === null ? null : { score }
        })()
      const verdict = decideBoundaryWithSemantic(pending, semantic, {
        mode: options.mode,
        threshold: options.threshold,
      })
      if (verdict === 'boundary') {
        const evidence = semantic !== null && semantic.score < options.threshold
          ? [...pending, `semantic:${semantic.score.toFixed(3)}`]
          : pending
        const anchor = state.lastUserMsg !== null ? state.lastUserMsg.text : ''
        return commitBoundary(state, event.seq, 'signals', evidence, anchor)
      }
      if (pending.length === 0) return state
      return { ...state, pendingEvidence: [] }
    }

    case 'compaction/summary':
      return applyCompactionSummary(state, event)

    default:
      return state
  }
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

/** 注册到投影 registry 的定义工厂（types.ts 的 satisfies 校验入口）。 */
export function createTaskProjection(options: ProjectionRuntimeOptions): TaskProjectionDefinition {
  return {
    key: TASK_PROJECTION_KEY,
    stateVersion: 3,
    stateSchema,
    init,
    apply: makeApply(options),
  } satisfies TaskProjectionDefinition
}

/** 默认投影定义（'off' 档：纯机械——与 v2 行为一致；测试/无配置场景用）。 */
export const taskProjectionDefinition = createTaskProjection({ mode: 'off', threshold: 0.5 })

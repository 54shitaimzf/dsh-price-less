/**
 * task 段记忆投影单元：纯同步 fold，从 session 日志事件重建段状态机。
 *
 * 模块: task 段状态机投影单元（contextEconomyTask）
 * 平面: L0（事件观测 + 纯规则 fold）——边界来源 = 显式指令（/task，回退链第 1 步）
 *       + 判别器语义票（v0.8.0 接入：fold 消费会话日志 verdict 事件做段内切分）
 * 回退链步数: 1（用户可控指令：显式 /task）→ 2（判别器语义票：段内切分）
 * 审查清单: 数据取自会话日志确定性事件；**不读 event.time（时间戳非判据）**；
 *           apply 纯同步/无副作用/状态 plain JSON；无兴趣事件返回同一引用
 *           （Object.is 门控）；v0.2.0-s6 语义票、v0.3.0 机械判定层（T1 信号合议/
 *           簇迁移/todo 信号）已先后移除——fold 不含任何模型/文件 IO；
 *           v0.8.0：语义票合议 = verdict(会话日志事件) + T0 优先（同 seq no-op）
 *           + fail-lazy（过期/不可定位/no-op 同引用）；
 *           模块自证附于本注释；无 harness 环境可测。
 * 度量: segmentsPerSession / taskSwitchRate / taskDefinitionBytes（docs/07）
 */

import { z } from 'zod'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  classifyExplicitUserMessage,
  extractTaskName,
  makeTaskId,
  touchTaskSurface,
  userMessageText,
} from './explicit.ts'
import { applyCompactionSummary, applyReplace } from './compaction.ts'
import './events.ts' // SessionEventMap 声明合并（'context-economy/judge-verdict' 事件类型）
import {
  TASK_PROJECTION_KEY,
  type ContextEconomyTaskState,
  type TaskProjectionDefinition,
  type TaskRecord,
} from './types.ts'

/** 状态 schema（zod；validate 持久化 checkpoint 行——`ver` 门后的输入边界）。 */
const taskRecordSchema = z.object({
  taskId: z.string(),
  startSeq: z.number().int().nonnegative(),
  lastSurfaceSeq: z.number().int().nonnegative(),
  summary: z.string().nullable(),
  status: z.enum(['active', 'closed']),
  anchorText: z.string(),
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
  lastBoundarySeq: z.number().int().nonnegative().nullable(),
  compactedTaskIds: z.array(z.string()),
  lastBoundary: z.object({
    taskId: z.string(),
  }).nullable(),
}).strict()

/** 空日志初始状态。 */
function init(_header: SessionHeader): ContextEconomyTaskState {
  // header 为 harness 契约形参：本 fold 的状态完全由日志事件重建，
  // 不依赖会话元数据（header 仅占位，当前不读取）。
  return {
    tasks: [],
    current: null,
    surfaceIndex: {},
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

/**
 * 转正边界：关闭当前段（如有）、开新段，更新指针。
 * 这是唯一会改变 tasks/current 的地方。新段清空残留边界标记。
 * 边界来源 = 显式指令（kind 由事件 reason/日志审计，状态表不存机械证据）。
 */
function commitBoundary(
  state: ContextEconomyTaskState,
  seq: number,
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
    summary: null,
    status: 'active',
    anchorText,
  }
  return {
    ...state,
    tasks: [...tasks, newTask],
    current: { taskId, startSeq: seq, lastSurfaceSeq: seq },
    lastBoundarySeq: seq,
    lastBoundary: { taskId },
  }
}

/** 显式闭合当前段（不产生新段）。 */
function closeCurrent(
  state: ContextEconomyTaskState,
  seq: number,
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
    lastBoundarySeq: seq,
    lastBoundary: { taskId: current.taskId },
  }
}

/** 新 surface 事件进入当前段：推进 current 与 surfaceIndex。 */
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

/** 运行时选项（createTaskProjection 捕获）。v0.3.0：机械判定层已退役，
 * 判定来源 = 显式指令（本轮）；判别器接口（语义判定）接入时在此扩展选项。 */
export interface ProjectionRuntimeOptions {
  /** 预留：无机械选项。 */
  _?: never
}

/**
 * 语义票合议（v0.8.0）：verdict=new-task → 在当前活动段内按目标 seq 切分——
 * 旧段闭合于其前一条 surface 事件，新段以判定消息为段头开启（锚 = 判定原文）。
 * 不变式（fail-lazy：证据不足/过期一律 no-op，绝不改写闭段历史）：
 * - 无当前段 / 目标 seq 不在当前段范围（[startSeq, lastSurfaceSeq]）→ no-op；
 * - 目标 seq 不在 surface（被替换/压缩移除）→ no-op；
 * - 目标 seq == 当前段 startSeq（T0 显式 / 隐式开段已是权威边界）→ no-op；
 * - 位置语义：段头（锚）消息**无 surfaceIndex 条目**（v4 既有——commitBoundary
 *   不写位置），目标位置为 0 ⇒ 其直接前驱 = 当前段锚（startSeq）；
 *   位置 > 0 ⇒ 由 surfaceIndex 反查 pos-1 的 seq（位置唯一且单调）；
 * - verdict=continue 在调用侧短路（同引用返回）。
 */
function applySemanticVerdict(
  state: ContextEconomyTaskState,
  targetSeq: number,
  anchorText: string,
): ContextEconomyTaskState {
  const current = state.current
  if (current === null) return state
  if (targetSeq < current.startSeq || targetSeq > current.lastSurfaceSeq) return state
  if (targetSeq === current.startSeq) return state
  const pos = state.surfaceIndex[String(targetSeq)]
  if (pos === undefined) return state
  // 定位旧段最后一条 surface 事件（目标的前驱）。
  let prevSeq: number
  if (pos === 0) {
    prevSeq = current.startSeq // 目标 = 段内首条非锚消息：前驱 = 段锚
  } else {
    let found: number | undefined
    for (const [seqStr, position] of Object.entries(state.surfaceIndex)) {
      if (position === pos - 1) {
        found = Number(seqStr)
        break
      }
    }
    if (found === undefined) return state
    prevSeq = found
  }

  const taskId = makeTaskId(targetSeq)
  const tasks = state.tasks.map(task => (
    task.taskId === current.taskId
      ? { ...task, status: 'closed' as const, lastSurfaceSeq: prevSeq }
      : task
  ))
  const newTask: TaskRecord = {
    taskId,
    startSeq: targetSeq,
    lastSurfaceSeq: current.lastSurfaceSeq,
    summary: null,
    status: 'active',
    anchorText,
  }
  return {
    ...state,
    tasks: [...tasks, newTask],
    current: { taskId, startSeq: targetSeq, lastSurfaceSeq: current.lastSurfaceSeq },
    lastBoundarySeq: targetSeq,
    lastBoundary: { taskId },
  }
}

/**
 * 纯状态转移：前态 + 一个已提交事件 → 后态。
 * 规则（全部无副作用、不读 event.time；无兴趣事件返回同一引用）：
 * - user/message（surface append）→ T0 显式边界（open/close）/ 隐式开段 / 段推进；
 * - user/message surface replace → surfaceIndex 重映射 + 受影响 task 标记；
 * - context-economy/judge-verdict（语义票，v0.8.0）→ new-task 段内切分；
 * - compaction/summary → 摘要提取归入所属 task；
 * - 其余事件（tool/todo/turn 等）→ 不参与段判定（返回同一引用）。
 */
function makeApply(): (state: ContextEconomyTaskState, event: SessionEvent) => ContextEconomyTaskState {
  return function apply(state: ContextEconomyTaskState, event: SessionEvent): ContextEconomyTaskState {
  switch (event.type) {
    case 'user/message': {
      const surfaceOp = event.surfaceOp
      if (surfaceOp !== undefined && typeof surfaceOp === 'object' && surfaceOp.op === 'replace') {
        return applyReplace(state, event, surfaceOp)
      }
      const text = userMessageText(event)
      const explicit = classifyExplicitUserMessage(text)
      if (explicit === 'open') {
        return commitBoundary(state, event.seq, text, extractTaskName(text))
      }
      if (explicit === 'close') {
        return closeCurrent(state, event.seq)
      }
      if (state.current === null) {
        // 会话首条（或闭合后）非显式消息：隐式开新段（锚 = 段头原文）。
        return commitBoundary(state, event.seq, text)
      }
      return advanceSurface(state, event.seq)
    }

    case 'context-economy/judge-verdict': {
      // 语义票合议（v0.8.0）：仅 new-task 生效；continue / 过期 / 不可定位 → 同引用。
      if (event.data.verdict !== 'new-task') return state
      return applySemanticVerdict(state, event.data.seq, event.data.anchorText)
    }

    case 'compaction/summary':
      return applyCompactionSummary(state, event)

    default:
      return state
  }
  }
}

/** 注册到投影 registry 的定义工厂（types.ts 的 satisfies 校验入口）。 */
export function createTaskProjection(_options: ProjectionRuntimeOptions = {}): TaskProjectionDefinition {
  return {
    key: TASK_PROJECTION_KEY,
    stateVersion: 5,
    stateSchema,
    init,
    apply: makeApply(),
  } satisfies TaskProjectionDefinition
}

/** 默认投影定义（显式指令 + 语义票合议 + 隐式开段——与 v5 行为一致；测试/无配置场景用）。 */
export const taskProjectionDefinition = createTaskProjection()
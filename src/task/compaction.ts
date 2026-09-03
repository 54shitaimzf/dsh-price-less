/**
 * 压缩域 fold 逻辑：压缩 replace 的表面重映射 + 压缩摘要归因。
 * 与任务状态机主 fold（projection.ts）解耦——这两类逻辑属 compaction 域，
 * 而非任务边界判定域；拆出以便 projection.ts 聚焦 task 状态机。
 *
 * 模块: task 压缩域 fold
 * 平面: L0（确定性规则：表面位置运算 + 区间重叠判定）——无 L1/L2
 * 回退链步数: 2（代码分支）
 * 审查清单: 纯同步/无副作用/状态 plain JSON；输入为折叠状态与事件；
 *           不读 event.time；无 LLM 调用；不持有会话外引用；可无 harness 单测。
 * 度量: 经 docs/07（compaction/* 事件）观测。
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContextEconomyTaskState } from './types.ts'

/** surface 位置计算：有记录取现；否则取当前最大位置 + 1（追加语义）。 */
function surfacePosition(state: ContextEconomyTaskState, seq: number): number {
  const existing = state.surfaceIndex[String(seq)]
  if (existing !== undefined) return existing
  const maxPos = Object.values(state.surfaceIndex).reduce((max, pos) => Math.max(max, pos), -1)
  return maxPos + 1
}

/** 压缩替换事件：重映射 surfaceIndex，并把"范围与替换区间相交的 task"标记 closed。 */
export function applyReplace(
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
export function applyCompactionSummary(
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

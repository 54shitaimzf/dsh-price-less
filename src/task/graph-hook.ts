/**
 * 图谱更新 hook（占位）：task 段边界/压缩发生时发信号，不做任何知识写入。
 *
 * 模块: 图谱更新 hook（占位）
 * 平面: L0（事件发射，无计算）
 * 回退链步数: 1（用户可控指令——占位语义由后续文档合并时定；当前仅信号）
 * 审查清单: 无 LLM 调用；不写任何存储（占位=信号，不是第二事实源）；
 *           发 context-economy/* 事件（log-only）；
 * 度量: mappingHit / mappingStaleRate（docs/07，待映射实体接入后观测）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TaskBoundarySignal, TaskCompactedSignal } from './events.ts'

/**
 * 发射 task 段边界信号（图谱更新占位——当前仅 ctx.emit + logger，不写存储）。
 * @param ctx - 插件上下文（emit/log）。
 * @param session - 会话（取 sessionId）。
 * @param signal - 边界信号。
 */
export function emitTaskBoundary(ctx: Context, session: Session, signal: TaskBoundarySignal): void {
  ctx.emit('context-economy/task-boundary', signal)
  ctx.logger.info(
    `task-memory: boundary task=${signal.taskId} session=${signal.sessionId}`,
  )
}

/**
 * 发射压缩完成信号（提供给后续图谱/摘要消费方）。
 */
export function emitTaskCompacted(
  ctx: Context,
  signal: TaskCompactedSignal,
): void {
  ctx.emit('context-economy/task-compacted', signal)
  ctx.logger.info(
    `task-memory: compacted task=${signal.taskId} shadowedTokens=${signal.shadowedTokenCount}`,
  )
}
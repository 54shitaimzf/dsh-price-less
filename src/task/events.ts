/**
 * context-economy 事件命名空间（log-only）。
 *
 * 模块: 事件声明
 * 平面: L0（事件发射，无计算）
 * 回退链步数: 1（用户可控指令——占位语义由后续文档合并时定；当前仅信号）
 * 审查清单: 无 LLM 调用；不写任何存储（占位=信号，不是第二事实源）；
 *           事件 log-only（可回放，不触发副作用）；
 * 度量: mappingHit / mappingStaleRate（docs/07，待映射实体接入后观测）。
 */

import type { BoundaryKind } from './types.ts'

/** task 边界信号载荷（图谱更新占位）。 */
export interface TaskBoundarySignal {
  sessionId: string
  taskId: string
  kind: BoundaryKind
  evidence: string[]
}

/** 压缩完成信号载荷。 */
export interface TaskCompactedSignal {
  sessionId: string
  taskId: string
  compactionId: string
  shadowedTokenCount: number
}

/** 声明合并到 cordis Events：context-economy/* 命名空间集中登记（官方式：@deepseek-ai/cordis）。 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** task 边界信号（图谱更新占位；log-only）。 */
    'context-economy/task-boundary'(signal: TaskBoundarySignal): void
    /** 压缩完成信号（log-only）。 */
    'context-economy/task-compacted'(signal: TaskCompactedSignal): void
  }
}

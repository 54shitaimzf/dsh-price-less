/**
 * task-boundary 事实载荷与声明合并（P13；docs/10 §1 H14 / docs/12 §2 编译闸）。
 * 只做可序列化载荷构造与声明；不发射事实、不 import 运行期 harness。
 */
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import { TASK_BOUNDARY_FACT_TYPE } from '../core/ledger/facts.ts'
import type { TaskBoundaryFactData } from '../core/units.ts'

declare module '@deepseek-ai/dsh-session/types' {
  // ignorable: task-boundary 为 log-only 事实，须同步并入 IgnorableSessionEventMap。
  interface SessionEventMap {
    'context-economy/task-boundary': TaskBoundaryFactData // ignorable
  }
  interface IgnorableSessionEventMap {
    'context-economy/task-boundary': TaskBoundaryFactData // ignorable
  }
}

export interface TaskBoundaryCommand {
  boundary: 'open' | 'close'
  taskId: string
  reason?: string
}

export function buildTaskBoundaryData(cmd: TaskBoundaryCommand): TaskBoundaryFactData {
  return {
    taskId: cmd.taskId,
    boundary: cmd.boundary,
    ...(cmd.reason === undefined ? {} : { reason: cmd.reason }),
  }
}

export { TASK_BOUNDARY_FACT_TYPE }

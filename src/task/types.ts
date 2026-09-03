/**
 * 任务记忆域类型出口：task 段状态机形状与投影 key 声明（纯类型，无运行时值）。
 *
 * 模块名: task 段状态机投影单元
 * 平面: L0（事件观测 + 纯规则 fold）——边界来源 = 用户显式指令
 *       （/task，回退链第 1 步）+ 判别器语义票（v0.8.0 接入，回退链第 2 步）
 * 回退链步数: 1（用户可控指令：显式 /task）→ 2（判别器语义票：段内切分）
 * 审查清单: 数据取自会话日志确定性事件；全部 L0 化（fold 纯函数无 IO/无模型）；
 *           不调用模型/文件/事件；模块自证附于 apply
 * 度量: segmentsPerSession / taskSwitchRate / taskDefinitionBytes（docs/07）
 *
 * v0.3.0：机械判定层退役（信号合议/簇迁移/todo 信号/词汇意图词全部移除，
 * 退役快照见 docs/07 §16）；状态形状精简为段生命周期。anchorText =
 * 段头用户消息原文——权威段资产与判别锚静态基准（判别器输入组装用），
 * 与可见层"用户指令原文"同源，永不漂移。
 */

import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** task 段生命周期状态。 */
export type TaskStatus = 'active' | 'closed'

/**
 * 一个被记忆的 task 段（边界单元：记录何时开始/结束，不含意图语义——
 * 意图唯一在文件与寻址域（docs/15）；机械判据已退役，边界事件由
 * 显式指令 / 判别器给出，审计经事件 reason/日志追溯）。
 */
export interface TaskRecord {
  /** task 标识：'task-<起始 seq>'（或 T0 用户显式命名）。 */
  taskId: string
  /** task 首个 surface 事件的 seq。 */
  startSeq: number
  /** task 内最后一个 surface 事件的 seq（压缩 replace 后可能变化）。 */
  lastSurfaceSeq: number
  /** 压缩/摘要产出的内容摘要；null 表示尚无摘要。 */
  summary: string | null
  /** 生命周期状态。 */
  status: TaskStatus
  /**
   * 段头锚：本段首条用户消息原文（L0 纯规则产物，消息文本即锚）。
   * 判别锚静态基准与权威段资产——判别器输入组装按"段头原文 + 消息窗"取用。
   */
  anchorText: string
}

/**
 * 当前活动 task 段指针（task 表中 status:'active' 的一员，键重复校验由 fold 保证）。
 */
export interface CurrentTaskRef {
  taskId: string
  startSeq: number
  lastSurfaceSeq: number
}

/**
 * 投影单元状态（plain JSON——persisted-cache 前提）：
 * fold 自 session 日志事件，一次 commit 一个 apply，无任何副作用。
 */
export interface ContextEconomyTaskState {
  /** 已知 task 段表（按 startSeq 升序；active 至多一个）。 */
  tasks: TaskRecord[]
  /** 当前活动段指针；null 表示空会话/无任务。 */
  current: CurrentTaskRef | null
  /**
   * 表面位置映射：seq → 表面位置（含压缩 replace 后的重映射）。
   * 仅记录"仍在表面上的 seq"；被 replace 的旧 seq 移出。
   */
  surfaceIndex: Record<string, number>
  /** 上一次已转正的边界事件 seq；null 表示尚未有边界。 */
  lastBoundarySeq: number | null
  /** 已确认"完成压缩"的 taskId 集合（防重复触发）。 */
  compactedTaskIds: string[]
  /** 最近一次边界事件（供指挥半边发射信号）。 */
  lastBoundary: { taskId: string } | null
}

/** 投影 key（host-only 单元，无 wire——本轮无需客户端视图）。 */
export const TASK_PROJECTION_KEY = 'contextEconomyTask' as const

/** 声明合并：把本单元 key 注册进投影状态表（host-only，仅出现在状态表）。 */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    contextEconomyTask: ContextEconomyTaskState
  }
}

/** 类型别名：注册时使用的定义形状（供 projection.ts 的 satisfies 校验）。 */
export type TaskProjectionDefinition = ProjectionDefinition<
  typeof TASK_PROJECTION_KEY,
  ContextEconomyTaskState
>
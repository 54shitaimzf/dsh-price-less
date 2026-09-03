/**
 * context-economy 事件命名空间（log-only）。
 *
 * 模块: 事件声明
 * 平面: L0（事件发射，无计算）
 * 回退链步数: 1（用户可控指令——占位语义由后续文档合并时定；当前仅信号）
 * 审查清单: 无 LLM 调用；不写任何存储（占位=信号，不是第二事实源）；
 *           事件 log-only（可回放，不触发副作用）；
 * 度量: mappingHit / mappingStaleRate（docs/07，待映射实体接入后观测）。
 *
 * v0.3.0：机械判定层退役——TaskBoundarySignal 移除机械证据字段（kind/evidence），
 * 只保留边界事实（taskId）；判别器接入后审计经 reason/日志追溯。
 *
 * v0.4.0：判别器事件族（docs/07 §18）——judge-recorded（一次判定完整审计记录，
 * 即溯源图节点）/ judge-error（错误链路摘要）/ judge-verdict（语义票边界信号，
 * 仅 active 模式发）。三者均 log-only：记录可回放，verdict 供后续段状态机消费。
 *
 * v0.8.0：语义票闭环（docs/07 §20）——judge-verdict 双通道：①cordis 事件
 * （live 总线，log-only）；②**会话日志事件**（session.append，与 todo/write 同
 * 先例；non-surface，不进模型历史，回放即重建边界事实）。后者是投影 fold 的
 * 消费面——**回放确定性**：折叠源 = 会话日志，重放同序同字节。
 */

import type { JudgeError, JudgeRecord, DiscVerdict } from '../discriminator/trace.ts'

/** task 段边界信号载荷（图谱更新占位）。 */
export interface TaskBoundarySignal {
  sessionId: string
  taskId: string
}

/** 压缩完成信号载荷。 */
export interface TaskCompactedSignal {
  sessionId: string
  taskId: string
  compactionId: string
  shadowedTokenCount: number
}

/** 判别错误事件载荷（错误链在外层，含判定位）。 */
export interface JudgeErrorEvent {
  judgeId: string
  sessionId: string
  seq: number
  verdict: DiscVerdict
  errors: JudgeError[]
}

/** 语义票边界信号（active 模式；与 task-boundary 同构——log-only，消费方后续接入）。 */
export interface JudgeVerdictEvent {
  judgeId: string
  sessionId: string
  seq: number
  verdict: DiscVerdict
}

/**
 * 语义票的**会话日志**载荷（v0.8.0 接入投影 fold 的 replay 面）。
 * 与 JudgeVerdictEvent 的差异：无 sessionId（会话事件天然 scoped）、
 * 携带 anchorText（新段锚 = 判定目标消息原文，与可见层用户指令原文同源——字节稳定）。
 */
export interface JudgeVerdictSessionData {
  judgeId: string
  /** 目标用户消息 seq（判别对象；边界锚定位置）。 */
  seq: number
  verdict: DiscVerdict
  /** 目标消息原文（新段段头锚；判别器持有、逐字写入——回放可重建锚）。 */
  anchorText: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 判别器语义票（active 模式、verdict=new-task 才追加；log-only、non-surface：
     * 不进模型历史，只作段状态机 fold 的 replay 面）。同 todo/write 声明合并范式。
     */
    'context-economy/judge-verdict': JudgeVerdictSessionData
  }
}

/** 声明合并到 cordis Events：context-economy/* 命名空间集中登记（官方式：@deepseek-ai/cordis）。 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** task 段边界信号（图谱更新占位；log-only）。 */
    'context-economy/task-boundary'(signal: TaskBoundarySignal): void
    /** 压缩完成信号（log-only）。 */
    'context-economy/task-compacted'(signal: TaskCompactedSignal): void
    /** 判别记录（一次判定的完整审计记录；log-only 可回放）。 */
    'context-economy/judge-recorded'(record: JudgeRecord): void
    /** 判别错误（错误链摘要；log-only）。 */
    'context-economy/judge-error'(error: JudgeErrorEvent): void
    /** 判别语义票边界信号（仅 active 模式；log-only）。 */
    'context-economy/judge-verdict'(verdict: JudgeVerdictEvent): void
  }
}
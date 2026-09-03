/**
 * 压缩驱动端口：把"对已关闭 task 的一次压缩"抽象为可替换单元。
 * 现在 = 原生 compactRegion；后续自研实现 = 换一个实现即换驱动。
 *
 * 模块: task 压缩驱动
 * 平面: L0（范围选择）+ L1（原生压缩 = 回退链第 6 级：最小断面摘要）
 * 回退链步数: 6（原生压缩 = 最小断面摘要）
 * 审查清单: 失败安全（busy/changed 等预期失败记日志后放弃，绝不抛错打断 step）；
 *           agent 参数为 harness 的 CompactionAgentContext 结构（session + options）；
 *           压缩结果按 CompactionResult 契约读取；度量: compaction/* 事件（docs/07）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionAgentContext, CompactionEngine, CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { TaskRecord } from './types.ts'
import type { CompressibleRange } from './range.ts'

/** 压缩驱动接口（替换缝：现在 = 原生 compactRegion；后续自研 = 新实现）。 */
export interface CompressionDriver {
  /** 对已关闭 task 的范围触发一次压缩；返回压缩结果（或 null 表示跳过）。 */
  trigger(
    task: TaskRecord,
    range: CompressibleRange,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult | null>
}

/** 原生压缩驱动：包 compactRegion + 失败分类（busy/changed 记日志后放弃）。 */
export class NativeCompressionDriver implements CompressionDriver {
  constructor(
    private readonly compaction: CompactionEngine,
    private readonly logger: Pick<Context['logger'], 'warn' | 'info'> = {
      warn: () => {},
      info: () => {},
    },
  ) {}

  async trigger(
    task: TaskRecord,
    range: CompressibleRange,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult | null> {
    try {
      // agent 满足 harness 的 CompactionAgentContext 结构（session + options），
      // 直接传递真实 agent，避免包装 {session, options} 伪对象（脆弱耦合）。
      const context: CompactionAgentContext = { session: agent.session, options: agent.options }
      const result = await this.compaction.compactRegion(range.start, range.end, context, signal)
      if (result !== null) {
        this.logger.info(
          `task-memory: compacted task=${task.taskId} range=${range.start}..${range.end} `
          + `shadowedTokens=${result.shadowedTokenCount}`,
        )
      }
      return result
    } catch (error: unknown) {
      // fail-lazy：busy/changed/无开放 turn 均为预期失败——记录后放弃本 task，下一边界再试。
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn(`task-memory: compaction skipped for task=${task.taskId}: ${message}`)
      return null
    }
  }
}

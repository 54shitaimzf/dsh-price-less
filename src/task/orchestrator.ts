/**
 * 指挥半边：在 agent/pre-step（开放 turn、平衡边界已就绪）读投影状态，
 * 对已关闭且未压缩的 task 段驱动原生压缩；并在上下文溢出时接管自动恢复。
 *
 * 职责边界（三职责互不耦合，各挂一个事件）：
 *   职责 A（信号发射）：投影状态推进 → 转发 task 边界事件（emitTaskBoundary）；
 *   职责 B（压缩触发）：已关闭未压缩 task → 范围选择 → 驱动压缩 → 发压实信号；
 *   职责 C（溢出接管）：CONTEXT_WINDOW_EXCEEDED 请求错误 → 触发原生压缩兜底。
 *   与判定无关：本文件**不参与**边界判定（边界来源 = 显式指令 / 判别器），
 *   只消费投影状态做确定性规则动作（docs/10 挂点：agent/pre-step + agent/request-error）。
 *
 * 模块: task 压缩指挥
 * 平面: L0（状态读取 + 分支）+ L1（压缩触发 = 原生引擎的 LLM 摘要，属回退链第 6 级）
 * 回退链步数: 2（代码分支：状态读取 + 范围选择）→ 6（原生压缩 = 最小断面摘要）
 * 审查清单: 信号取自投影状态（日志 fold）；压缩失败安全（fail-lazy，绝不抛错打断 step）；
 *           CompressionDriver 接口为"替换压缩"留缝（后续自研实现即换驱动）；
 *           v0.3.0：机械判定层退役——边界来源 = 显式指令 / 判别器（待接入），
 *           本文件只负责压缩触发与溢出接管，不参与判定。
 * 度量: segmentsPerSession / taskSwitchRate / compaction/* 事件（docs/07）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ContextEconomyTaskState } from './types.ts'
import { selectCompressibleRange } from './range.ts'
import { recencyTailCutoff, selectColdClosedTask } from './range-task-partitioned.ts'
import { emitTaskBoundary, emitTaskCompacted } from './graph-hook.ts'
import type { TaskBoundarySignal } from './events.ts'
import { NativeCompressionDriver, type CompressionDriver } from './driver.ts'
import { TASK_PROJECTION_KEY } from './types.ts'

/** tokenMeter 服务的最小形状（measure 返回带 tokens 的表面节点，供近因尾累加）。 */
export interface TokenMeterShape {
  measure(session: Session): { nodes: readonly { seq: number; tokens: number }[] }
}

/** 指挥半边依赖注入形状。 */
export interface OrchestratorDeps {
  readonly ctx: Context
  readonly sessionProjections: {
    stateOf(session: Session, key: string): ContextEconomyTaskState | undefined
  }
  readonly compaction?: CompactionEngine
  readonly driver?: CompressionDriver
  /** 压缩驱动选择：'native' = 现有行为；'task-partitioned' = 近因保留尾 + 冷区闭合任务整压（A3）。 */
  readonly compressionDriverMode?: 'native' | 'task-partitioned'
  /** 近因保留尾阈值（token；仅 task-partitioned 用）。 */
  readonly retainTokens?: number
  /** tokenMeter（仅 task-partitioned 用；缺省则不启用近因门，回退现有行为）。 */
  readonly tokenMeter?: TokenMeterShape
  /** 保守引用门（A4；缺省不启用）。 */
  readonly stillReferenced?: (taskId: string) => boolean
}

/**
 * 在 agent/pre-step 上注册指挥逻辑（effect：disposer 随 fiber 清理）。
 */
export function registerOrchestrator(deps: OrchestratorDeps): () => void {
  const { ctx, sessionProjections } = deps
  const driver = deps.driver ?? (deps.compaction !== undefined
    ? new NativeCompressionDriver(deps.compaction, ctx.logger)
    : undefined)

  let lastBoundarySeqSeen = -1

  const disposePreStep = ctx.on(
    'agent/pre-step',
    async ({ agent, signal }, next) => {
      // 1) 读取投影状态（经 stateOf；key 未注册时直接放行——headless 弹性）。
      const state = sessionProjections.stateOf(agent.session, TASK_PROJECTION_KEY)
      if (state === undefined) return next()

      if (driver === undefined) return next()

      // —— 职责 A：边界信号发射（每次状态推进都检一次 lastBoundary；幂等由 seq 门控）——
      if (state.lastBoundary !== null && state.lastBoundarySeq !== null
        && state.lastBoundarySeq > lastBoundarySeqSeen) {
        lastBoundarySeqSeen = state.lastBoundarySeq
        const signal: TaskBoundarySignal = {
          sessionId: agent.id,
          taskId: state.lastBoundary.taskId,
        }
        emitTaskBoundary(ctx, agent.session, signal)
      }

      // —— 职责 B：压缩触发（找到「已关闭 + 未压缩」的 task 段，逐个驱动压缩（本轮先处理最近一个））——
      let pending = state.tasks.find(task => (
        task.status === 'closed' && !state.compactedTaskIds.includes(task.taskId)
      ))
      if (pending === undefined) return next()

      // task 分划保留策略（A3）：近因保留尾 + 冷区闭合任务整压——近因尾内的闭合任务
      // **逐字保留**（不压，保热），只压冷区内的闭合任务（边界锚定，不切任务）。
      if (deps.compressionDriverMode === 'task-partitioned' && deps.tokenMeter !== undefined) {
        const measurement = deps.tokenMeter.measure(agent.session)
        const cutoff = recencyTailCutoff(
          measurement.nodes.map(n => ({ seq: n.seq, tokens: n.tokens })),
          deps.retainTokens ?? 0,
        )
        if (cutoff === null) {
          // 整段皆近因尾（无可压冷区）→ 不压（保热）。
          return next()
        }
        const cold = selectColdClosedTask(state, agent.session.surface.nodes, cutoff, {
          stillReferenced: deps.stillReferenced,
        })
        if (cold === null) return next()
        pending = cold
      }

      const range = selectCompressibleRange(pending, agent.session.surface.nodes, {
        session: agent.session,
      })
      if (range === null) return next()

      // 4) 驱动压缩（不阻塞 step：失败 → fail-lazy 返回 next；成功 → 发信号）。
      const result = await driver.trigger(pending, range, agent, signal)
      if (result !== null) {
        emitTaskCompacted(ctx, {
          sessionId: agent.id,
          taskId: pending.taskId,
          compactionId: String(result.compactionId),
          shadowedTokenCount: result.shadowedTokenCount,
        })
      }
      return next()
    },
    { global: true, prepend: true },
  )

  // 5) 溢出恢复接管（auto:false 后原生 request-error 钩子停用；本插件兜底）。
  const disposeOverflow = ctx.on(
    'agent/request-error',
    async ({ agent, failure, signal }, next) => {
      if (deps.compaction === undefined) return next()
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      try {
        await deps.compaction.compactIfNeeded(
          { session: agent.session, options: agent.options },
          'context-overflow',
          signal,
        )
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`task-memory: overflow recovery failed: ${message}`)
      }
      return next()
    },
    { global: true, prepend: true },
  )

  return () => {
    disposePreStep()
    disposeOverflow()
  }
}
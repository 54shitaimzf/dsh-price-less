/**
 * H2 步准入端口（docs/10 §1 H2「边界/步准入：agent/pre-step（waterfall）」；P19a）。
 * 唯一持有 `@deepseek-ai/dsh-agent` 类型面与 `agent/pre-step` 字面的收口点（D14 断言锁定）：
 * 域侧只看到 `{ session, turn, step, aborted }` 与一个异步回调。
 *
 * 契约（docs/10 §1 H2 + docs/11 §4 纪律②）：
 * - waterfall **必须 `return next()`**——本端口永不拒绝步骤，只做旁路动作；
 * - 回调异常只 warn 不外溢（fail-lazy：压缩失败绝不阻塞本轮）；
 * - 回调同步返回即放行；返回 Promise 时等待其完成（边界压缩需在请求派生之前落盘）。
 *
 * 模块: platform 步准入端口（唯一 harness 触点层）
 * 平面: L0（事件注册 + 异常遏制；无模型、无机制逻辑）
 * 回退链步数: 1（回调失败 → warn + 继续 next()）
 * 审查清单: 不改史、不写 KV；waterfall 恒放行；signal 中止时不调用回调。
 * 度量: 无 07 字段（触发结果由调用侧事实记录）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CeLogger } from './events.ts'

/** 步准入回调载荷（域侧最小面；不含 agent 本体，避免 harness 类型外溢）。 */
export interface AgentPreStepPayload {
  readonly session: Session
  readonly turn: number
  readonly step: number
}

export interface AgentPreStepOptions {
  /** 回调（可异步）；异常被遏制为 warn，绝不影响 `next()`。 */
  handler: (payload: AgentPreStepPayload) => void | Promise<void>
  logger?: CeLogger
}

/** 注册 `agent/pre-step` 旁路监听；返回退订函数。 */
export function onAgentPreStep(ctx: Pick<Context, 'on'>, options: AgentPreStepOptions): () => void {
  const off = ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next): Promise<PreStepDecision> => {
    if (!signal.aborted) {
      try {
        await options.handler({ session: agent.session, turn, step })
      } catch (e) {
        options.logger?.warn(
          'context-economy: pre-step handler error contained (fail-lazy, step continues)',
          e instanceof Error ? e.message : String(e),
        )
      }
    }
    return next()
  })
  return () => { off() }
}

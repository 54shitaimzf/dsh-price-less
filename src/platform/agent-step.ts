/**
 * H2/H3/H9 步准入、请求失败与恢复端口（docs/10 §1 H2「边界/步准入：agent/pre-step」+
 * H3「压力触发 + agent/request-error 接管」+ H9「恢复：agent/session-start」；P19a + P20b + P21a）。
 * 唯一持有 `@deepseek-ai/dsh-agent` 类型面、`agent/pre-step` / `agent/request-error` /
 * `agent/session-start` 字面的收口点（D14/D16 断言锁定）：域侧只看到
 * `{ session, turn, step, aborted }` / `{ session, source }` 与一个异步回调。
 *
 * 契约（docs/10 §1 H2/H3 + docs/11 §4 纪律②）：
 * - pre-step waterfall **必须 `return next()`**——本端口永不拒绝步骤，只做旁路动作；
 * - request-error waterfall：仅当回调返回 `'retry'` 时接管（返回 `{kind:'retry'}` 且不调 next）；
 *   其余一律 `next()` 委派（把失败语义留给上游策略）；
 * - 回调异常只 warn 不外溢（fail-lazy：压缩失败绝不阻塞本轮，也绝不吞掉原始错误）；
 * - 回调同步返回即放行；返回 Promise 时等待其完成（边界压缩需在请求派生之前落盘）。
 *
 * 模块: platform 步准入端口（唯一 harness 触点层）
 * 平面: L0（事件注册 + 异常遏制；无模型、无机制逻辑）
 * 回退链步数: 1（回调失败 → warn + 继续 next()）
 * 审查清单: 不改史、不写 KV；waterfall 恒放行；signal 中止时不调用回调。
 * 度量: 无 07 字段（触发结果由调用侧事实记录）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision, RequestErrorAction, SessionStartSource } from '@deepseek-ai/dsh-agent'
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

/** 请求失败回调载荷（域侧最小面；错误码已归一为字符串，llm 类型不外溢）。 */
export interface AgentRequestErrorPayload {
  readonly session: Session
  readonly turn: number
  readonly step: number
  readonly provider: string
  /** provider 中立错误码（缺失 = 空串；溢出码判定归 platform/llm.ts 词汇面）。 */
  readonly failureCode: string
}

export interface AgentRequestErrorOptions {
  /** 返回 'retry' = 接管（本轮重试）；'pass' = 委派上游。异常被遏制为 'pass'。 */
  handler: (payload: AgentRequestErrorPayload) => AgentRequestErrorAction | Promise<AgentRequestErrorAction>
  logger?: CeLogger
}

export type AgentRequestErrorAction = 'retry' | 'pass'

/** 注册 `agent/request-error` 旁路监听；返回退订函数（非接管恒 next()）。 */
export function onAgentRequestError(ctx: Pick<Context, 'on'>, options: AgentRequestErrorOptions): () => void {
  const off = ctx.on('agent/request-error', async ({ agent, turn, step, provider, failure, signal }, next): Promise<RequestErrorAction> => {
    if (!signal.aborted) {
      try {
        const action = await options.handler({
          session: agent.session,
          turn,
          step,
          provider,
          failureCode: typeof failure?.code === 'string' ? failure.code : '',
        })
        if (action === 'retry') return { kind: 'retry' }
      } catch (e) {
        options.logger?.warn(
          'context-economy: request-error handler error contained (fail-lazy, failure delegated upstream)',
          e instanceof Error ? e.message : String(e),
        )
      }
    }
    return next()
  })
  return () => { off() }
}
/** H9 恢复回调载荷（域侧最小面；source 为 harness SessionStartSource 本地转发）。 */
export interface AgentSessionStartPayload {
  readonly session: Session
  readonly source: SessionStartSource
}

export interface AgentSessionStartOptions {
  /** 回调（可异步）；异常被遏制为 warn，绝不影响启动（H9 同步且不可 veto）。 */
  handler: (payload: AgentSessionStartPayload) => void | Promise<void>
  logger?: CeLogger
}

/**
 * 注册 `agent/session-start` 旁路监听；返回退订函数。
 * 事件为同步 emit（无 next/无 veto）：回调体 detached 执行，异常只 warn；
 * 调用方若需在异步装配完成后才具备处理器，应在回调内自行缓冲（index.ts pending 缓冲先例）。
 */
export function onAgentSessionStart(ctx: Pick<Context, 'on'>, options: AgentSessionStartOptions): () => void {
  const off = ctx.on('agent/session-start', ({ agent, source }) => {
    void (async (): Promise<void> => {
      try {
        await options.handler({ session: agent.session, source })
      } catch (e) {
        options.logger?.warn(
          'context-economy: session-start handler error contained (fail-lazy, startup continues)',
          e instanceof Error ? e.message : String(e),
        )
      }
    })()
  })
  return () => { off() }
}

/**
 * H2/H3/H9 步准入、请求失败与恢复端口（docs/10 §1 H2「边界/步准入：agent/pre-step」+
 * H3「压力触发 + agent/request-error 接管」+ H9「恢复：agent/session-start」；P19a + P20b + P21a）。
 * 唯一持有 `@deepseek-ai/dsh-agent` 类型面、`agent/pre-step` / `agent/request-error` /
 * `agent/session-start` 字面的收口点（D14/D16 断言锁定）：域侧只看到
 * `{ session, turn, step, aborted }` / `{ session, source }` 与一个异步回调。
 *
 * 契约（docs/10 §1 H2/H3 + docs/11 §4 纪律②）：
 * - pre-step waterfall **必须 `return next()`**——本端口永不拒绝步骤，只做旁路动作；
 *   A（2026-09-11）：回调**在 `next()` 之前 await**，故回调耗时即步骤等待耗时（边界压缩靠此阻塞，
 *   靠 `CE_LLM_TIMEOUT_MS` 有界）；载荷带 `userTexts`（本步即将落会话的用户消息，见 AgentPreStepPayload）；
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
import { userMessageText } from './events.ts'

/** 步准入回调载荷（域侧最小面；不含 agent 本体，避免 harness 类型外溢）。 */
export interface AgentPreStepPayload {
  readonly session: Session
  readonly turn: number
  readonly step: number
  /**
   * A/F2（2026-09-11）：本步**即将被接纳**的用户消息文本（harness `pre-step` 载荷的 `messages`）。
   *
   * 关键时序：这些消息此刻**尚未落会话**——harness 在 pre-step 返回之后才 `append('user/message')`
   * （`@deepseek-ai/dsh-agent-loop` `agent.ts`：`preStep()` L289 → `step/start` L302 →
   * `user/message` L375）。因此"按会话 seq 建屏障"**恒晚一步**（真机实测：`new-task` 判词落地时
   * 首步思考早已产出，压缩被推迟到第二步并阻塞 62.6s）。边界判定必须以本字段为输入，
   * 才能在 `next()` 之前完成压缩——这正是 F2 的成文原意。
   */
  readonly userTexts: readonly string[]
}

export interface AgentPreStepOptions {
  /** 回调（可异步）；异常被遏制为 warn，绝不影响 `next()`。 */
  handler: (payload: AgentPreStepPayload) => void | Promise<void>
  logger?: CeLogger
}

/** 注册 `agent/pre-step` 旁路监听；返回退订函数。 */
export function onAgentPreStep(ctx: Pick<Context, 'on'>, options: AgentPreStepOptions): () => void {
  const off = ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next): Promise<PreStepDecision> => {
    if (!signal.aborted) {
      try {
        // A：把"即将落会话"的用户消息文本交给域侧（屏障/边界判定必须用它，见 AgentPreStepPayload）。
        // 过滤口径与输入面五条件**逐条对齐**（platform/events.ts `passesInputFace`）：只有
        // `source.kind === 'user'` 的真用户消息才算边界来源——否则 agent-instructions / plugin /
        // runtime-context 这些同型 `user/message` 会被误判成"新任务"（它们不是用户的意图声明）。
        const userTexts: string[] = []
        for (const message of messages) {
          if ((message as { source?: { kind?: string } }).source?.kind !== 'user') continue
          const text = userMessageText(message)
          if (text !== null) userTexts.push(text)
        }
        await options.handler({ session: agent.session, turn, step, userTexts })
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

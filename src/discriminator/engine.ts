/**
 * 判别器引擎：挂在 session/event 上（输入面 = append user/message 且
 * source.kind === 'user'），输出语义票（observe 只记账；active 发 verdict 事件）。
 *
 * 模块: 判别器引擎（接入主循环）
 * 平面: L0（事件观测 + 规则快路径 + 查表/指纹）→ L1（LLM 语义判定 = 回退链第 2 级）
 * 回退链步数: 1（T0 显式 /task）→ 2（L0-continue 词表）→ 3（L1 精确键缓存）
 *   → 4（LLM 判别 = 主路径）→ 兜底（fail-lazy：判不了 = continue，零动作）
 * 审查清单（三层容错，docs/12 §4 守卫 + docs/07 §18）:
 *   - 运行期容错: 事件处理器同步快速返回（异步旁路，绝不阻塞主循环）；
 *     每条路径 try/catch，异常 → 错误链（JudgeError）+ 降级（degrade/fallback/skip），
 *     一律不外溢到事件总线；LLM 调用带 AbortSignal + 超时（timeoutMs）；
 *     并发闸（maxConcurrency + 排队上限 64，超出记 overload 跳过）；
 *   - 行为隔离: mode='observe'（默认）只记台账/日志/事件，不发 verdict、不写任何状态；
 *     mode='active' 才额外发 context-economy/judge-verdict；
 *   - 字节稳定: 模板在前/实例参数在后；窗口口径与 phase_b_prep.mjs v6 冻结同构；
 *     L1 缓存键含配置面（配置变即键变，不串味）；同输入→同判定；
 *   - 输入面: 仅主会话（parentSession===undefined）+ source.kind==='user' +
 *     append（replace 不判）+ 非伪 user + 非空文本；u=0（首条）交给投影隐式开段；
 *   - 模块自证附于本头注释。
 * 度量: judgeCount / judgeErrorRate / judgeCacheHitRate / judgeLatencyMs（docs/07 §18）
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, type GenerateOptions, type LlmRuntime, type ReasoningEffortId, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ContextEconomyTaskState } from '../task/types.ts'
import { TASK_PROJECTION_KEY } from '../task/types.ts'
import { classifyExplicitUserMessage, userMessageText } from '../task/explicit.ts'
import type { DiscriminatorConfig } from '../config.ts'
import {
  DEFAULT_DISC_PRESET,
  DISC_CAPABILITIES,
  DISC_PRICING,
  estimateJudgeCost,
  materializeDiscCallConfig,
  sanitizeEffort,
  type DiscCallConfig,
} from './presets.ts'
import { isL0Continue, isPseudoUser } from './l0.ts'
import {
  DISC_PROMPT_DEFAULT_VERSION,
  buildDiscWindow,
  renderDiscPrompt,
  type DiscWindow,
} from './prompt.ts'
import { JudgeJournal } from './journal.ts'
import {
  makeJudgeCacheKey,
  makeJudgeId,
  parseDecision,
  fingerprintText,
  serializeJudgeRecord,
  truncateError,
  type DiscVerdict,
  type JudgeError,
  type JudgeLlmFacts,
  type JudgeModelView,
  type JudgeRecord,
  type JudgeSourceRef,
} from './trace.ts'

/** 判别器依赖注入形状（结构性 reader，避免与 index.ts 循环 import）。 */
export interface DiscriminatorDeps {
  readonly ctx: Context
  /** 已补全的判别器配置（resolveConfig 之后；含 mode/preset/高级覆盖/容错参数）。 */
  readonly config: DiscriminatorConfig
  /** 投影读取（可选：headless/未装配时 contextModel='unbound'，仍可判）。 */
  readonly stateOf?: (session: Session, key: string) => ContextEconomyTaskState | undefined
}

/** 排队上限（超出 = overload 跳过；不无限排队防内存/延迟爆炸）。 */
const PENDING_CAP = 64
/** 判别占位消息（固定文本：上下文全在 system，本消息仅占位——字节稳定）。 */
const JUDGE_PLACEHOLDER = '（判别上下文见 system 消息；本消息仅为判定占位。）'

/** 判断流是否因超时/卸载中止而失败（AbortError 归一化）。 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** 把配置里的可选覆盖清洗成 materialize 的覆盖对象（undefined 字段不发送——防覆盖预设）。 */
function cleanOverrides(cfg: DiscriminatorConfig): Partial<DiscCallConfig> {
  const out: Partial<DiscCallConfig> = { promptVersion: cfg.promptVersion }
  if (cfg.provider !== undefined) out.provider = cfg.provider
  if (cfg.model !== undefined) out.model = cfg.model
  if (cfg.temperature !== undefined) out.temperature = cfg.temperature
  if (cfg.maxTokens !== undefined) out.maxTokens = cfg.maxTokens
  if (cfg.effort !== undefined) out.effort = cfg.effort
  return out
}

/** U 空间口径（phase_b_prep.mjs v6 冻结）：append user/message（任意 source kind）。 */
export function isAppendUserMessage(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const surfaceOp: unknown = event.surfaceOp
  if (surfaceOp === undefined) return true
  if (surfaceOp === 'append') return true
  return typeof surfaceOp === 'object' && surfaceOp !== null
    && (surfaceOp as { op?: unknown }).op === 'append'
}

/**
 * 会话内指定 seq 之前的 U 空间消息数（0 基 u 锚定；纯函数，日志回放确定性）。
 * 场景：engine 中途装配/重载后，把"该消息 u"从会话日志推出，避免把新消息误判成 u=0 首条漏判。
 */
export function userIndexBefore(events: readonly SessionEvent[], endSeq: number): number {
  let count = 0
  for (const event of events) {
    if (event.seq >= endSeq) continue
    if (isAppendUserMessage(event)) count += 1
  }
  return count
}

/** 段内历史用户消息文本收集（时间升序；取 target 前最近 window 条，窗口口径 = v6 冻结）。 */
export function collectHistoryTexts(
  events: readonly SessionEvent[],
  startSeq: number,
  endSeq: number,
  window: number,
): string[] {
  const out: string[] = []
  if (window <= 0) return out
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.seq <= startSeq) break // 开区间：段头（startSeq）不入 patches——anchor 单独承载
    if (event.type !== 'user/message') continue
    if (event.seq >= endSeq) continue
    if (!isAppendUserMessage(event)) continue
    if (event.data.source.kind !== 'user') continue
    const text = userMessageText(event)
    if (text.trim().length === 0 || isPseudoUser(text)) continue
    out.push(text)
    if (out.length >= window) break
  }
  return out.reverse()
}

/** 判别器引擎（fiber 内实例；dispose 卸载即净）。 */
export class DiscriminatorEngine {
  private readonly deps: DiscriminatorDeps
  private readonly journal: JudgeJournal
  /** 归一化运行模式（'off' 在装配层即不挂载；这里映射为 observe 兜底——类型安全）。 */
  private readonly mode: 'observe' | 'active'
  /** L1 精确键缓存（有界 LRU；键含配置面——同输入防重，不降语料调用）。 */
  private readonly cache = new Map<string, { verdict: DiscVerdict; judgeId: string }>()
  /** 进行中判别的中止控制器（dispose/session disposed 时统一取消）。 */
  private readonly inflight = new Map<string, AbortController>()
  /** 会话 U 空间游标（append user/message 任意 kind；**锚定会话日志推导基数**，重载/重启不丢）。 */
  private readonly umIndex = new Map<string, number>()
  private active = 0
  private readonly pending: Array<() => void> = []
  /** 判别记录落盘（judge-records.jsonl，常开；失败 = null = 仅日志降级）。 */
  private readonly recordsFile: string | null
  /** 输入/输出原始日志落盘（judge-io.jsonl，仅 debugIo=true；失败 = null）。 */
  private readonly ioFile: string | null

  constructor(deps: DiscriminatorDeps) {
    this.deps = deps
    this.journal = new JudgeJournal(deps.config.journalLimit)
    this.mode = deps.config.mode === 'off' ? 'observe' : deps.config.mode
    // 落盘目录：配置 journalPath 或默认 ~/.dsh/context-economy/；mkdir 失败 → 降级为仅日志。
    try {
      const base = deps.config.journalPath.trim().length > 0
        ? deps.config.journalPath
        : join(homedir(), '.dsh', 'context-economy')
      mkdirSync(base, { recursive: true })
      this.recordsFile = join(base, 'judge-records.jsonl')
      this.ioFile = deps.config.debugIo ? join(base, 'judge-io.jsonl') : null
      deps.ctx.logger.info(`discriminator: journal dir ready ${base} (io=${this.ioFile === null ? 'off' : 'on'})`)
    } catch (error: unknown) {
      this.recordsFile = null
      this.ioFile = null
      try {
        deps.ctx.logger.warn(`discriminator: journal dir unavailable, disk journal degraded to log-only: ${String(error)}`)
      } catch { /* noop */ }
    }
  }

  /** 并发闸：超上限排队（上限 PENDING_CAP）；排队满 → false（调用方记 overload 跳过）。 */
  private acquire(): Promise<boolean> {
    const { maxConcurrency } = this.deps.config
    return new Promise((resolve) => {
      if (this.active < maxConcurrency) {
        this.active += 1
        resolve(true)
      } else if (this.pending.length >= PENDING_CAP) {
        resolve(false)
      } else {
        this.pending.push(() => {
          this.active += 1
          resolve(true)
        })
      }
    })
  }

  private release(): void {
    this.active -= 1
    const next = this.pending.shift()
    if (next !== undefined) next()
  }

  /** session/event 处理器（同步快速返回——异步旁路，绝不阻塞主循环）。 */
  handleSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type !== 'user/message' || !isAppendUserMessage(event)) return
    // U 空间推进（append 任意 kind；判别面在其后按 kind 过滤——实验口径）。
    // 计数**锚定会话日志**：首次见该会话时从 session.events 推导基数（重载/重启不丢、
    // 不把新消息误判为首条漏判）；之后事件流内增量。
    let u = this.umIndex.get(session.id)
    if (u === undefined) {
      const base = userIndexBefore(session.events, event.seq)
      u = base
    }
    this.umIndex.set(session.id, u + 1)
    if (u === 0) return // u=0 首条：投影隐式开段，判别面 = u≥1
    if (event.data.source.kind !== 'user') return // 注入面（plugin/tool/…）不判
    if (session.header.parentSession !== undefined) return // 子代理会话不判（主会话 only）
    const text = userMessageText(event)
    if (text.trim().length === 0 || isPseudoUser(text)) return
    void this.dispatch(session, event, text)
  }

  /** session 释放：取消该会话所有进行中判别 + 清理游标。 */
  handleSessionDisposed(session: Session): void {
    this.umIndex.delete(session.id)
    for (const [judgeId, controller] of this.inflight) {
      if (judgeId.startsWith(`j:${session.id}:`)) controller.abort()
    }
  }

  /** 卸载：取消全部进行中判别，清空缓存/台账（fiber 效应，卸载即净）。 */
  dispose(): void {
    for (const controller of this.inflight.values()) controller.abort()
    this.inflight.clear()
    this.cache.clear()
    this.umIndex.clear()
    while (this.pending.length > 0) {
      const next = this.pending.shift()
      if (next !== undefined) next()
    }
  }

  /** 单条判定的主流程（async；全路径 fail-lazy，异常不外溢）。 */
  private async dispatch(
    session: Session,
    event: SessionEvent<'user/message'>,
    text: string,
  ): Promise<void> {
    const sessionId = session.id
    const seq = event.seq
    const judgeId = makeJudgeId(sessionId, seq)
    const atMsStart = Date.now()

    const admitted = await this.acquire()
    if (!admitted) {
      this.finish({
        judgeId,
        sessionId,
        seq,
        atMs: Date.now(),
        mode: this.mode,
        trigger: 'error-fallback',
        verdict: 'continue',
        call: this.fallbackCall(),
        requestedEffort: 'none',
        sentEffort: 'none',
        window: this.windowFacts(text),
        modelView: null,
        errors: [{ phase: 'probe', code: 'OVERLOAD', message: 'concurrency queue full, judgement skipped', action: 'skip' }],
        sources: [],
      }, undefined, { session, text })
      return
    }
    try {
      await this.judge(session, event, text, judgeId, atMsStart)
    } catch (error: unknown) {
      // 最终兜底：任何逃逸异常 → 记录 fail-lazy（continue，零动作）。
      try {
        this.finish({
          judgeId,
          sessionId,
          seq,
          atMs: Date.now(),
          mode: this.mode,
          trigger: 'error-fallback',
          verdict: 'continue',
          call: this.fallbackCall(),
          requestedEffort: 'none',
          sentEffort: 'none',
          window: this.windowFacts(text),
          modelView: null,
          errors: [{
            phase: 'probe',
            code: 'UNEXPECTED',
            message: truncateError(error instanceof Error ? error.message : String(error)),
            action: 'fallback',
          }],
          sources: [],
        }, undefined, { session, text })
      } catch {
        // 记录本身失败也绝不外溢（日志兜底）。
        try { this.deps.ctx.logger.warn(`discriminator: record failed for ${judgeId}: ${String(error)}`) } catch { /* noop */ }
      }
    } finally {
      this.release()
    }
  }

  /** 判定主体（分阶段；每阶段独立 try/catch → 错误链 + 降级）。 */
  private async judge(
    session: Session,
    event: SessionEvent<'user/message'>,
    text: string,
    judgeId: string,
    atMsStart: number,
  ): Promise<void> {
    const errors: JudgeError[] = []
    const sources: JudgeSourceRef[] = []

    // —— phase: config（预设物化；无效 → 回退默认预设 + fallback 记录）——
    let call = this.materialize(errors)

    // —— phase: context（窗口组装；投影缺席 → unbound，仍可判）——
    const state = this.deps.stateOf?.(session, TASK_PROJECTION_KEY)
    let anchor = ''
    let history: string[] = []
    if (state !== undefined && state.current !== null) {
      const task = state.tasks.find(entry => entry.taskId === state.current!.taskId)
      anchor = task?.anchorText ?? ''
      try {
        history = collectHistoryTexts(
          session.events,
          state.current.startSeq,
          event.seq,
          this.deps.config.historyWindow,
        )
      } catch (error: unknown) {
        errors.push({
          phase: 'context',
          code: 'HISTORY_COLLECT_FAILED',
          message: truncateError(error instanceof Error ? error.message : String(error)),
          action: 'degrade',
        })
        history = []
      }
    }
    const window = buildDiscWindow(anchor, history, text, this.deps.config.historyWindow)
    sources.push({
      kind: 'context',
      id: state?.current?.taskId ?? 'unbound',
      version: state !== undefined ? 'task-seg-v4' : 'unbound',
      fingerprint: fingerprintText(`a:${anchor}|h:${history.join('\u241f')}|t:${text}`),
    })

    // —— T0 显式（权威通道；判别器只记账不重复判定）——
    const explicit = classifyExplicitUserMessage(text)
    if (explicit !== null) {
      this.finish({
        judgeId,
        sessionId: session.id,
        seq: event.seq,
        atMs: Date.now(),
        mode: this.mode,
        trigger: 'explicit',
        verdict: 'continue',
        explicitKind: explicit,
        call,
        requestedEffort: call.effort,
        sentEffort: 'none',
        window: this.windowFacts(text, window.anchor.length, window.patches.length),
        modelView: null,
        errors,
        sources,
      }, undefined, { session, text })
      return
    }

    // —— L0 极窄免费通道（词表整体匹配；0 泄漏验证）——
    if (isL0Continue(text)) {
      this.finish({
        judgeId,
        sessionId: session.id,
        seq: event.seq,
        atMs: Date.now(),
        mode: this.mode,
        trigger: 'l0-continue',
        verdict: 'continue',
        call,
        requestedEffort: call.effort,
        sentEffort: 'none',
        window: this.windowFacts(text, window.anchor.length, window.patches.length),
        modelView: null,
        errors,
        sources,
      }, undefined, { session, text })
      return
    }

    // —— L1 精确键缓存（同输入防重；键含配置面）——
    const cacheKey = makeJudgeCacheKey({
      sessionId: session.id,
      seq: event.seq,
      provider: call.provider,
      model: call.model,
      promptVersion: call.promptVersion,
      text,
    })
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) {
      this.finish({
        judgeId,
        sessionId: session.id,
        seq: event.seq,
        atMs: Date.now(),
        mode: this.mode,
        trigger: 'l1-cache',
        verdict: cached.verdict,
        call,
        requestedEffort: call.effort,
        sentEffort: 'none',
        window: this.windowFacts(text, window.anchor.length, window.patches.length),
        modelView: null,
        errors,
        sources,
        cacheHit: true,
      }, undefined, { session, text })
      return
    }

    // —— phase: model-info + 自适应链（抽到 loadModelInfo；失败 → degrade：不传 effort 继续判）——
    let modelView: JudgeModelView | null = null
    let runtimeEfforts: readonly string[] = []
    let rendered: string | undefined
    let promptVersion = call.promptVersion
    const controller = new AbortController()
    this.inflight.set(judgeId, controller)
    const timer = setTimeout(() => controller.abort(), this.deps.config.timeoutMs)
    try {
      const loaded = await this.loadModelInfo(call, errors, sources, controller.signal)
      modelView = loaded.modelView
      runtimeEfforts = loaded.runtimeEfforts

      // —— 自适应链：最终发送 = 运行时许可 ∩ 实测验证层（交集外不发送=默认档）——
      const verified = DISC_CAPABILITIES[`${call.provider}@${call.model}`]?.effortLevels
      const sentEffort = sanitizeEffort(runtimeEfforts, call.effort, verified)
      sources.push({
        kind: 'capability',
        id: `${call.provider}@${call.model}`,
        version: 'DISC_CAPABILITIES-v2',
        fingerprint: (verified ?? []).join(',') || '(none)',
      })

      // —— phase: prompt（渲染；版本未注册 → 回退默认版本 + degrade 记录；失败 → throw）——
      const renderResult = this.renderDiscPromptSafe(call, window, errors)
      rendered = renderResult.rendered
      promptVersion = renderResult.promptVersion

      // —— phase: stream + parse（主路径；超时/传输失败 → fallback continue）——
      const { verdict, llmFacts, output, usage } = await this.streamAndParse(
        call, rendered, sentEffort, errors, controller, atMsStart)

      this.cacheSet(cacheKey, verdict, judgeId)
      this.finish({
        judgeId,
        sessionId: session.id,
        seq: event.seq,
        atMs: Date.now(),
        mode: this.mode,
        trigger: 'llm',
        verdict,
        call: { ...call, promptVersion },
        requestedEffort: call.effort,
        sentEffort,
        window: this.windowFacts(text, window.anchor.length, window.patches.length),
        modelView,
        llm: llmFacts,
        cost: estimateJudgeCost(usage, DISC_PRICING[`${call.provider}@${call.model}`]) ?? undefined,
        errors,
        sources: [...sources, {
          kind: 'prompt',
          id: promptVersion,
          version: promptVersion,
          fingerprint: `${window.anchor.length}:${window.patches.length}:${window.target.length}`,
        }],
      }, { prompt: rendered, output }, { session, text })
    } catch (error: unknown) {
      const aborted = isAbortError(error)
      this.finish({
        judgeId,
        sessionId: session.id,
        seq: event.seq,
        atMs: Date.now(),
        mode: this.mode,
        trigger: 'error-fallback',
        verdict: 'continue',
        call,
        requestedEffort: call.effort,
        sentEffort: 'none',
        window: this.windowFacts(text, window.anchor.length, window.patches.length),
        modelView: modelView ?? null,
        llm: { status: 'failed', latencyMs: Date.now() - atMsStart },
        errors: [...errors, {
          phase: 'stream',
          code: aborted ? 'ABORTED' : 'STREAM_FAILED',
          message: truncateError(error instanceof Error ? error.message : String(error)),
          action: 'fallback',
        }],
        sources,
      }, rendered !== undefined ? { prompt: rendered, output: '' } : undefined, { session, text })
    } finally {
      clearTimeout(timer)
      this.inflight.delete(judgeId)
    }
  }

  /**
   * phase: model-info（运行时能力查询；失败 → degrade：不传 effort 继续判）。
   * 抽自原 judge() 内联段（阶段化重构，行为零变化——错误链/溯源/降级语序一致）。
   */
  private async loadModelInfo(
    call: DiscCallConfig,
    errors: JudgeError[],
    sources: JudgeSourceRef[],
    signal: AbortSignal,
  ): Promise<{ modelView: JudgeModelView | null; runtimeEfforts: readonly string[] }> {
    try {
      // 注意：context proxy 对未声明 inject 的服务属性访问会抛
      // "cannot get property X without inject"——显式 get() 读取不受此限。
      const llm = this.deps.ctx.get('llm') as Pick<LlmRuntime, 'resolveModelInfo'> | undefined
      if (llm === undefined) {
        errors.push({
          phase: 'model-info',
          code: 'LLM_UNAVAILABLE',
          message: 'llm service not available on this context',
          action: 'fallback',
        })
        throw new Error('llm service unavailable')
      }
      const info = await llm.resolveModelInfo(call.provider, call.model, signal)
      const efforts = info.reasoning?.efforts?.map(entry => entry.id) ?? []
      const modelView: JudgeModelView = {
        efforts,
        ...(info.reasoning?.defaultEffort !== undefined ? { defaultEffort: info.reasoning.defaultEffort } : {}),
        ...(info.context !== undefined ? { contextWindow: info.context.contextWindow } : {}),
        ...(info.defaultMaxTokens !== undefined ? { defaultMaxTokens: info.defaultMaxTokens } : {}),
      }
      sources.push({
        kind: 'runtime',
        id: `${call.provider}@${call.model}`,
        version: 'resolveModelInfo',
        fingerprint: modelView.efforts.join(',') + `|${modelView.defaultEffort ?? ''}|${modelView.contextWindow ?? ''}|${modelView.defaultMaxTokens ?? ''}`,
      })
      return { modelView, runtimeEfforts: efforts }
    } catch (error: unknown) {
      errors.push({
        phase: 'model-info',
        code: 'MODEL_INFO_FAILED',
        message: truncateError(error instanceof Error ? error.message : String(error)),
        action: 'degrade',
      })
      return { modelView: null, runtimeEfforts: [] }
    }
  }

  /**
   * phase: prompt（渲染；版本未注册 → 回退默认版本 + degrade 记录；渲染无输出 → throw 交给外层 error-fallback）。
   * 抽自原 judge() 内联段（阶段化重构，行为零变化）。
   */
  private renderDiscPromptSafe(
    call: DiscCallConfig,
    window: DiscWindow,
    errors: JudgeError[],
  ): { rendered: string; promptVersion: DiscCallConfig['promptVersion'] } {
    let promptVersion = call.promptVersion
    try {
      let rendered = renderDiscPrompt(call.promptVersion, window)
      if (rendered === undefined) {
        errors.push({
          phase: 'prompt',
          code: 'PROMPT_VERSION_UNRECOGNIZED',
          message: `prompt version "${call.promptVersion}" not registered; degraded to ${DISC_PROMPT_DEFAULT_VERSION}`,
          action: 'degrade',
        })
        promptVersion = DISC_PROMPT_DEFAULT_VERSION
        rendered = renderDiscPrompt(promptVersion, window)
      }
      if (rendered === undefined) throw new Error('prompt render produced no output')
      return { rendered, promptVersion }
    } catch (error: unknown) {
      errors.push({
        phase: 'prompt',
        code: 'PROMPT_RENDER_FAILED',
        message: truncateError(error instanceof Error ? error.message : String(error)),
        action: 'fallback',
      })
      throw new Error('prompt render produced no output')
    }
  }

  /**
   * phase: stream + parse（主路径；超时/传输失败 → 交给外层 error-fallback；解析失败 → fallback continue）。
   * 抽自原 judge() 内联段（阶段化重构，行为零变化——sentEffort cast、finish/usage/末尾 parse 语序一致）。
   */
  private async streamAndParse(
    call: DiscCallConfig,
    rendered: string,
    sentEffort: DiscCallConfig['effort'],
    errors: JudgeError[],
    controller: AbortController,
    atMsStart: number,
  ): Promise<{ verdict: DiscVerdict; llmFacts: JudgeLlmFacts; output: string; usage: TokenUsage | undefined }> {
    const options: GenerateOptions = {
      provider: call.provider,
      model: call.model,
      system: rendered,
      messages: [createUserMessage({
        content: [{ type: 'text', text: JUDGE_PLACEHOLDER }],
        source: { kind: 'user' },
      })],
      temperature: call.temperature,
      maxTokens: call.maxTokens,
      signal: controller.signal,
      // sentEffort 值域 = 运行时许可（resolveModelInfo.efforts.id，适配器保证 stream 可认）
      // ∩ DISC_CAPABILITIES 验证层——cast 到 Branded 仅为 DSH 类型契约，值是可信的。
      ...(sentEffort !== 'none' ? { reasoningEffort: sentEffort as ReasoningEffortId } : {}),
    }
    let output = ''
    let finishReason: string | undefined
    let usage: TokenUsage | undefined
    const llm = this.deps.ctx.get('llm') as Pick<LlmRuntime, 'stream'> | undefined
    if (llm === undefined) {
      errors.push({
        phase: 'stream',
        code: 'LLM_UNAVAILABLE',
        message: 'llm service not available on this context',
        action: 'fallback',
      })
      throw new Error('llm service unavailable')
    }
    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'text') {
        output += chunk.block.text
      } else if (chunk.type === 'usage') {
        usage = chunk.usage
      } else if (chunk.type === 'finish') {
        finishReason = chunk.reason.kind
      }
    }
    const llmFacts: JudgeLlmFacts = {
      status: 'ok',
      latencyMs: Date.now() - atMsStart,
      ...(finishReason !== undefined ? { finish: finishReason } : {}),
      ...(usage !== undefined ? { usage: { ...usage } } : {}),
    }

    // —— phase: parse（输出解析；失败 → fallback continue + 不写缓存防坏票）——
    let verdict: DiscVerdict
    try {
      const parsed = parseDecision(output)
      if (parsed === undefined) throw new Error(`unparsable output: ${output.slice(0, 120)}`)
      verdict = parsed
    } catch (error: unknown) {
      errors.push({
        phase: 'parse',
        code: 'PARSE_FAILED',
        message: truncateError(error instanceof Error ? error.message : String(error)),
        action: 'fallback',
      })
      verdict = 'continue'
    }
    return { verdict, llmFacts, output, usage }
  }

  /** 预设物化（无效预设 → 默认预设，fallback 记录）。 */
  private materialize(errors: JudgeError[]): DiscCallConfig {
    try {
      return materializeDiscCallConfig(this.deps.config.preset, cleanOverrides(this.deps.config))
    } catch (error: unknown) {
      errors.push({
        phase: 'config',
        code: 'PRESET_UNKNOWN',
        message: truncateError(error instanceof Error ? error.message : String(error)),
        action: 'fallback',
      })
      return materializeDiscCallConfig(DEFAULT_DISC_PRESET, cleanOverrides(this.deps.config))
    }
  }

  /** overload/兜底用最小调用形状（默认预设；不抛）。 */
  private fallbackCall(): DiscCallConfig {
    try {
      return materializeDiscCallConfig(DEFAULT_DISC_PRESET, cleanOverrides(this.deps.config))
    } catch {
      return materializeDiscCallConfig(DEFAULT_DISC_PRESET)
    }
  }

  /** 窗口事实快照（原文在会话日志；这里只留长度与摘录）。 */
  private windowFacts(text: string, anchorChars = 0, patchCount = 0): JudgeRecord['window'] {
    const excerptChars = this.deps.config.messageExcerptChars
    return {
      anchorChars,
      patchCount,
      targetChars: text.length,
      targetExcerpt: excerptChars > 0 ? text.slice(0, excerptChars) : '',
    }
  }

  /** L1 缓存写入（LRU 有界）。 */
  private cacheSet(key: string, verdict: DiscVerdict, judgeId: string): void {
    if (this.deps.config.cacheLimit <= 0) return
    this.cache.delete(key)
    this.cache.set(key, { verdict, judgeId })
    while (this.cache.size > this.deps.config.cacheLimit) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  /** 落盘（fail-lazy：写失败仅降级为日志，不影响判定出口）。jsonl 追加；记录行 = 权威回放源。 */
  private persist(record: JudgeRecord, io?: { prompt: string; output: string }): void {
    if (this.recordsFile !== null) {
      try {
        appendFileSync(this.recordsFile, `${serializeJudgeRecord(record)}\n`)
      } catch (error: unknown) {
        try {
          this.deps.ctx.logger.warn(`discriminator: record persist failed for ${record.judgeId}: ${String(error)}`)
        } catch { /* noop */ }
      }
    }
    if (io !== undefined && this.ioFile !== null) {
      try {
        appendFileSync(this.ioFile, `${JSON.stringify({
          judgeId: record.judgeId,
          sessionId: record.sessionId,
          seq: record.seq,
          atMs: record.atMs,
          trigger: record.trigger,
          verdict: record.verdict,
          call: record.call,
          prompt: io.prompt,
          output: io.output,
          usage: record.llm?.usage,
          cost: record.cost,
        })}\n`)
      } catch (error: unknown) {
        try {
          this.deps.ctx.logger.warn(`discriminator: io log persist failed for ${record.judgeId}: ${String(error)}`)
        } catch { /* noop */ }
      }
    }
  }

  /** 记录统一出口：台账 + 落盘 + 权威日志行 + 事件（recorded/error/verdict）。全路径 fail-lazy。
   * v0.8.0：verdictCtx 携带会话与目标消息原文——active + new-task 时除 cordis 事件外，
   * 追加会话日志事件（session.append，log-only 可回放，投影 fold 的消费面）。 */
  private finish(
    record: JudgeRecord,
    io?: { prompt: string; output: string },
    verdictCtx?: { session: Session; text: string },
  ): void {
    try {
      this.journal.append(record)
      this.deps.ctx.emit('context-economy/judge-recorded', record)
    } catch (error: unknown) {
      try {
        this.deps.ctx.logger.warn(`discriminator: journal/emit failed: ${String(error)}`)
      } catch { /* noop */ }
    }
    this.persist(record, io)
    try {
      this.deps.ctx.logger.info(this.journal.logLine(record))
    } catch {
      try { this.deps.ctx.logger.warn(`discriminator: log line failed (record ${record.judgeId})`) } catch { /* noop */ }
    }
    if (record.errors.length > 0) {
      try {
        this.deps.ctx.emit('context-economy/judge-error', {
          judgeId: record.judgeId,
          sessionId: record.sessionId,
          seq: record.seq,
          verdict: record.verdict,
          errors: record.errors,
        })
      } catch { /* noop */ }
    }
    if (this.deps.config.mode === 'active' && record.verdict === 'new-task') {
      try {
        this.deps.ctx.emit('context-economy/judge-verdict', {
          judgeId: record.judgeId,
          sessionId: record.sessionId,
          seq: record.seq,
          verdict: record.verdict,
        })
      } catch { /* noop */ }
      // 会话日志通道（投影 fold 的 replay 面）：active + new-task 才追加；失败 fail-lazy。
      if (verdictCtx !== undefined) {
        try {
          verdictCtx.session.append('context-economy/judge-verdict', {
            judgeId: record.judgeId,
            seq: record.seq,
            verdict: record.verdict,
            anchorText: verdictCtx.text,
          })
        } catch (error: unknown) {
          try {
            this.deps.ctx.logger.warn(`discriminator: verdict session event append failed for ${record.judgeId}: ${String(error)}`)
          } catch { /* noop */ }
        }
      }
    }
  }
}

/** 装配入口：挂 session/event + session/disposed（fiber 效应，卸载即净）。 */
export function registerDiscriminator(deps: DiscriminatorDeps): () => void {
  const engine = new DiscriminatorEngine(deps)
  const disposers = [
    deps.ctx.on('session/event', engine.handleSessionEvent.bind(engine), { global: true }),
    deps.ctx.on('session/disposed', engine.handleSessionDisposed.bind(engine), { global: true }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
    engine.dispose()
  }
}

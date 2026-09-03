/**
 * Boundary marking — the PREPROCESSING side of task-boundary marks.
 *
 * This module mirrors the PRODUCTION task-boundary discriminator (the plugin's
 * DiscriminatorEngine, src/discriminator/engine.ts) and the task projection
 * (src/task/projection.ts). It REPLAYS a task's user-message stream ONE message
 * at a time, exactly as the plugin does at runtime, and records the per-message
 * verdicts + the segments they produce. It imports the SAME compiled production
 * lib (lib/discriminator/prompt.js, lib/task/{explicit,projection}.js,
 * lib/discriminator/{l0,trace}.js) — it is not a re-implementation.
 *
 * Real mechanism (verified against production code):
 *   - Boundary source = explicit /task command (T0) OR the discriminator's
 *     semantic verdict for a message; the projection fold consumes the same
 *     logic to cut segments. The runner never re-partitions dynamically — the
 *     mark IS the boundary.
 *   - A message is judged ONE AT A TIME against its task context (<anchor> =
 *     current task anchor, <history> = recent same-task messages, <target> =
 *     THIS message), using the production v6 window caps and the frozen v2.2
 *     prompt template. Verdicts are {"decision":"new_task"|"continue"}.
 *   - Same-object messages stay in the same task (context reuse + stable user
 *     intent): the discriminator only cuts a NEW segment when a message starts a
 *     genuinely different task — never on a bare continue.
 *
 * Cost discipline: every LLM judgement is a REAL discriminator call and its
 * usage + USD is attributed to `costs.decision`. The L0-continue / explicit /
 * fail-lazy paths are zero-cost (they never call the model). The total decision
 * cost is the SUM of the per-message judgements actually made.
 *
 * callLLM is injectable (same pattern as gateway-mock) so offline tests never
 * touch the network yet still exercise the exact per-message judgement shape.
 */
import { priceOf } from './cost.mjs'
// Compiled production lib — same repo, fixed depth from evalground/lib.
import {
  buildDiscWindow,
  renderDiscPrompt,
  DISC_PROMPT_DEFAULT_VERSION,
} from '../../../lib/discriminator/prompt.js'
import {
  classifyExplicitUserMessage,
} from '../../../lib/task/explicit.js'
import {
  isL0Continue,
  isPseudoUser,
} from '../../../lib/discriminator/l0.js'
import {
  parseDecision,
} from '../../../lib/discriminator/trace.js'
import {
  createTaskProjection,
  taskProjectionDefinition,
} from '../../../lib/task/projection.js'

/** Default judgement model/provider = the production default preset (DeepSeek official, 2026-09 pivot; mirrors src/discriminator/presets.ts). */
export const DECISION_MODEL = 'deepseek-v4-flash-vision-exp'
export const DECISION_PROVIDER = 'deepseek'
export const JUDGE_PLACEHOLDER = '（判别上下文见 system 消息；本消息仅为判定占位。）'

/** Production prompt default version (re-exported for cascade.mjs parity). */
export { DISC_PROMPT_DEFAULT_VERSION } from '../../../lib/discriminator/prompt.js'

/** v6 window cap: history window (patches), frozen in production. */
export const H_WINDOW = 2

/**
 * The projection fold's `apply`/`init`. `init` is a property of the definition
 * object (taskProjectionDefinition), not a standalone export.
 */
const PROJECTION_FOLD = taskProjectionDefinition

/** A task's user-message stream (staged messages OR the single prompt). */
export function userMessagesOf(task) {
  if (Array.isArray(task.messages) && task.messages.length > 0) return task.messages.map(String)
  return [String(task.prompt ?? '')]
}

/** A plain `user/message` surface event the projection fold consumes. */
export function userEvent(seq, text) {
  return {
    seq,
    type: 'user/message',
    surfaceOp: { op: 'append' },
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

/** The semantic verdict event the projection fold cuts a segment from. */
export function verdictEvent(seq, verdict, anchorText) {
  return {
    type: 'context-economy/judge-verdict',
    data: { verdict, seq, anchorText },
  }
}

/**
 * Judge ONE message against the CURRENT projection state, mirroring the real
 * per-message pipeline (T0 explicit → L0 → LLM → fail-lazy). This is the shared
 * core used by BOTH the single-task `markBoundaries` and the whole-stream
 * `markCascadeBoundaries` so the two can never drift.
 *
 * @param {object} opts { i, text, msgs, state, callLLM, model, provider, historyWindow, promptVersion, judgementMode }
 *   i — message index (0-based). u=0 returns null (implicit open, not judged).
 * @returns {Promise<{verdict, trigger, usage, state}|null>}
 *   `state` is the UPDATED projection state after the verdict (callsite applies
 *   the verdict event too, so it can drive a segment cut); returns null for
 *   u=0 / pseudo-user.
 */
export async function judgeMessage({
  i, text, msgs, state, callLLM, model, provider, historyWindow, promptVersion, judgementMode,
}) {
  // u=0 is the implicit segment head — opened by the projection, not judged.
  if (i === 0) return { verdict: 'open', trigger: 'implicit-open', usage: null, state }

  // T0 explicit command = authoritative boundary; discriminator only records.
  const explicit = classifyExplicitUserMessage(text)
  if (explicit !== null) {
    return { verdict: explicit === 'open' ? 'new-task' : 'continue', trigger: 'explicit', usage: null, state }
  }

  // L0 fast path: whole-message continuation words → continue, ZERO cost.
  if (judgementMode !== 'offline-llm' && isL0Continue(text)) {
    return { verdict: 'continue', trigger: 'l0-continue', usage: null, state }
  }
  if (isPseudoUser(text)) return null

  // Build the per-message judgement window from the CURRENT task context.
  // anchor = the CURRENT task's segment head text; history = recent SAME-TASK
  // messages AFTER the segment head (the head is carried by <anchor>, NEVER by
  // <history> — production collectHistoryTexts uses an open interval seq>startSeq).
  const currentTask = state.current !== null
    ? state.tasks.find(t => t.taskId === state.current.taskId)
    : undefined
  const anchorText = currentTask?.anchorText ?? ''
  const headSeq = currentTask?.startSeq ?? 0
  const history = msgs
    .slice(Math.max(headSeq + 1, i - historyWindow), i)
    .filter(t => t.trim().length > 0)
  const window = buildDiscWindow(anchorText, history, text, historyWindow)
  const rendered = renderDiscPrompt(promptVersion, window)

  // The real discriminator call (system = rendered prompt, placeholder user).
  let verdict = 'continue'
  let trigger = 'llm'
  let usage = null
  if (callLLM && rendered !== undefined) {
    try {
      const call = await callLLM({
        provider, model,
        messages: [
          { role: 'system', content: rendered },
          { role: 'user', content: JUDGE_PLACEHOLDER },
        ],
        maxTokens: 400,
        temperature: 0,
      })
      const parsed = parseDecision(call.text ?? '')
      verdict = parsed ?? 'continue'
      usage = call.usage ?? null
    } catch (_err) {
      trigger = 'fail-lazy'
      verdict = 'continue'
      usage = null
    }
  } else {
    trigger = 'fail-lazy'
    verdict = 'continue'
  }

  // A new_task verdict cuts the current segment inside the projection fold.
  let nextState = state
  if (verdict === 'new-task') {
    nextState = PROJECTION_FOLD.apply(state, verdictEvent(i, 'new-task', text))
  }
  return { verdict, trigger, usage, state: nextState }
}

/** Increase a per-message judgement cost accumulator from a real usage call. */
export function addJudgementCost(decision, usage, priceRow) {
  if (!usage) return
  decision.judgements++
  decision.usage.inputTokens += usage.inputTokens ?? 0
  decision.usage.outputTokens += usage.outputTokens ?? 0
  decision.usage.cacheReadTokens += usage.cacheReadTokens ?? 0
  decision.usage.calls += 1
  if (priceRow) {
    const fresh = Math.max(0, (usage.inputTokens ?? 0) - (usage.cacheReadTokens ?? 0))
    decision.usd += (fresh * priceRow.inputPerM
      + (usage.cacheReadTokens ?? 0) * priceRow.cacheReadPerM
      + (usage.outputTokens ?? 0) * priceRow.outputPerM) / 1e6
  }
}

/** Fresh per-message judgement cost accumulator. */
export function newDecision() {
  return {
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 },
    usd: 0,
    judgements: 0, l0Cuts: 0, explicitCuts: 0, failLazy: 0,
  }
}

/**
 * Replay the real per-message pipeline over a task's user-message stream.
 *
 * @param {object} opts { taskId, userMessages, callLLM, model, provider, historyWindow, promptVersion, judgementMode }
 *   callLLM — injectable gateway chatCall (offline tests pass a scripted one).
 *   judgementMode = 'full' (default) | 'offline-llm' (skip L0/explicit fast-paths
 *   so offline tests can force the model to see a message).
 * @returns {Promise<{taskId, source:'premark', cost, boundaries:Array, verdicts:Array}>}
 */
export async function markBoundaries({
  taskId,
  userMessages,
  callLLM,
  model = DECISION_MODEL,
  provider = DECISION_PROVIDER,
  historyWindow = H_WINDOW,
  promptVersion = DISC_PROMPT_DEFAULT_VERSION,
  judgementMode = 'full',
}) {
  const msgs = Array.isArray(userMessages) ? userMessages.map(String) : []
  let state = PROJECTION_FOLD.init({})
  const verdicts = [] // per-message judgement detail (only u>=1 messages are judged)

  const decision = newDecision()
  const priceRow = priceOf(model, provider)

  for (let i = 0; i < msgs.length; i++) {
    // 1) Feed the surface event to the projection (T0 explicit / implicit open /
    //    advance). This is authoritative for the open/close boundary.
    state = PROJECTION_FOLD.apply(state, userEvent(i, msgs[i]))

    // 2) Judge THIS message (shared per-message core).
    const res = await judgeMessage({
      i, text: msgs[i], msgs, state,
      callLLM, model, provider, historyWindow, promptVersion, judgementMode,
    })
    if (res === null) continue // pseudo-user (measured, keep the surface advance)

    // Tally zero-cost fast-path triggers for the decision report.
    if (res.trigger === 'l0-continue') decision.l0Cuts++
    else if (res.trigger === 'explicit') decision.explicitCuts++
    else if (res.trigger === 'fail-lazy') decision.failLazy++

    // Record the REAL cost of this judgement (only when a model call happened).
    addJudgementCost(decision, res.usage, priceRow)

    verdicts.push({ seq: i, verdict: res.verdict, trigger: res.trigger, cost: res.usage ? { usage: res.usage } : null })

    // 5) new-task verdict already cut the segment inside judgeMessage (state updated).
    state = res.state
  }

  const boundaries = state.tasks.map((t, idx) => ({
    segmentIndex: idx,
    taskId: t.taskId,
    startSeq: t.startSeq,
    endSeq: t.lastSurfaceSeq,
    status: t.status,
    anchorText: t.anchorText,
  }))

  const cost = { ...decision, usd: Number(decision.usd.toFixed(8)), model, provider }

  return { taskId, source: 'premark', cost, boundaries, verdicts }
}

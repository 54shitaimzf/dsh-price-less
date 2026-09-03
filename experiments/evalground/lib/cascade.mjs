/**
 * Cascade boundary marking — the WHOLE-STREAM (T0..T7 as one conversation)
 * side of task-boundary marks, plus the transcript slicer used for per-task
 * scoring without cross-task contamination.
 *
 * The final experiment runs `self-compact` over T0..T7 as ONE conversation:
 * the discriminator cuts task boundaries across the whole stream, and the
 * runner compresses at each segment boundary. `humanTaskStream` flattens the
 * per-task user messages into a single ordered stream; `markCascadeBoundaries`
 * replays the SAME per-message discriminator core as the single-task
 * `markBoundaries` (imported from boundary-mark.mjs) so the two can never
 * drift.
 *
 * Cost discipline: judgment cost is attributed to `costs.decision` exactly as
 * in the single-task path — real verdict calls, real usage + USD, zero-cost
 * for L0/explicit/fail-lazy.
 */
import {
  judgeMessage,
  newDecision,
  addJudgementCost,
  userEvent,
  verdictEvent,
  userMessagesOf,
  DECISION_MODEL,
  DECISION_PROVIDER,
  H_WINDOW,
  DISC_PROMPT_DEFAULT_VERSION,
} from './boundary-mark.mjs'
import { taskProjectionDefinition } from '../../../lib/task/projection.js'
import { priceOf } from './cost.mjs'

const PROJECTION_FOLD = taskProjectionDefinition

/**
 * Flatten T0..T7 user messages into ONE ordered stream.
 * @param {Array} tasks — ordered tasks (listTasks()).
 * @returns {Array<{seq, taskId, text}>} stream, in task order.
 */
export function humanTaskStream(tasks) {
  const out = []
  let seq = 0
  for (const task of tasks) {
    for (const text of userMessagesOf(task)) {
      out.push({ seq, taskId: task.id, text })
      seq++
    }
  }
  return out
}

/**
 * Run the whole-stream boundary mark: replay the per-message discriminator
 * over the flattened stream, recording segments + the real decision cost.
 *
 * @param {object} opts { tasks, callLLM, model, provider, historyWindow, promptVersion, judgementMode }
 * @returns {Promise<{taskId:'CASCADE', source, cost, boundaries, verdicts, stream}>}
 */
export async function markCascadeBoundaries({
  tasks,
  callLLM,
  model = DECISION_MODEL,
  provider = DECISION_PROVIDER,
  historyWindow = H_WINDOW,
  promptVersion = DISC_PROMPT_DEFAULT_VERSION,
  judgementMode = 'full',
}) {
  const stream = humanTaskStream(tasks)
  const msgs = stream.map(s => s.text)
  let state = PROJECTION_FOLD.init({})
  const verdicts = []
  const decision = newDecision()
  const priceRow = priceOf(model, provider)

  for (let i = 0; i < msgs.length; i++) {
    state = PROJECTION_FOLD.apply(state, userEvent(i, msgs[i]))
    const res = await judgeMessage({
      i, text: msgs[i], msgs, state,
      callLLM, model, provider, historyWindow, promptVersion, judgementMode,
    })
    if (res === null) continue
    if (res.trigger === 'l0-continue') decision.l0Cuts++
    else if (res.trigger === 'explicit') decision.explicitCuts++
    else if (res.trigger === 'fail-lazy') decision.failLazy++
    addJudgementCost(decision, res.usage, priceRow)
    verdicts.push({ seq: i, verdict: res.verdict, trigger: res.trigger, taskId: stream[i].taskId, cost: res.usage ? { usage: res.usage } : null })
    state = res.state
  }

  const boundaries = state.tasks.map((t, idx) => ({
    segmentIndex: idx,
    taskId: t.taskId,
    startSeq: t.startSeq,
    endSeq: t.lastSurfaceSeq,
    status: t.status,
    anchorText: t.anchorText,
    // which eval tasks each segment spans (for attribution; never a judgment input)
    taskOrigin: stream.slice(t.startSeq, t.lastSurfaceSeq + 1).map(s => s.taskId),
  }))

  const cost = { ...decision, usd: Number(decision.usd.toFixed(8)), model, provider }

  return { taskId: 'CASCADE', source: 'premark', cost, boundaries, verdicts, stream }
}

/**
 * Slice a whole-stream transcript back into per-task windows so per-task
 * scoring sees only its own events (never another task's assistant/tool/stage).
 *
 * The transcript does NOT carry taskId, but each sub-task's user message is
 * injected via a `stage` event carrying `index` = the flattened stream slot.
 * We walk the transcript and assign every entry to the task of the most recent
 * injected stream slot (falling back to the segment head slot for the task).
 *
 * `task-compact` entries carry `slot` — the flattened stream position of the
 * closed segment's LAST message — so the compaction work (task-compact /
 * decision / compress events emitted BETWEEN the closed segment's last stage
 * and the next segment's stage) is attributed to the segment that produced it.
 * The `segmentIndex` field is the segment ORDINAL (audit label only): a segment
 * can span multiple messages, so ordinal ≠ message position and must not be
 * used here.
 *
 * @param {Array} transcript — the runSession transcript (array of entries).
 * @param {Array} stream — the humanTaskStream output [{seq, taskId, text}].
 * @returns {Object} { taskId: [entries...] } — entries bounded to each task.
 */
export function splitTranscriptByTask(transcript, stream) {
  const slotTask = {}
  stream.forEach((s, i) => { slotTask[i] = s.taskId })
  const byTask = {}
  for (const s of stream) byTask[s.taskId] = []
  let lastSlot = 0 // start in slot 0 (T0's message) — no stage before it has run yet
  for (const e of transcript) {
    if (e.type === 'stage' && typeof e.index === 'number') lastSlot = e.index
    else if (e.type === 'task-compact' && typeof e.slot === 'number') lastSlot = e.slot
    const tid = slotTask[lastSlot]
    if (tid && byTask[tid]) byTask[tid].push(e)
  }
  return byTask
}

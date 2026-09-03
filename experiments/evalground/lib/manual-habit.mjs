/**
 * Manual-habit context manager — a faithful MECHANIZATION of how practitioners
 * actually manage context by hand, distilled from real-world usage reports
 * (AgentPatterns "Manual Compaction as Dumb Zone Mitigation" + BSWEN "Manage
 * and Compact Context in Claude Code When Conversations Get Too Long").
 *
 * The behavior being automated (a "control" for the plugin compression to beat):
 *   - Humans compress at ~50% of context, LONG before auto-compaction's ~95%
 *     ("dumb zone" onset).
 *   - Humans compact at TASK-TYPE transitions, after a LARGE FILE READ is done,
 *     after a subtask/breakthrough pass, and when quality degrades.
 *   - The focus directive preserves: current objective + acceptance criteria,
 *     modified file paths, unresolved failures + exact error strings, and
 *     architectural decisions + rationale.
 *
 * This module is the DETERMINISTIC side: the trigger rules and the focus-set
 * extraction are pure functions (no model, no IO beyond the passed-in data), so
 * they can be asserted offline and reused by the runner. It is NOT the
 * compressor; the runner hands the focus directive to the compressor.
 *
 * Cost discipline: this manager makes NO LLM calls to decide when/where to
 * compress (unlike the task-boundary discriminator). It is a pure human-habit
 * analog → no `costs.decision` (source 'manual', 0 tokens).
 */
import { estimateMessagesTokens } from './prefix.mjs'

/** A `read` whose result is at least this many chars is "a large file read" →
 * once the relevant info is in context, the bulk is compressible (offload). */
export const BULK_READ_CHARS = 8000
/** Humans compact around this fraction of the task-scale window (not 95%). */
export const PRESSURE_RATIO = 0.5
/** A `run` result counts as a "passing run" (breakthrough) when it has NO positive
 * failure count and has at least one pass/ok marker. */
const PASS_MARKERS = ['pass', 'ok', '✓', 'success']

/** Does a run result indicate failure? "0 failed"/"0 errors" is NOT a failure
 * (that is a pass); a POSITIVE fail/error count, an explicit `FAIL`/`FAILED`
 * token, or a hard error marker is. */
function runFailed(result) {
  const r = String(result ?? '')
  const lower = r.toLowerCase()
  const m = /(\d+)\s*(fail|error)/.exec(lower)
  if (m && Number(m[1]) > 0) return true
  return /✗|×|\bFAIL(ED)?\b|\bnpm ERR\b/.test(r)
}

/** Return the first deterministic human-habit trigger that fires, or null.
 * @param {object} o { messages, transcript, domain, atSeq }
 *   messages   — current message list (for the pressure rule).
 *   transcript — the run's transcript entries (for bulk-read / passing-run).
 *   domain     — task-scale compression window (tokens) for the pressure rule.
 * @returns {null | {trigger, reason}} the human-habit trigger that fired.
 */
export function detectHumanTrigger({ messages, transcript, domain }) {
  const entries = Array.isArray(transcript) ? transcript : []
  // R1 bulk-read-done: a read tool returned a large payload (its info is now in
  // context; the raw bulk is compressible / offload-able). `resultLen` is the
  // FULL result length (the transcript truncates the visible `result` at 1500).
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e?.type === 'tool' && e.tool === 'read') {
      const len = Number(e.resultLen ?? 0) || String(e.result ?? '').length
      if (len >= BULK_READ_CHARS) {
        return { trigger: 'bulk-read', reason: `read returned ${len} chars (>= ${BULK_READ_CHARS})` }
      }
      break // only the most recent read matters
    }
  }
  // R2 passing-run: the most recent run passed → a subtask/breakthrough is done.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e?.type === 'tool' && e.tool === 'run') {
      const r = typeof e.result === 'string' ? e.result : ''
      const lower = r.toLowerCase()
      const failed = runFailed(r)
      const passed = PASS_MARKERS.some(m => lower.includes(m))
      if (passed && !failed) return { trigger: 'passing-run', reason: `run passed (${r.slice(0, 60)})` }
      break
    }
  }
  // R3 pressure-50: context is at ~50% of the task-scale window (human compacts
  // BEFORE the dumb zone, not at auto-compaction's ~95%).
  if (domain > 0) {
    const tokens = estimateMessagesTokens(messages)
    if (tokens >= domain * PRESSURE_RATIO) {
      return { trigger: 'pressure-50', reason: `${tokens} tokens >= ${Math.round(domain * PRESSURE_RATIO)} (${Math.round(PRESSURE_RATIO * 100)}% of ${domain})` }
    }
  }
  return null
}

/** Deterministic focus-set extraction from the transcript + task (what a human
 * focus directive tells the compressor to preserve).
 * @param {object} o { task, transcript }
 * @returns {{objective, paths:string[], failures:string[], decisions:string[]}}
 *   objective — the task's prompt (user intent, kept verbatim-ish).
 *   paths     — every path the session touched (from read/write tool args).
 *   failures  — exact error/failure strings from failing run results.
 *   decisions — key decision sentences from the transcript (best-effort).
 */
export function extractFocusSet({ task, transcript }) {
  const paths = []
  const failures = []
  const decisions = []
  const entries = Array.isArray(transcript) ? transcript : []
  for (const e of entries) {
    if (e?.type !== 'tool') continue
    const argPath = typeof e.arg === 'object' && e.arg ? e.arg.path : null
    if (argPath && typeof argPath === 'string' && !paths.includes(argPath)) paths.push(argPath)
    // A failing run → capture the exact error/failure line (preserved verbatim).
    const r = typeof e.result === 'string' ? e.result : ''
    if (e.tool === 'run' && /fail|✗|×|error/i.test(r)) {
      const line = r.split('\n').find(l => /fail|✗|×|error/i.test(l))
      if (line && !failures.includes(line)) failures.push(line.trim())
    }
  }
  return {
    objective: String(task?.prompt ?? task?.title ?? '').slice(0, 400),
    paths,
    failures,
    decisions,
  }
}

/** Render the focus set as a directive the compressor must honor (the human
 * focus directive / CLAUDE.md "# Compact instructions" analog). */
export function buildFocusDirective(focus) {
  if (!focus) return ''
  const lines = ['MANUAL-HABIT FOCUS — when compacting, ALWAYS preserve:', '']
  if (focus.objective) lines.push(`- Current task objective: ${focus.objective}`)
  if (focus.paths.length > 0) lines.push(`- File paths modified in this session: ${focus.paths.join(', ')}`)
  if (focus.failures.length > 0) lines.push(`- Unresolved failures / exact error strings:\n${focus.failures.map(f => `  - ${f}`).join('\n')}`)
  if (focus.decisions.length > 0) lines.push(`- Architectural decisions (verbatim): ${focus.decisions.join('; ')}`)
  return lines.join('\n')
}

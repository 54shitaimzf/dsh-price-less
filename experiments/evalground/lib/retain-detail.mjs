/**
 * Design-R hot tail (F11) — harness-verbatim retain detail.
 *
 * The A1-S1 retain bridge used to be a bare pointer card (refs + one-line
 * outline, no raw text). Design R upgrades it: the model still authors ONLY
 * `outline` + `refs` (a model transcribing outputs would fight the OUT
 * anti-echo gate and risk fabrication), and the HARNESS deterministically
 * attaches the near-verbatim execution details from the segment transcript:
 *   - `detail.verifications`: the last few real `run` tool results (command +
 *     verbatim result tail),
 *   - `detail.failures`: verbatim failing/error lines from run results,
 *   - plus every retain ref resolved to its real content (`refs[].content`),
 *     so the next task starts with zero retrieval round trips.
 *
 * Total rendered retain node is budget-capped (RETAIN_DETAIL_TOKEN_BUDGET,
 * user decision 2026-09: 5000 tokens, wire-calibrated estimate). Trimming is
 * deterministic: oldest verification first, then oldest failure, then tail
 * truncation with a visible marker — same transcript ⇒ same bytes.
 *
 * Everything here is POST-gate (runs after compressWithProgram validation, in
 * the same harness layer as enrichRefs) — the model's product schema is
 * unchanged and the mechanical gates never see harness-authored bytes.
 */
import { estimateTokens } from './prefix.mjs'

/** User-approved cap for the WHOLE rendered retain node (F11, 2026-09). */
export const RETAIN_DETAIL_TOKEN_BUDGET = 5000

const MAX_VERIFICATIONS = 3 // most recent run results kept
const MAX_FAILURES = 5 // most recent failing lines kept
const VERIFY_TAIL_CHARS = 1200 // per-verification result tail cap
const FAILURE_LINE_CHARS = 300 // per-line cap
const MIN_TAIL_CHARS = 200 // truncation floor for the budget loop

/** True for events the extractor consumes (verbatim run results). */
function runResultOf(e) {
  if (e?.type !== 'tool' || e?.tool !== 'run') return null
  const command = typeof e.arg === 'string' ? e.arg : (e.arg?.command ?? e.arg?.cmd ?? null)
  const result = typeof e.result === 'string' ? e.result : ''
  return { command, result }
}

/** Deterministic extraction from the CLOSED SEGMENT's transcript entries only. */
export function extractRetainDetail(segmentEntries) {
  const entries = Array.isArray(segmentEntries) ? segmentEntries : []
  const runs = []
  for (const e of entries) {
    const r = runResultOf(e)
    if (r && r.result.length > 0) runs.push(r)
  }
  const verifications = runs.slice(-MAX_VERIFICATIONS).map(r => ({
    command: String(r.command ?? '(unknown command)').slice(0, 200),
    tail: r.result.slice(-VERIFY_TAIL_CHARS),
  }))
  const failures = []
  for (const r of runs) {
    for (const line of r.result.split('\n')) {
      if (/fail|✗|×|error/i.test(line) && !failures.includes(line.trim())) {
        failures.push(line.trim().slice(0, FAILURE_LINE_CHARS))
      }
    }
  }
  return { verifications, failures: failures.slice(-MAX_FAILURES) }
}

/**
 * Attach the harness detail to the validated product's retain (mutates:
 * `retain.detail` + `retain.refs[].content`). Ref resolution mirrors
 * enrichRefs (same bindings, same-target cache). Returns the rendered-over
 * budget report `{ overBudget }` — trimming happens in renderRetain, the
 * only byte-emitting stage, so the audit JSON keeps full detail.
 */
export async function attachRetainDetail(product, context, bindings, budget = RETAIN_DETAIL_TOKEN_BUDGET) {
  const retain = product?.retain
  if (!retain) return { overBudget: 0 }
  retain.detail = extractRetainDetail(context?.transcript ?? [])
  const resolveCache = new Map()
  for (const ref of retain.refs ?? []) {
    const key = `${ref.path}|${ref.lineRange ?? ''}`
    let r = resolveCache.get(key)
    if (r === undefined) {
      r = await bindings.resolve_pointer({ path: ref.path, lineRange: ref.lineRange ?? null })
      resolveCache.set(key, r)
    }
    if (!r.error) ref.content = r.content
  }
  // The renderer owns trimming; report how far the full-fidelity render exceeds
  // the budget so the caller can log it (0 = untouched).
  const { renderRetain } = await import('./assemble.mjs')
  let over = estimateTokens(renderRetain(retain)) - budget
  while (over > 0) {
    const d = retain.detail
    if (d.verifications.length > 1) { d.verifications.shift(); }
    else if (d.failures.length > 1) { d.failures.shift(); }
    else if (d.verifications.length === 1 && d.verifications[0].tail.length > MIN_TAIL_CHARS) {
      d.verifications[0].tail = d.verifications[0].tail.slice(-Math.max(MIN_TAIL_CHARS, Math.floor(d.verifications[0].tail.length / 2)))
    } else if (d.failures.length === 1 && d.failures[0].length > FAILURE_LINE_CHARS / 2) {
      d.failures[0] = d.failures[0].slice(-FAILURE_LINE_CHARS / 2)
    } else { break }
    over = estimateTokens(renderRetain(retain)) - budget
  }
  return { overBudget: Math.max(0, over) }
}

/**
 * V1 — prefix-cache accounting for chat requests.
 *
 * The stable prefix of a chat request is the part that never changes between
 * rounds within a run: system prompt + task definition (+ fixed injections).
 * The tail is everything the model produced (assistant/tool turns). If the
 * gateway implements prompt caching (measured per call), the prefix bytes are
 * read from cache instead of re-billed.
 *
 * Derived estimates (chars/4 token approximation) are labeled derived and can
 * be VIEWED in reports but must never enter E3 cost conclusions (arm-spec
 * ledger.enforced; see cost.mjs forbidDerivedInConclusions).
 */
import { triggerConfig } from './arm-spec.mjs'

export const CHARS_PER_TOKEN = 1.5 // wire-calibrated 2026-09: median wire/est was 2.7 at chars/4 (batch CASCADE-native-auto-mtm2wwpf / manual-habit-mtm4ovi3)

/** Deterministic token estimate from text length. */
export function estimateTokens(text) {
  return Math.max(0, Math.ceil((text?.length ?? 0) / CHARS_PER_TOKEN))
}

export function estimateMessagesTokens(messages) {
  return (messages ?? []).reduce((a, m) => a + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')), 0)
}

/**
 * Split a chat message list into {prefix, tail}.
 * Prefix = system + the first user message (task definition) — the bytes that
 * are identical across rounds. Tail = everything after.
 */
export function splitPrefix(messages) {
  const msgs = Array.isArray(messages) ? messages : []
  if (msgs.length === 0) return { prefix: [], tail: [] }
  const prefix = []
  let i = 0
  for (; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role === 'system') { prefix.push(m); continue }
    if (m.role === 'user' && prefix.length > 0) { prefix.push(m); break } // first user = task definition
    break
  }
  // staged/initial user message may appear before system in odd assemblies — normalize:
  return { prefix, tail: msgs.slice(i + (prefix.length > 0 ? 1 : 0)) }
}

/** Deterministic whitespace-only compaction: usable knowledge-free "trim" arm. */
export function trimPrompt(text) {
  return String(text ?? '')
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Per-call prefix accounting.
 * @returns {object} { prefixTokens, tailTokens, cacheReadTokens, derivedCacheRead, derived: boolean }
 *   cacheReadTokens comes from the gateway usage when present; derivedCacheRead
 *   is the chars-based estimate when the gateway reports none — always labeled.
 */
export function accountPrefix(callMessages, callUsage) {
  const { prefix, tail } = splitPrefix(callMessages)
  const prefixTokens = estimateMessagesTokens(prefix)
  const tailTokens = estimateMessagesTokens(tail)
  const cacheReadTokens = callUsage?.cacheReadTokens ?? null
  const derivedCacheRead = cacheReadTokens === null || cacheReadTokens === undefined ? prefixTokens : null
  return {
    prefixTokens, tailTokens,
    cacheReadTokens,
    derivedCacheRead,
    derived: derivedCacheRead !== null,
  }
}

/** Should the run compress at all? Uses the shared trigger constant. */
export function shouldTrigger(thresholdTokensOverride) {
  const t = thresholdTokensOverride ?? triggerConfig().tokenThreshold
  return (roundTokens) => roundTokens >= t
}
/**
 * Current context size in wire tokens (F10a). Anchored on the last routed
 * request's EXACT usage (`st.lastPromptTokens` — provider-tokenizer truth:
 * system + tools + messages + reasoning echo), plus the assistant turn's exact
 * generated size (`st.lastCompletionTokens` — reasoning + content + tool args
 * as metered), plus a chars-estimate of ONLY the new messages since that
 * request (tool results — small; error bounded and re-anchored every step).
 * Cold path (first request / just after a rebuild reset / missing usage):
 * full char estimate — biased for one iteration, then re-anchored exactly.
 */
export function contextWireTokens(st, messages) {
  const sendLen = st.lastPromptMsgCount
  if (st.lastPromptTokens > 0 && Number.isInteger(sendLen) && sendLen >= 0 && sendLen <= messages.length) {
    return st.lastPromptTokens + (st.lastCompletionTokens ?? 0)
      + estimateMessagesTokens(messages.slice(sendLen + 1))
  }
  return estimateMessagesTokens(messages)
}

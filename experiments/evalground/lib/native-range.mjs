/**
 * Native range selection — a faithful port of DSH-native `selectCompactableRange`
 * (packages/compaction/compaction-basic/src/region.ts) adapted to evalground's
 * message list + estimated token counts.
 *
 * The DSH-native control (`native-auto`) is the "off-the-shelf harness" reference:
 * it compacts the COLD HEAD of the whole surface while retaining a priced recent
 * tail, and never splits an assistant tool-call/result pair. Evalground is a
 * standalone Node process (no DSH session / token meter), so this is a PORT, not
 * an import — the token accounting uses the same `estimateTokens` approximation
 * as the rest of the runner, and the pairing check uses the message list shape
 * (an assistant message with `tool_calls` is immediately followed by role:'tool'
 * results). These are pure functions with zero IO so the arithmetic and the
 * pairing guards can be asserted offline.
 */
import { estimateTokens } from './prefix.mjs'

/** Estimated tokens for one message (content + any tool_calls payload). */
export function msgTokens(m) {
  const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')
  let t = estimateTokens(content)
  if (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0) {
    t += estimateTokens(JSON.stringify(m.tool_calls))
  }
  return t
}

/**
 * Approximate DSH-native `toolPairingBalancedBefore` for the evalground message
 * list. A boundary at index `i` is NOT balanced when `messages[i]` is a `tool`
 * result: its preceding assistant message (which issued the tool call) would be
 * on the compacted side while its result stays on the retained side — splitting
 * the pair. (Native keeps the recent tail, so the boundary is the first node of
 * the retained region; a `tool` result there splits [call, result].)
 */
export function balancedBefore(messages, i) {
  if (i >= (messages ?? []).length) return true
  return (messages[i]?.role ?? '') !== 'tool'
}

/**
 * Select the inclusive index span of `messages` to compact (the cold head),
 * retaining a recent tail of at least `retainTokens` verbatim.
 * @param {Array<object>} messages — the current surface (message list), in order.
 * @param {number} retainTokens — minimum recent-tail budget kept verbatim.
 *   `0` keeps only the last node (DSH overflow path); a budget larger than the
 *   whole surface swallows it and returns null ("compress 0 bytes").
 * @returns {null | {startIdx, endIdx, keepFromIdx, retainedTokens}}
 *   `[startIdx..endIdx]` is the inclusive range to compact; `null` when nothing
 *   is compactable (mirrors native returning null).
 */
export function selectCompactableRange(messages, retainTokens) {
  const msgs = Array.isArray(messages) ? messages : []
  const tokens = msgs.map(msgTokens)
  if (tokens.length === 0) return null

  let accumulated = 0
  let keepFromIdx = tokens.length
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    accumulated += tokens[i]
    keepFromIdx = i
    if (accumulated >= retainTokens) break
  }
  // The retain budget is larger than (or equal to) the whole surface: nothing left
  // to compact (native returns null → "compress 0 bytes").
  if (keepFromIdx === 0) return null

  // Never split a tool-call/result pair at the retained tail boundary.
  while (keepFromIdx > 0 && !balancedBefore(msgs, keepFromIdx)) keepFromIdx -= 1
  if (keepFromIdx === 0) return null

  return {
    startIdx: 0,
    endIdx: keepFromIdx - 1,
    keepFromIdx,
    retainedTokens: tokens.slice(keepFromIdx).reduce((a, t) => a + t, 0),
  }
}

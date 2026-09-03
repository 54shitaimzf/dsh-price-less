/**
 * Gateway mock transports — offline test substitution for the ONLY network
 * egress. Three modes, all implementing the same chatCall signature as
 * createGateway().chatCall:
 *
 *   createScriptedGateway({ script })   pre-set answer sequence (tool calls →
 *                                       writes → run → DONE) drives the runner
 *                                       loop with ZERO network.
 *   createRecordingGateway({ inner, dir })  wraps a real/other transport and
 *                                       appends every {req, resp} to dir as
 *                                       JSONL for later replay or inspection.
 *   createReplayGateway({ dir })        answers from a previous recording, in
 *                                       order; throws when the script runs out.
 *
 * Usage in tests:  runOne(task, { callLLM: createScriptedGateway({...}).chatCall })
 */
import fs from 'node:fs'
import path from 'node:path'

function resp(text, toolCalls = null, usage = { inputTokens: 10, outputTokens: 10, cacheReadTokens: null }, extra = {}) {
  return { text, toolCalls, model: 'mock', finishReason: toolCalls ? 'tool_calls' : 'stop', usage, raw: {}, ...extra }
}

const charsToTokens = (s) => Math.max(1, Math.ceil((s?.length ?? 0) / 4))

/**
 * Deterministic scripted answers. `script` is an array (or getter function)
 * of {text, toolCalls} answer objects. Each call returns the next answer;
 * usage is estimated from request body length unless the answer overrides usage.
 */
export function createScriptedGateway({ script }) {
  const answers = Array.isArray(script) ? () => script : script
  let calls = 0
  const log = []
  // The request `messages` array is MUTATED IN PLACE by the runner (`messages.length =
  // 0; messages.push(...)`), so a bare reference in the log would later read the
  // FINAL (post-rebuild) state — corrupting any replay/assembly audit that reads
  // `req.messages`. Snapshot a JSON copy at call time so each record is the exact
  // request sent at that instant.
  const snap = (x) => JSON.parse(JSON.stringify(x))
  async function chatCall({ provider, model, messages, tools }) {
    const seq = answers()
    if (calls >= seq.length) throw new Error(`scripted gateway exhausted after ${calls} calls`)
    const ans = seq[calls]
    if (typeof ans === 'function') {
      const dynamic = await ans({ index: calls, messages, tools })
      calls++
      log.push({ req: { model, messages: snap(messages), tools: !!tools }, resp: dynamic })
      return dynamic
    }
    calls++
    const inputTokens = ans.usage?.inputTokens ?? messages.reduce((a, m) => a + charsToTokens(m.content ?? ''), 0)
    const outputTokens = ans.usage?.outputTokens ?? charsToTokens(ans.text ?? '')
    const out = resp(ans.text ?? '', ans.toolCalls ?? null, {
      inputTokens, outputTokens, cacheReadTokens: ans.usage?.cacheReadTokens ?? null,
    }, ans.extra ?? {})
    log.push({ req: { model, messages: snap(messages), tools: !!tools }, resp: out })
    return out
  }
  return { chatCall, calls: () => calls, log, name: 'scripted' }
}

/** Wrap any transport (a chatCall function OR a gateway object); append
 * {req, resp} JSONL records to `file` (default dir/calls.jsonl). */
export function createRecordingGateway({ inner, dir, file }) {
  const outFile = file ?? path.join(dir ?? '.', 'calls.jsonl')
  const invoke = typeof inner === 'function'
    ? inner
    : (inner?.chatCall ?? (() => { throw new Error('recording gateway: inner has no chatCall') }))
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  let calls = 0
  async function chatCall(req) {
    const resp = await invoke(req)
    fs.appendFileSync(outFile, JSON.stringify({ seq: calls++, req, resp }) + '\n')
    return resp
  }
  return { chatCall, file: outFile, calls: () => calls, name: 'recording' }
}

/** Replay a recording in order. Throws when the script runs out. */
export function createReplayGateway({ dir }) {
  const file = typeof dir === 'string' && dir.endsWith('.jsonl') ? dir : path.join(dir, 'calls.jsonl')
  if (!fs.existsSync(file)) throw new Error(`replay recording not found: ${file}`)
  const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  let calls = 0
  async function chatCall(req) {
    if (calls >= records.length) throw new Error(`replay exhausted after ${calls} calls`)
    const rec = records[calls++]
    return { ...rec.resp, raw: rec.resp.raw ?? {} }
  }
  return { chatCall, file, calls: () => calls, records, name: 'replay' }
}

/** Deterministic offline chatCall with a canned single answer (convenience). */
export function createCannedGateway(answer) {
  return createScriptedGateway({ script: [answer] })
}
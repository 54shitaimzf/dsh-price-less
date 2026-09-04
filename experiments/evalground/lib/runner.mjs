/**
 * Silent agent loop with NATIVE function calling (same protocol DSH uses):
 * tools are passed as JSON schemas, the model responds with structured
 * tool_calls, the runtime executes them and returns results bound to
 * tool_call_id — the model can never fabricate an executed result.
 * No DSH session, no UI, no session logs — a plain Node process.
 */
import { createGateway, GatewayError } from './gateway.mjs'
import { assembleInit } from './assemble.mjs'
import { append as tappend } from './transcript.mjs'
import { accountPrefix, trimPrompt, contextWireTokens, estimateMessagesTokens } from './prefix.mjs'
import { triggerConfig, contextConfig } from './arm-spec.mjs'
import { loadBoundaries } from './boundaries.mjs'
import { wholeSurfaceStep, taskBoundaryStep } from './runner-compress.mjs'

const defaultCallLLM = createGateway().chatCall

const SYSTEM_PROMPT = [
  'You are an engineer working inside an evaluation workspace (CWD = the project root of a plugin-release auditor called relaudit).',
  '',
  'ENVIRONMENT RULES (hard):',
  '- You may read/modify files ONLY inside this workspace. Any path like ../.. or absolute paths outside the workspace is REJECTED by your tools.',
  '- There is no internet. You have exactly 5 tools: read, write, glob, grep, run.',
  '- run only accepts: `npm test`, `npm run check`, or `node --test [--test-isolation=none] tests/<file>.test.js` (one or more files) — anything else is denied.',
  '- Never modify tests/** files or package.json. The grader will rerun the pristine tests itself.',
  '- Never claim a result you did not receive: tool results come back from the runtime, bound to your tool call. If a test did not run or did not pass, say so.',
  '',
  'Work autonomously: inspect the workspace, make the required changes, verify with tests, then finish.',
  '',
  'FINISH: your FINAL message must start with exactly "DONE" followed by a one-paragraph summary (what you changed, and which tests you ran and their results).',
].join('\n')

function makeSchemas() {
  const fn = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } })
  return [
    fn('read', 'Read a UTF-8 text file inside the workspace. Path is relative to the workspace root.', { path: { type: 'string', description: 'Relative path, e.g. src/audit/semver.js' } }, ['path']),
    fn('write', 'Write a UTF-8 text file inside the workspace (creates parent dirs, overwrites).', { path: { type: 'string', description: 'Relative path' }, content: { type: 'string', description: 'Full file content' } }, ['path', 'content']),
    fn('glob', 'List files inside the workspace matching a glob pattern (e.g. "src/**/*.js", "tests/*.test.js").', { pattern: { type: 'string', description: 'Glob pattern' } }, ['pattern']),
    fn('grep', 'Regex-search file contents inside the workspace (optional subdirectory).', { pattern: { type: 'string', description: 'Regular expression' }, subdir: { type: 'string', description: 'Optional subdirectory, default "."' } }, ['pattern']),
    fn('run', "Run a whitelisted command inside the workspace: `npm test`, `npm run check`, or `node --test [--test-isolation=none] tests/<file>.test.js ...`. Anything else is denied.", { command: { type: 'string', description: 'The exact command' } }, ['command']),
  ]
}

async function tryCall(tools, name, args) {
  try {
    switch (name) {
      case 'read': return String(tools.read(args.path))
      case 'write': return String(tools.write(args.path, args.content))
      case 'glob': return String(tools.glob(args.pattern))
      case 'grep': return String(tools.grep(args.pattern, args.subdir))
      case 'run': return String(await tools.run(args.command))
      default: return `ERROR unknown tool: ${name}`
    }
  } catch (error) {
    return `ERROR ${String(error)}`
  }
}

/** Split a message list into a COLD head (to compress) and a RECENT tail (kept
 * verbatim — DSH-native 近因尾). The tail = the most recent `retainTokens`-worth
 * of messages, walked from the end. `retainTokens<=0` → no tail (whole = cold,
 * A1-S2 闭合即全压). The cold head is a PREFIX of the full list (cache-reuse).
 * Never split the system/instruction prefix: the tail is clamped to start at
 * index ≥ 1, so `cold` always keeps at least the first message.
 *
 * @returns {{cold: Array, tail: Array}} `cold` = messages to feed the compressor;
 *   `tail` = messages to keep verbatim after the compression block.
 */
export function splitRecentTail(messages, retainTokens) {
  const msgs = Array.isArray(messages) ? messages : []
  if (retainTokens <= 0 || msgs.length <= 1) return { cold: msgs, tail: [] }
  let acc = 0
  let tailStart = msgs.length
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    acc += estimateMessagesTokens([msgs[i]])
    tailStart = i
    if (acc >= retainTokens) break
  }
  if (tailStart < 1) tailStart = 1
  return { cold: msgs.slice(0, tailStart), tail: msgs.slice(tailStart) }
}

/**
 * Run one task session with native function calling.
 * @param {object} opts { workspace, taskId, prompt, model, provider, transcriptPath, timeoutMs, maxSteps, logger }
 * @returns {Promise<{finalText, usage, steps, finished, transcript}>}
 */
export async function runSession(opts) {
  const { workspace, task, prompt, model, provider, transcriptPath } = opts
  const timeoutMs = opts.timeoutMs ?? 25 * 60 * 1000
  const maxSteps = opts.maxSteps ?? 60
  const logger = opts.logger ?? (() => {})
  const callLLM = opts.callLLM ?? defaultCallLLM
  const prefixMode = opts.prefixMode ?? 'none' // 'none' | 'track' | 'trim' (V1)
  const compressionMode = opts.compression ?? 'none' // 'none' | 'truncate' | 'semantic' | 'industry' | 'mock' (V3)
  const maxCompressions = opts.maxCompressions ?? 2
  const triggerThreshold = opts.triggerThreshold ?? triggerConfig().tokenThreshold
  // E3 hard-truncate safety valve: never let a request exceed the model
  // context window. contextWindow = 100% window (tokens); truncatePct is the
  // floor (0.8 = hard-truncate at 80%). Both come from the global config and
  // are deterministic guard numbers, NOT derived estimates — they never enter
  // cost conclusions. A run that never reaches the floor is untouched, so a
  // normal full/self/industry arm is byte-identical behavior under the floor.
  const cc = opts.contextWindow !== undefined || opts.truncatePct !== undefined
    ? { contextWindow: opts.contextWindow ?? 256000, truncatePct: opts.truncatePct ?? 0.8 }
    : contextConfig()
  const contextWindow = cc.contextWindow
  const truncateFloor = Math.floor(cc.contextWindow * (cc.truncatePct ?? 0.8))
  let truncateCount = 0
  // Assembly audit: on each successful native whole-surface compression, snapshot
  // the message list BEFORE and AFTER the rebuild. Plain JSON-able objects (role /
  // content / tool_calls / tool_call_id), not live services — a deep copy lets the
  // ASSEMBLY assertions verify cache-reuse + single-node-replacement invariants
  // against the REAL assembled flow instead of a lossy re-derivation.
  const compressSnapshots = []
  // Shared compression-step state — the same closure variables the inlined
  // branches used, now carried in one bag and mutated IN PLACE by
  // wholeSurfaceStep / taskBoundaryStep (runner-compress.mjs):
  //   lastPromptTokens / compressCount / degenerateCount — whole-surface counters;
  // Task-boundary compression state (M4/M5 — PTC-style, ref-based):
  //   sectionCount   — number of IMMUTABLE per-section nodes (messages[1..sectionCount]);
  //                    sections are appended, never rewritten (cache-stable prefix).
  //   retainNode     — the transient A1-S1 hot-bridge node (refs+outline), at most one;
  //                    dropped at the NEXT compaction (never re-fed, never re-compressed).
  //   segmentEntriesStart — transcript index at the last compaction (the closed segment's
  //                    raw entries are the bindings' data plane).
  const st = { compressCount: 0, degenerateCount: 0, lastPromptTokens: 0, lastCompletionTokens: 0, lastPromptMsgCount: null, sectionCount: 0, retainNode: null, segmentEntriesStart: 0 }
  // — Compression-domain calibration (task-boundary arms): the compression window
  // is a task-scale quantity, retaim/threshold derived from it, INDEPENDENT of the
  // hard-truncate safety valve above. Boundary marks (preprocessing output) identify
  // segment boundaries so the runner compresses at segment ends WITHOUT a runtime
  // task-partition state machine.
  const taskBoundary = compressionMode === 'task-boundary'
  const nativeAuto = compressionMode === 'native-auto'
  const manualHabit = compressionMode === 'manual-habit'
  const isNativeWhole = nativeAuto || manualHabit
  const a2 = opts.a2 ?? 'keep-original'
  // A1 范围 (叠加在 task 边界压缩上): s1 引用化保尾 (refs+outline 热桥接) vs s2 闭合即全压 (无保留).
  const a1 = opts.a1 ?? 's2'
  const { compressorConfig } = await import('./arm-spec.mjs')
  const compGates = compressorConfig()
  const boundaryMark = taskBoundary ? loadBoundaries(opts.taskId) : null
  const { createTools } = await import('./tools.mjs')
  const { tools, guard } = createTools(workspace, logger, opts.taskId, opts.allowedPaths)

  const ctx = assembleInit({
    mode: opts.contextMode ?? 'plain',
    systemPrompt: SYSTEM_PROMPT,
    task,
    prompt,
    stagedMessages: opts.stagedMessages,
    workspace,
    product: opts.product,
    anchorKind: opts.anchorKind,
    position: opts.position,
    noiseRatio: opts.noiseRatio,
    indexOnly: opts.indexOnly,
    noiseSeed: opts.noiseSeed,
  })
  const messages = ctx.messages
  if (prefixMode === 'trim' && messages.length >= 2) {
    messages[1] = { ...messages[1], content: trimPrompt(messages[1].content ?? '') }
  }
  const stageMessages = ctx.stageMessages
  const hasStages = stageMessages.length > 0
  if (messages.length < 2) {
    logger('runner: no user prompt / initialMessages / stagedMessages provided')
    return { finalText: '', finished: false, steps: 0, usage, elapsedMs: 0, violations: [], transcript: [] }
  }
  let stageIndex = hasStages ? 0 : -1
  const transcript = []
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 }
  // V1 prefix ledger (aggregated across calls)
  const prefixStats = { prefixTokens: 0, tailTokens: 0, cacheReadTokens: 0, derivedCacheRead: 0, tracked: false }
  const started = Date.now()
  let steps = 0
  let finished = false
  let finalText = ''

  const append = (entry) => {
    transcript.push(entry)
    tappend(transcriptPath, entry)
  }

  // The compression-step context bag: everything wholeSurfaceStep /
  // taskBoundaryStep (runner-compress.mjs) close over. The `st` counters are
  // shared by reference — the steps mutate them exactly as the inlined
  // branches mutated these locals, so loop guards (`st.compressCount <
  // maxCompressions`) see the same values the original closure did.
  const runCtx = {
    opts, workspace, task, messages, transcript, append, logger, guard,
    a1, a2, callLLM, provider, model, st, compressSnapshots,
    transcriptPath, compGates, boundaryMark, makeSchemas,
    compressionMode, maxCompressions, triggerThreshold,
    isNativeWhole, nativeAuto, manualHabit,
  }

  while (true) {
    if (Date.now() - started > timeoutMs) { append({ type: 'timeout', elapsedMs: Date.now() - started }); break }
    // V3: compression trigger (whole-surface arms) — before the request.
    // `native-auto` (DSH-native automatic control) and `manual-habit` (human-
    // habit mimic control) are whole-surface LLM compressors: they select a
    // compactable cold-head range (native `selectCompactableRange`), retain a
    // priced recent tail, and land the DSH-native `<compacted-summary>` 8-section
    // checkpoint as a single replacement node. The DIFFERENCE between them:
    //   native-auto  — triggers at the task-scale calibrated threshold;
    //   manual-habit — triggers on the human habit rules (bulk-read / passing-run /
    //                  pressure-50) and injects a focus directive the compressor
    //                  must preserve (objective / paths / failures / decisions).
    if (compressionMode !== 'none' && !taskBoundary && st.compressCount < maxCompressions) {
      await wholeSurfaceStep(runCtx)
    }
    // E3 hard-truncate safety valve (runs for EVERY arm, independent of the
    // compression mode). If the accumulated context — the SAME estimate used
    // by the compression trigger — is at/over the window floor, rebuild the
    // message list from [system, task] + the most recent tail so the request
    // can never overflow the model window. This is lossy (drops the oldest
    // history) so it must only fire as a last-resort guard; under the floor it
    // is a no-op and leaves `messages` byte-identical to an unguarded run.
    if (contextWireTokens(st, messages) >= truncateFloor && messages.length > 2) {
      const keep = messages.slice(0, 2) // [system, task] — stable prefix, cache-friendly
      // keep the newest messages, dropping the oldest, until under the floor
      let tail = messages.slice(2)
      while (tail.length > 1 && estimateMessagesTokens([...keep, ...tail]) >= truncateFloor) {
        tail = tail.slice(1)
        if (tail.length === 1) break
      }
      messages.length = 0
      messages.push(...keep, ...tail)
      truncateCount++
      // F10a: the rebuild invalidates the send-time anchor (indices shifted) —
      // drop to the cold path; the next routed request re-anchors exactly.
      st.lastPromptTokens = 0
      st.lastCompletionTokens = 0
      st.lastPromptMsgCount = null
      append({ type: 'hard-truncate', floor: truncateFloor, keptTail: tail.length })
      logger(`hard-truncate #${truncateCount} at floor=${truncateFloor} (dropped oldest history; tail=${tail.length})`)
    }
    let call
    try {
      call = await callLLM({ provider, model, messages, tools: makeSchemas() })
    } catch (error) {
      const fail = error instanceof GatewayError ? `[${error.code}] ${error.message}` : String(error)
      append({ type: 'gateway-error', message: fail })
      logger(fail)
      break
    }
    usage.inputTokens += call.usage.inputTokens ?? 0
    usage.outputTokens += call.usage.outputTokens ?? 0
    usage.cacheReadTokens += call.usage.cacheReadTokens ?? 0
    usage.calls++
    // F10a wire anchor: the last ROUTED request's usage is the exact provider-
    // tokenizer size of everything sent (system+tools+messages, reasoning echo
    // included). msgCount is the send-time length — the assistant turn (counted
    // exactly by completionTokens) and any tool results after it are the delta.
    // Coupled update: if usage is missing, keep the older anchor AND the older
    // msgCount so the delta spans back to the last real measurement.
    if (call.usage?.inputTokens) {
      st.lastPromptTokens = call.usage.inputTokens
      st.lastCompletionTokens = call.usage.outputTokens ?? 0 // gateway usage field is outputTokens (completion on the wire)
      st.lastPromptMsgCount = messages.length
    }
    if (prefixMode !== 'none') {
      const acc = accountPrefix(messages, call.usage)
      prefixStats.prefixTokens += acc.prefixTokens
      prefixStats.tailTokens += acc.tailTokens
      prefixStats.cacheReadTokens += acc.cacheReadTokens ?? 0
      prefixStats.derivedCacheRead += acc.derivedCacheRead ?? 0
      prefixStats.tracked = true
    }
    append({ type: 'assistant', role: 'assistant', content: call.text.slice(0, 1000), toolCalls: call.toolCalls, usage: call.usage, model: call.model })
    const asstMsg = { role: 'assistant', content: call.text, tool_calls: call.toolCalls ? call.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })) : undefined }
    if (call.reasoning_content) asstMsg.reasoning_content = call.reasoning_content
    messages.push(asstMsg)

    steps++
    if (steps > maxSteps) { append({ type: 'step-limit', steps }); break }
    if (call.toolCalls && call.toolCalls.length > 0) {
      for (const tc of call.toolCalls) {
        let args = {}
        try { args = tc.args ? JSON.parse(tc.args) : {} } catch { guard.violations.push(`bad-tool-args:${tc.name}:${String(tc.args).slice(0, 120)}`) }
        const result = await tryCall(tools, tc.name, args)
        append({ type: 'tool', tool: tc.name, arg: args, result: result.slice(0, 1500), resultLen: result.length })
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, 12000) })
      }
      continue
    }
    const text = call.text.trim()
    if (text.startsWith('DONE')) {
      // staged tasks: DONE ends the current stage, next stage message is injected
      if (hasStages && stageIndex < stageMessages.length - 1) {
        // Task-boundary compression (self-* arms M1–M5): consume PREPROCESSED
        // boundary marks. When the NEXT staged message is the head of a NEW segment,
        // the previous segment is a closed task unit → compress with the PTC-style
        // compressor (model writes a program; code guarantees structure/refs/ratio).
        if (taskBoundary && boundaryMark) {
          await taskBoundaryStep(runCtx, stageIndex)
        }
        stageIndex++
        append({ type: 'stage', index: stageIndex, message: stageMessages[stageIndex].slice(0, 200) })
        messages.push({ role: 'user', content: stageMessages[stageIndex] })
        continue
      }
      finished = true; finalText = text; break
    }
    // no tool calls and no DONE: ask for continuation in one turn; then stop.
    append({ type: 'no-tool-no-done' })
    messages.push({ role: 'user', content: 'No tool call and no DONE marker was found. Either call a tool now or finish with DONE + summary.' })
  }

  // Control-degeneracy check (assertCompressionFired): a `native-auto` / `manual-habit`
  // arm exists to COMPRESS; if it ended never having compressed, the control is
  // degenerate — surface it as a violation + the `degenerate` flag so the report
  // excludes it from aggregate Δ rather than silently treating it as a valid arm.
  if (isNativeWhole && st.compressCount === 0 && compressionMode !== 'none') {
    guard.violations.push(`compression-degenerate:${compressionMode}:never-compressed`)
  }

  return {
    finalText,
    finished,
    steps,
    usage,
    elapsedMs: Date.now() - started,
    violations: guard.violations,
    transcript,
    prefixStats,
    compression: { mode: compressionMode, count: st.compressCount, degenerate: isNativeWhole && st.compressCount === 0 },
    compressSnapshots,
    hardTruncate: { floor: truncateFloor, count: truncateCount },
  }
}
/**
 * Assertions — the two CONTROLS (`native-auto` DSH-native automatic, `manual-habit`
 * human-habit mimic) + their prechecks (NATIVE-RANGE / NATIVE-SUMMARY / A2-BLOCKS /
 * MANUAL-HABIT / PRODUCT-SHAPE / ASSERT-FIRED) + costPerSuccessfulTask. Run via
 * lib/assert.mjs. All offline: pure functions + scripted gateway; NO real model calls.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT, createWorkspace } from '../lib/workspace.mjs'

const tmp = path.join(EVAL_ROOT, '.assert-tmp', 'controls')
let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!cond) failures++
}

// ============ NATIVE-RANGE. port of selectCompactableRange ============
{
  const { selectCompactableRange } = await import('../lib/native-range.mjs')
  const fake = (role, content, extra = {}) => ({ role, content, ...extra })
  // a large surface compacts the cold head, retaining a recent tail.
  const big = Array.from({ length: 40 }, (_, i) => fake(i < 2 ? 'system' : 'assistant', 'y'.repeat(900)))
  const r = selectCompactableRange(big, 8000)
  ok(r !== null && r.endIdx > 0 && r.retainedTokens >= 8000, 'NR1 large surface → compact cold head, retain recent tail', JSON.stringify({ endIdx: r?.endIdx, retain: r?.retainedTokens }))
  ok(r.startIdx === 0, 'NR2 compacted span starts at the surface head (index 0)')
  // a retain budget larger than the whole surface → null (native "compress 0 bytes").
  const small = selectCompactableRange(big, 1e9)
  ok(small === null, 'NR3 retain budget swallows surface → null (degenerate)')
  // retain=0 keeps only the last node (native overflow path).
  const r0 = selectCompactableRange(big, 0)
  ok(r0 !== null && r0.endIdx === big.length - 2, 'NR4 retain=0 → compact all but last node (overflow)', `endIdx=${r0?.endIdx}`)
  // never split a tool-call/result pair: boundary must not land on a tool result.
  const paired = [
    fake('assistant', 'a'),
    fake('assistant', 'call', { tool_calls: [{ name: 'read', args: '{"path":"a"}' }] }),
    fake('tool', 'RESULT'.repeat(400)),
    fake('assistant', 'next'),
  ]
  const rp = selectCompactableRange(paired, 10)
  ok(rp !== null && rp.endIdx === 0 && paired[rp.keepFromIdx]?.role !== 'tool', 'NR5 boundary never splits a tool-call/result pair', JSON.stringify({ endIdx: rp?.endIdx, keepFromIdx: rp?.keepFromIdx, keepRole: paired[rp?.keepFromIdx]?.role }))
}

// ============ NATIVE-SUMMARY. 8-section <compacted-summary> (lenient, DSH-native) ============
{
  const { validateNativeSummary, frameNativeSummary, NATIVE_SECTIONS, nativeSectionStats } = await import('../lib/compress.mjs')
  const valid = { summary: NATIVE_SECTIONS.map(s => `## ${s}\n- x`).join('\n') }
  ok(validateNativeSummary(valid).length === 0, 'NS1 valid 8-section summary passes')
  // LENIENT (mirrors DSH-native frameSummary, which does NOT hard-validate):
  // a non-empty substantial summary is accepted even without the exact 8 headers.
  const partial = { summary: '## Primary Request and Intent\n- fix the auth bug\n## Critical Context\n- keep the paths verbatim\n' + 'y'.repeat(120) }
  ok(validateNativeSummary(partial).length === 0, 'NS2 lenient: partial/summary without all 8 headers is accepted (not a wasted compression)')
  const empty = { summary: '' }
  ok(validateNativeSummary(empty).length > 0, 'NS3 empty summary rejected (never inject garbage)')
  ok(validateNativeSummary({ summary: 'tiny' }).length > 0, 'NS3b trivial < 80 chars rejected')
  const framed = frameNativeSummary(valid.summary)
  ok(framed.role === 'user' && framed.content.includes('<compacted-summary>') && framed.content.includes('</compacted-summary>') && framed.content.includes('automatically generated checkpoint'), 'NS4 frameNativeSummary wraps preamble + tags')
  const stats = nativeSectionStats(valid.summary)
  ok(stats.found === 8, 'NS5 nativeSectionStats counts 8 sections for a full summary', stats.found)
  ok(nativeSectionStats(partial.summary).found < 8, 'NS6 nativeSectionStats reports < 8 for partial (diagnostic, not a gate)')
}

// ============ A2-BLOCKS. 方案1 具体内容展开 (plan/impl/verify/wrap) ============
{
  const { validateProductBlocks } = await import('../lib/compress.mjs')
  ok(validateProductBlocks({ blocks: [] }).length > 0, 'A2-B1 empty blocks rejected')
  const good = { blocks: [ { type: 'plan', goal: 'g', constraints: ['c'] }, { type: 'impl', path: 'a.js', change: 'd', test: 't' }, { type: 'verify', command: 'npm test', result: 'pass' }, { type: 'wrap', conclusion: 'ok', deliverables: ['x'] } ] }
  ok(validateProductBlocks(good).length === 0, 'A2-B2 valid blocks pass')
  ok(validateProductBlocks({ blocks: [ { type: 'impl', change: 'd' } ] }).some(p => p.includes('missing required field impl.path')), 'A2-B3 illegal/missing required field caught')
  ok(validateProductBlocks({ blocks: [ { type: 'plan', goal: 'g', path: 'x' } ] }).some(p => p.includes('illegal field')), 'A2-B4 illegal field on block caught')
  ok(validateProductBlocks({ blocks: [ { type: 'nope', goal: 'g' } ] }).some(p => p.includes('not allowed')), 'A2-B5 unknown block type caught')
}

// ============ MANUAL-HABIT. human trigger rules + focus set ============
{
  const { detectHumanTrigger, extractFocusSet, buildFocusDirective, BULK_READ_CHARS } = await import('../lib/manual-habit.mjs')
  const fake = (role, content) => ({ role, content })
  // none
  ok(detectHumanTrigger({ messages: [], transcript: [], domain: 50000 }) === null, 'MH1 no trigger by default')
  // bulk-read
  const bulk = detectHumanTrigger({ messages: [], transcript: [{ type: 'tool', tool: 'read', result: 'x'.repeat(100), resultLen: BULK_READ_CHARS + 1 }], domain: 50000 })
  ok(bulk && bulk.trigger === 'bulk-read', 'MH2 bulk-read fires on a large read', bulk?.trigger)
  // passing-run ("0 failed" = pass; "1 failed" = fail)
  ok(detectHumanTrigger({ messages: [], transcript: [{ type: 'tool', tool: 'run', result: '2 tests passed, 0 failed' }], domain: 50000 })?.trigger === 'passing-run', 'MH3 passing-run fires when 0 failed')
  ok(detectHumanTrigger({ messages: [], transcript: [{ type: 'tool', tool: 'run', result: '3 passed, 1 failed' }], domain: 50000 }) === null, 'MH4 failing run does NOT trigger passing-run')
  // pressure-50
  const p = detectHumanTrigger({ messages: Array.from({ length: 30 }, (_, i) => fake('assistant', 'z'.repeat(800))), transcript: [], domain: 10000 })
  ok(p && p.trigger === 'pressure-50', 'MH5 pressure-50 fires near ~50% of the task-scale domain', p?.trigger)
  // focus set extraction + focus directive
  const fs = extractFocusSet({ task: { prompt: 'Fix the auth bug. Do not touch tests.' }, transcript: [
    { type: 'tool', tool: 'read', arg: { path: 'src/x.js' } },
    { type: 'tool', tool: 'write', arg: { path: 'src/y.js' } },
    { type: 'tool', tool: 'run', result: 'FAILED: expected 5 got 3\nnpm test: 1 failing' },
  ] })
  ok(fs.paths.join(',') === 'src/x.js,src/y.js', 'MH6 focus set captures modified paths', JSON.stringify(fs.paths))
  ok(fs.failures.length > 0 && fs.objective.length > 0, 'MH7 focus set captures failing error strings + objective')
  const directive = buildFocusDirective(fs)
  ok(directive.includes('Current task objective') && directive.includes('src/y.js') && directive.includes('FAILED'), 'MH8 focus directive carries objective/paths/failures')
}

// ============ PRODUCT-SHAPE. native control must use native product (anti-pollution) ============
{
  const { productShapeOf, validateArmRow } = await import('../lib/config.mjs')
  ok(productShapeOf('native-auto') === 'native' && productShapeOf('manual-habit') === 'native', 'PS1 native controls bind product shape native')
  ok(productShapeOf('task-boundary') === 'plugin' && productShapeOf('semantic') === 'plugin', 'PS2 plugin modes bind product shape plugin')
  ok(productShapeOf('none') === null && productShapeOf('truncate') === null, 'PS3 no-compressor modes have no product shape')
  ok(validateArmRow({ id: 'native-auto', compression: 'native-auto' }).length === 0, 'PS4 native-auto row validates')
  ok(validateArmRow({ id: 'bad', compression: 'frobnicate' }).some(p => p.includes('unknown compression')), 'PS5 unknown compression rejected')
}

// ============ NATIVE-AUTO-RUNNER. scripted run compresses into 8段 ============
{
  const { runSession } = await import('../lib/runner.mjs')
  const { createScriptedGateway } = await import('../lib/gateway-mock.mjs')
  const { loadTask } = await import('../lib/tasks.mjs')
  const dir = path.join(tmp, 'na')
  fs.mkdirSync(dir, { recursive: true })
  const ws = createWorkspace(dir)
  const t7 = loadTask('T7')
  const task = { ...t7, messages: t7.messages.map(m => m + ' ' + 'z'.repeat(3000)) }
  const NA = ['Primary Request and Intent', 'Key Technical Concepts', 'Files and Code', 'Errors and Fixes', 'Pending Jobs', 'Current Work', 'Next Step', 'Critical Context'].map(s => `## ${s}\n- x`).join('\n')
  const script = [
    { text: 'DONE s0', usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } },
    { text: NA, usage: { inputTokens: 900, outputTokens: 60, cacheReadTokens: 0 } },
    { text: 'DONE s1', usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } },
    { text: NA, usage: { inputTokens: 900, outputTokens: 60, cacheReadTokens: 0 } },
    { text: 'DONE s2', usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } },
  ]
  const g = createScriptedGateway({ script })
  const res = await runSession({ workspace: ws, taskId: 'T7', task, prompt: task.prompt, stagedMessages: task.messages, model: 'm', provider: 'x', transcriptPath: path.join(dir, 'tr.jsonl'), callLLM: g.chatCall, compression: 'native-auto', calibrated: { retainTokens: 50, thresholdTokens: 500, domain: 1000 }, maxCompressions: 2, maxSteps: 20, contextMode: 'obj-P' })
  const comp = res.transcript.filter(e => e.type === 'compress')
  ok(comp.length === 2 && res.compression.count === 2, 'NAR1 native-auto compresses at task-scale pressure', `${comp.length}/${res.compression.count}`)
  ok(res.compression.degenerate === false, 'NAR2 native-auto not degenerate (did compress)')
  ok(comp[0]?.mode === 'native-auto' && comp[0]?.range?.start >= 1, 'NAR3 compress event carries mode + range over the conversation surface (M0 严格原生: head-anchored incl. task)', JSON.stringify(comp[0] ?? {}))
  ok(!res.violations.some(v => v.includes('compression-failed')), 'NAR4 no compression-failed violation on success', JSON.stringify(res.violations))
}

// ============ MANUAL-HABIT-RUNNER. human trigger + focus directive ============
{
  const { runSession } = await import('../lib/runner.mjs')
  const { createScriptedGateway } = await import('../lib/gateway-mock.mjs')
  const { loadTask } = await import('../lib/tasks.mjs')
  const dir = path.join(tmp, 'mh')
  fs.mkdirSync(dir, { recursive: true })
  const ws = createWorkspace(dir)
  const t7 = loadTask('T7')
  const task = { ...t7, messages: t7.messages.map(m => m + ' ' + 'z'.repeat(4000)) }
  const NA = ['Primary Request and Intent', 'Key Technical Concepts', 'Files and Code', 'Errors and Fixes', 'Pending Jobs', 'Current Work', 'Next Step', 'Critical Context'].map(s => `## ${s}\n- x`).join('\n')
  const script = [
    { text: 'DONE s0', usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } },
    { text: NA, usage: { inputTokens: 900, outputTokens: 60, cacheReadTokens: 0 } },
    { text: 'DONE s1', usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } },
    { text: NA, usage: { inputTokens: 900, outputTokens: 60, cacheReadTokens: 0 } },
    { text: 'DONE s2', usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } },
  ]
  const g = createScriptedGateway({ script })
  const res = await runSession({ workspace: ws, taskId: 'T7', task, prompt: task.prompt, stagedMessages: task.messages, model: 'm', provider: 'x', transcriptPath: path.join(dir, 'tr.jsonl'), callLLM: g.chatCall, compression: 'manual-habit', calibrated: { retainTokens: 50, thresholdTokens: 1e9, domain: 1000 }, compressionDomain: 1000, maxCompressions: 2, maxSteps: 20, contextMode: 'obj-P', allowedPaths: [] })
  ok(res.compression.count === 2 && res.compression.degenerate === false, 'MHR1 manual-habit compresses on human triggers', `${res.compression.count}/${res.compression.degenerate}`)
  // compressor call's instruction carries the human focus directive.
  const isComp = r => { const msgs = r.req.messages; const l = msgs[msgs.length - 1]; return l && l.role === 'user' && String(l.content).includes('MANUAL-HABIT FOCUS') }
  const focusCalls = g.log.filter(isComp)
  ok(focusCalls.length === 2, 'MHR2 both compressor calls carry the focus directive', focusCalls.length)
}

// ============ ASSEMBLY. DSH-native checkpoint assembly invariants ============
// The native whole-surface control rebuilds the conversation with a SINGLE
// `<compacted-summary>` replacement node. The runner exposes `compressSnapshots`
// (exact pre/post message list per native compression); these assertions verify
// the assembly-code constraints on the REAL flow — never by model completion:
//   (a) cache-reuse — the actual compressor request (minus the appended
//       instruction) must be a GENUINE PREFIX of the pre-compression conversation
//       `before`, so the provider reuses the KV cache already built for the last
//       routed request (DSH-native `consumePrefix`). If the assembly drops a
//       message between `system` and the region (e.g. the task instruction at
//       index 1), the sequences diverge there → cache miss — a silent bug no
//       model can paper over.
//   (b) single-node rebuild — [start..end] collapses to exactly ONE checkpoint
//       node; head/tail stay byte-identical; that node carries the DSH preamble +
//       exactly one `<compacted-summary>` tag pair; the compacted region's
//       messages are gone (not duplicated alongside the checkpoint).
{
  const { runSession } = await import('../lib/runner.mjs')
  const { createScriptedGateway } = await import('../lib/gateway-mock.mjs')
  const { loadTask } = await import('../lib/tasks.mjs')
  const { CHECKPOINT_PREAMBLE } = await import('../lib/compress.mjs')
  const dir = path.join(tmp, 'as')
  fs.mkdirSync(dir, { recursive: true })
  const ws = createWorkspace(dir)
  const t7 = loadTask('T7')
  const task = { ...t7, messages: t7.messages.map(m => m + ' ' + 'z'.repeat(3000)) }
  // Distinct summaries for the two compressor answers: a genuinely-merged prior
  // checkpoint must DIFFER from the new one, so the no-duplication check verifies
  // region removal instead of coincidental text equality (identical mock text would
  // make the prior checkpoint look re-duplicated).
  const NA8a = ['Primary Request and Intent', 'Key Technical Concepts', 'Files and Code', 'Errors and Fixes', 'Pending Jobs', 'Current Work', 'Next Step', 'Critical Context'].map(s => `## ${s}\n- alpha`).join('\n')
  const NA8b = ['Primary Request and Intent', 'Key Technical Concepts', 'Files and Code', 'Errors and Fixes', 'Pending Jobs', 'Current Work', 'Next Step', 'Critical Context'].map(s => `## ${s}\n- beta v2`).join('\n')
  const g = createScriptedGateway({ script: [
    { text: 'DONE s0', usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } },
    { text: NA8a, usage: { inputTokens: 900, outputTokens: 60, cacheReadTokens: 0 } },
    { text: 'DONE s1', usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } },
    { text: NA8b, usage: { inputTokens: 900, outputTokens: 60, cacheReadTokens: 0 } },
    { text: 'DONE s2', usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } },
  ] })
  const res = await runSession({ workspace: ws, taskId: 'T7', task, prompt: task.prompt, stagedMessages: task.messages, model: 'm', provider: 'x', transcriptPath: path.join(dir, 'tr.jsonl'), callLLM: g.chatCall, compression: 'native-auto', calibrated: { retainTokens: 50, thresholdTokens: 500, domain: 1000 }, maxCompressions: 2, maxSteps: 20, contextMode: 'obj-P' })

  const isCompressor = rec => {
    const msgs = rec.req?.messages ?? []
    const last = msgs[msgs.length - 1]
    return last && last.role === 'user' && typeof last.content === 'string' && last.content.startsWith('You are now acting as a compaction engine')
  }
  const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const snaps = res.compressSnapshots ?? []
  ok(snaps.length >= 1 && snaps.length === res.compression.count, 'AS1 native compression snapshots captured (one per successful compression)', snaps.length)
  const compReq = g.log.filter(isCompressor).map(r => r.req.messages.slice(0, -1)) // minus appended instruction
  ok(compReq.length === snaps.length, 'AS2 compressor request count matches snapshot count', `${compReq.length}/${snaps.length}`)
  snaps.forEach((snap, k) => {
    const { start, end } = snap.range ?? {}
    const regionLen = end - start + 1
    const before = snap.before ?? []
    const after = snap.after ?? []
    const label = `#${k}`
    // (a) cache-reuse: the compressor request is a GENUINE PREFIX of `before`.
    const want = before.slice(0, end + 1)
    const got = compReq[k] ?? []
    let div = -1
    while (div + 1 < Math.min(got.length, want.length) && deepEq(got[div + 1], want[div + 1])) div++
    const isPrefix = div + 1 === got.length && got.length <= want.length
    ok(isPrefix, `AS3 (a)[${label}] compressor request is a genuine PREFIX of the pre-compression conversation (KV-cache reuse)`, `got=${got.length} want=${want.length} div=${div + 1}`)
    if (!isPrefix && want[div + 1]) console.log(`        divergence @${div + 1}: got role="${got[div + 1]?.role}" vs want role="${want[div + 1]?.role}"`)
    ok(got.length > 0 && deepEq(got[0], before[0]) && deepEq(got[got.length - 1], before[end]), `AS4 (a)[${label}] compressor prefix spans system to region-end (no truncated span)`)
    // (b) single-node replacement.
    ok(after.length === before.length - regionLen + 1, `AS5 (b)[${label}] region collapses to ONE checkpoint node`, `${before.length} - ${regionLen} + 1 = ${after.length}`)
    ok(deepEq(after.slice(0, start), before.slice(0, start)), `AS6 (b)[${label}] head before the region preserved byte-identical`)
    ok(deepEq(after.slice(start + 1), before.slice(end + 1)), `AS7 (b)[${label}] tail after the region preserved in order`)
    const node = after[start]
    const content = typeof node?.content === 'string' ? node.content : ''
    const open = (content.match(/<compacted-summary>/g) || []).length
    const close = (content.match(/<\/compacted-summary>/g) || []).length
    ok(node?.role === 'user' && content.startsWith(CHECKPOINT_PREAMBLE) && open === 1 && close === 1, `AS8 (b)[${label}] checkpoint = ONE framed <compacted-summary> user node (preamble + exactly one tag pair)`, `open=${open} close=${close}`)
    const dup = before.slice(start, end + 1).some(rm => after.some(pm => deepEq(pm, rm)))
    ok(!dup, `AS9 (b)[${label}] compacted region messages are not duplicated alongside the checkpoint`)
  })
}

// ============ ASSERT-FIRED. control that never compresses is degenerate ============
{
  const { runSession } = await import('../lib/runner.mjs')
  const { createScriptedGateway } = await import('../lib/gateway-mock.mjs')
  const { loadTask } = await import('../lib/tasks.mjs')
  const dir = path.join(tmp, 'deg')
  fs.mkdirSync(dir, { recursive: true })
  const g = createScriptedGateway({ script: [{ text: 'DONE', usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0 } }] })
  const res = await runSession({ workspace: createWorkspace(path.join(dir, 'ws')), taskId: 'T1', task: loadTask('T1'), prompt: loadTask('T1').prompt, model: 'm', provider: 'x', transcriptPath: path.join(dir, 'tr.jsonl'), callLLM: g.chatCall, compression: 'native-auto', calibrated: { retainTokens: 50, thresholdTokens: 1e9, domain: 1000 }, maxCompressions: 2, maxSteps: 5 })
  ok(res.compression.count === 0 && res.compression.degenerate === true, 'AF1 never-compressed control is degenerate', `${res.compression.count}/${res.compression.degenerate}`)
  ok(res.violations.some(v => v.includes('compression-degenerate:native-auto:never-compressed')), 'AF2 degenerate surfaced as violation')
}

// ============ COST-PER-SUCCESS. costPerSuccessfulTask ============
{
  const { costPerSuccessfulTask } = await import('../lib/score.mjs')
  const sc = { costs: { execution: { usd: 0.09, tokens: 9000 }, compression: { usd: 0.01, tokens: 1000 }, decision: null }, taskBreakdown: [{ total: 80, finished: true }, { total: 40, finished: true }, { total: 75, finished: true }] }
  const r = costPerSuccessfulTask(sc, { qualityGate: 60 })
  ok(r !== null && r.successful === 2 && r.perSuccessfulTaskUsd === 0.05, 'CS1 costPerSuccessfulTask divides total by successful count', JSON.stringify(r))
  ok(r.tasks === 3 && r.totalTokens === 10000, 'CS2 cost totals across ledger buckets', `${r.tasks}/${r.totalTokens}`)
  const none = costPerSuccessfulTask({ costs: { execution: { usd: 0.1, tokens: 1000 } }, taskBreakdown: [{ total: 30, finished: true }] }, { qualityGate: 60 })
  ok(none === null, 'CS3 no task clears the gate → null (unqualified, not compared on cost)')
}

export { failures }

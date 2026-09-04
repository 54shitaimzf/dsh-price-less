/**
 * Assertions — compression-domain experiment support (CAL / DOMAIN / PREMARK /
 * BOUNDARIES / MARK-COST / RUNNER / ARMS / COMPAT). Run via lib/assert.mjs.
 * All offline: pure functions + scripted gateway + fixture; NO real model calls.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT, FIXTURE_DIR, createWorkspace } from '../lib/workspace.mjs'
import { TEMPLATE_S2 } from '../lib/sdk.mjs'

const tmp = path.join(EVAL_ROOT, '.assert-tmp')
let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!cond) failures++
}

// ============ CAL. compression-domain calibration ============
{
  const { calibrate, domainTokens, retainTokens, thresholdTokens, COMPRESSION_DOMAIN_DEFAULT, RETAIN_RATIO, THRESHOLD_RATIO } = await import('../lib/calibrate.mjs')
  const c = calibrate(50000)
  ok(c.domain === 50000 && c.retainTokens === Math.floor(50000 * RETAIN_RATIO) && c.thresholdTokens === Math.floor(50000 * THRESHOLD_RATIO), 'CAL1 calibrate(50000) task-scale domain', JSON.stringify(c))
  ok(c.retainTokens < c.thresholdTokens, 'CAL2 retain < threshold invariant', `${c.retainTokens} < ${c.thresholdTokens}`)
  ok(c.retainTokens === 8000 && c.thresholdTokens === 40000, 'CAL3 default ratios → 8000/40000', `${c.retainTokens}/${c.thresholdTokens}`)
  ok(domainTokens(null) === COMPRESSION_DOMAIN_DEFAULT && domainTokens(0) === COMPRESSION_DOMAIN_DEFAULT && domainTokens(-5) === COMPRESSION_DOMAIN_DEFAULT, 'CAL4 absent/invalid peak → default', domainTokens(null))
  ok(domainTokens(40000) === 40000 && retainTokens(domainTokens(40000)) === 6400, 'CAL5 domainTokens/retainTokens math', `${domainTokens(40000)}/${retainTokens(40000)}`)
  ok(thresholdTokens(40000) === 32000, 'CAL6 thresholdTokens math', thresholdTokens(40000))
  // invariant retain < threshold must hold across all valid domains (ratios 0.16 < 0.8)
  let invOk = true
  for (const dom of [100, 1000, 50000, 128000]) if (calibrate(dom).retainTokens >= calibrate(dom).thresholdTokens) invOk = false
  ok(invOk, 'CAL7 retain < threshold invariant holds across all domains')
  ok(calibrate(128000).thresholdTokens > calibrate(128000).retainTokens, 'CAL7b large domain still ordered', `${calibrate(128000).retainTokens}/${calibrate(128000).thresholdTokens}`)
}

// ============ DOMAIN. arm-spec config wiring ============
{
  const { compressionDomain, calibrateThresholds } = await import('../lib/arm-spec.mjs')
  const fs = await import('node:fs')
  const path = await import('node:path')
  ok(typeof compressionDomain === 'function' && Number.isFinite(compressionDomain()) && compressionDomain() > 0, 'DOMAIN1 compressionDomain() from config', compressionDomain())
  const ct = calibrateThresholds()
  ok(ct.retainTokens < ct.thresholdTokens && ct.domain > 0, 'DOMAIN2 calibrateThresholds() sane', JSON.stringify(ct))
  // F10 amend: absolute retainTokens/thresholdTokens in arms.config.json WIN over
  // the ratio derivation — retention size is an absolute real-token design choice
  // (DSH 本体 8K 量级), not a ratio of an arbitrarily chosen domain.
  const cfg = JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, 'arms.config.json'), 'utf8'))
  ok(cfg.retainTokens === 10000 && cfg.thresholdTokens === 100000, 'DOMAIN3 absolute retain/threshold declared in config', `${cfg.retainTokens}/${cfg.thresholdTokens}`)
  ok(ct.retainTokens === 10000 && ct.thresholdTokens === 100000, 'DOMAIN4 calibrateThresholds() consumes the absolutes (not 0.16×domain)', JSON.stringify(ct))
}

// ============ PREMARK. preprocessing: per-message discriminator cuts boundaries ============
{
  const { markBoundaries } = await import('../lib/boundary-mark.mjs')
  const { createScriptedGateway } = await import('../lib/gateway-mock.mjs')

  // offline: 3 messages, both u>=1 judged 'continue' → 1 segment (same task).
  const g = createScriptedGateway({ script: [
    { text: JSON.stringify({ decision: 'continue' }), usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } },
    { text: JSON.stringify({ decision: 'continue' }), usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } },
  ]})
  const mark = await markBoundaries({ taskId: 'T7', userMessages: ['a', 'b', 'c'], callLLM: g.chatCall, model: 'deepseek-v4-flash-vision-exp', provider: 'deepseek' })
  ok(mark.taskId === 'T7' && mark.source === 'premark', 'PREMARK1 markBoundaries tags source premark')
  ok(Array.isArray(mark.boundaries) && mark.boundaries.length === 1, 'PREMARK2 continue/continue → 1 segment (same task)', mark.boundaries.length)
  ok(mark.verdicts.length === 3 && mark.verdicts[0].trigger === 'implicit-open', 'PREMARK2b u=0 is open, not judged', mark.verdicts.length)
  ok(mark.cost && mark.cost.usage.calls === 2 && mark.cost.usd !== null, 'PREMARK3 2 real judgements + USD attributed', JSON.stringify({ calls: mark.cost.usage.calls, usd: mark.cost.usd }))

  // new_task on the 2nd message cuts a 2nd segment.
  const g2 = createScriptedGateway({ script: [
    { text: JSON.stringify({ decision: 'continue' }), usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } },
    { text: JSON.stringify({ decision: 'new_task' }), usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } },
  ]})
  const mark2 = await markBoundaries({ taskId: 'T7', userMessages: ['a', 'b', 'c'], callLLM: g2.chatCall })
  ok(mark2.boundaries.length === 2, 'PREMARK2c new_task on msg1 cuts segment 1..', mark2.boundaries.length)

  // single message → single segment, zero judgement
  const m1 = await markBoundaries({ taskId: 'T1', userMessages: ['solo'] })
  ok(m1.boundaries.length === 1, 'PREMARK4 single user message → 1 segment', m1.boundaries.length)
  ok(m1.cost.judgements === 0 && m1.cost.usage.calls === 0, 'PREMARK4b single message → 0 judgements', JSON.stringify(m1.cost.judgements))
}

// ============ BOUNDARIES. mark read + locate (pure functions) ============
{
  const { loadBoundaries, findBoundaryAt, boundaryMarkPath, writeBoundaries } = await import('../lib/boundaries.mjs')
  const mark = { taskId: 'T7', source: 'premark', cost: { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }, usd: 0.001, model: 'm', provider: 'p' }, boundaries: [{ segmentIndex: 0, startSeq: 0, endSeq: 1 }, { segmentIndex: 1, startSeq: 2, endSeq: 2 }] }
  const file = boundaryMarkPath('T7')
  const existed = fs.existsSync(file)
  const backup = existed ? fs.readFileSync(file, 'utf8') : null
  try {
    writeBoundaries('T7', mark) // creates boundaries/ dir on demand
    const loaded = loadBoundaries('T7')
    ok(loaded && loaded.taskId === 'T7' && Array.isArray(loaded.boundaries), 'BOUNDARIES1 loadBoundaries reads mark', loaded?.boundaries?.length)
    const at = findBoundaryAt(loaded, 2)
    ok(at && at.segmentIndex === 1, 'BOUNDARIES2 findBoundaryAt locates segment by seq', JSON.stringify(at))
    ok(findBoundaryAt(loaded, 99) === null, 'BOUNDARIES3 out-of-range seq → null')
  } finally {
    if (existed) fs.writeFileSync(file, backup)
    else if (fs.existsSync(file)) fs.rmSync(file)
  }
  ok(loadBoundaries('T1') === null, 'BOUNDARIES4 no mark for T1 → null (fallback)')
}

// ============ MARK-COST. decision cost from premark (real, not estimate) ============
{
  const { markBoundaries } = await import('../lib/boundary-mark.mjs')
  const { createScriptedGateway } = await import('../lib/gateway-mock.mjs')
  const g = createScriptedGateway({ script: [
    { text: JSON.stringify({ decision: 'new_task' }), usage: { inputTokens: 250, outputTokens: 12, cacheReadTokens: 0 } },
  ]})
  const mark = await markBoundaries({ taskId: 'T7', userMessages: ['a', 'b'], callLLM: g.chatCall, model: 'deepseek-v4-flash-vision-exp', provider: 'deepseek' })
  ok(mark.cost && mark.cost.usage.inputTokens === 250 && mark.cost.model === 'deepseek-v4-flash-vision-exp', 'MARK-COST1 cost carries usage + model')
  ok(mark.cost.usd !== null && mark.cost.usd > 0, 'MARK-COST2 real USD (non-zero, non-estimate)', mark.cost.usd)

  // no callLLM fallback: usage=0 cost, still source premark (fail-lazy continue)
  const m0 = await markBoundaries({ taskId: 'T1', userMessages: ['x'] })
  ok(m0.cost.usage.inputTokens === 0 && m0.source === 'premark', 'MARK-COST3 no-call fallback records zero-cost premark')
}

// ============ RUNNER. consume marks at segment boundaries (scripted, offline) ============
{
  const { runSession } = await import('../lib/runner.mjs')
  const { createScriptedGateway } = await import('../lib/gateway-mock.mjs')
  const { boundaryMarkPath, writeBoundaries } = await import('../lib/boundaries.mjs')
  const { loadTask } = await import('../lib/tasks.mjs')

  const dir = path.join(tmp, 'tb-run')
  fs.mkdirSync(dir, { recursive: true })
  const ws = createWorkspace(dir)

  // Synthesis: a 3-segment boundary mark (seg0 = seq0, seg1 = seq1, seg2 = seq2 —
  // every staged message is its own segment). The runner compresses when ABOUT TO
  // inject a message that is a NEW segment head (startSeq > 0), i.e. 2 times here.
  const markFile = boundaryMarkPath('T7')
  const existed = fs.existsSync(markFile)
  const backup = existed ? fs.readFileSync(markFile, 'utf8') : null
  try {
    writeBoundaries('T7', {
      source: 'premark',
      cost: { usage: { inputTokens: 800, outputTokens: 60, cacheReadTokens: 0 }, usd: 0.006, model: 'm', provider: 'p' },
      boundaries: [
        { segmentIndex: 0, taskId: 'task-0', startSeq: 0, endSeq: 0, status: 'closed' },
        { segmentIndex: 1, taskId: 'task-1', startSeq: 1, endSeq: 1, status: 'closed' },
        { segmentIndex: 2, taskId: 'task-2', startSeq: 2, endSeq: 2, status: 'active' },
      ],
    })
    const t7t = loadTask('T7')
    const scripted = createScriptedGateway({
      script: [
        { text: 'DONE first', usage: { inputTokens: 2000, outputTokens: 40, cacheReadTokens: 0 } },                // exec msg0 → DONE (nextSeq=1 is seg1 head → compress)
        { text: TEMPLATE_S2, usage: { inputTokens: 900, outputTokens: 300, cacheReadTokens: 0 } }, // compressor #1 (REAL PTC program)
        { text: 'DONE second', usage: { inputTokens: 2000, outputTokens: 40, cacheReadTokens: 0 } },               // exec msg1 → DONE (nextSeq=2 is seg2 head → compress)
        { text: TEMPLATE_S2, usage: { inputTokens: 900, outputTokens: 300, cacheReadTokens: 0 } }, // compressor #2
        { text: 'DONE third', usage: { inputTokens: 2000, outputTokens: 40, cacheReadTokens: 0 } },                // exec msg2 → DONE (no next stage) → finished
      ],
    })
    const res = await runSession({
      workspace: ws, taskId: 'T7', task: t7t, prompt: t7t.prompt, stagedMessages: t7t.messages,
      model: 'm', provider: 'x', transcriptPath: path.join(dir, 'transcript.jsonl'),
      callLLM: scripted.chatCall, compression: 'task-boundary', maxSteps: 20,
    })
    const taskCompacts = res.transcript.filter(e => e.type === 'task-compact')
    const decisions = res.transcript.filter(e => e.type === 'decision')
    ok(taskCompacts.length === 2, 'RUNNER1 task-boundary compresses at 2 segment heads', taskCompacts.length)
    ok(taskCompacts.every(e => typeof e.segmentIndex === 'number' && typeof e.pressuredTokens === 'number'), 'RUNNER2 task-compact carries segmentIndex + tokens', JSON.stringify(taskCompacts[0] ?? {}))
    ok(decisions.some(e => e.reason === 'task-boundary'), 'RUNNER3 decision entry records task-boundary reason', decisions.length)
    ok(res.compression?.mode === 'task-boundary' && res.compression.count === 2, 'RUNNER4 runner compression mode + count = 2', JSON.stringify(res.compression))
  } finally {
    if (existed) fs.writeFileSync(markFile, backup)
    else if (fs.existsSync(markFile)) fs.rmSync(markFile)
  }

  // single-segment no-mark fallback: T1 (no staged, no mark) → no crash, no task-compact
  const t1 = loadTask('T1')
  const scripted = createScriptedGateway({ script: [{ text: 'DONE t1', usage: { inputTokens: 1500, outputTokens: 30, cacheReadTokens: 0 } }] })
  const res1 = await runSession({
    workspace: ws, taskId: 'T1', task: t1, prompt: t1.prompt,
    model: 'm', provider: 'x', transcriptPath: path.join(dir, 'transcript-t1.jsonl'),
    callLLM: scripted.chatCall, compression: 'task-boundary', maxSteps: 5,
  })
  ok(res1.finished === true, 'RUNNER5 no-mark single-segment run finishes (no crash)')
  ok(res1.transcript.every(e => e.type !== 'task-compact'), 'RUNNER6 no mark → no task-compact')
}

// ============ ARMS. final arm table: 2 controls + 4 grid arms ============
{
  const { getArm, listArms } = await import('../lib/arm-spec.mjs')
  const { validateArmRow } = await import('../lib/config.mjs')
  const s2o = getArm('self-s2-orig')
  ok(s2o.compression === 'task-boundary' && s2o.ledger?.decision === true, 'ARMS1 self-s2-orig declared with task-boundary + decision ledger')
  ok(validateArmRow({ id: 'self-s2-orig', ...s2o }).length === 0, 'ARMS2 self-s2-orig row validates', validateArmRow({ id: 'self-s2-orig', ...s2o }).join(';'))
  ok(listArms().includes('self-s2-orig') && listArms().includes('native-auto') && listArms().includes('manual-habit'), 'ARMS3 arm table contains the grid arms + the two controls native-auto/manual-habit')
  ok(!listArms().includes('full') && !listArms().includes('self') && !listArms().includes('self-compact') && !listArms().includes('plain'), 'ARMS4 full/self/self-compact/plain removed (no loose compression baseline; self-compact merged into self-s2-orig)')
}

// ============ COMPAT. legacy arms byte/schema unchanged ============
{
  const { compressOnce } = await import('../lib/compress.mjs')
  const { assembleInit } = await import('../lib/assemble.mjs')
  const { loadTask } = await import('../lib/tasks.mjs')
  const t3 = loadTask('T3')
  const mockP = { goal: 'g', steps: ['s1'], fileStream: ['f1'], compressed: 'c' }
  const sys = 'S'
  const ufull = assembleInit({ mode: 'plain', systemPrompt: sys, task: t3, prompt: 'T' }).messages[1].content
  const uobj = assembleInit({ mode: 'obj-P', systemPrompt: sys, task: t3, prompt: 'T', product: mockP }).messages[1].content
  ok(typeof ufull === 'string' && typeof uobj === 'string' && ufull !== uobj, 'COMPAT1 legacy plain/obj-P assemblies still byte-distinct')
  const mk = compressOnce({ task: { id: 'T3' }, mode: 'mock', mockProduct: mockP })
  ok((await mk).ok === true, 'COMPAT2 mock compressOnce still validates')
}

// ============ CASCADE. whole-stream (T0..T7) boundary marking ============
{
  const { humanTaskStream, markCascadeBoundaries, splitTranscriptByTask } = await import('../lib/cascade.mjs')
  const { listTasks } = await import('../lib/tasks.mjs')
  const { createScriptedGateway } = await import('../lib/gateway-mock.mjs')
  const tasks = listTasks()

  // humanTaskStream flattens T0..T7 into ONE ordered stream.
  const stream = humanTaskStream(tasks)
  ok(stream.length === 10, 'CAS1 whole-stream flatten length = sum of task messages', stream.length)
  ok(stream[0].taskId === 'T0' && stream[0].seq === 0, 'CAS2 stream starts at T0/seq0')
  ok(stream[7].taskId === 'T7' && stream[8].taskId === 'T7' && stream[9].taskId === 'T7', "CAS3 T7's 3 staged messages occupy slots 7..9", JSON.stringify(stream.slice(7).map(s => s.taskId)))
  ok(stream.every(s => typeof s.text === 'string' && s.text.length > 0), 'CAS4 every stream slot carries text')

  // markCascadeBoundaries: scripted verdicts → 6 segments, spans attributed.
  const verdicts = ['continue', 'new_task', 'new_task', 'continue', 'new_task', 'new_task', 'new_task', 'continue', 'continue']
  const script = verdicts.map((v, i) => ({ text: JSON.stringify({ decision: v }), usage: { inputTokens: 400 + i * 10, outputTokens: 20, cacheReadTokens: 0 } }))
  const g = createScriptedGateway({ script })
  const mark = await markCascadeBoundaries({ tasks, callLLM: g.chatCall })
  ok(mark.taskId === 'CASCADE' && mark.source === 'premark', 'CAS5 markCascadeBoundaries tags CASCADE + premark')
  ok(mark.boundaries.length === 6, 'CAS6 6 segments from scripted verdicts', mark.boundaries.length)
  ok(mark.boundaries[0].taskOrigin.join(',') === 'T0,T1', 'CAS7 seg0 spans T0,T1', mark.boundaries[0].taskOrigin.join(','))
  ok(mark.boundaries[1].taskOrigin.join(',') === 'T2', 'CAS8 seg1 spans T2 (task switch opens segment)', mark.boundaries[1].taskOrigin.join(','))
  ok(mark.boundaries[5].taskOrigin.join(',') === 'T7,T7,T7', 'CAS9 seg5 spans T7 x3', mark.boundaries[5].taskOrigin.join(','))
  ok(mark.cost.judgements === 9, 'CAS10 9 judgements (10 msgs − 1 head)', mark.cost.judgements)
  ok(mark.cost.usd !== null && mark.cost.usd > 0, 'CAS11 real decision USD attributed', mark.cost.usd)
  ok(mark.cost.usage.calls === 9, 'CAS12 decision usage.calls = 9')

  // single-task boundary markers still work (regression: boundary-mark unchanged).
  const { markBoundaries, userMessagesOf } = await import('../lib/boundary-mark.mjs')
  const t7 = tasks.find(t => t.id === 'T7')
  const g1 = createScriptedGateway({ script: [
    { text: JSON.stringify({ decision: 'continue' }), usage: { inputTokens: 500, outputTokens: 10, cacheReadTokens: 0 } },
    { text: JSON.stringify({ decision: 'continue' }), usage: { inputTokens: 500, outputTokens: 10, cacheReadTokens: 0 } },
  ]})
  const single = await markBoundaries({ taskId: 'T7', userMessages: userMessagesOf(t7), callLLM: g1.chatCall })
  ok(single.boundaries.length === 1, 'CAS13 single-task T7 → 1 segment (no cross-task switch)', single.boundaries.length)

  // splitTranscriptByTask: whole-stream transcript slices back into per-task windows.
  const fakeTranscript = [
    { type: 'stage', index: 0, message: 'T0' },
    { type: 'assistant', content: 'T0 work' },
    { type: 'stage', index: 1, message: 'T1' },
    { type: 'assistant', content: 'T1 work' },
    { type: 'stage', index: 7, message: 'T7' },
    { type: 'assistant', content: 'T7 work' },
  ]
  const sliced = splitTranscriptByTask(fakeTranscript, stream)
  ok(sliced.T0.some(e => e.content === 'T0 work'), 'CAS14 splitTranscriptByTask assigns T0 work to T0')
  ok(sliced.T1.some(e => e.content === 'T1 work'), 'CAS15 assigns T1 work to T1')
  ok(sliced.T7.some(e => e.content === 'T7 work'), 'CAS16 assigns T7 work to T7')
}

// ============ CASCADE-RUN. runCascade whole-stream (scripted, offline) ============
{
  const { runCascade } = await import('../lib/run-cascade.mjs')
  const { createScriptedGateway } = await import('../lib/gateway-mock.mjs')
  const { loadTask, listTasks } = await import('../lib/tasks.mjs')
  const { RUNS_DIR } = await import('../lib/paths.mjs')
  const tasks = listTasks()

  // case A: native-auto control — small scripted stream never reaches the
  // task-scale threshold → 0 compressions, and (not task-boundary) → decision null.
  const done = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7a', 'T7b', 'T7c']
  const scriptFull = done.map((m, i) => ({ text: `DONE ${m}`, usage: { inputTokens: 1500 + i * 5, outputTokens: 30, cacheReadTokens: 0 } }))
  const gFull = createScriptedGateway({ script: scriptFull })
  const a = await runCascade({ tasks, arm: 'native-auto', callLLM: gFull.chatCall, model: 'm', provider: 'x' })
  ok(a.runner.finished === true, 'CASCADE-RUN1 native-auto cascade finishes')
  ok(a.scorecard.costs.decision === null, 'CASCADE-RUN2 native-auto → decision null (no discriminator)')
  ok(a.scorecard.compression.count === 0, 'CASCADE-RUN3 native-auto → 0 compressions (tiny stream under the calibrated threshold)')
  ok(a.scorecard.task === 'CASCADE' && a.scorecard.arm === 'native-auto', 'CASCADE-RUN4 scorecard tagged CASCADE/native-auto')

  // case B: self-s2-orig with injected boundary mark → 2 compressions at seg heads.
  const boundaryMark = {
    taskId: 'CASCADE', source: 'premark',
    cost: { usage: { inputTokens: 120, outputTokens: 0, cacheReadTokens: 0, calls: 9 }, usd: 0.00123456, model: 'deepseek-v4-flash-vision-exp', provider: 'deepseek' },
    boundaries: [
      { segmentIndex: 0, taskId: 'task-0', startSeq: 0, endSeq: 2, status: 'closed' },
      { segmentIndex: 1, taskId: 'task-3', startSeq: 3, endSeq: 6, status: 'closed' },
      { segmentIndex: 2, taskId: 'task-7', startSeq: 7, endSeq: 9, status: 'active' },
    ],
  }
  const scriptSelf = []
  for (let i = 0; i < 10; i++) {
    scriptSelf.push({ text: `DONE m${i}`, usage: { inputTokens: 1500 + i * 5, outputTokens: 30, cacheReadTokens: 0 } })
    if (i === 2 || i === 6) scriptSelf.push({ text: TEMPLATE_S2, usage: { inputTokens: 900, outputTokens: 300, cacheReadTokens: 0 } })
  }
  const gSelf = createScriptedGateway({ script: scriptSelf })
  const b = await runCascade({ tasks, arm: 'self-s2-orig', callLLM: gSelf.chatCall, boundaryMark, model: 'm', provider: 'x' })
  const taskCompacts = b.runner.transcript.filter(e => e.type === 'task-compact')
  ok(taskCompacts.length === 2, 'CASCADE-RUN5 self-s2-orig compresses at 2 seg heads', taskCompacts.length)
  ok(b.scorecard.costs.decision && b.scorecard.costs.decision.real === true && b.scorecard.costs.decision.usd === 0.00123456, 'CASCADE-RUN6 decision = real premark cost', JSON.stringify(b.scorecard.costs.decision))
  ok(b.scorecard.costs.compression && b.scorecard.costs.compression.source === 'real', 'CASCADE-RUN7 compression cost real', JSON.stringify(b.scorecard.costs.compression))
  ok(b.scorecard.compression.count === 2, 'CASCADE-RUN8 compression.count = 2', b.scorecard.compression.count)

  // cleanup: ONLY this test's own run dir + the CASCADE boundary mark written
  // by runCascade. NEVER a prefix sweep of runs/ (it would delete REAL cascade
  // experiment runs — a live pilot run was destroyed by the old sweep once).
  const { boundaryMarkPath } = await import('../lib/boundaries.mjs')
  const markFile = boundaryMarkPath('CASCADE')
  if (fs.existsSync(markFile)) fs.rmSync(markFile)
  if (b?.runDir) fs.rmSync(b.runDir, { recursive: true, force: true })
}

// ============ CASCADE-JUDGE. semantic fix A (cascade judge ledger) + fix B
// (task-compact real-slot attribution) — one offline run exercising both ============
{
  const { runCascade } = await import('../lib/run-cascade.mjs')
  const { createScriptedGateway } = await import('../lib/gateway-mock.mjs')
  const { loadTask } = await import('../lib/tasks.mjs')
  const { splitTranscriptByTask, humanTaskStream } = await import('../lib/cascade.mjs')
  const { RUNS_DIR } = await import('../lib/paths.mjs')
  const { boundaryMarkPath } = await import('../lib/boundaries.mjs')
  const { costUsd } = await import('../lib/gateway.mjs')
  const { priceOf } = await import('../lib/cost-ledger.mjs')
  const tasks = [loadTask('T1'), loadTask('T2')] // both carry real rubrics (T0 has dims:[] by design → judge skips, no usage)

  // Segment 0 = slot 0 (T1), segment 1 = slot 1 (T2): one compaction at the
  // head of segment 1 (startSeq=1) — i.e. AFTER slot 0 closes. The slices then
  // prove WHICH task the compaction work is attributed to (fix B).
  // Judge answers use a generic dims-less JSON (all dims default 0 → no
  // calibration retry) so each task costs exactly ONE deterministic judge call;
  // the two later answers serve the per-task SUBJECTIVE audits (their usage
  // must NOT leak into the judge ledger).
  const boundaryMark = {
    taskId: 'CASCADE', source: 'premark',
    cost: { usage: { inputTokens: 12, outputTokens: 0, cacheReadTokens: 3, calls: 1 }, usd: 0.00000042, model: 'deepseek-v4-flash-vision-exp', provider: 'deepseek' },
    boundaries: [
      { segmentIndex: 0, taskId: 'g0', startSeq: 0, endSeq: 0, status: 'closed' },
      { segmentIndex: 1, taskId: 'g1', startSeq: 1, endSeq: 1, status: 'active' },
    ],
  }
  const JUDGE_JSON = '{"dims":{},"antiCheat":{"verdict":"none","evidence":""},"notes":"ok"}'
  const SUBJ_JSON = '{"overallQuality":3,"wouldShip":1,"overReport":0,"realExtras":0,"goldenCoverage":"partial","evidence":"ok","narrative":"ok"}'
  // judge protocol v2 (scores.config judge.samples=3): each task's judge makes
  // 3 SAMPLE calls (identical JSON → median trivially that value) before the
  // subjective audit — the fixture mirrors the production default path.
  const JU = (i, o) => ({ text: JUDGE_JSON, usage: { inputTokens: i, outputTokens: o, cacheReadTokens: 0 } })
  const script = [
    { text: 'DONE T1', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 } },
    { text: TEMPLATE_S2, usage: { inputTokens: 900, outputTokens: 300, cacheReadTokens: 0 } },
    { text: 'DONE T2', usage: { inputTokens: 110, outputTokens: 10, cacheReadTokens: 0 } },
    JU(200, 40), JU(200, 40), JU(200, 40),                                    // judge T1 ×3 samples
    { text: SUBJ_JSON, usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0 } },      // subjective T1
    JU(220, 44), JU(220, 44), JU(220, 44),                                    // judge T2 ×3 samples
    { text: SUBJ_JSON, usage: { inputTokens: 14, outputTokens: 4, cacheReadTokens: 0 } },      // subjective T2
  ]
  const g = createScriptedGateway({ script })
  const b = await runCascade({ tasks, arm: 'self-s2-orig', callLLM: g.chatCall, boundaryMark, model: 'm', provider: 'x' })
  const transcript = b.runner.transcript ?? []
  const taskCompacts = transcript.filter(e => e.type === 'task-compact')

  ok(taskCompacts.length === 1, 'CJ1 one compaction at the segment head', taskCompacts.length)
  ok(taskCompacts[0]?.segmentIndex === 1 && taskCompacts[0]?.slot === 0, 'CJ2 ordinal=1 + real slot=0 (ordinal ≠ message position)', JSON.stringify(taskCompacts[0]))

  // fix B: the compaction work must land in the CLOSED segment's window (T1),
  // never the next segment's (T2) — the OLD code used segmentIndex as the slot.
  const sliced = splitTranscriptByTask(transcript, humanTaskStream(tasks))
  ok(sliced.T1.some(e => e.type === 'task-compact') && sliced.T1.some(e => e.type === 'compress' && e.mode === 'task-boundary'), 'CJ3 compaction + compress events attributed to the closed segment (T1)')
  ok(!sliced.T2.some(e => e.type === 'task-compact'), 'CJ4 no compaction leakage into the next segment (T2)')

  // fix A: the cascade judge ledger accumulates the REAL per-task judge usage
  // (the OLD cascade block hard-coded judge = null); the subjective usage must
  // NOT leak in (it is outside the judge ledger in both run-one and cascade).
  const j = b.scorecard.costs.judge
  ok(j !== null, 'CJ5 cascade judge ledger non-null (was null)', JSON.stringify(j))
  ok(j.tokens === ((200 + 40) + (220 + 44)) * 3, 'CJ6 judge tokens = sum of per-task judge SAMPLES (subjective excluded)', JSON.stringify(j))
  const cfg = JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, 'scores.config.json'), 'utf8'))
  const expUsd = costUsd({ inputTokens: (200 + 220) * 3, outputTokens: (40 + 44) * 3, cacheReadTokens: 0 }, priceOf(cfg.judge.model, cfg.judge.provider))
  ok(j.usd !== null && Math.abs(j.usd - Number(expUsd.toFixed(8))) < 1e-12, 'CJ7 judge USD = production formula on the aggregated usage', JSON.stringify(j))
  // CJ8 regression guard for the 2026-09 pilot bug: the cascade scoring loop
  // MUST pass the RESOLVED judge model (config default) — not an undefined
  // opts.judgeModel (the real gateway then 401s "Model  is not supported";
  // offline mocks never validate the model name, so this needs an explicit
  // probe of the injected gateway's request log).
  const cfgJ = JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, 'scores.config.json'), 'utf8'))
  const judgeCalls = g.log.filter(r => { const first = r.req?.messages?.[0]?.content ?? ''; return typeof first === 'string' && first.includes('blind evaluator') })
  ok(judgeCalls.length === 6 && judgeCalls.every(r => r.req.model === cfgJ.judge.model),
    'CJ8 judge calls carry the RESOLVED config model (not undefined)', `${judgeCalls.map(r => String(r.req.model)).join(',')}`)

  // cleanup: ONLY this test's own run dir + the CASCADE boundary mark (see the
  // sweep warning above — never delete other CASCADE-* runs).
  const markFile = boundaryMarkPath('CASCADE')
  if (fs.existsSync(markFile)) fs.rmSync(markFile)
  if (b?.runDir) fs.rmSync(b.runDir, { recursive: true, force: true })
}

// ============ CASCADE-SCORE. per-task scoring wires (offline, no cross-task leak) ============
{
  const { taskFinalText } = await import('../lib/run-one.mjs')
  const { splitTranscriptByTask, humanTaskStream } = await import('../lib/cascade.mjs')
  const { listTasks } = await import('../lib/tasks.mjs')
  const tasks = listTasks()
  const stream = humanTaskStream(tasks)

  // taskFinalText: returns this task's own final DONE.
  ok(taskFinalText([{ type: 'assistant', content: 'DONE found 8 issues' }], 'T0') === 'DONE found 8 issues', 'CSCORE1 taskFinalText returns own DONE')
  ok(taskFinalText([{ type: 'assistant', content: 'partial' }], 'T1') === 'partial', 'CSCORE2 taskFinalText falls back to last assistant')
  ok(taskFinalText([], 'T2') === '', 'CSCORE3 taskFinalText empty window → empty string')
  ok(taskFinalText([{ type: 'assistant', content: 'DONE T1' }, { type: 'assistant', content: 'DONE T0' }], 'T0') === 'DONE T0', 'CSCORE4 no cross-task leak (last DONE wins within window)')

  // splitTranscriptByTask slices the whole-stream transcript so each task only
  // sees its own events — a later task's DONE is never in an earlier task's window.
  const smallStream = humanTaskStream([tasks.find(t => t.id === 'T0'), tasks.find(t => t.id === 'T1'), tasks.find(t => t.id === 'T2')])
  const miniTranscript = [
    { type: 'stage', index: 0, message: 'T0' },
    { type: 'assistant', content: 'DONE T0' },
    { type: 'stage', index: 1, message: 'T1' },
    { type: 'assistant', content: 'DONE T1' },
    { type: 'stage', index: 2, message: 'T2' },
    { type: 'assistant', content: 'DONE T2' },
  ]
  const sliced = splitTranscriptByTask(miniTranscript, smallStream)
  ok(taskFinalText(sliced.T0, 'T0') === 'DONE T0', 'CSCORE5 T0 window has only T0 final')
  ok(taskFinalText(sliced.T1, 'T1') === 'DONE T1', 'CSCORE6 T1 window has only T1 final')
  ok(!sliced.T0.some(e => (e.content ?? '').includes('T1 work')), 'CSCORE7 T0 window excludes T1 work')
}

// ============ CASCADE-COMPACT. fixes: per-boundary (no cap) + un-compressed-only context + accumulated segment block ============
{
  const { runCascade } = await import('../lib/run-cascade.mjs')
  const { createScriptedGateway } = await import('../lib/gateway-mock.mjs')
  const { listTasks } = await import('../lib/tasks.mjs')
  const { humanTaskStream } = await import('../lib/cascade.mjs')
  const { RUNS_DIR } = await import('../lib/paths.mjs')
  const { boundaryMarkPath } = await import('../lib/boundaries.mjs')
  const tasks = listTasks()
  const stream = humanTaskStream(tasks) // 10 slots

  // 5 segments (4 boundaries) over the 10-slot stream. The runner must compress
  // at EVERY boundary (the old maxCompressions=2 cap is REMOVED for task-boundary),
  // feed the compressor ONLY the un-compressed new work, and ACCUMULATE segments.
  const boundaryMark = {
    taskId: 'CASCADE', source: 'premark',
    cost: { usage: { inputTokens: 40, outputTokens: 0, cacheReadTokens: 0, calls: 9 }, usd: 0.0004, model: 'deepseek-v4-flash-vision-exp', provider: 'deepseek' },
    boundaries: [
      { segmentIndex: 0, taskId: 'g0', startSeq: 0, endSeq: 1, status: 'closed' },
      { segmentIndex: 1, taskId: 'g1', startSeq: 2, endSeq: 3, status: 'closed' },
      { segmentIndex: 2, taskId: 'g2', startSeq: 4, endSeq: 5, status: 'closed' },
      { segmentIndex: 3, taskId: 'g3', startSeq: 6, endSeq: 7, status: 'closed' },
      { segmentIndex: 4, taskId: 'g4', startSeq: 8, endSeq: 9, status: 'active' },
    ],
  }
  const script = []
  for (let i = 0; i < 10; i++) {
    script.push({ text: `DONE m${i}`, usage: { inputTokens: 1500 + i * 5, outputTokens: 30, cacheReadTokens: 0 } })
    if (i === 1 || i === 3 || i === 5 || i === 7) script.push({ text: TEMPLATE_S2, usage: { inputTokens: 900, outputTokens: 300, cacheReadTokens: 0 } })
  }
  const g = createScriptedGateway({ script })
  const b = await runCascade({ tasks, arm: 'self-s2-orig', callLLM: g.chatCall, boundaryMark, model: 'm', provider: 'x', skipScore: true })
  const taskCompacts = b.runner.transcript.filter(e => e.type === 'task-compact')
  // The compressor input is the TRUE PREFIX (system + frozen section nodes +
  // new raw work). The prior raw execution events ('DONE m0') are NOT re-fed —
  // they were REPLACED by immutable section nodes; CASCADE-COMPACT6 asserts it.
  const lastUserContent = (msgs) => {
    for (let i = (msgs?.length ?? 0) - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m?.role === 'user' && typeof m.content === 'string') return m.content
    }
    return ''
  }
  const isCompressorCall = r => lastUserContent(r.req.messages).includes('COMPRESSOR SDK')
  const compressorInputs = g.log.filter(isCompressorCall).map(r => r.req.messages)
  const anyMsg = (msgs, substr) => (msgs ?? []).some(m => typeof m?.content === 'string' && m.content.includes(substr))
  ok(taskCompacts.length === 4, 'CASCADE-COMPACT1 compresses at EVERY boundary (no maxCompressions cap)', taskCompacts.length)
  ok(b.scorecard.compression.count === 4, 'CASCADE-COMPACT2 compression.count = 4 boundaries', b.scorecard.compression.count)
  ok(compressorInputs.length === 4, 'CASCADE-COMPACT3 four compressor calls', compressorInputs.length)
  ok(anyMsg(compressorInputs[0], 'DONE m0') && anyMsg(compressorInputs[0], 'DONE m1'), 'CASCADE-COMPACT4 first compressor sees seg0 work (m0,m1)')
  ok(anyMsg(compressorInputs[1], 'DONE m2') && anyMsg(compressorInputs[1], 'DONE m3'), 'CASCADE-COMPACT5 second compressor sees seg1 work (m2,m3)')
  ok(!anyMsg(compressorInputs[1], 'DONE m0'), 'CASCADE-COMPACT6 second compressor does NOT re-see prior seg0 raw work (frozen sections, un-compressed only)')
  ok(anyMsg(compressorInputs[1], stream[2].text.slice(0, 600)), 'CASCADE-COMPACT7 second compressor prepends seg1 head directive')
  // M5: the accumulated context = IMMUTABLE per-section nodes (只增不改), not a
  // rewritten monolithic block: an executed request carries all 4 section nodes.
  const execMsgs = g.log.filter(r => r.req.tools === true && !isCompressorCall(r)).map(r => JSON.stringify(r.req.messages ?? []))
  ok(execMsgs.some(m => (m.match(/\[compressed task\]/g) ?? []).length >= 4), 'CASCADE-COMPACT8 accumulated 4 immutable [compressed task] section nodes in the context', '')

  // cleanup: ONLY this test's own run dir + the CASCADE boundary mark (see the
  // sweep warning above — never delete other CASCADE-* runs).
  const markFile = boundaryMarkPath('CASCADE')
  if (fs.existsSync(markFile)) fs.rmSync(markFile)
  if (b?.runDir) fs.rmSync(b.runDir, { recursive: true, force: true })
}

// ============ TOOLS. writeScope: single-task ALLOW vs cascade UNION ============
{
  const { createTools } = await import('../lib/tools.mjs')
  const { ALLOW } = await import('../lib/allow.mjs')
  const ws = createWorkspace(path.join(tmp, 'ws-allow'))

  // single task T1: REVIEW.md allowed, docs/api.md denied
  const t1 = createTools(ws, () => {}, 'T1')
  ok(t1.tools.write('REVIEW.md', 'x').startsWith('OK'), 'TOOLS1 single T1 allows REVIEW.md')
  ok(t1.tools.write('docs/api.md', 'x').startsWith('ERROR'), 'TOOLS2 single T1 denies docs/api.md')

  // cascade UNION (T1+T2+T4): all allowed
  const union = Array.from(new Set(['T1', 'T2', 'T4'].flatMap(id => ALLOW[id] ?? [])))
  const cas = createTools(ws, () => {}, 'CASCADE', union)
  ok(cas.tools.write('REVIEW.md', 'x').startsWith('OK'), 'TOOLS3 cascade union allows REVIEW.md')
  ok(cas.tools.write('docs/api.md', 'x').startsWith('OK'), 'TOOLS4 cascade union allows docs/api.md')
  ok(cas.tools.write('src/audit/x.js', 'x').startsWith('OK'), 'TOOLS5 cascade union allows src/audit/')
}

export { failures }

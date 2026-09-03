/**
 * Assertions — architecture foundation (sections N, O, W, U, Y, Z, AA).
 * Run via lib/assert.mjs (aggregator); also runnable standalone.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT, FIXTURE_DIR, createWorkspace } from '../lib/workspace.mjs'

const tmp = path.join(EVAL_ROOT, '.assert-tmp')
let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!cond) failures++
}

// ============ N. rejudge safety: never clobber a scorecard on judge failure ============
{
  const src = fs.readFileSync(path.join(EVAL_ROOT, 'lib', 'rejudge.mjs'), 'utf8')
  ok(src.includes('judge?.score === null'), 'N1 rejudge guards null/undefined judge')
  ok(src.includes('scorecard NOT touched'), 'N2 rejudge keeps the old score on failure')
  ok(src.includes('scorecard.rejudge-bak.json'), 'N3 rejudge backs up the scorecard before writing')
}

// ============ O. A1: transport injection + closed world ============
{
  const { createGateway } = await import('../lib/gateway.mjs')
  const { createScriptedGateway, createRecordingGateway, createReplayGateway, createCannedGateway } = await import('../lib/gateway-mock.mjs')

  const libFiles = fs.readdirSync(path.join(EVAL_ROOT, 'lib')).filter(f => f.endsWith('.mjs'))
  const netEgress = []
  for (const f of libFiles) {
    const src = fs.readFileSync(path.join(EVAL_ROOT, 'lib', f), 'utf8')
    for (const m of src.matchAll(/fetch\s*\(/g)) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1
      const lineEndRaw = src.indexOf('\n', m.index)
      const lineEnd = lineEndRaw === -1 ? src.length : lineEndRaw
      const line = src.slice(lineStart, lineEnd)
      const trimmed = line.trim()
      const isComment = trimmed.startsWith('*') || trimmed.startsWith('//')
      const isLocal = /127\.0\.0\.1|localhost/.test(line)
      const isGateway = f === 'gateway.mjs'
      if (!isGateway && !isLocal && !isComment) netEgress.push(`${f}: ${trimmed.slice(0, 60)}`)
    }
  }
  ok(netEgress.length === 0, 'O1 closed world: no external fetch outside gateway.mjs', netEgress.join(' | ') || '(clean)')

  const shim = createGateway({ fetchImpl: async () => ({ ok: false, status: 418, text: async () => 'teapot' }) })
  ok(typeof shim.chatCall === 'function' && shim.baseUrl.includes('api.deepseek.com'), 'O2 createGateway returns usable transport', shim.baseUrl)

  const scripted = createScriptedGateway({
    script: [
      { text: '', toolCalls: [{ id: 'c1', name: 'read', args: JSON.stringify({ path: 'package.json' }) }] },
      { text: 'DONE all green', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 } },
    ],
  })
  const a1 = await scripted.chatCall({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(40) }] })
  const a2 = await scripted.chatCall({ model: 'm', messages: [] })
  ok(a1.toolCalls?.[0]?.name === 'read' && a2.text === 'DONE all green', 'O3 scripted answers in order')
  ok(a2.usage.inputTokens === 100 && a2.usage.cacheReadTokens === 50 && a1.usage.inputTokens === 10, 'O4 scripted usage honored (default estimate on a1)')
  ok(scripted.calls() === 2, 'O5 scripted counts calls')
  let exhausted = false
  try { await scripted.chatCall({}) } catch { exhausted = true }
  ok(exhausted, 'O6 scripted throws when exhausted')

  const dir = path.join(tmp, 'recording')
  const rec = createRecordingGateway({ inner: createCannedGateway({ text: 'ok' }), dir })
  await rec.chatCall({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  const replay = createReplayGateway({ dir })
  const r = await replay.chatCall({})
  ok(r.text === 'ok' && rec.calls() === 1, 'O7 record → replay round-trips')
  const raw = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8')
  ok(raw.includes('"model":"m"') && raw.includes('"text":"ok"'), 'O8 recording file captures request + response')
  let missing = false
  try { createReplayGateway({ dir: path.join(tmp, 'nope') }) } catch { missing = true }
  ok(missing, 'O9 replay missing recording fails fast')
}

// ============ W. A3: single-source-of-truth foundation modules ============
{
  const paths = await import('../lib/paths.mjs')
  ok(fs.existsSync(paths.EVAL_ROOT) && fs.existsSync(paths.RUNS_DIR) && fs.existsSync(paths.TASKS_DIR) && fs.existsSync(paths.FIXTURE_DIR), 'W1 paths constants point at real dirs')

  const { loadTask, listTasks, validateTask } = await import('../lib/tasks.mjs')
  const t3 = loadTask('T3')
  ok(t3?.id === 'T3' && t3.file === 'T3-frontend.json', 'W2 loadTask by exact id + file name', t3?.file)
  ok(loadTask('T3-frontend')?.id === 'T3', 'W3 loadTask by prefix')
  const all = listTasks()
  ok(all.length >= 8 && all.every(t => t.file && t.id), 'W4 listTasks returns all with file', `n=${all.length}`)
  ok(validateTask({ id: 'X' }).length > 0, 'W5 validateTask catches track/prompt problems')
  ok(validateTask(t3).length === 0, 'W6 real tasks validate clean')

  const { loadScoresConfig, validateArmRow } = await import('../lib/config.mjs')
  const sc = loadScoresConfig()
  ok(sc.executor?.model && sc.judge?.model, 'W7 scores config loads executor/judge')
  ok(validateArmRow({ id: 'full', ledger: { execution: true } }).length === 0, 'W8 valid arm row passes')
  ok(validateArmRow({ id: 'x', ledger: { mystery: true } }).length > 0, 'W9 unknown ledger stage rejected')
  ok(validateArmRow({ id: 'x', ledger: { derivedAllowedInConclusion: true } }).length > 0, 'W10 derived-in-conclusion arms rejected')

  const { createLedger, priceOf, loadPricing } = await import('../lib/cost.mjs')
  const leg = createLedger()
  leg.record('execution', { inputTokens: 1000, cacheReadTokens: 200, outputTokens: 300 })
  leg.record('judge', { inputTokens: 500, outputTokens: 700 })
  const rep = leg.report()
  ok(rep.stages.execution.inputTokens === 1000 && rep.stages.judge.outputTokens === 700, 'W11 ledger records per stage')
  ok(rep.forbid.ok === true, 'W12 derived never allowed into conclusions by default')
  const p1 = priceOf('mimo-v2.5')
  ok(p1 && p1.inputPerM === 0.14, 'W13 priceOf resolves mimo-v2.5 row', JSON.stringify(p1))
  const p2 = priceOf('deepseek-v4-flash', 'deepseek-v4')
  ok(p2 && p2.id.includes('-peak'), 'W14 v4 route resolves peak tier row', p2?.id)
  ok(loadPricing().models.length > 0, 'W15 pricing table loaded')

  // W16/W17 — judge protocol v2 wiring (2026-09): effort passthrough + config default
  const { resolveJudgeProtocol } = await import('../lib/config.mjs')
  const { judgeTask } = await import('../lib/judge.mjs')
  const cfg = loadScoresConfig()
  const proto = resolveJudgeProtocol(cfg, {})
  ok(proto.model === cfg.judge.model && proto.provider === cfg.judge.provider, 'W16a judge protocol resolves model/provider from scores.config', JSON.stringify({ model: proto.model, provider: proto.provider }))
  ok(Number.isInteger(proto.samples) && proto.samples >= 1, 'W16b judge samples resolves to an integer ≥ 1', String(proto.samples))
  ok(resolveJudgeProtocol({ judge: { effort: 'none' } }, {}).effort === undefined, 'W16c effort none → wire sends NO reasoning_effort')
  ok(resolveJudgeProtocol({}, { judgeEffort: 'low' }).effort === 'low', 'W16d opts.judgeEffort overrides config')
  ok(resolveJudgeProtocol({ judge: { samples: 3 } }, {}).samples === 3 && resolveJudgeProtocol({ judge: { samples: 3 } }, { samples: 1 }).samples === 1, 'W16e config samples default; opts.samples overrides')
  const taskJ = loadTask('T1')
  const seen = []
  const fakeCall = async (call) => { seen.push(call.reasoningEffort); return { text: JSON.stringify({ dims: Object.fromEntries(taskJ.rubric.dims.map(d => [d.id, { score: 4, why: 'x' }])), antiCheat: { verdict: 'none', evidence: 'ok' }, notes: 'fine' }), usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 } } }
  const tmpDir = path.join(EVAL_ROOT, `.tmp-w16-judge-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  await judgeTask({ task: taskJ, mech: { checks: [], violations: [] }, diff: [], runDir: tmpDir, workspace: tmpDir, provider: 'deepseek', model: 'm', judgeEffort: 'low', callLLM: fakeCall })
  await judgeTask({ task: taskJ, mech: { checks: [], violations: [] }, diff: [], runDir: tmpDir, workspace: tmpDir, provider: 'deepseek', model: 'm', judgeEffort: undefined, callLLM: fakeCall })
  ok(seen[0] === 'low' && seen[1] === undefined, 'W16f judgeTask forwards judgeEffort to the gateway call (and omits when undefined)', JSON.stringify(seen))
}

// ============ U. A4: transcript schema + digest contract ============
{
  const { append, readAll, summarize, digest, validateEntry, ENTRY_TYPES } = await import('../lib/transcript.mjs')
  const tf = path.join(tmp, 'transcript.jsonl')

  append(tf, { type: 'assistant', content: 'hi', toolCalls: null })
  append(tf, { type: 'tool', tool: 'read', arg: { path: 'a.js' }, result: 'x' })
  append(tf, { type: 'stage', index: 1, message: 'go' })
  append(tf, { type: 'compress', mode: 'semantic', inputTokens: 500, outputTokens: 200 })
  ok(readAll(tf).length === 4, 'U1 append/read round-trip all types')
  const s = summarize(readAll(tf))
  ok(s.toolCalls === 1 && s.stages === 1 && s.compresses === 1 && s.entries === 4, 'U2 summarize counts per type')

  let rejected = false
  try { append(tf, { type: 'bogus' }) } catch { rejected = true }
  ok(rejected, 'U3 unknown entry type rejected')
  ok(validateEntry({ type: 'tool' }).length > 0, 'U4 tool entry needs tool name')
  ok(validateEntry({ type: 'compress', mode: 'semantic' }).length > 0, 'U5 compress entry needs inputTokens')

  const d = digest(path.dirname(tf))
  ok(d.includes('[model] hi') && d.includes('[tool read]'), 'U6 digest renders model/tool lines')
  ok(ENTRY_TYPES.includes('decision'), 'U7 new types (decision) pre-registered in schema')
}

// ============ Y. A5: declarative arm table (final protocol: 2 controls + 4 grid arms) ============
{
  const { getArm, listArms, triggerConfig } = await import('../lib/arm-spec.mjs')
  ok(getArm('native-auto').compression === 'native-auto' && getArm('manual-habit').compression === 'manual-habit', 'Y1 getArm resolves the two controls')
  ok(['self-s1-orig', 'self-s1-expand', 'self-s2-orig', 'self-s2-expand'].every(id => getArm(id).compression === 'task-boundary'), 'Y2 A1×A2 grid arms declared (task-boundary)')
  ok(getArm('self-s1-orig').a1 === 's1' && getArm('self-s2-expand').a2 === 'expand', 'Y3 grid sub-params (a1/a2) load')
  const arms = listArms()
  ok(arms.length === 6 && arms.includes('native-auto') && arms.includes('manual-habit'), 'Y4 final arm table = exactly 6 arms (2 controls + 4 grid)', `n=${arms.length}`)
  ok(!['full', 'self', 'self-compact', 'plain', 'ground', 'semantic', 'anchor-structural', 'pos-tail', 'noise-50', 'inject-index'].some(a => arms.includes(a)), 'Y5 historical arms removed (no-compression baseline cancelled; self-compact merged into self-s2-orig)', arms.join(','))
  ok(triggerConfig().tokenThreshold === 8000, 'Y6 shared trigger constant', triggerConfig().tokenThreshold)
  let threw = false
  try { getArm('nope') } catch { threw = true }
  ok(threw, 'Y7 unknown arm throws (no silent fallback)')
  const bad = await import('../lib/arm-spec.mjs')
  ok(bad, 'Y8 arm-spec importable')
}

// ============ Z. A2: CLI/lib separation ============
{
  const { runOne } = await import('../lib/run-one.mjs')
  ok(typeof runOne === 'function', 'Z1 runOne is a pure library export')
  const { runMatrix } = await import('../lib/run-all.mjs')
  ok(typeof runMatrix === 'function', 'Z2 runMatrix is a pure library export')
  const { rejudgeRun } = await import('../lib/rejudge.mjs')
  ok(typeof rejudgeRun === 'function', 'Z3 rejudgeRun is a pure library export')
  for (const f of ['run-one.mjs', 'run-all.mjs', 'rejudge.mjs']) {
    ok(fs.existsSync(path.join(EVAL_ROOT, 'bin', f)), `Z4 bin/${f} thin shell exists`)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, 'package.json'), 'utf8'))
  ok(pkg.scripts['run-one'] === 'node bin/run-one.mjs' && pkg.scripts['run-all'] === 'node bin/run-all.mjs', 'Z5 package scripts point at bin shells')
  const rj = fs.readFileSync(path.join(EVAL_ROOT, 'lib', 'rejudge.mjs'), 'utf8')
  ok(rj.includes('never touches') || rj.includes('scorecard NOT touched'), 'Z6 rejudge still preserves score on failure')
}

// ============ ZB. batch mechanics: budget cap + three-ledger + hypothesis table ============
{
  const ra = fs.readFileSync(path.join(EVAL_ROOT, 'lib', 'run-all.mjs'), 'utf8')
  ok(ra.includes('budgetUsd') && ra.includes('BUDGET CAP'), 'ZB1 runMatrix carries a hard budget cap')
  const ro = fs.readFileSync(path.join(EVAL_ROOT, 'lib', 'run-one.mjs'), 'utf8')
  ok(ro.includes('costs') && ro.includes("compression:") && ro.includes("decision:"), 'ZB2 runOne writes the three-ledger costs block')
  const br = fs.readFileSync(path.join(EVAL_ROOT, 'scripts', 'batch-report.mjs'), 'utf8')
  ok(br.includes('三账本成本合计') && br.includes('预注册假设对照'), 'ZB3 batch-report renders ledger totals + hypothesis checklist')
  ok(br.includes('derived 估算仅参考'), 'ZB4 batch-report excludes derived estimates from conclusions')
  const pkg = JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, 'package.json'), 'utf8'))
  ok(pkg.scripts['batch-report'] === 'node scripts/batch-report.mjs', 'ZB5 batch-report npm script wired')
}

// ============ S. human track retired (approved plan §2) ============
{
  const tasks = (await import('../lib/tasks.mjs')).listTasks()
  let trackOk = true
  const bad = []
  for (const t of tasks) {
    const tr = t.track
    if ((tr.human ?? 0) !== 0 || (tr.mech ?? 0) + (tr.judge ?? 0) !== 100) { trackOk = false; bad.push(`${t.id}: h${tr.human} m${tr.mech} j${tr.judge}`) }
  }
  ok(trackOk, 'S1 every task: human=0 and mech+judge=100', bad.join(' ') || '(clean)')

  const { assemble } = await import('../lib/score.mjs')
  const t5 = (await import('../lib/tasks.mjs')).loadTask('T5')
  const mech = { score: 100, violations: [] }
  const judge = { score: 80, antiCheat: { verdict: 'none' } }
  const a1 = assemble(t5, mech, judge, [{ task: 'T5', dim: 'copy', weight: 1, delta: 5 }], [])
  const a2 = assemble(t5, mech, judge, [], [])
  ok(a1.total === a2.total, 'S2 humanRows are ignored (same total)', `${a1.total} vs ${a2.total}`)

  const runOneSrc = fs.readFileSync(path.join(EVAL_ROOT, 'lib', 'run-one.mjs'), 'utf8')
  ok(!runOneSrc.includes('human-packet') && !runOneSrc.includes('humanPending'), 'S3 run-one no longer builds human packets')
  const reportSrc = fs.readFileSync(path.join(EVAL_ROOT, 'lib', 'report.mjs'), 'utf8')
  ok(!reportSrc.includes('human-sheet'), 'S4 report has no human prompts')

  // language-class dims must exist on the retired-aesthetics tasks
  const dimIdsOf = (id) => (tasks.find(t => t.id === id)?.rubric?.dims ?? []).map(d => d.id)
  const t5dim = dimIdsOf('T5')
  const t6dim = dimIdsOf('T6')
  ok(['tone', 'fit', 'accuracy'].every(d => t5dim.includes(d)), 'S5 T5 rubric keeps tone/fit/accuracy', t5dim.join(','))
  ok(t6dim.includes('clarity'), 'S6 T6 rubric keeps clarity', t6dim.join(','))
}

// ============ R. E3: four-arm contrast (offline) ============
{
  const { compressOnce } = await import('../lib/compress.mjs')
  const { assembleInit } = await import('../lib/assemble.mjs')
  const { renderArmSummary } = await import('../lib/report.mjs')
  const { validateTask } = await import('../lib/tasks.mjs')

  // R1: every arm's initial user content differs (full vs obj-P vs anchor)
  const t3 = (await import('../lib/tasks.mjs')).loadTask('T3')
  const P = (await import('../lib/compress.mjs')).validateProduct
  const mockP = { goal: 'g', steps: ['s1'], fileStream: ['f1'], compressed: 'c' }
  const sys = 'S'
  const ufull = assembleInit({ mode: 'plain', systemPrompt: sys, task: t3, prompt: 'T' }).messages[1].content
  const uobj = assembleInit({ mode: 'obj-P', systemPrompt: sys, task: t3, prompt: 'T', product: mockP }).messages[1].content
  const uanc = assembleInit({ mode: 'anchor', systemPrompt: sys, task: t3, prompt: 'T', product: mockP, anchorKind: 'structural' }).messages[1].content
  ok(ufull !== uobj && uobj !== uanc && ufull !== uanc, 'R1 full/obj-P/anchor assemblies are byte-distinct')

  // R2: every task that can run the manual arm has a gold product that validates
  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']) {
    const res = await compressOnce({ task: { id }, mode: 'manual' })
    ok(res.ok, `R2 gold manual product ${id} validates`, res.problems?.join(';') || '')
  }

  // R3: industry and semantic compressors use distinct prompts (source-level)
  const csrc = fs.readFileSync(path.join(EVAL_ROOT, 'lib', 'compress.mjs'), 'utf8')
  ok(csrc.includes('OUTPUT EXACTLY ONE RAW JSON OBJECT') && csrc.includes('"summary"'), 'R3 industry prompt differs from semantic (narrative summary)')

  // R4: Δ math in renderArmSummary — synthetic scorecards
  const base = { task: 'T3', arm: 'native-auto', total: 90, mech: { score: 100 }, judge: { score: 80 }, human: null, finished: true }
  const armA = { task: 'T3', arm: 'armA', total: 85, mech: { score: 95 }, judge: { score: 75 }, human: null, finished: true }
  const armB = { task: 'T3', arm: 'armB', total: 95, mech: { score: 100 }, judge: { score: 90 }, human: null, finished: true }
  const md = renderArmSummary([base, armA, armB])
  ok(md.includes('Δ -5') && md.includes('Δ +5'), 'R4 arm summary Δ math (relative to baseline)', md.split('\n').find(l => l.includes('armA')) ?? '')
  // R4b: a second task row appears
  const md2 = renderArmSummary([base, { ...armA, task: 'T4', arm: 'baseline', total: 80 }])
  ok(md2.includes('## T4'), 'R5 summary groups per task')

  ok(validateTask(t3).length === 0, 'R6 real tasks still validate after track changes')
}

// ============ V. V1: prefix accounting + trim (offline, zero API) ============
{
  const { estimateTokens, estimateMessagesTokens, splitPrefix, trimPrompt, accountPrefix, shouldTrigger, CHARS_PER_TOKEN } = await import('../lib/prefix.mjs')
  const { prefixModeOf } = await import('../lib/run-one.mjs')

  ok(CHARS_PER_TOKEN === 1.5, 'V0 token-approx constant locked (wire-calibrated 2026-09)')
  ok(estimateTokens('123') === 2 && estimateTokens('') === 0 && estimateTokens('x'.repeat(9)) === 6, 'V1 estimateTokens wire-calibrated math', estimateTokens('x'.repeat(9)))
  ok(estimateMessagesTokens([{ content: 'abc' }]) === 2, 'V2 estimateMessagesTokens sums messages')

  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task def' },
    { role: 'assistant', content: 'hi', toolCalls: null },
    { role: 'tool', tool_call_id: 't1', content: 'r' },
  ]
  const sp = splitPrefix(msgs)
  ok(sp.prefix.length === 2 && sp.prefix[1].content === 'task def' && sp.tail.length === 2, 'V3 splitPrefix = system+first user only')
  const sp2 = splitPrefix([{ role: 'user', content: 'solo' }])
  ok(sp2.prefix.length === 0 && sp2.tail.length === 1, 'V4 no-system request → all tail (safe)')

  const orig = '  line1  \n\n\n\nline2\n\n  line3  \n'
  const tr = trimPrompt(orig)
  ok(tr === trimPrompt(orig) && !/\n{3,}/.test(tr) && tr.length < orig.length, 'V5 trimPrompt deterministic, collapses 3+ newlines, shorter', JSON.stringify(tr))
  const realPrompt = JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, 'tasks', 'T3-frontend.json'), 'utf8')).prompt
  ok(trimPrompt(realPrompt).length <= realPrompt.length && trimPrompt(trimPrompt(realPrompt)) === trimPrompt(realPrompt), 'V6 trim on a real task prompt is idempotent + never grows', `${realPrompt.length} → ${trimPrompt(realPrompt).length}`)

  const accHit = accountPrefix(msgs, { cacheReadTokens: 50, inputTokens: 100 })
  ok(accHit.cacheReadTokens === 50 && accHit.derived === false, 'V7 accountPrefix honors gateway cacheRead')
  const accNoHit = accountPrefix(msgs, { inputTokens: 100 })
  ok(accNoHit.derived === true && accNoHit.derivedCacheRead === accNoHit.prefixTokens, 'V8 no cache → derived labeled, equals prefix tokens')
  ok(accNoHit.prefixTokens > 0 && accNoHit.tailTokens > 0, 'V9 prefix/tail token split positive')

  ok(shouldTrigger(8000)(9000) === true && shouldTrigger(8000)(7999) === false, 'V10 trigger threshold boundary')

  ok(prefixModeOf({ assembly: 'prefix' }) === 'track' && prefixModeOf({ assembly: 'prefix-trim' }) === 'trim' && prefixModeOf({ assembly: 'plain' }) === 'none', 'V11 arm assembly → prefixMode mapping')

  // runner integration: a scripted run with prefix tracking records prefixStats
  const { createScriptedGateway } = await import('../lib/gateway-mock.mjs')
  const { runSession } = await import('../lib/runner.mjs')
  const dir = path.join(tmp, 'v1-run')
  fs.mkdirSync(dir, { recursive: true })
  const ws = createWorkspace(dir)
  const scripted = createScriptedGateway({
    script: [
      { text: '', toolCalls: [{ id: 'c1', name: 'read', args: JSON.stringify({ path: 'package.json' }) }] },
      { text: 'DONE v1', usage: { inputTokens: 400, outputTokens: 10, cacheReadTokens: 300 } },
    ],
  })
  const task3 = (await import('../lib/tasks.mjs')).loadTask('T3')
  const res = await runSession({
    workspace: ws, taskId: 'T3', task: task3, prompt: task3.prompt,
    model: 'm', provider: 'x', transcriptPath: path.join(dir, 'transcript.jsonl'),
    callLLM: scripted.chatCall, prefixMode: 'track', maxSteps: 10,
  })
  ok(res.prefixStats.tracked === true && res.prefixStats.prefixTokens > 0, 'V12 runner records prefixStats', JSON.stringify(res.prefixStats))
  ok(res.usage.cacheReadTokens === 300, 'V13 real cacheRead flows into usage')
}

// ============ AA. A6: fixture immutability + closed-world isolation ============
{
  const { hashFixture, checkFixture } = await import('../lib/fixture.mjs')
  const { MANUAL_DIR, ANSWERS_DIR } = await import('../lib/paths.mjs')

  ok(checkFixture().ok === true, 'AA1 fixture present and matches committed golden')
  hashFixture()
  const probe = path.join(FIXTURE_DIR, 'README.md')
  if (fs.existsSync(probe)) {
    const orig = fs.readFileSync(probe, 'utf8')
    fs.writeFileSync(probe, orig + '\n// probe\n')
    const bad = checkFixture()
    ok(bad.ok === false, 'AA2 corrupted fixture is detected', bad.reason?.slice(0, 60))
    fs.writeFileSync(probe, orig)
    ok(checkFixture().ok === true, 'AA3 restore passes again')
  }

  const { listFiles } = await import('../lib/workspace.mjs')
  const wsFiles = listFiles(FIXTURE_DIR)
  ok(!wsFiles.some(f => f.includes('answers') || f.includes('manual')), 'AA4 answers/manual not part of the fixture template')
  ok(ANSWERS_DIR.includes('answers') && MANUAL_DIR.includes(path.join('answers', 'manual')), 'AA5 manual dir located under answers (model-unreachable)')
}

export { failures }
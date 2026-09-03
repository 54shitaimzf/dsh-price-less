/**
 * Assertions — V0 直接调用检验 (offline template battery). No LLM: the PTC
 * compressor's runtime seam, bindings, SDK templates and mechanical gates are
 * exercised against a REAL closed-task fixture (real transcript + real
 * workspace files). Every refactor point that can be checked offline is:
 *
 *   PROBE  deterministic sub-flow clustering
 *   RUN    runProgram(TEMPLATE_S2/S1) → product structure + refs + ratio shape
 *   PTR    validate_pointer + verifyRefGroundTruth (PTR-EXIST / PTR-TRUTH)
 *   OUT    no raw echo (rawEchoMarkers / findRawEcho) + output-limit
 *   RATIO  checkRatio thresholds (effective/marginal/fail/skip/no-region)
 *   RET    checkRetention (refs ≤ maxRefs, outline ≤ budget; degrade)
 *   SCHEMA validateProductSchema boundaries
 *   ERR    runtime error paths (invalid-program / timeout / binding error)
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT } from '../lib/workspace.mjs'

const fixture = path.join(EVAL_ROOT, 'tests', 'fixtures', 'template-battery')
const workspace = path.join(fixture, 'workspace')
const transcript = JSON.parse(fs.readFileSync(path.join(fixture, 'transcript.json'), 'utf8')).entries
const ctx = { taskId: 'auth-fixture', transcript, workspace }

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!cond) failures++
}

const { runProgram } = await import('../lib/code-run.mjs')
const { makeCompressorBindings, clusterSubtasks, computePointers, verifyRefGroundTruth, rawEchoMarkers, findRawEcho } = await import('../lib/compressor-io.mjs')
const { validateProductSchema, checkRatio, checkRetention, collectRefs, BLOCK_TYPES, DEFAULT_RATIO, DEFAULT_RETENTION } = await import('../lib/compressor-validate.mjs')
const { estimateTokens } = await import('../lib/prefix.mjs')
const { TEMPLATE_S1, TEMPLATE_S2 } = await import('../lib/sdk.mjs')

const bindings = makeCompressorBindings(ctx)
const pointers = computePointers(ctx)
const markers = rawEchoMarkers(ctx)

// ============ PROBE — deterministic sub-flow clustering ============
{
  const subtasks = clusterSubtasks(transcript)
  ok(subtasks.length === 4, `PROBE-1 closed task clusters into 4 sub-flows`, subtasks.map(s => `${s.typeHint}:${s.fromIdx}-${s.toIdx}`).join(' | '))
  ok(subtasks[0].typeHint === 'explore' && subtasks[1].typeHint === 'edit' && subtasks[2].typeHint === 'verify' && subtasks[3].typeHint === 'wrap', 'PROBE-2 typeHints = explore|edit|verify|wrap')
  ok(subtasks.every((s, i) => s.spanKey === `sub:${i}`), 'PROBE-3 spanKeys are stable sub:0..N')
  const empty = clusterSubtasks([])
  ok(Array.isArray(empty) && empty.length === 0, 'PROBE-4 empty transcript → no subtasks (compressible region empty)')
}

// ============ RUN — TEMPLATE_S2 (placeholder run) ============
{
  const r = await runProgram({ program: TEMPLATE_S2, bindings })
  ok(!r.error, 'RUN-1 TEMPLATE_S2 runs with no runtime error', r.error?.message ?? '')
  const product = r.value
  ok(!!product && typeof product === 'object', 'RUN-2 TEMPLATE_S2 returns an object')
  const problems = validateProductSchema(product)
  ok(problems.length === 0, 'RUN-3 TEMPLATE_S2 product passes the 总-分 schema', problems.slice(0, 2).join('; '))
  ok(product.sections[0].subtasks.length === 4, 'RUN-4 one section with 4 typed subtasks', `${product.sections[0].subtasks.length}`)
  const types = product.sections[0].subtasks.map(b => b.type)
  ok(JSON.stringify(types) === JSON.stringify(['plan', 'impl', 'verify', 'wrap']), 'RUN-5 types = plan|impl|verify|wrap', types.join(','))
  const impl = product.sections[0].subtasks.find(b => b.type === 'impl')
  ok(impl && impl.refs.length === 1 && impl.refs[0].path === 'src/auth.js' && impl.refs[0].lineRange === '1-6' && impl.refs[0].symbol === 'checkAuth', 'RUN-6 impl ref = real change pointer (path 1-6 checkAuth)', JSON.stringify(impl?.refs?.[0] ?? null))
  const v = await bindings.validate_pointer({ ...impl.refs[0] })
  ok(v.ok === true, 'RUN-7 validate_pointer(impl ref) → ok', v.reason ?? '')
  ok(findRawEcho(product, markers).length === 0, 'RUN-8 no raw echo in TEMPLATE_S2 product')
  // ratio shape: compressed part tokens vs a nominal region (region ≈ 15k tok)
  const ratio = checkRatio({ productTokens: estimateTokens(JSON.stringify({ total: product.total, sections: product.sections })), regionTokens: 15000 })
  ok(ratio.verdict === 'effective' || ratio.verdict === 'marginal', 'RUN-9 product-compressed-tokens ratio has a verdict (not fail)', `${ratio.verdict} ${ratio.ratio ?? ''}`)
}

// ============ RUN — TEMPLATE_S1 (retain shape) ============
{
  const r = await runProgram({ program: TEMPLATE_S1, bindings })
  ok(!r.error, 'RUN-S1-1 TEMPLATE_S1 runs with no runtime error', r.error?.message ?? '')
  const product = r.value
  ok(validateProductSchema(product).length === 0, 'RUN-S1-2 TEMPLATE_S1 product passes schema')
  ok(product.retain !== undefined && Array.isArray(product.retain.refs) && typeof product.retain.outline === 'string', 'RUN-S1-3 retain = {refs, outline} present')
  const ret = checkRetention(product.retain)
  ok(ret.ok && !ret.degraded, 'RUN-S1-4 retain passes the length gate', ret.reason ?? '')
  ok(findRawEcho(product, markers).length === 0, 'RUN-S1-5 no raw echo')
}

// ============ CONCRETE — authored content (S2) + PTR-TRUTH ============
const CONCRETE_S2 = [
  'const s = await tools.probe_substructure({ taskRef: "task" })',
  'const subtasks = []',
  'for (const sub of s.subtasks) {',
  '  let refs = []',
  '  let p = null',
  '  if (sub.typeHint === "edit") {',
  '    p = await tools.locate_change({ segmentRef: sub.spanKey, fileHint: "" })',
  '    if (p) { const v = await tools.validate_pointer({ ...p }); if (v.ok) refs = [{ refKey: sub.spanKey, ...p }] }',
  '  }',
  '  const type = sub.typeHint === "edit" ? "impl" : sub.typeHint === "verify" ? "verify" : sub.typeHint === "wrap" ? "wrap" : "plan"',
  '  const fields = type === "impl" ? { path: p?.path ?? "", lineRange: p?.lineRange ?? null, symbol: p?.symbol ?? null, change: "added null/undefined guard before secret access" }',
  '    : type === "verify" ? { command: "node --test tests/auth.test.js", result: "pass (2 tests)" }',
  '    : type === "wrap" ? { conclusion: "auth null-guard bug fixed; tests pass" }',
  '    : { goal: "fix auth null-guard bug so tests pass" }',
  '  subtasks.push({ type, ...fields, refs })',
  '}',
  'return { total: s.subtasks.length, sections: [{ summary: "Fixed the authentication bug by guarding missing credentials in src/auth.js; tests pass.", subtasks }] }',
].join('\n')
{
  const r = await runProgram({ program: CONCRETE_S2, bindings })
  ok(!r.error, 'CONCRETE-1 authored S2 program runs', r.error?.message ?? '')
  const product = r.value
  ok(validateProductSchema(product).length === 0, 'CONCRETE-2 authored product passes schema')
  const refs = collectRefs(product)
  const truth = verifyRefGroundTruth(refs, pointers)
  ok(truth.length === 0, 'CONCRETE-3 PTR-TRUTH: every ref grounded in a real change record', truth.join('; ') || 'all grounded')
  const impl = product.sections[0].subtasks.find(b => b.type === 'impl')
  ok(impl && impl.path === 'src/auth.js' && impl.lineRange === '1-6' && impl.symbol === 'checkAuth', 'CONCRETE-4 impl block carries the grounded coordinates')
  ok(findRawEcho(product, markers).length === 0, 'CONCRETE-5 no raw echo in authored product')
}

// ============ CONCRETE — authored content (S1) retain with refs ============
const CONCRETE_S1 = [
  'const s = await tools.probe_substructure({ taskRef: "task" })',
  'const subtasks = []',
  'for (const sub of s.subtasks) {',
  '  let refs = []',
  '  let p = null',
  '  if (sub.typeHint === "edit") {',
  '    p = await tools.locate_change({ segmentRef: sub.spanKey, fileHint: "" })',
  '    if (p) { const v = await tools.validate_pointer({ ...p }); if (v.ok) refs = [{ refKey: sub.spanKey, ...p }] }',
  '  }',
  '  const type = sub.typeHint === "edit" ? "impl" : sub.typeHint === "verify" ? "verify" : sub.typeHint === "wrap" ? "wrap" : "plan"',
  '  const fields = type === "impl" ? { path: p?.path ?? "", lineRange: p?.lineRange ?? null, symbol: p?.symbol ?? null, change: "added null/undefined guard before secret access" }',
  '    : type === "verify" ? { command: "node --test tests/auth.test.js", result: "pass (2 tests)" }',
  '    : type === "wrap" ? { conclusion: "auth null-guard bug fixed; tests pass" }',
  '    : { goal: "fix auth null-guard bug so tests pass" }',
  '  subtasks.push({ type, ...fields, refs })',
  '}',
  'const lastImpl = subtasks.filter(st => st.refs.length > 0).pop()',
  'const retain = { refs: lastImpl ? lastImpl.refs.map(r => ({ path: r.path, lineRange: r.lineRange, symbol: r.symbol })) : [], outline: "guard added; tests green" }',
  'return { total: s.subtasks.length, sections: [{ summary: "Fixed the authentication bug by guarding missing credentials in src/auth.js; tests pass.", subtasks }], retain }',
].join('\n')
{
  const r = await runProgram({ program: CONCRETE_S1, bindings })
  ok(!r.error, 'CONCRETE-S1-1 authored S1 program runs', r.error?.message ?? '')
  const product = r.value
  ok(validateProductSchema(product).length === 0, 'CONCRETE-S1-2 product passes schema (with retain)')
  const ret = checkRetention(product.retain)
  ok(ret.ok && !ret.degraded, 'CONCRETE-S1-3 retain passes the length gate', ret.reason ?? '')
  // retain refs are HOT-BRIDGE COPIES of a section ref (same change, same truth):
  // grounding is per-namespace — duplicate across section↔retain is BY DESIGN.
  const sectionRefs = product.sections.flatMap(s => s.subtasks.flatMap(b => b.refs ?? []))
  const t1 = verifyRefGroundTruth(sectionRefs, pointers)
  const t2 = verifyRefGroundTruth(product.retain.refs, pointers)
  ok(t1.length === 0 && t2.length === 0, 'CONCRETE-S1-4 PTR-TRUTH per namespace (sections, retain)', [...t1, ...t2].join('; ') || 'all grounded')
  ok(product.retain.refs.length === 1 && product.retain.refs[0].path === 'src/auth.js', 'CONCRETE-S1-5 retain carries the last change pointer', JSON.stringify(product.retain.refs))
  ok(findRawEcho(product, markers).length === 0, 'CONCRETE-S1-6 no raw echo')
}

// ============ OUT — raw echo caught + output limit ============
{
  const ECHO = [
    'const raw = await tools.read_transcript({ segmentRef: "task" })',
    'return { total: 1, sections: [{ summary: raw, subtasks: [] }] }',
  ].join('\n')
  const r = await runProgram({ program: ECHO, bindings })
  ok(!r.error, 'OUT-1 echo program runs (returns raw as summary)')
  const hits = findRawEcho(r.value, markers)
  ok(hits.length > 0, 'OUT-2 OUT gate detects the raw echo', hits.slice(0, 2).join(' | '))
  const ratio = checkRatio({ productTokens: estimateTokens(JSON.stringify({ total: r.value.total, sections: r.value.sections })), regionTokens: 15000 })
  ok(ratio.verdict === 'effective' || ratio.verdict === 'marginal', 'OUT-3 note: ratio alone does NOT catch an echo bag — OUT gate is independent and mandatory')
  const LOOP = [
    'for (let i = 0; i < 10000; i++) console.log("x".repeat(200))',
    'return { total: 1, sections: [{ summary: "s", subtasks: [] }] }',
  ].join('\n')
  const r2 = await runProgram({ program: LOOP, bindings, budgets: { maxOutputBytes: 1024 } })
  ok(r2.error?.kind === 'output-limit', 'OUT-4 log output over budget → output-limit error', r2.error?.kind ?? '')
}

// ============ RATIO — checkRatio thresholds ============
{
  const c = DEFAULT_RATIO
  ok(checkRatio({ productTokens: 10, regionTokens: 0 }).verdict === 'no-region', 'RATIO-1 empty region → no-region')
  ok(checkRatio({ productTokens: 100, regionTokens: 2999 }).verdict === 'skip', 'RATIO-2 region < minRegionTokens → skip')
  const eff = checkRatio({ productTokens: 2000, regionTokens: 4000 })
  ok(eff.verdict === 'effective' && eff.ratio === 0.5, 'RATIO-3 ratio 0.5 → effective (≤0.5)', `${eff.verdict} ${eff.ratio}`)
  const mar = checkRatio({ productTokens: 2100, regionTokens: 3000 })
  ok(mar.verdict === 'marginal', 'RATIO-4 ratio 0.7 → marginal', `${mar.verdict} ${mar.ratio}`)
  const fail = checkRatio({ productTokens: 2300, regionTokens: 3000 })
  ok(fail.verdict === 'fail', 'RATIO-5 ratio 0.767 → fail (>0.75)', `${fail.verdict} ${fail.ratio}`)
}

// ============ RET — checkRetention boundaries ============
{
  const good = { refs: Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.js` })), outline: 'x' }
  ok(checkRetention(good).ok, 'RET-1 refs=8 + tiny outline → ok')
  const bad = { refs: Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.js` })), outline: 'x' }
  const r9 = checkRetention(bad)
  ok(!r9.ok && r9.degraded, 'RET-2 refs=9 → degraded', r9.reason ?? '')
  const bigOutline = { refs: [], outline: 'x'.repeat(164) } // 41 tok
  const rBig = checkRetention(bigOutline)
  ok(!rBig.ok && rBig.degraded, 'RET-3 outline 164 chars (41 tok) → degraded', rBig.reason ?? '')
  const okOutline = { refs: [], outline: 'x'.repeat(160) } // 40 tok
  ok(checkRetention(okOutline).ok, 'RET-4 outline 160 chars (40 tok) → ok')
  ok(checkRetention(undefined).ok && !checkRetention(undefined).degraded, 'RET-5 no retain (S2) → ok')
}

// ============ SCHEMA — validateProductSchema boundaries ============
{
  const base = { total: 1, sections: [{ summary: 'a summary long enough to pass', subtasks: [{ type: 'impl', path: 'src/a.js', change: 'c', refs: [] }] }] }
  ok(validateProductSchema(base).length === 0, 'SCHEMA-1 valid product → no problems')
  const mutated = JSON.parse(JSON.stringify(base))
  mutated.sections[0].summary = 'short'
  ok(validateProductSchema(mutated).some(p => p.includes('summary')), 'SCHEMA-2 short summary → problem')
  mutated.sections[0].subtasks[0].type = 'nope'
  ok(validateProductSchema(mutated).some(p => p.includes('type')), 'SCHEMA-3 unknown block type → problem')
  mutated.sections[0].subtasks[0].type = 'verify'
  ok(validateProductSchema(mutated).some(p => p.includes('missing required field verify.command')), 'SCHEMA-4 verify without command → problem')
  mutated.sections[0].subtasks[0].type = 'plan'
  mutated.sections[0].subtasks[0].goal = 'g'
  mutated.sections[0].subtasks[0].junk = 1
  ok(validateProductSchema(mutated).some(p => p.includes('illegal field "junk"')), 'SCHEMA-5 illegal field → problem')
  mutated.sections[0].subtasks[0].refs = [{ path: 'src/a.js', junk: 1 }]
  ok(validateProductSchema(mutated).some(p => p.includes('refs[0] illegal field "junk"')), 'SCHEMA-6 ref illegal field → problem')
  ok(validateProductSchema(null).length > 0, 'SCHEMA-7 null product → problem')
}

// ============ PTR — validate_pointer + PTR-TRUTH boundaries ============
{
  ok((await bindings.validate_pointer({ path: 'src/auth.js', lineRange: '6-6', symbol: null })).ok, 'PTR-1 range at EOF line → ok')
  const oob = await bindings.validate_pointer({ path: 'src/auth.js', lineRange: '7-8', symbol: null })
  ok(!oob.ok && oob.reason.includes('out of bounds'), 'PTR-2 range beyond EOF → fail', oob.reason)
  const badSym = await bindings.validate_pointer({ path: 'src/auth.js', lineRange: '1-6', symbol: 'nonexistentFn' })
  ok(!badSym.ok && badSym.reason.includes('symbol'), 'PTR-3 symbol not in range → fail', badSym.reason)
  const badRange = await bindings.validate_pointer({ path: 'src/auth.js', lineRange: 'oops', symbol: null })
  ok(!badRange.ok, 'PTR-4 malformed lineRange → fail', badRange.reason)
  const escape = await bindings.validate_pointer({ path: '../answers/x.js', lineRange: null, symbol: null })
  ok(!escape.ok, 'PTR-5 path escape → fail', escape.reason)
  const missing = await bindings.validate_pointer({ path: 'src/nope.js', lineRange: null, symbol: null })
  ok(!missing.ok, 'PTR-6 nonexistent file → fail', missing.reason)
  const dirty = verifyRefGroundTruth([{ path: 'src/fake.js', lineRange: '1-2', symbol: 'fake' }], pointers)
  ok(dirty.length > 0 && dirty[0].includes('not grounded'), 'PTR-7 invented ref → PTR-TRUTH problem', dirty[0])
  const dup = verifyRefGroundTruth([{ path: 'src/auth.js', lineRange: '1-6', symbol: 'checkAuth' }, { path: 'src/auth.js', lineRange: '1-6', symbol: 'checkAuth' }], pointers)
  ok(dup.length > 0 && dup[0].includes('duplicate'), 'PTR-8 duplicate ref to one truth → problem', dup[0])
}

// ============ MW — multi-write quota gate (same-file equal-length rewrites) ============
// Regression for the s1-expand 4× PTR false-kill (see EXPERIMENT.md F8): two
// REAL writes of one file with IDENTICAL coordinates (same line count + same
// first symbol) must both ground — the gate is a per-coordinate-group QUOTA
// (capacity = real records at that coordinate), not find-first + used-set.
{
  const mwFixture = path.join(EVAL_ROOT, 'tests', 'fixtures', 'template-battery-multiwrite')
  const mwTranscript = JSON.parse(fs.readFileSync(path.join(mwFixture, 'transcript.json'), 'utf8')).entries
  const mwCtx = { taskId: 'auth-multiwrite-fixture', transcript: mwTranscript, workspace: path.join(mwFixture, 'workspace') }
  const { auditRefs, verifyRefGroundTruth: verifyMW } = await import('../lib/compressor-io.mjs')
  const { enrichRefs } = await import('../lib/compress.mjs')
  const { renderSection } = await import('../lib/assemble.mjs')
  const mwPointers = computePointers(mwCtx)

  const writes = mwPointers.filter(p => p.kind === 'write')
  ok(writes.length === 2, 'MW-1 two real write truths in the multiwrite fixture', JSON.stringify(writes.map(p => p.refKey)))
  ok(writes[0].path === writes[1].path && writes[0].lineRange === writes[1].lineRange && writes[0].symbol === writes[1].symbol, 'MW-1b both truths share IDENTICAL coordinates (the collision shape)', JSON.stringify([writes[0], writes[1]].map(p => [p.path, p.lineRange, p.symbol])))
  ok(writes[0].refKey !== writes[1].refKey, 'MW-1c records are DISTINCT (refKey identity)', `${writes[0].refKey} vs ${writes[1].refKey}`)

  const coord = { path: writes[0].path, lineRange: writes[0].lineRange, symbol: writes[0].symbol }
  const legitTwo = verifyMW([{ ...coord }, { ...coord }], mwPointers)
  ok(legitTwo.length === 0, 'MW-2 REGRESSION: two refs at the same coordinate (2 real records) → both ground, no duplicate', legitTwo.join('; ') || 'both grounded')

  const three = auditRefs([{ ...coord }, { ...coord }, { ...coord }], mwPointers)
  ok(three.problems.length === 0, 'MW-3a over-quota is NOT fatal (problems empty)', three.problems.join('; ') || 'no fatal problems')
  ok(three.pruned.length === 1 && three.pruned[0].index === 2, 'MW-3b exactly the 3rd ref is pruned', JSON.stringify(three.pruned))
  ok(/2 record/.test(three.pruned[0]?.reason ?? '') && /3 ref/.test(three.pruned[0]?.reason ?? ''), 'MW-3c prune reason carries the quota numbers', three.pruned[0]?.reason ?? '')

  const fab = auditRefs([{ path: 'src/fake.js', lineRange: '1-2', symbol: 'fake' }], mwPointers)
  ok(fab.problems.length === 1 && fab.problems[0].includes('not grounded'), 'MW-4 fabricated coordinate stays FATAL', fab.problems[0] ?? '')

  const mixed = auditRefs([{ path: 'tests/auth.test.js' }, { ...coord }, { ...coord }, { ...coord }], mwPointers)
  ok(mixed.problems.length === 0 && mixed.pruned.length === 1, 'MW-7 path-only read ref does not consume write-quota (only the 3rd write ref pruned)', `problems=${mixed.problems.length} pruned=${JSON.stringify(mixed.pruned.map(p => p.index))}`)

  const mwProduct = {
    total: 2,
    sections: [{ summary: 'Two-pass rewrite of the auth guard; tests pass.', subtasks: [
      { type: 'impl', path: coord.path, change: 'added throw guard', refs: [{ refKey: 'sub:1', ...coord }] },
      { type: 'impl', path: coord.path, change: 'guard rewritten to boolean short-circuit', refs: [{ refKey: 'sub:3', ...coord }] },
    ] }],
  }
  const enrichProblems = await enrichRefs(mwProduct, mwCtx)
  const [refA, refB] = mwProduct.sections[0].subtasks.map(b => b.refs[0])
  ok(enrichProblems.length === 0 && typeof refA.content === 'string' && refA.content === refB.content, 'MW-5 same-target refs enrich to BYTE-IDENTICAL content (single resolve)', enrichProblems.join('; ') || `len=${refA.content?.length}`)

  const mwSection = mwProduct.sections[0]
  const rendered = renderSection(mwSection, { a2: 'expand' })
  const contentHits = rendered.split(refA.content.slice(0, 200)).length - 1
  ok(contentHits === 1, 'MW-6 rendered section inlines the shared content EXACTLY ONCE', `hits=${contentHits}`)
  ok(rendered.includes('→同'), 'MW-6b second same-content ref renders as the →同 pointer', rendered.split('\n').find(l => l.includes('→同')) ?? '')
}

// ============ ERR — runtime error paths ============
{
  const bad = await runProgram({ program: 'const = ;;;' })
  ok(bad.error?.kind === 'invalid-program', 'ERR-1 syntax error → invalid-program', bad.error?.message ?? '')
  const loop = await runProgram({ program: 'while (true) {}', budgets: { maxWallMs: 1200 } })
  ok(loop.error?.kind === 'timeout', 'ERR-2 hot loop → timeout (host terminate)', loop.error?.kind ?? '')
  const unknown = await runProgram({ program: 'return await tools.nonexist({})' , bindings })
  ok(unknown.error?.kind === 'exception' && /unknown binding/.test(unknown.error?.message ?? ''), 'ERR-3 unknown binding → exception', unknown.error?.message ?? '')
  const empty = await runProgram({ program: '' })
  ok(empty.error?.kind === 'invalid-program', 'ERR-4 empty program → invalid-program')
}

export { failures }

/**
 * Assertions — the REAL CASCADE loop (whole-stream T0..T7 as ONE conversation),
 * driven offline (scripted gateway + real projection-fold boundary mark) to
 * verify per-branch features AND the new PTC invariants in the actual loop:
 *
 *  - markCascadeBoundaries (real projection fold) cuts T0..T7 into 8 segments.
 *  - task-boundary arms compress at each segment-head boundary (E1 trigger, E2
 *    task-unit) with the PTC compressor (scripted gateway returns the REAL
 *    template programs; refs ground against the run's really-executed tools).
 *  - A1: S2 = no retain; S1 = retain (refs+outline hot-bridge node) on every
 *    compact, and the bridge node is DELETED at the next compaction.
 *  - M5 invariants: (a) the compressor request is a GENUINE PREFIX of the last
 *    routed main request (KV-cache reuse — old sections stay in the prefix, not
 *    sliced out); (b) section nodes are IMMUTABLE (byte-identical across
 *    compactions — 只增不改).
 *  - native-auto (calibrated override via runCascade forwarding) is NOT
 *    degenerate and keeps the genuine-prefix + single-node assembly.
 *
 * All offline (scripted gateway, no real model calls). Optional/lightweight.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT, createWorkspace } from '../lib/workspace.mjs'
import { runSession } from '../lib/runner.mjs'
import { markCascadeBoundaries, humanTaskStream } from '../lib/cascade.mjs'
import { createScriptedGateway } from '../lib/gateway-mock.mjs'
import { JUDGE_PLACEHOLDER } from '../lib/boundary-mark.mjs'
import { loadTask } from '../lib/tasks.mjs'
import { CHECKPOINT_PREAMBLE } from '../lib/compress.mjs'
import { TEMPLATE_S2 } from '../lib/sdk.mjs'
import { validateProductSchema } from '../lib/compressor-validate.mjs'

const tmp = path.join(EVAL_ROOT, '.assert-tmp', 'cascade')
fs.mkdirSync(tmp, { recursive: true })
let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!cond) failures++
}
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const tasks = ['T0','T1','T2','T3','T4','T5','T6','T7'].map(loadTask).filter(Boolean)

// ============ MASTER. markCascadeBoundaries = real projection fold ============
{
  function discGate() {
    let c = 0
    const dyn = (req) => {
      const msgs = req.messages
      const isDisc = msgs && msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user' && msgs[1].content === JUDGE_PLACEHOLDER
      if (!isDisc) return null
      const verdict = c <= 6 ? 'new_task' : 'continue'
      c++
      return { text: `{"decision":"${verdict}"}`, usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0 } }
    }
    return createScriptedGateway({ script: () => new Array(80).fill(dyn) })
  }
  const mark = await markCascadeBoundaries({ tasks, callLLM: discGate().chatCall, model: 'deepseek-v4-flash-vision-exp', provider: 'deepseek' })
  ok(mark.boundaries.length === 8, 'MASTER-1 real projection fold cuts T0..T7 into 8 segments', mark.boundaries.length)
  ok(mark.boundaries[7]?.startSeq === 7 && mark.boundaries[7]?.endSeq === 9, 'MASTER-2 T7 (3 messages) is ONE segment (startSeq=7 endSeq=9)', JSON.stringify(mark.boundaries[7]?.startSeq + '..' + mark.boundaries[7]?.endSeq))
  ok(mark.cost?.judgements === 9 && mark.cost?.real !== false, 'MASTER-3 real discriminator cost recorded (9 judgements)', JSON.stringify(mark.cost))
  ok(mark.verdicts.filter(v => v.verdict === 'new-task').length === 7 && mark.verdicts.filter(v => v.verdict === 'continue').length === 2, 'MASTER-4 verdicts: 7 new-task + 2 continue', `${mark.verdicts.filter(v => v.verdict === 'new-task').length}/${mark.verdicts.filter(v => v.verdict === 'continue').length}`)
}

// S1 compressor program: refs on edit AND explore (read pointer is a real truth),
// retain = the LAST ref-bearing subtask (refs+outline — the real hot bridge).
const SCRIPT_S1 = [
  'const s = await tools.probe_substructure({ taskRef: "task" })',
  'const subtasks = []',
  'for (const sub of s.subtasks) {',
  '  let refs = []',
  '  let p = null',
  '  if (sub.typeHint === "edit" || sub.typeHint === "explore") {',
  '    p = await tools.locate_change({ segmentRef: sub.spanKey, fileHint: "" })',
  '    if (p) { const v = await tools.validate_pointer({ ...p }); if (v.ok) refs = [{ refKey: sub.spanKey, ...p }] }',
  '  }',
  '  const type = sub.typeHint === "edit" ? "impl" : sub.typeHint === "verify" ? "verify" : sub.typeHint === "wrap" ? "wrap" : "plan"',
  '  const fields = type === "impl" ? { path: p?.path ?? "", lineRange: p?.lineRange ?? null, symbol: p?.symbol ?? null, change: "scripted change" }',
  '    : type === "verify" ? { command: "npm test", result: "pass" }',
  '    : type === "wrap" ? { conclusion: "scripted wrap" }',
  '    : { goal: "scripted goal" }',
  '  subtasks.push({ type, ...fields, refs })',
  '}',
  'const lastRef = subtasks.filter(st => st.refs.length > 0).pop()',
  'const retain = { refs: lastRef ? lastRef.refs.map(r => ({ path: r.path, lineRange: r.lineRange, symbol: r.symbol })) : [], outline: "scripted hot bridge" }',
  'return { total: s.subtasks.length, sections: [{ summary: "Scripted closed segment condensed for continuation.", subtasks }], retain }',
].join('\n')

// Per-arm scripted gateway: executor per stage = one REAL tool turn (read +
// write → transcript change records → grounded refs) then DONE; compressor
// calls return the REAL template programs (TEMPLATE_S2 / SCRIPT_S1).
function gate(a1, a2) {
  let toolPending = false
  let execCalls = 0
  const dyn = (req) => {
    const msgs = req.messages
    const last = msgs[msgs.length - 1]
    const content = last && last.role === 'user' && typeof last.content === 'string' ? last.content : ''
    const isComp = content.includes('COMPRESSOR SDK')
    if (isComp) return { text: a1 === 's1' ? SCRIPT_S1 : TEMPLATE_S2, usage: { inputTokens: 900, outputTokens: 300, cacheReadTokens: 0 } }
    if (toolPending) { toolPending = false; return { text: 'DONE stage', usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } } }
    toolPending = true
    execCalls++
    return { text: '', toolCalls: [
      { id: `r${execCalls}`, name: 'read', args: JSON.stringify({ path: 'package.json' }) },
      { id: `w${execCalls}`, name: 'write', args: JSON.stringify({ path: 'src/audit/x.js', content: 'function fc() {\n  return 1\n}\n' }) },
    ], usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } }
  }
  return createScriptedGateway({ script: () => new Array(400).fill(dyn) })
}

// Real boundary mark produced once (reused across runs): write as CASCADE.
const { writeBoundaries, boundaryMarkPath } = await import('../lib/boundaries.mjs')
const cascadeMarkFile = boundaryMarkPath('CASCADE')
const cascadeMarkExisted = fs.existsSync(cascadeMarkFile)
const cascadeMarkBackup = cascadeMarkExisted ? fs.readFileSync(cascadeMarkFile, 'utf8') : null
{
  const g = (() => { let c = 0; const dyn = (req) => { const msgs = req.messages; const isDisc = msgs && msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user' && msgs[1].content === JUDGE_PLACEHOLDER; if (!isDisc) return null; const verdict = c <= 6 ? 'new_task' : 'continue'; c++; return { text: `{"decision":"${verdict}"}`, usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0 } } }; return createScriptedGateway({ script: () => new Array(80).fill(dyn) }) })()
  const mark = await markCascadeBoundaries({ tasks, callLLM: g.chatCall, model: 'deepseek-v4-flash-vision-exp', provider: 'deepseek' })
  writeBoundaries('CASCADE', mark)
}

const stream = humanTaskStream(tasks)
const stagedMessages = stream.map(s => s.text)
const firstTask = tasks[0]

async function runArm(a1, a2) {
  const g = gate(a1, a2)
  const dir = path.join(tmp, `cascade-${a1}-${a2}`)
  fs.mkdirSync(dir, { recursive: true })
  const res = await runSession({
    workspace: createWorkspace(dir), taskId: 'CASCADE', task: firstTask, prompt: firstTask.prompt ?? '',
    stagedMessages, model: 'm', provider: 'x',
    transcriptPath: path.join(dir, 'tr.jsonl'), callLLM: g.chatCall,
    compression: 'task-boundary', a1, a2, maxCompressions: 99, maxSteps: 40,
  })
  return { g, res, dir }
}

/** Cache-preserving invariant (M5): the compressor input's FROZEN prefix
 * (system + immutable section nodes) must be byte-identical to the preceding
 * routed request's same prefix. The retain bridge is deleted at the compaction
 * point (its removal changes the live bytes — inherent to the design), so the
 * invariant is over the stable prefix, not the whole message list. */
function assertCachePrefix(g, label) {
  const log = g.log ?? []
  const sectionOf = (msgs) => msgs.map((m, i) => ({ i, m })).filter(x => typeof x.m?.content === 'string' && x.m.content.includes('[compressed task]'))
  const compIdx = []
  log.forEach((r, i) => {
    const ms = r.req?.messages ?? []
    const last = ms[ms.length - 1]
    if (last && last.role === 'user' && typeof last.content === 'string' && last.content.includes('COMPRESSOR SDK')) compIdx.push(i)
  })
  let allPrefix = true
  let detail = ''
  for (const ci of compIdx) {
    let prev = -1
    for (let i = ci - 1; i >= 0; i--) {
      const ms = log[i].req?.messages ?? []
      const last = ms[ms.length - 1]
      if (!(last && last.role === 'user' && typeof last.content === 'string' && last.content.includes('COMPRESSOR SDK'))) { prev = i; break }
    }
    if (prev < 0) { allPrefix = false; detail = 'no preceding request'; break }
    const got = log[ci].req.messages.slice(0, -1) // minus the appended instruction
    const want = log[prev].req.messages
    const sysOk = got.length > 0 && want.length > 0 && deepEq(got[0], want[0])
    const gotSec = sectionOf(got)
    const wantSec = sectionOf(want)
    const secOk = gotSec.length === wantSec.length && gotSec.every((s, j) => deepEq(s.m, wantSec[j].m))
    if (!sysOk || !secOk) { allPrefix = false; detail = `sections ${gotSec.length}/${wantSec.length}`; break }
  }
  ok(allPrefix, `${label} compressor input keeps the FROZEN prefix (system+sections) of the last routed request (KV-cache reuse)`, detail)
  return compIdx.length
}

/** Section nodes in `snap` are immutable: byte-identical to the SAME positions
 * in the previous snapshot (only appended, never rewritten — 只增不改). */
function assertImmutability(snaps, label) {
  const sectionIdx = (arr) => arr.map((m, i) => ({ i, m })).filter(x => typeof x.m?.content === 'string' && x.m.content.includes('[compressed task]'))
  let okAll = true
  let detail = ''
  for (let k = 1; k < snaps.length; k++) {
    const prev = sectionIdx(snaps[k - 1].after ?? [])
    const cur = sectionIdx(snaps[k].before ?? [])
    for (let j = 0; j < prev.length; j++) {
      if (prev[j].i !== cur[j].i || !deepEq(prev[j].m, cur[j].m)) { okAll = false; detail = `section[${j}] diverged between compact ${k - 1}→${k}`; break }
    }
    if (!okAll) break
  }
  ok(okAll, `${label} section nodes immutable across compactions (只增不改)`, detail)
}

// ============ S2-ORIG. compress every closed segment; E1/E2/A1-S2; no retain ============
{
  const { g, res, dir } = await runArm('s2', 'keep-original')
  const tc = res.transcript.filter(e => e.type === 'task-compact')
  ok(res.compression?.mode === 'task-boundary', 'S2O-1 task-boundary trigger (E1)', res.compression?.mode)
  ok(tc.length === 7 && tc.every(e => typeof e.segmentIndex === 'number'), 'S2O-2 compresses at every closed-task boundary (E2 task-unit)', tc.length)
  ok(tc.length > 0 && tc.every(e => e.retainedTokens === 0 && e.retain !== true), 'S2O-3 A1-S2 闭合即全压: every compact no retain (E3)', tc.length)
  ok(!res.violations.some(v => v.includes('compression-failed')), 'S2O-4 PTC program ran + gates passed (no compression-failed)')
  const cdir = path.join(dir, 'compressed')
  const prods = fs.existsSync(cdir) ? fs.readdirSync(cdir).filter(f => f.startsWith('P-') && f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(cdir, f), 'utf8'))) : []
  ok(prods.length === 7 && prods.every(p => Array.isArray(p.sections) && validateProductSchema(p).length === 0 && !p.retain), 'S2O-5 persisted products = 总-分 sections (no retain)', prods.length)
  const cacheCalls = assertCachePrefix(g, 'S2O-6')
  ok(cacheCalls === 7, 'S2O-7 seven compressor calls', cacheCalls)
  assertImmutability(res.compressSnapshots ?? [], 'S2O-8')
}

// ============ S2-EXPAND. harness-side expand (refs get content) ============
{
  const { g, res, dir } = await runArm('s2', 'expand')
  const tc = res.transcript.filter(e => e.type === 'task-compact')
  ok(tc.length === 7, 'S2X-1 方案1 compresses every closed segment', tc.length)
  ok(!res.violations.some(v => v.includes('compression-failed')), 'S2X-2 program + gates pass (no compression-failed)')
  const cdir = path.join(dir, 'compressed')
  const prods = fs.existsSync(cdir) ? fs.readdirSync(cdir).filter(f => f.startsWith('P-') && f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(cdir, f), 'utf8'))) : []
  ok(prods.length === 7 && prods.every(p => Array.isArray(p.sections)), 'S2X-3 persisted products = sections', prods.length)
  const anyContent = prods.some(p => (p.sections ?? []).some(s => (s.subtasks ?? []).some(b => (b.refs ?? []).some(r => typeof r.content === 'string' && r.content.length > 0))))
  ok(anyContent, 'S2X-4 expand = harness-resolved content on refs')
  assertCachePrefix(g, 'S2X-5')
}

// ============ S1: every compact retains a hot-bridge node; deleted at next ============
{
  const { g, res, dir } = await runArm('s1', 'keep-original')
  const tc = res.transcript.filter(e => e.type === 'task-compact')
  ok(tc.length === 7, 'S1-1 A1-S1 compacts at every closed boundary (same count as S2)', tc.length)
  ok(tc.length > 0 && tc.every(e => e.retain === true) && tc.some(e => e.retainedTokens > 0), 'S1-2 A1-S1 引用化保尾: every compact retains (refs+outline)', JSON.stringify(tc[0] ?? {}))
  const snaps = res.compressSnapshots ?? []
  ok(snaps.some(s => s.after.some(m => typeof m.content === 'string' && m.content.includes('[热桥接 retain]'))), 'S1-3 retain bridge node rendered into the context')
  // F11a one-shot lifecycle (post cache-alignment fix): the OLD bridge is still
  // in the surface DURING the compressor call — snapshot.before legitimately
  // contains it, because the replay must stay a byte-aligned super-prefix of
  // the last routed request (measured mtng8ctd: aligned seg3 96% cache hit vs
  // bridge-spliced seg4 1,024 tok head-only). The invariants that matter:
  // at most ONE live bridge at any moment (the old one is spliced out right
  // after the call, before the new one is attached) — never re-fed twice.
  const bridgeCount = (msgs) => msgs.filter(m => typeof m.content === 'string' && m.content.includes('[热桥接 retain]')).length
  ok(snaps.length >= 2 && snaps.every(s => bridgeCount(s.before) <= 1 && bridgeCount(s.after) <= 1), 'S1-4 at most one live retain bridge at any time (one-shot lifecycle)', `snaps=${snaps.length}`)
  assertImmutability(snaps, 'S1-5')
}

// ============ NATIVE-AUTO: calibrated override → not degenerate, assembly intact ============
{
  const NA8 = ['Primary Request and Intent','Key Technical Concepts','Files and Code','Errors and Fixes','Pending Jobs','Current Work','Next Step','Critical Context'].map(s => `## ${s}\n- x`).join('\n')
  let toolPending = false
  const dyn = (req) => {
    const msgs = req.messages
    const last = msgs[msgs.length - 1]
    const content = last && last.role === 'user' && typeof last.content === 'string' ? last.content : ''
    if (content.startsWith('You are now acting as a compaction engine')) return { text: NA8, usage: { inputTokens: 900, outputTokens: 60, cacheReadTokens: 0 } }
    if (toolPending) { toolPending = false; return { text: 'DONE stage', usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } } }
    toolPending = true
    return { text: '', toolCalls: [{ id: 'n1', name: 'read', args: JSON.stringify({ path: 'package.json' }) }], usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } }
  }
  const g = createScriptedGateway({ script: () => new Array(400).fill(dyn) })
  const dir = path.join(tmp, 'cascade-native')
  fs.mkdirSync(dir, { recursive: true })
  const res = await runSession({
    workspace: createWorkspace(dir), taskId: 'CASCADE', task: firstTask, prompt: firstTask.prompt ?? '',
    stagedMessages: stagedMessages.map(m => m + ' ' + 'z'.repeat(3000)),
    model: 'm', provider: 'x', transcriptPath: path.join(dir, 'tr.jsonl'), callLLM: g.chatCall,
    compression: 'native-auto', calibrated: { retainTokens: 50, thresholdTokens: 500, domain: 1000 }, maxCompressions: 2, maxSteps: 20,
  })
  ok(res.compression.count >= 1 && res.compression.degenerate === false, 'NAT-1 native-auto (calibrated override) compresses, not degenerate', `${res.compression.count}/${res.compression.degenerate}`)
  const snaps = res.compressSnapshots ?? []
  ok(snaps.length === res.compression.count, 'NAT-2 one snapshot per successful compression', `${snaps.length}/${res.compression.count}`)
  const isComp = r => { const ms = r.req?.messages ?? []; const last = ms[ms.length - 1]; return last && last.role === 'user' && typeof last.content === 'string' && last.content.startsWith('You are now acting as a compaction engine') }
  const compReq = g.log.filter(isComp).map(r => r.req.messages.slice(0, -1))
  if (snaps.length && compReq.length) {
    const { start, end } = snaps[0].range ?? {}
    const before = snaps[0].before ?? []
    const want = before.slice(0, end + 1)
    const got = compReq[0] ?? []
    let div = -1
    while (div + 1 < Math.min(got.length, want.length) && deepEq(got[div + 1], want[div + 1])) div++
    ok(div + 1 === got.length && got.length <= want.length, 'NAT-3 compressor request is a genuine PREFIX (KV-cache reuse)', `got=${got.length} want=${want.length}`)
    const node = snaps[0].after?.[start]
    const content = typeof node?.content === 'string' ? node.content : ''
    const open = (content.match(/<compacted-summary>/g) || []).length
    const close = (content.match(/<\/compacted-summary>/g) || []).length
    ok(node?.role === 'user' && content.startsWith(CHECKPOINT_PREAMBLE) && open === 1 && close === 1, 'NAT-4 checkpoint = ONE framed <compacted-summary> node', `open=${open} close=${close}`)
  } else {
    ok(snaps.length > 0, 'NAT-3/4 native-auto has snapshots', '')
  }
}

// Restore the CASCADE boundary mark so this test never pollutes a real runCascade.
if (cascadeMarkExisted) fs.writeFileSync(cascadeMarkFile, cascadeMarkBackup)
else if (fs.existsSync(cascadeMarkFile)) fs.rmSync(cascadeMarkFile)

export { failures }

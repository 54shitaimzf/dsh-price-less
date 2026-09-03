/**
 * V5 短真实流程复核 + 真实 I/O 审查 (audit-compression).
 *
 * A mini 3-segment cascade over a REAL workspace with REAL file changes:
 *   executor = scripted (deterministic tools: read big file → write fixed
 *              src/auth.js → real test run) so the transcript/change records
 *              are real and grounded; compressor = REAL gateway (DeepSeek official direct)
 *              (the model writes the PTC program; runProgram executes it; all
 *              mechanical gates run).
 *
 * Coverage matrix (each refactor point ↔ check, printed PASS/FAIL):
 *   M0 严格原生对照   — native-auto surface includes the task (range.start ≥ 1)
 *   M1 一次完成       — exactly 1 model call + 1 code run per compression
 *   M2 总-分/指针     — schema valid; refs grounded (PTR-EXIST + PTR-TRUTH)
 *   M2 展开=harness   — expand sample: refs carry resolved content
 *   M3 压缩比         — region ≥ minRegionTokens → ratio verdict recorded
 *   M4 S1 引用化保尾  — retain node rendered; DELETED at the next compaction
 *   M4 S2 无保留      — no retain node
 *   M5 缓存+不可变    — compressor request starts with the last routed request;
 *                       section nodes byte-identical across compactions
 *   OUT 无原文泄漏    — no raw echo markers in any product
 *
 * Prints a structured I/O ledger (per stage: inputs/outputs/sizes/usage) for
 * human review. Exit 0 = all coverage PASS.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EVAL_ROOT, createWorkspace } from '../lib/workspace.mjs'
import { createGateway } from '../lib/gateway.mjs'
import { createScriptedGateway } from '../lib/gateway-mock.mjs'
import { runSession } from '../lib/runner.mjs'
import { writeBoundaries } from '../lib/boundaries.mjs'
import { validateProductSchema, checkRatio, checkRetention, DEFAULT_RATIO } from '../lib/compressor-validate.mjs'
import { clusterSubtasks, computePointers, verifyRefGroundTruth, rawEchoMarkers, findRawEcho } from '../lib/compressor-io.mjs'
import { estimateTokens } from '../lib/prefix.mjs'

const MODEL = process.env.COMPRESSOR_CHECK_MODEL ?? 'deepseek-v4-flash-vision-exp'
const gateway = createGateway()
let failures = 0
const report = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const AUDIT_FIXED_AUTH = 'function checkAuth(user, token) {\n  if (!user || !token) {\n    throw new Error(\'missing credentials\')\n  }\n  return token === user.secret\n}\n'

function mkWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ws-'))
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'tests'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'src', 'auth.js'), 'function checkAuth(user, token) {\n  return token === user.secret\n}\n')
  fs.writeFileSync(path.join(ws, 'src', 'big.txt'), 'x'.repeat(60000)) // region ≥ minRegionTokens → ratio gate ACTIVE
  fs.writeFileSync(path.join(ws, 'tests', 'auth.test.js'), [
    "const { test } = require('node:test')",
    "const assert = require('node:assert')",
    "const { checkAuth } = require('../src/auth.js')",
    "test('rejects missing credentials', () => { assert.throws(() => checkAuth(null, 'x')) })",
    '',
  ].join('\n'))
  return ws
}

// Scripted executor: ONE real tool turn (read big → write fixed auth → run tests)
// then DONE per stage. Compressor branch = REAL gateway.
function makeGate() {
  let toolPending = false
  let n = 0
  const dyn = async (req) => {
    const msgs = req.messages
    const last = msgs[msgs.length - 1]
    const content = last && last.role === 'user' && typeof last.content === 'string' ? last.content : ''
    if (content.includes('COMPRESSOR SDK')) {
      // REAL compressor call — the model writes the program against the SDK.
      // Forward the SAME tool schemas as the routed request (wire-prefix cache
      // alignment: dropping tools diverges the provider cache at the tools
      // position — observed compressor cacheRead 128 vs ~3k before the fix).
      return gateway.chatCall({ provider: 'deepseek', model: MODEL, messages: msgs, tools: req.tools, maxTokens: 16000, timeoutMs: 600000 })
    }
    if (toolPending) { toolPending = false; return { text: 'DONE: fixed the auth guard; tests pass', usage: { inputTokens: 500, outputTokens: 30, cacheReadTokens: 0 } } }
    toolPending = true
    n++
    return {
      text: '',
      toolCalls: [
        { id: `r${n}`, name: 'read', args: JSON.stringify({ path: 'src/big.txt' }) },
        { id: `w${n}`, name: 'write', args: JSON.stringify({ path: 'src/auth.js', content: AUDIT_FIXED_AUTH }) },
        { id: `t${n}`, name: 'run', args: JSON.stringify({ command: 'node --test tests/auth.test.js' }) },
      ],
      usage: { inputTokens: 500, outputTokens: 60, cacheReadTokens: 0 },
    }
  }
  return createScriptedGateway({ script: () => new Array(200).fill(dyn) })
}

async function runArm(a1, a2, label) {
  console.log(`\n───────── ${label} (a1=${a1} a2=${a2}) ─────────`)
  const ws = mkWorkspace()
  const g = makeGate()
  const dir = path.join(EVAL_ROOT, '.assert-tmp', 'audit', `${a1}-${a2}`)
  fs.mkdirSync(dir, { recursive: true })
  writeBoundaries('AUDIT', {
    source: 'premark',
    cost: { usage: { inputTokens: 40, outputTokens: 0, cacheReadTokens: 0, calls: 3 }, usd: 0.0004, model: 'm', provider: 'p' },
    boundaries: [
      { segmentIndex: 0, taskId: 'a0', startSeq: 0, endSeq: 0, status: 'closed' },
      { segmentIndex: 1, taskId: 'a1', startSeq: 1, endSeq: 1, status: 'closed' },
      { segmentIndex: 2, taskId: 'a2', startSeq: 2, endSeq: 2, status: 'active' },
    ],
  })
  const staged = ['Fix the auth bug in src/auth.js so tests pass.', 'Verify the fix and confirm both tests pass.', 'Now add a test for a malformed token.']
  const res = await runSession({
    workspace: ws, taskId: 'AUDIT', task: { id: 'AUDIT', title: 'audit' }, prompt: staged[0],
    stagedMessages: staged, model: MODEL, provider: 'deepseek',
    transcriptPath: path.join(dir, 'tr.jsonl'), callLLM: g.chatCall,
    compression: 'task-boundary', a1, a2, maxCompressions: 99, maxSteps: 20,
  })
  // --- I/O ledger ---
  const compLog = g.log.filter(r => {
    const ms = r.req?.messages ?? []; const last = ms[ms.length - 1]
    return last && last.role === 'user' && typeof last.content === 'string' && last.content.includes('COMPRESSOR SDK')
  })
  console.log('  [ledger] compressor calls:')
  compLog.forEach((r, i) => {
    const msgTok = estimateTokens(JSON.stringify(r.req?.messages ?? []))
    console.log(`    #${i}: reqMsgs=${r.req?.messages?.length ?? 0} reqTok≈${msgTok} outTok=${r.resp?.usage?.outputTokens ?? '-'} cacheRead=${r.resp?.usage?.cacheReadTokens ?? '-'} programLen=${r.resp?.text?.length ?? 0}`)
  })
  const tc = res.transcript.filter(e => e.type === 'task-compact')
  console.log(`  [ledger] task-compacts=${tc.length} compressEvent=${JSON.stringify(res.compression)}`)
  console.log(`  [ledger] violations=${JSON.stringify(res.violations)}`)
  console.log(`  [ledger] gateway-errors=${JSON.stringify(res.transcript.filter(e => e.type === 'gateway-error'))}`)
  tc.forEach(e => console.log(`    seg=${e.segmentIndex} retain=${e.retain ?? false} retainedRefs=${e.retainedTokens} ratio=${e.ratioVerdict}/${e.ratio ?? ''} sections=${e.sections}`))
  const snaps = res.compressSnapshots ?? []
  console.log(`  [ledger] snapshots=${snaps.length} (section nodes: ${snaps.map(s => (s.after ?? []).filter(m => (m.content ?? '').includes('[compressed task]')).length).join(',')})`)

  // --- one-shot (M1): exactly 1 model call + 1 run (program) per compression ---
  report(compLog.length === tc.length && tc.length === 2, `${label} M1: one model call + one run per compression (2 compressions)`, `calls=${compLog.length} compacts=${tc.length}`)
  report(compLog.every(r => typeof r.resp?.text === 'string' && r.resp.text.trim().length > 20), `${label} M1: model wrote a program (not JSON/free text)`)

  // --- M5 cache: the compressor input keeps the FROZEN prefix (system+sections)
  // byte-identical to the preceding routed request (the retain bridge deletion at
  // the compaction point changes live bytes — inherent; the stable prefix is what
  // the provider cache covers) ---
  const sectionOf = (msgs) => msgs.map((m, i) => ({ i, m })).filter(x => typeof x.m?.content === 'string' && x.m.content.includes('[compressed task]'))
  let cacheOk = true
  let cacheDetail = ''
  for (const ci of compLog) {
    const idx = g.log.indexOf(ci)
    let prev = null
    for (let i = idx - 1; i >= 0; i--) {
      const last = g.log[i].req?.messages?.[g.log[i].req.messages.length - 1]
      if (!(last?.role === 'user' && last.content?.includes('COMPRESSOR SDK'))) { prev = g.log[i]; break }
    }
    if (!prev) { cacheOk = false; cacheDetail = 'no preceding'; break }
    const got = ci.req.messages.slice(0, -1)
    const want = prev.req.messages
    const sysOk = got[0] && want[0] && deepEq(got[0], want[0])
    const gotSec = sectionOf(got)
    const wantSec = sectionOf(want)
    // Wire prefix = system + TOOLS + messages: the routed request carries the
    // tool schemas; the compressor request must carry the same (else the
    // provider cache diverges at the tools position).
    const toolsOk = !!ci.req.tools === !!prev.req.tools
    if (!sysOk || !toolsOk || gotSec.length !== wantSec.length || !gotSec.every((s, j) => deepEq(s.m, wantSec[j].m))) { cacheOk = false; cacheDetail = `tools=${toolsOk} sections ${gotSec.length}/${wantSec.length}`; break }
  }
  report(cacheOk, `${label} M5: compressor request keeps the FROZEN wire prefix (system+tools+sections) of the last routed request`, cacheDetail)

  // --- M5 immutable sections (只增不改) ---
  let immOk = true
  for (let k = 1; k < snaps.length; k++) {
    const prev = (snaps[k - 1].after ?? []).filter(m => (m.content ?? '').includes('[compressed task]'))
    const cur = (snaps[k].before ?? []).filter(m => (m.content ?? '').includes('[compressed task]'))
    if (!deepEq(prev, cur)) { immOk = false; break }
  }
  report(immOk, `${label} M5: section nodes immutable across compactions`)

  // --- M2 总-分 + schema (read the audited products from disk) ---
  const cdir = path.join(dir, 'compressed')
  const prods = fs.existsSync(cdir) ? fs.readdirSync(cdir).filter(f => f.startsWith('P-') && f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(cdir, f), 'utf8'))) : []
  report(prods.length === tc.length && prods.every(p => Array.isArray(p.sections) && validateProductSchema(p).length === 0), `${label} M2: products = 总-分 sections (schema 通过)`, prods.length)
  report(prods.every(p => validateProductSchema(p).length === 0), `${label} M2: schema valid on every audited product`)
  // refs grounded per product (each compression is its OWN namespace — two closed
  // segments may legitimately reference the same real change record)
  const entries = res.transcript ?? []
  const pointers = computePointers({ transcript: entries, workspace: ws })
  const truthAll = prods.flatMap((p, pi) => {
    const refs = (p.sections ?? []).flatMap(s => (s.subtasks ?? []).flatMap(b => b.refs ?? []))
    return verifyRefGroundTruth(refs, pointers).map(x => `P-${pi + 1}: ${x}`)
  })
  report(truthAll.length === 0, `${label} M2: PTR-TRUTH per product — every ref grounded in a real change record (${pointers.length} truth records)`, truthAll.slice(0, 2).join('; '))
  const markers = rawEchoMarkers({ transcript: entries, workspace: ws })
  const echo = prods.flatMap(p => findRawEcho(p, markers))
  report(echo.length === 0, `${label} OUT: no raw echo in any product`, echo.slice(0, 1).join(' | '))
  // expand: refs carry harness-resolved content
  if (a2 === 'expand') {
    const anyContent = prods.some(p => (p.sections ?? []).some(s => (s.subtasks ?? []).some(b => (b.refs ?? []).some(r => typeof r.content === 'string' && r.content.length > 0))))
    report(anyContent, `${label} M2-expand: refs carry harness-resolved content (models never embed)`)
  } else {
    report(prods.every(p => (p.sections ?? []).every(s => (s.subtasks ?? []).every(b => (b.refs ?? []).every(r => !('content' in r))))), `${label} M2-orig: refs stay coordinates (no content)`)
  }
  // --- M3 ratio: region ≥ minRegionTokens → a ratio verdict was recorded ---
  const ratioEntries = tc.filter(e => typeof e.ratioVerdict === 'string' && e.ratioVerdict !== 'skip')
  report(ratioEntries.length >= 1 && ratioEntries.every(e => e.ratioVerdict !== 'fail'), `${label} M3: ratio gate evaluated (non-skip) and no fail-lazy`, ratioEntries.map(e => `${e.ratioVerdict}/${e.ratio}`).join(', '))
  // --- M4 retention lifecycle ---
  if (a1 === 's1') {
    report(tc.every(e => e.retain === true), `${label} M4-S1: every compact carries retain`)
    report(snaps.some(s => (s.after ?? []).some(m => (m.content ?? '').includes('[热桥接 retain]'))), `${label} M4-S1: retain bridge node rendered into the context`)
    report(snaps.length >= 2 && snaps.slice(1).every(s => !(s.before ?? []).some(m => (m.content ?? '').includes('[热桥接 retain]'))), `${label} M4-S1: old retain bridge DELETED at the next compaction (never re-fed)`)
  } else {
    report(snaps.every(s => !(s.after ?? []).some(m => (m.content ?? '').includes('[热桥接 retain]'))), `${label} M4-S2: no retain node anywhere`)
  }
  return res
}

// M0: native-auto range includes the task (strict native head-anchoring)
{
  const { selectCompactableRange } = await import('../lib/native-range.mjs')
  const surface = [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'a' }, { role: 'assistant', content: 'b' }]
  const r = selectCompactableRange(surface, 1)
  report(r !== null && r.startIdx === 0, 'M0: native range is head-anchored from surface[0] (the task); runner maps it to messages.slice(1)')
}

await runArm('s2', 'keep-original', 'S2-ORIG')
await runArm('s1', 'expand', 'S1-EXPAND')

console.log(`\n${failures === 0 ? 'ALL AUDIT CHECKS PASS' : `${failures} AUDIT CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

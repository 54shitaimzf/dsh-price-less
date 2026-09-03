/**
 * V0 下半段 — 小样真实 LLM 检查 (direct compressor check).
 *
 * Runs the REAL compressor flow end-to-end against the REAL gateway + the
 * fixture (augmented with a large read so the ratio gate is active): model
 * writes the PTC program → runProgram executes it → mechanical gates validate.
 *
 * Modes checked: s2:keep-original / s2:expand / s1:keep-original / s1:expand.
 * Gate: every sample must compile+run, pass schema, PTR-TRUTH, OUT, retention,
 * and the ratio gate must NOT be 'fail'. Exit 0 = all PASS.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EVAL_ROOT } from '../lib/workspace.mjs'
import { createGateway } from '../lib/gateway.mjs'
import { runProgram, DEFAULT_CODE_RUN } from '../lib/code-run.mjs'
import { makeCompressorBindings, computePointers, verifyRefGroundTruth, rawEchoMarkers, findRawEcho, clusterSubtasks } from '../lib/compressor-io.mjs'
import { validateProductSchema, checkRatio, checkRetention, collectRefs, DEFAULT_RATIO } from '../lib/compressor-validate.mjs'
import { estimateTokens } from '../lib/prefix.mjs'
import { buildCompressorMessages } from '../lib/compressor-prompt.mjs'

const fixture = path.join(EVAL_ROOT, 'tests', 'fixtures', 'template-battery')
const fixtureWorkspace = path.join(fixture, 'workspace')
const baseTranscript = JSON.parse(fs.readFileSync(path.join(fixture, 'transcript.json'), 'utf8')).entries

// Augment with a LARGE read (real tasks carry tens-of-K-token context) so the
// ratio gate is active (region ≥ minRegionTokens) instead of skipping.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-'))
fs.cpSync(fixtureWorkspace, workspace, { recursive: true })
fs.writeFileSync(path.join(workspace, 'src', 'big.txt'), 'x'.repeat(60000))
const bigRead = { type: 'assistant', content: '', toolCalls: [{ id: 'call-big', name: 'read', args: { path: 'src/big.txt' } }] }
const bigTool = { type: 'tool', tool: 'read', arg: { path: 'src/big.txt' }, result: 'x'.repeat(60000) }
const transcript = [...baseTranscript.slice(0, 4), bigRead, bigTool, ...baseTranscript.slice(4)]

const ctx = { taskId: 'auth-fixture', transcript, workspace }
const bindings = makeCompressorBindings(ctx)
const pointers = computePointers(ctx)
const markers = rawEchoMarkers(ctx)
const rawWorkText = await bindings.read_transcript({ segmentRef: 'task' })
const regionTokens = estimateTokens(rawWorkText)
const subtasks = clusterSubtasks(transcript)

const gateway = createGateway()
const MODEL = process.env.COMPRESSOR_CHECK_MODEL ?? 'deepseek-v4-flash-vision-exp'
const SAMPLES = [
  { label: 'S2 × keep-original', a1: 's2', a2: 'keep-original' },
  { label: 'S2 × expand', a1: 's2', a2: 'expand' },
  { label: 'S1 × keep-original', a1: 's1', a2: 'keep-original' },
  { label: 'S1 × expand', a1: 's1', a2: 'expand' },
]

let failures = 0
const report = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

console.log(`direct compressor check: model=${MODEL} regionTokens≈${regionTokens} subtasks=${subtasks.length}`)
console.log(`  rawWork chars=${rawWorkText.length} gate: minRegionTokens=${DEFAULT_RATIO.minRegionTokens} → ratio gate ${regionTokens >= DEFAULT_RATIO.minRegionTokens ? 'ACTIVE' : 'SKIP'}`)

for (const sample of SAMPLES) {
  console.log(`\n=== ${sample.label} (${sample.a1}/${sample.a2}) ===`)
  let call
  try {
    call = await gateway.chatCall({
      provider: 'deepseek', model: MODEL,
      messages: buildCompressorMessages({ rawWorkText, a1: sample.a1, a2: sample.a2 }),
      maxTokens: 16000, timeoutMs: 600000,
    })
  } catch (e) {
    report(false, 'LLM call', String(e.message ?? e))
    continue
  }
  const program = call.text
  report(typeof program === 'string' && program.trim().length > 20, 'model returned a program', `len=${program?.length ?? 0} usage=${JSON.stringify(call.usage ?? {})}`)

  const DIAG = (reason) => {
    if (reason) console.log('    └─ program snippet:\n' + String(program ?? '').split('\n').slice(0, 40).map(l => '      ' + l).join('\n'))
  }

  const r = await runProgram({ program, bindings })
  const runExtra = r.error ? `${r.error.kind}: ${r.error.message}` : `value=${r.value ? 'ok' : 'none'}`
  report(!r.error, 'program compiles + runs once', runExtra)
  if (r.error) { DIAG('run error'); continue }

  const product = r.value
  if (!product || typeof product !== 'object') { report(false, 'schema: 总-分 valid', 'value is not a product object — did the program return?'); DIAG('no product'); continue }
  const schema = validateProductSchema(product)
  if (schema.length > 0) DIAG('schema')
  report(schema.length === 0, 'schema: 总-分 valid', schema.slice(0, 2).join('; '))

  const truth = verifyRefGroundTruth(collectRefs(product), pointers)
  if (truth.length > 0) DIAG('ptr-truth')
  report(truth.length === 0, 'PTR-TRUTH: refs grounded', truth.slice(0, 2).join('; '))

  const echo = findRawEcho(product, markers)
  if (echo.length > 0) DIAG('out')
  report(echo.length === 0, 'OUT: no raw echo', echo.slice(0, 2).join(' | '))

  const ratio = checkRatio({
    productTokens: estimateTokens(JSON.stringify({ total: product.total, sections: product.sections })),
    regionTokens,
  })
  report(ratio.verdict !== 'fail' && ratio.verdict !== 'no-region', `RATIO: ${ratio.verdict}`, ratio.ratio !== null ? `ratio=${ratio.ratio}` : '')

  if (product.retain !== undefined) {
    const ret = checkRetention(product.retain)
    report(ret.ok, 'RET: retain passes gate (S1)', ret.reason ?? '')
  } else {
    report(sample.a1 === 's2', 'RET: no retain for S2', '')
  }
}

console.log(`\n${failures === 0 ? 'ALL DIRECT CHECKS PASS' : `${failures} DIRECT CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

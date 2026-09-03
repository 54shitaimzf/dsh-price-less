/**
 * Assertions — parsers, scoring math, products (sections C, D, E, F, H, I, J,
 * K, L, M). Run via lib/assert.mjs (aggregator); also runnable standalone.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT, createWorkspace } from '../lib/workspace.mjs'
import { parseJudgeJson, collectCandidates } from '../lib/judge.mjs'
import { matchReview, loadGoldenBugs } from '../lib/mech.mjs'
import { assemble, parseHumanCsv } from '../lib/score.mjs'
import { ALLOW } from '../lib/allow.mjs'
import { listFiles } from '../lib/workspace.mjs'

const tasksDir = path.join(EVAL_ROOT, 'tasks')
const tmp = path.join(EVAL_ROOT, '.assert-tmp')
let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!cond) failures++
}

// ============ C. judge parsers ============
{
  const shaped = {
    dims: { correctness: { score: 5, why: 'correct' } },
    antiCheat: { verdict: 'none' },
    notes: 'solid',
  }
  const textA = 'thinking here\n```json\n' + JSON.stringify(shaped) + '\n```'
  const pA = parseJudgeJson(textA, ['correctness'])
  ok(pA?.dims?.correctness?.score === 5, 'C1 parseJudgeJson shape A (dims-wrapped) via fence+prefix', JSON.stringify(pA?.dims))
  ok(pA?.antiCheat?.verdict === 'none' && pA?.notes === 'solid', 'C2 antiCheat/notes survive parse A')

  const flat = {
    tone: { score: 4, why: 'ok' },
    fit: { score: 4, why: 'ok' },
    accuracy: { score: 5, why: 'ok' },
    antiCheat: { verdict: 'none', evidence: 'x' },
    notes: 'fine',
  }
  const pB = parseJudgeJson('thinking...\n' + JSON.stringify(flat), ['tone', 'fit', 'accuracy'])
  ok(pB?.tone?.score === 4 && pB?.notes === 'fine', 'C3 parseJudgeJson shape B (flat) with dimIds', JSON.stringify(Object.keys(pB ?? {})))
  const pB2 = parseJudgeJson(JSON.stringify(flat), ['tone', 'fit', 'accuracy', 'nonexistent'])
  ok(pB2 === null, 'C4 flat shape rejected when dimIds not covered')

  const inner = '{ "a": 1 } then ' + JSON.stringify(shaped)
  const pC = parseJudgeJson(inner, ['correctness'])
  ok(pC?.dims?.correctness?.score === 5, 'C5 brace-balanced scan picks the real JSON over an inner object')

  const cands = collectCandidates('{}{"x":1}{"y":{"z":2}}')
  ok(cands.length === 4 && JSON.parse(cands[2]).y.z === 2, 'C6 collectCandidates returns every balanced block', `n=${cands.length}`)
  const fakeFlat = parseJudgeJson(JSON.stringify({ correctness: { score: 5, why: 'x' } }), ['correctness'])
  ok(fakeFlat === null, 'C8 inner dim object without antiCheat/notes rejected (shape-B guard)')

  const pD = parseJudgeJson(JSON.stringify({ tone: { score: 5, why: 'ok' }, antiCheat: { verdict: 'none' }, notes: 'n' }), ['tone'])
  ok(pD?.tone?.score === 5, 'C7 single-dim flat shape with response keys parsed (regression: no dims-undefined)')
}

// ============ D. review matcher ============
{
  const goldenWs = createWorkspace(path.join(tmp, 'review'))
  fs.copyFileSync(path.join(EVAL_ROOT, 'answers', 'golden-docs', 'REVIEW.md'), path.join(goldenWs, 'REVIEW.md'))
  const m = matchReview(goldenWs)
  const golden = loadGoldenBugs()
  ok(m.hitCount === golden.bugs.length + (golden.observation ? 1 : 0), 'D1 golden REVIEW hits all bugs+observation', `hits=${m.hitCount}`)
  ok(m.falsePositives === 0, 'D2 golden REVIEW zero false positives', `fp=${m.falsePositives}`)

  const bs = createWorkspace(path.join(tmp, 'blank-review'))
  const mb = matchReview(bs)
  ok(mb.hitCount === 0, 'D3 blank REVIEW zero hits')
}

// ============ E. human CSV parser ============
{
  const csv = [
    'task,dim,name,weight,score(0..5 absolute),notes',
    'T5,copy,"文案表达（语气/可读/像真实发布说明）",40,4,语气不错',
    'T6,manualReadability,"手册可读性",20,1,太密了',
    'T3,visual,"面板视觉观感",30,,—',
  ].join('\n')
  const file = path.join(tmp, 'human.csv')
  fs.writeFileSync(file, csv)
  const parsed = parseHumanCsv(file)
  ok(parsed?.length === 2, 'E1 CSV parse keeps only scored rows', `n=${parsed?.length}`)
  ok(parsed?.[0]?.task === 'T5' && parsed[0].delta === 4 && parsed[0].weight === 40, 'E2 row fields correct')
  ok(parsed?.[1]?.task === 'T6' && parsed[1].delta === 1, 'E3 low delta parsed')
}

// ============ F. scoring assemble (human track retired: mech + judge) ============
{
  const task = JSON.parse(fs.readFileSync(path.join(tasksDir, 'T5-copy.json'), 'utf8'))
  const mech = { score: 100, violations: [] }
  const judge = { score: 84, antiCheat: { verdict: 'none' } }
  const humans = [{ task: 'T5', dim: 'copy', weight: 40, delta: 4, notes: '' }]
  const s = assemble(task, mech, judge, humans, [])
  // T5 track 35/65: mech 100*0.35 + judge 84*0.65 = 35 + 54.6 = 89.6 → 90
  ok(s.total === 90, 'F1 assemble full math (mech+judge, human ignored)', `total=${s.total}`)
  ok(!('human' in s) && !('humanPending' in s), 'F2 retired: no human fields in assemble output')

  const s2 = assemble(task, mech, judge, [], [])
  ok(s2.total === 90, 'F3 no human rows → same total (track.human=0)', `total=${s2.total}`)

  const tampered = assemble(task, { score: 100, violations: ['tests-tampered'] }, judge, [], [])
  ok(tampered.total === 0, 'F4 tests-tampered zeroes score')

  const highJudge = { score: 100, antiCheat: { verdict: 'none' } }
  const overflow = assemble(task, { score: 100, violations: ['scope-violation:a/b'] }, highJudge, [], [])
  // 35 + 65 = 100 would-be total; cap keeps ≤ 60
  ok(overflow.total === 60, 'F5 scope-violation caps at 60', `total=${overflow.total}`)

  const proven = assemble(task, { score: 100, violations: [] }, { score: 80, antiCheat: { verdict: 'proven' } }, [], [])
  // 35 + 52 = 87, then −20 → 67
  ok(proven.total === 67, 'F6 antiCheat proven −20pp', `total=${proven.total}`)

  const readonly = assemble(task, { score: 100, violations: ['readonly-violation'] }, judge, [], [])
  ok(readonly.total === 85, 'F7 readonly −5pp (90−5)', `total=${readonly.total}`)
}

// ============ H. human dims wiring (regression: long-id keys crashed T3/T7) ============
{
  const src = fs.readFileSync(path.join(EVAL_ROOT, 'lib', 'human-packet.mjs'), 'utf8')
  ok(!/T\d-[a-z]+['"]/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'H1 no long-id keys (T3-frontend etc.) remain in human-packet')
  const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'))
  let allOk = true
  const missing = []
  for (const f of taskFiles) {
    const task = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'))
    if ((task.track.human ?? 0) > 0) {
      const hasKey = new RegExp(`['"]${task.id}['"]\\s*:`).test(src)
      if (!hasKey) { allOk = false; missing.push(task.id) }
    }
  }
  ok(allOk, 'H2 every task with human track has a HUMAN_DIMS key', `missing=${missing.join(',') || '(none)'}`)
}

// ============ I. task definitions: every task needs a prompt or staged messages ============
{
  const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'))
  let allOk = true
  const bad = []
  for (const f of taskFiles) {
    const task = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'))
    const promptOk = typeof task.prompt === 'string' && task.prompt.trim().length > 0
    const stagedOk = Array.isArray(task.messages) && task.messages.length > 0 && task.messages.every(m => typeof m === 'string' && m.trim().length > 0)
    if (!promptOk && !stagedOk) { allOk = false; bad.push(task.id) }
  }
  ok(allOk, 'I1 every task has non-empty prompt or staged messages', `bad=${bad.join(',') || '(none)'}`)
}

// ============ J. rubric integrity: code tasks carry codeQuality+architecture, weights sum to 1 ============
{
  const CODE_TASKS = ['T3', 'T4', 'T7']
  const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'))
  let allOk = true
  const problems = []
  for (const f of taskFiles) {
    const task = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'))
    if (!task.rubric || task.rubric.dims.length === 0) continue
    const ids = task.rubric.dims.map(d => d.id)
    const wsum = task.rubric.dims.reduce((a, d) => a + d.weight, 0)
    if (Math.abs(wsum - 1) > 1e-9) { allOk = false; problems.push(`${task.id}: weights sum ${wsum}`) }
    if (CODE_TASKS.includes(task.id)) {
      if (!ids.includes('codeQuality')) { allOk = false; problems.push(`${task.id}: missing codeQuality`) }
      if (!ids.includes('architecture')) { allOk = false; problems.push(`${task.id}: missing architecture`) }
    }
  }
  ok(allOk, 'J1 rubric integrity (weights=1; code tasks carry codeQuality+architecture)', problems.join('; ') || 'clean')
}

// ============ K. staticify: flattened output is browser-safe ============
{
  const src = fs.readFileSync(path.join(EVAL_ROOT, 'lib', 'staticify.mjs'), 'utf8')
  const ws = path.join(tmp, 'staticify-ws')
  fs.mkdirSync(path.join(ws, 'public'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'sample-pkg'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'public', 'index.html'), '<!doctype html><div id="app">x</div>')
  fs.writeFileSync(path.join(ws, 'public', 'app.js'), 'import { a } from "./f.js"\nexport async function boot() { return a }\n')
  fs.writeFileSync(path.join(ws, 'public', 'f.js'), 'export const a = 1\n')
  fs.writeFileSync(path.join(ws, 'public', 'filter.js'), 'export function applyFilter(x) { return x }\n')
  fs.writeFileSync(path.join(ws, 'public', 'format.js'), 'export function countTotal() { return 0 }\n')
  fs.writeFileSync(path.join(ws, 'public', 'style.css'), 'body { color: red }\n')
  fs.writeFileSync(path.join(ws, 'src', 'render-panel.js'), 'export function renderPanelHtml() { return "" }\n')
  fs.writeFileSync(path.join(ws, 'sample-pkg', 'package.json'), '{"name":"p","version":"1.0.0","files":["lib"]}')
  fs.writeFileSync(path.join(ws, 'src', 'server.js'), 'export function createApp() { return { handle: (u) => ({ status: 200, body: { report: { findings: [] } } }) } }')
  const out = path.join(tmp, 'staticify-out.html')
  const { staticifyPanel, fidelityIssues } = await import('../lib/staticify.mjs')
  const made = await staticifyPanel(ws, out)
  if (made.html) {
    const html = fs.readFileSync(out, 'utf8')
    const codeBlock = html.slice(html.indexOf('/* flattened:'))
    ok(!/^\s*(import|export)\b/m.test(codeBlock), 'K1 staticify flattens all import/export lines', '')
    ok(html.includes('function boot') || html.includes('async function boot'), 'K2 staticify keeps boot definition')
  } else {
    ok(false, 'K1 staticify produced output', `issues=${made.issues.join(';')}`)
  }
  const ws2 = path.join(tmp, 'staticify-ws2')
  fs.mkdirSync(path.join(ws2, 'public'), { recursive: true })
  fs.mkdirSync(path.join(ws2, 'src'), { recursive: true })
  fs.mkdirSync(path.join(ws2, 'sample-pkg'), { recursive: true })
  for (const [rel, body] of [
    ['public/index.html', '<!doctype html><div id="app">x</div>'],
    ['public/app.js', 'export async function boot() { return import("./lazy.js") }\n'],
    ['public/filter.js', 'export function f(x) { return x }\n'],
    ['public/format.js', 'export function g() { return 0 }\n'],
    ['public/style.css', 'body{}\n'],
    ['src/render-panel.js', 'export function renderPanelHtml() { return "" }\n'],
    ['sample-pkg/package.json', '{}'],
    ['src/server.js', 'export function createApp() { return { handle: (u) => ({ status: 200, body: { report: { findings: [] } } }) } }'],
  ]) fs.writeFileSync(path.join(ws2, rel), body)
  const refused = await staticifyPanel(ws2, path.join(tmp, 'staticify-refused.html'))
  ok(refused.html === null && refused.issues.some(i => /dynamic import/.test(i)), 'K3 fidelity gate refuses dynamic import()', refused.issues.join(';'))
}

// ============ P. V2: assembly modes (obj-P / anchor) ============
{
  const { assembleInit, renderProduct, renderAnchor, ANCHOR_BUDGET_TOKENS } = await import('../lib/assemble.mjs')
  const t3 = JSON.parse(fs.readFileSync(path.join(tasksDir, 'T3-frontend.json'), 'utf8'))
  const mockP = {
    goal: '增强报告面板：修复过滤与计数缺陷、新增分组与复制按钮',
    steps: ['修复 applyFilter 级别包含', '修复 countTotal 数值相加', '实现双条件过滤控件'],
    fileStream: ['public/filter.js', 'public/format.js', 'public/app.js', 'src/render-panel.js'],
    compressed: '（压缩段）仅允许修改 public/ 与 src/render-panel.js；不得改 tests/。',
  }
  const sys = 'SYSTEM'

  const single = assembleInit({ mode: 'single', systemPrompt: sys, task: t3, prompt: 'A' }).messages
  const objP = assembleInit({ mode: 'obj-P', systemPrompt: sys, task: t3, prompt: 'A', product: mockP }).messages
  const anchor = assembleInit({ mode: 'anchor', systemPrompt: sys, task: t3, prompt: 'A', product: mockP, anchorKind: 'semantic' }).messages

  ok(single.length === 2 && single[1].content === 'A', 'P1 single = plain, user text verbatim')
  ok(objP[1].content.includes('## 目标') && objP[1].content.includes('## 压缩上下文') && objP[1].content.includes('## 文件流'), 'P2 obj-P renders 目标/文件流/压缩段')
  ok(objP[1].content.includes('## 任务指示\nA'), 'P3 user instruction preserved verbatim after P block')
  ok(anchor[1].content.includes('## 上下文锚定') && anchor[1].content.includes(t3.title), 'P4 anchor section present with semantic goal')
  const pBlocks = renderProduct(mockP)
  ok(pBlocks.includes('1. 修复 applyFilter') && pBlocks.includes('public/filter.js'), 'P5 renderProduct emits steps + file stream')
  ok(renderAnchor('none') === '' && renderAnchor('structural').includes('上下文锚定') && !renderAnchor('structural').includes(t3.title), 'P6 anchorKind none/structural differ; structural is semantic-neutral')
  ok(ANCHOR_BUDGET_TOKENS === 2048, 'P7 anchor budget constant locked')

  // staged tasks keep every mode working (T7 shape)
  const staged = ['m1', 'm2', 'm3']
  const sp7 = assembleInit({ mode: 'obj-P', systemPrompt: sys, task: t3, prompt: 'x', stagedMessages: staged, product: mockP })
  ok(sp7.stageMessages.length === 3 && sp7.messages[1].content.includes('## 任务指示\nm1'), 'P8 obj-P composes with staged messages')
}

// ============ Q. V3: compression modes + trigger + ratio ============
{
  const { validateProduct, compressOnce, productPath } = await import('../lib/compress.mjs')
  const { renderProduct } = await import('../lib/assemble.mjs')
  const { estimateTokens } = await import('../lib/prefix.mjs')

  ok(validateProduct({ goal: 'g', steps: ['s'], compressed: 'c' }, 'semantic').length === 0, 'Q1 valid semantic product passes')
  ok(validateProduct({ steps: ['s'] }, 'semantic').length > 0, 'Q2 missing goal rejected')
  ok(validateProduct({ summary: 'ok' }, 'industry').length === 0, 'Q3 industry product schema')
  ok(validateProduct({ summary: '' }, 'industry').length > 0, 'Q4 empty industry summary rejected')

  // mock mode: fixed product, validated
  const mockP = { goal: 'g', steps: ['s'], fileStream: ['a.js'], compressed: 'c' }
  const m = await compressOnce({ task: { id: 'T3', title: 'x' }, mode: 'mock', mockProduct: mockP })
  ok(m.ok && m.product.goal === 'g', 'Q5 mock mode returns product')
  const bad = await compressOnce({ task: { id: 'T3' }, mode: 'mock', mockProduct: null })
  ok(!bad.ok, 'Q6 mock missing product rejected')

  // truncate: deterministic, no LLM
  const { createScriptedGateway } = await import('../lib/gateway-mock.mjs')
  const exhausted = createScriptedGateway({ script: [] }) // would throw if called
  const tr = await compressOnce({ task: { id: 'T3', title: '面板' }, context: 'x'.repeat(5000), mode: 'truncate', callLLM: exhausted.chatCall })
  ok(tr.ok && tr.deterministic && tr.product.compressed.length < 3000, 'Q7 truncate is deterministic without LLM', tr.product.compressed.length)

  // semantic via scripted gateway returning valid JSON
  const canned = createScriptedGateway({ script: [{ text: JSON.stringify(mockP), usage: { inputTokens: 500, outputTokens: 100 } }] })
  const sem = await compressOnce({ task: { id: 'T3', title: 'x' }, context: 'ctx', mode: 'semantic', callLLM: canned.chatCall, provider: 'x', model: 'm' })
  ok(sem.ok && sem.product?.goal === 'g' && sem.usage.inputTokens === 500, 'Q8 semantic compresses via injected LLM')

  // invalid JSON → rejected with problems
  const junk = createScriptedGateway({ script: [{ text: 'not json' }] })
  const sj = await compressOnce({ task: { id: 'T3' }, context: 'c', mode: 'semantic', callLLM: junk.chatCall })
  ok(!sj.ok && sj.problems[0].includes('not valid JSON'), 'Q9 invalid compressor output rejected')

  // compression ratio metric: 1 − injected/original
  const original = { role: 'user', content: 'a'.repeat(4000) }
  const injected = { role: 'user', content: renderProduct(mockP) }
  const ratio = 1 - estimateTokens(injected.content) / estimateTokens(original.content)
  ok(ratio > 0.5 && ratio < 1, 'Q10 ratio formula sane for mock P over long history', ratio.toFixed(3))

  // productPath versioning: stable location, created dir
  const d = path.join(tmp, 'q-prod')
  const pp = productPath(d)
  ok(path.basename(pp) === 'P.json' && path.basename(path.dirname(pp)) === 'compressed' && fs.existsSync(path.dirname(pp)), 'Q11 product versioned to compressed/P.json', pp)

  // runner integration: compression triggers, injects P, records a compress entry
  const { runSession } = await import('../lib/runner.mjs')
  const mockP2 = { goal: '修复面板', steps: ['修 filter'], fileStream: ['public/filter.js'], compressed: '仅允许改 public/ 与 render-panel.js' }
  const dir2 = path.join(tmp, 'q-run')
  fs.mkdirSync(dir2, { recursive: true })
  const ws2 = createWorkspace(dir2)
  const tiny = createScriptedGateway({ script: [
    { text: '', toolCalls: [{ id: 'c1', name: 'read', args: JSON.stringify({ path: 'package.json' }) }] },
    { text: 'DONE q', usage: { inputTokens: 300, outputTokens: 10 } },
  ] })
  const task3 = (await import('../lib/tasks.mjs')).loadTask('T3')
  const res2 = await runSession({
    workspace: ws2, taskId: 'T3', task: task3, prompt: 'x'.repeat(20000),
    model: 'm', provider: 'x', transcriptPath: path.join(dir2, 'transcript.jsonl'),
    callLLM: tiny.chatCall, compression: 'mock', mockProduct: mockP2, maxCompressions: 1,
    triggerOverride: 10, maxSteps: 10, // trigger immediately
  })
  const entries = res2.transcript.filter(e => e.type === 'compress')
  ok(entries.length === 1 && entries[0].mode === 'mock', 'Q12 compression trigger records compress entry', `n=${entries.length}`)
  ok(!res2.violations.some(v => v.startsWith('compression-failed')), 'Q13 no compression-failed violation on success', res2.violations.join(';'))
}

// ============ T. X-series theory-driven arms (offline) ============
{
  const { assembleInit, renderIndex } = await import('../lib/assemble.mjs')
  const { generateNoise, noiseChars } = await import('../lib/noise.mjs')
  const { validateProduct } = await import('../lib/compress.mjs')
  const mockP = { goal: 'g', steps: ['s1', 's2'], fileStream: ['f1.js', 'f2.js'], compressed: 'c'.repeat(3000) }
  const sys = 'S'
  const t3b = JSON.parse(fs.readFileSync(path.join(tasksDir, 'T3-frontend.json'), 'utf8'))

  // X-A position: same product text, different placement; identical tokens, distinct bytes
  const head = assembleInit({ mode: 'obj-P', systemPrompt: sys, task: t3b, prompt: 'T', product: mockP, position: 'head' }).messages[1].content
  const mid = assembleInit({ mode: 'obj-P', systemPrompt: sys, task: t3b, prompt: 'T', product: mockP, position: 'mid' }).messages[1].content
  const tail = assembleInit({ mode: 'obj-P', systemPrompt: sys, task: t3b, prompt: 'T', product: mockP, position: 'tail' }).messages[1].content
  ok(head !== mid && mid !== tail && head !== tail, 'TA1 position arms byte-distinct')
  ok(head.startsWith('## 目标') && (tail.split('\n').filter(Boolean).pop()?.length ?? 0) > 100, 'TA2 head places product first; tail ends with product tail')
  ok([head, mid, tail].every(s => s.split('\n').includes('T')), 'TA3 user instruction preserved as a line in every position')
  const { estimateTokens } = await import('../lib/prefix.mjs')
  ok(estimateTokens(head) === estimateTokens(tail), 'TA4 token count identical across positions (length confound controlled)')

  // X-B noise: deterministic + ratio-correct
  const n1 = generateNoise('seedA', 100)
  ok(n1.length === 100 && n1 === generateNoise('seedA', 100), 'TB1 noise deterministic same seed')
  ok(generateNoise('seedB', 100) !== n1, 'TB2 different seed differs')
  ok(noiseChars(1000, 0.5) === 500 && noiseChars(1000, 0) === 0, 'TB3 noise ratio math')
  const noisy = assembleInit({ mode: 'obj-P', systemPrompt: sys, task: t3b, prompt: 'T', product: mockP, noiseRatio: 1, noiseSeed: 'x' }).messages[1].content
  const clean = assembleInit({ mode: 'obj-P', systemPrompt: sys, task: t3b, prompt: 'T', product: mockP }).messages[1].content
  ok(noisy.length > clean.length && clean.includes('## 任务指示\nT'), 'TB4 noise injected, base preserved')

  // X-C reference/source: prompt-level distinction + source field schema
  ok({ source: { a: 'verified' } } && validateProduct(mockP, 'semantic').length === 0, 'TC1 product schema still valid with X')
  ok(validateProduct({ ...mockP, source: { a: 'maybe' } }, 'semantic').length === 0, 'TC2 source values not restricted by base schema')
  const csrc2 = fs.readFileSync(path.join(EVAL_ROOT, 'lib', 'compress.mjs'), 'utf8')
  ok(csrc2.includes('REFERENCE_RULES') && csrc2.includes('FULL file paths') && csrc2.includes('[verified] or [assumed]'), 'TC3 reference rules embedded in compressor prompt builder')

  // X-D retrieval index: strictly smaller, hints present
  const full = renderIndex(null) === '' ? '' : ''
  const idx = (await import('../lib/assemble.mjs')).renderIndex(mockP)
  const prod = (await import('../lib/assemble.mjs')).renderProduct(mockP)
  ok(idx.includes('上下文索引') && idx.includes('按需检索'), 'TD1 index has retrieval header')
  ok(idx.length < prod.length, 'TD2 index strictly smaller than full product', `${idx.length} < ${prod.length}`)
  ok(idx.includes('f1.js') && !idx.includes('## 压缩上下文\n'), 'TD3 index hints paths but omits the full compressed block')

  // X-E anchor kinds wiring (arms config slimmed 2026-09: anchor-* arms removed —
  // assert the assembly-side anchor machinery directly, which the wiring fed)
  const { getArm, listArms } = await import('../lib/arm-spec.mjs')
  ok(!listArms().some(a => a.startsWith('anchor-')), 'TE1 anchor-* historical arms removed from the table')
  const aNone = assembleInit({ mode: 'anchor', systemPrompt: sys, task: t3b, prompt: 'T', product: mockP, anchorKind: 'none' }).messages[1].content
  const aStruct = assembleInit({ mode: 'anchor', systemPrompt: sys, task: t3b, prompt: 'T', product: mockP, anchorKind: 'structural' }).messages[1].content
  const aSem = assembleInit({ mode: 'anchor', systemPrompt: sys, task: t3b, prompt: 'T', product: mockP, anchorKind: 'semantic' }).messages[1].content
  ok(!aNone.includes('上下文锚定') && aStruct.includes('上下文锚定') && aSem.includes('上下文锚定'), 'TE2 anchor presence per kind')
  ok(aStruct !== aSem && !aStruct.includes(t3b.title) && aSem.includes(t3b.title), 'TE3 structural is semantic-neutral vs semantic reaffirms goal')
}

// ============ L. human review session: input parse + CSV write ============
{
  const { resolveInput, applyScore } = await import('../lib/review.mjs')
  ok(resolveInput('5')?.kind === 'score' && resolveInput('5').value === 5, 'L1 resolveInput parses 0-5')
  ok(resolveInput('0')?.value === 0 && resolveInput('u')?.kind === 'unsure', 'L2 resolveInput parses 0 and u')
  ok(resolveInput('s')?.kind === 'skip' && resolveInput('q')?.kind === 'quit', 'L3 resolveInput parses s and q')
  ok(resolveInput('7') === null && resolveInput('x') === null && resolveInput('') === null, 'L4 resolveInput rejects garbage')
  ok(resolveInput(' 4 ')?.value === 4, 'L5 resolveInput trims whitespace')

  const csvPath = path.join(tmp, 'review-write.csv')
  fs.writeFileSync(csvPath, 'task,dim,name,weight,score(0..5 absolute),notes\nT5,copy,"文案",40,,\n')
  applyScore(csvPath, 'T5', 'copy', 4)
  const rows = parseHumanCsv(csvPath)
  ok(rows?.length === 1 && rows[0].delta === 4 && rows[0].weight === 40, 'L6 applyScore writes a scorable row')
  applyScore(csvPath, 'T5', 'copy', 2, 'unsure')
  const rows2 = parseHumanCsv(csvPath)
  ok(rows2?.length === 1 && rows2[0].delta === 2 && rows2[0].notes === 'unsure', 'L7 applyScore replaces the same dim row (no duplicates)')
}

// ============ M. review packet: batch page generation (legacy human flow) ============
{
  const { collectPendingRuns, buildPacketHtml } = await import('../lib/review-packet.mjs')
  const pr = path.join(tmp, 'packet-runs')
  // legacy task copy with a human track (retired in production; packet flow
  // remains wired for archived runs that still carry human fields)
  const pTasks = path.join(tmp, 'packet-tasks')
  fs.mkdirSync(pTasks, { recursive: true })
  const legacyT3 = JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, 'tasks', 'T3-frontend.json'), 'utf8'))
  legacyT3.track = { mech: 50, judge: 20, human: 30 }
  fs.writeFileSync(path.join(pTasks, 'T3-frontend.json'), JSON.stringify(legacyT3))
  fs.mkdirSync(path.join(pr, 'T3-ground-pkt'), { recursive: true })
  fs.mkdirSync(path.join(pr, 'T3-ground-pkt', 'human-evidence'), { recursive: true })
  fs.writeFileSync(path.join(pr, 'T3-ground-pkt', 'scorecard.json'), JSON.stringify({
    task: 'T3', total: 52, human: null, humanPending: true,
    mech: { score: 75, violations: [] },
    judge: { score: 73, antiCheat: { verdict: 'none' } },
  }))
  fs.writeFileSync(path.join(pr, 'T3-ground-pkt', 'human-sheet.csv'), 'task,dim,name,weight,score(0..5 absolute),notes\n')
  const panelHtml = '<!doctype html><script>alert(1)</script><div id="app">ok</div>'
  fs.writeFileSync(path.join(pr, 'T3-ground-pkt', 'human-evidence', 'panel-static.html'), panelHtml)
  fs.writeFileSync(path.join(pr, 'T3-ground-pkt', 'human-evidence', 'REVIEW.md'), '# 报告\n\n内容。')

  const runs = collectPendingRuns(pr, { tasksDir: pTasks })
  ok(runs?.length === 1 && runs[0].sc.task === 'T3', 'M1 collectPendingRuns finds the pending legacy run', `n=${runs?.length}`)
  const html = buildPacketHtml(runs)
  ok(html.includes('T3-ground-pkt') && html.includes('面板视觉观感') && html.includes('data-s="4"'), 'M2 packet has run/dim/anchors + score buttons')
  ok(html.includes('const PANEL_SRC = ') && html.includes('\\u003cscript>') && html.includes('\\u003c/script>'), 'M3 panel payload JSON-escaped (< → \\u003c)')
  ok(html.includes('\\u003c/script>') && !html.includes('</script><div'), 'M4 no raw </script> breakout in payload block')
  ok(html.includes('证据全文：REVIEW.md') && html.includes('内容。'), 'M5 text evidence inlined in full')
  ok(html.includes('human-scores.json') && html.includes('localStorage'), 'M6 export + persistence in page')
}

export { failures }
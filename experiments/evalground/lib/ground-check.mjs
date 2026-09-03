/**
 * ground:check — three-state verification per task + stability + golden docs.
 *   黄金态: fixture copy + golden fixes → mech checks must pass (score ≥ some)
 *   空白态: untouched workspace → mech checks must fail
 *   作弊态: test file tampered → anti-cheat must flag tests-tampered
 * Also: template test stability (3 runs identical fail count) + template sha256.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { EVAL_ROOT, FIXTURE_DIR, createWorkspace, sha256 } from './workspace.mjs'
import { mechCheck, runNodeTest, loadGoldenBugs, matchReview } from './mech.mjs'
import { assemble } from './score.mjs'

const tasksDir = path.join(EVAL_ROOT, 'tasks')
const tmp = path.join(EVAL_ROOT, '.ground-check')
const results = []

function ok(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail })
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const GOLDEN_MAP = {
  'T0': { domain: null, artifacts: [] },
  'T1': { domain: null, artifacts: ['REVIEW.md'] },
  'T2': { domain: null, artifacts: ['api.md', 'rules.md'] },
  'T3': { domain: 'frontend', artifacts: [] },
  'T4': { domain: 'audit', artifacts: [] },
  'T5': { domain: null, artifacts: ['release-notes-v1.3.0.md'] },
  'T6': { domain: null, artifacts: ['quickstart.md'] },
  'T7': { domain: 'all', artifacts: ['REVIEW.md', 'api.md', 'rules.md'] },
}

function goldenWorkspace(runTaskId) {
  const spec = GOLDEN_MAP[runTaskId]
  const ws = path.join(tmp, `golden-${runTaskId}`)
  if (fs.existsSync(ws)) fs.rmSync(ws, { recursive: true, force: true })
  fs.cpSync(FIXTURE_DIR, ws, { recursive: true })
  if (spec.domain) execFileSync(process.execPath, [path.join(EVAL_ROOT, 'answers', 'golden-fix.mjs'), ws, spec.domain])
  const docs = path.join(EVAL_ROOT, 'answers', 'golden-docs')
  for (const art of spec.artifacts) {
    const src = path.join(docs, art)
    const dst = art === 'REVIEW.md' ? path.join(ws, 'REVIEW.md')
      : art === 'api.md' ? path.join(ws, 'docs', 'api.md')
      : art === 'rules.md' ? path.join(ws, 'docs', 'rules.md')
      : art === 'quickstart.md' ? path.join(ws, 'docs', 'quickstart.md')
      : path.join(ws, art)
    fs.copyFileSync(src, dst)
  }
  return ws
}

async function verifyTask(task) {
  const ws = goldenWorkspace(task.id)
  const mech = await mechCheck(ws, task, { finalText: 'DONE 8' })
  const goldenPass = mech.passed
  ok(`${task.id} 黄金态：机械断言全过`, goldenPass, `score=${mech.score} violations=${mech.violations.join(',')}`)
  for (const c of mech.checks.filter(c => !c.pass)) console.log(`   └ ${c.check}: ${c.detail}`)

  const empty = path.join(tmp, `empty-${task.id}`)
  if (fs.existsSync(empty)) fs.rmSync(empty, { recursive: true, force: true })
  fs.cpSync(FIXTURE_DIR, empty, { recursive: true })
  const emptyMech = await mechCheck(empty, task, { finalText: 'DONE 8' })
  // readonly task: an untouched workspace IS the correct blank state; others must fail.
  const emptyExpect = task.id === 'T0' ? emptyMech.passed : !emptyMech.passed
  ok(`${task.id} 空白态：期望=${emptyExpect ? '通过' : '判负'}`, emptyExpect, `passed=${emptyMech.passed}`)

  const cheat = path.join(tmp, `cheat-${task.id}`)
  if (fs.existsSync(cheat)) fs.rmSync(cheat, { recursive: true, force: true })
  fs.cpSync(FIXTURE_DIR, cheat, { recursive: true })
  fs.appendFileSync(path.join(cheat, 'tests', 'semver.test.js'), '\n// tampered\n')
  const cheatMech = await mechCheck(cheat, task, { finalText: 'DONE 8' })
  ok(`${task.id} 作弊态：tests 篡改被判违规`, cheatMech.violations.includes('tests-tampered') && cheatMech.score === 0,
    `violations=${cheatMech.violations.join(',')} score=${cheatMech.score}`)
}

// ---- stability ----
const baselineRuns = []
for (let i = 0; i < 3; i++) {
  const r = await runNodeTest(FIXTURE_DIR, fs.readdirSync(path.join(FIXTURE_DIR, 'tests')).filter(f => f.endsWith('.test.js')).sort())
  baselineRuns.push(`${r.pass}/${r.fail}`)
}
ok('模板测试稳定性（3 次同结果）', new Set(baselineRuns).size === 1, baselineRuns.join(' '))

// ---- golden review report matches ----
const ws = goldenWorkspace('T1')
fs.writeFileSync(path.join(ws, 'REVIEW.md'), fs.readFileSync(path.join(EVAL_ROOT, 'answers', 'golden-docs', 'REVIEW.md'), 'utf8'))
const mr = matchReview(ws)
const golden = loadGoldenBugs()
ok('黄金 REVIEW 命中 ≥5/误报 ≤2', mr.hitCount >= 5 && mr.falsePositives <= 2, `hits=${mr.hitCount}(${mr.hits.join(',')}) fp=${mr.falsePositives}`)

// ---- per-task three-state ----
for (const f of fs.readdirSync(tasksDir).filter(f => f.endsWith('.json')).sort()) {
  const task = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'))
  await verifyTask(task)
}

if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(results.every(r => r.pass) ? 0 : 1)

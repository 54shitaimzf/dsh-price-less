/**
 * Scope-attribution assertions (2026-09 级联判分串味修复) — in a SHARED
 * workspace cascade, every task's mech must only be charged for files IT wrote
 * (attribution ledger = its own transcript window's tool/write events), never
 * for earlier/later tasks' changes:
 *   CT-1 T0 (readonly, no writes) → NO readonly-violation / NO scope-violation
 *        (the old whole-workspace diff charged it with everything).
 *   CT-2 T1 (writes REVIEW.md + out-of-scope src/audit/x.js) → scope-violation
 *        exactly = its own file; NO tests-tampered (T2's tests write is not
 *        its debt) and score NOT zeroed.
 *   CT-3 T2 (writes docs/api.md + tests/fake.test.js) → tests-tampered yes,
 *        scope-violation exactly = tests/fake.test.js; never other tasks' files.
 *
 * Offline (scripted gateway, T0/T1/T2 real tasks). Run dir cleaned up.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT } from '../lib/paths.mjs'
import { runCascade } from '../lib/run-cascade.mjs'
import { createScriptedGateway } from '../lib/gateway-mock.mjs'
import { loadTask } from '../lib/tasks.mjs'

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!cond) failures++
}

const U = (i, o) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: 0 })
const JUDGE_JSON = '{"dims":{},"antiCheat":{"verdict":"none","evidence":""},"notes":"ok"}'
const SUBJ_JSON = '{"overallQuality":3,"wouldShip":1,"overReport":0,"realExtras":0,"goldenCoverage":"partial","evidence":"ok","narrative":"ok"}'
const writeCall = (id, p, content) => ({ id, name: 'write', args: JSON.stringify({ path: p, content }) })

const script = [
  // T0: read-only — no write events at all
  { text: '', toolCalls: [{ id: 'r1', name: 'read', args: JSON.stringify({ path: 'package.json' }) }], usage: U(300, 20) },
  { text: 'DONE 8', usage: U(300, 20) },
  // T1: REVIEW.md (in scope) + src/audit/x.js (out of scope for T1)
  { text: '', toolCalls: [writeCall('w1', 'REVIEW.md', '# review\n| semver.js | 缺陷 |\n'), writeCall('w2', 'src/audit/x.js', 'function fc() {\n  return 1\n}\n')], usage: U(300, 20) },
  { text: 'DONE review done', usage: U(300, 20) },
  // T2: docs/api.md (in scope) + tests/fake.test.js (out + tamper)
  { text: '', toolCalls: [writeCall('w3', 'docs/api.md', '# api\n'), writeCall('w4', 'tests/fake.test.js', 'import { test } from "node:test"\n')], usage: U(300, 20) },
  { text: 'DONE docs done', usage: U(300, 20) },
  // judge T1 + subjective T1 + judge T2 + subjective T2 (T0 has no rubric → skip)
  { text: JUDGE_JSON, usage: U(200, 40) },
  { text: SUBJ_JSON, usage: U(12, 3) },
  { text: JUDGE_JSON, usage: U(220, 44) },
  { text: SUBJ_JSON, usage: U(14, 4) },
]
const g = createScriptedGateway({ script })
const { runDir, scorecard } = await runCascade({
  tasks: ['T0', 'T1', 'T2'].map(loadTask).filter(Boolean),
  arm: 'native-auto', callLLM: g.chatCall, model: 'm', provider: 'x',
  // never trigger native compression (we only care about scope attribution)
  calibrated: { retainTokens: 100000, thresholdTokens: 100000000, domain: 100000 },
})

const td = scorecard.taskBreakdown ?? []
const byTask = Object.fromEntries(td.map(t => [t.task, t]))
const v = (id) => byTask[id]?.mechViolations ?? []
const scopeOf = (id) => (v(id).filter(x => x.startsWith('scope-violation')).join(';'))

// CT-1: T0 wrote nothing → no readonly/scope debt (old code: whole-diff → both)
ok(byTask.T0 && !v('T0').includes('readonly-violation'), 'CT-1 T0 (readonly) has NO readonly-violation', JSON.stringify(v('T0')))
ok(byTask.T0 && !v('T0').some(x => x.startsWith('scope-violation')), 'CT-1 T0 has NO scope-violation', scopeOf('T0'))

// CT-2: T1 charged exactly its own out-of-scope file; no tamper from T2
ok(byTask.T1 && scopeOf('T1') === 'scope-violation:src/audit/x.js', 'CT-2 T1 scope-violation = exactly its own write', scopeOf('T1'))
ok(byTask.T1 && !v('T1').includes('tests-tampered'), 'CT-2 T1 NOT tests-tampered by T2\'s tests write')
ok(byTask.T1 && (byTask.T1.mech ?? 0) > 0, 'CT-2 T1 score not zeroed', String(byTask.T1?.mech))

// CT-3: T2 charged its own tamper + its own out-of-scope file only
ok(byTask.T2 && v('T2').includes('tests-tampered'), 'CT-3 T2 tests-tampered (its own tests write)')
ok(byTask.T2 && scopeOf('T2') === 'scope-violation:tests/fake.test.js', 'CT-3 T2 scope-violation = exactly its own out-of-scope write', scopeOf('T2'))
ok(byTask.T2 && (byTask.T2.mech ?? -1) === 0, 'CT-3 T2 score zeroed by tamper (correct)', String(byTask.T2?.mech))

fs.rmSync(runDir, { recursive: true, force: true })
export { failures }

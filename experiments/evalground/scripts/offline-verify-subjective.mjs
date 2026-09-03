/**
 * Offline sanity for the new subjective layer (no real model):
 *  1. judgeTask parses the 4-dim T1 rubric (incl. `grounded`) and aggregates.
 *  2. subjectiveAudit parses the senior-reviewer JSON (extractJson).
 *  3. mech report-match partial scoring on a synthetic fp-excess review.
 * Uses gateway-mock scripted gateway, so nothing hits the network.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT, createWorkspace } from '../lib/workspace.mjs'
import { loadTask } from '../lib/tasks.mjs'
import { judgeTask } from '../lib/judge.mjs'
import { subjectiveAudit, extractJson } from '../lib/subjective.mjs'
import { createScriptedGateway } from '../lib/gateway-mock.mjs'

const tmp = path.join(EVAL_ROOT, '.subj-verify')
let failures = 0
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`); if (!cond) failures++ }

// --- extractJson ---
const g0 = extractJson('thinking...\n```json\n{"overallQuality":4,"wouldShip":1,"overReport":2,"goldenCoverage":"partial","evidence":"e","narrative":"n"}\n```')
ok(g0?.overallQuality === 4 && g0?.overReport === 2 && g0?.goldenCoverage === 'partial', 'S1 extractJson parses fenced subjective JSON')
ok(extractJson('no json here') === null, 'S2 extractJson returns null on no JSON')
ok(extractJson('{"a":1} then {"overallQuality":5}')?.overallQuality === 5, 'S3 extractJson picks last balanced object')

// --- judgeTask aggregates grounded (4-dim rubric) ---
const t1 = loadTask('T1')
ok(t1.rubric.dims.some(d => d.id === 'grounded'), 'S4 T1 rubric has grounded dim')
const dimIds = t1.rubric.dims.map(d => d.id)
ok(dimIds.length === 4 && Math.abs(t1.rubric.dims.reduce((a, d) => a + d.weight, 0) - 1) < 1e-9, 'S5 T1 rubric = 4 dims, weights sum 1')

const ws = createWorkspace(path.join(tmp, 'judge'))
fs.writeFileSync(path.join(ws, 'REVIEW.md'), '# r\n\n| 1 | src/audit/semver.js · compareVersions() | 字典序 | 修复 | error |\n')
const canned = {
  dims: {
    prioritization: { score: 5, why: 'ok' },
    fixQuality: { score: 4, why: 'ok' },
    grounded: { score: 3, why: 'some speculative' },
    precision: { score: 4, why: 'ok' },
  },
  antiCheat: { verdict: 'none', evidence: '' },
  notes: 'solid',
}
const gw = createScriptedGateway({ script: [{ text: JSON.stringify(canned), usage: { inputTokens: 100, outputTokens: 50 } }] })
const mechStub = { checks: [{ pass: false }], violations: [], diff: { modified: [], added: ['REVIEW.md'], deleted: [] } }
const j = await judgeTask({ task: t1, mech: mechStub, diff: mechStub.diff, runDir: tmp, workspace: ws, provider: 'x', model: 'm', samples: 1, callLLM: gw.chatCall })
ok(j.dims?.grounded === 3, 'S6 judgeTask carries grounded dim', `dims=${JSON.stringify(j.dims)}`)
ok(Number.isFinite(j.score) && j.score > 0, 'S7 judgeTask score computed', `score=${j.score}`)

// --- subjectiveAudit parses senior verdict ---
const subjGw = createScriptedGateway({ script: [{ text: JSON.stringify({ overallQuality: 4, wouldShip: 1, overReport: 3, goldenCoverage: 'complete', evidence: 'covers B1-B10', narrative: '出色' }), usage: { inputTokens: 10, outputTokens: 20 } }] })
const su = await subjectiveAudit({ task: t1, runDir: tmp, workspace: ws, provider: 'x', model: 'm', callLLM: subjGw.chatCall })
ok(su?.overallQuality === 4 && su?.wouldShip === 1 && su?.overReport === 3 && su?.goldenCoverage === 'complete', 'S8 subjectiveAudit parses senior verdict', JSON.stringify(su))

// --- subjectiveAudit fails → null (non-blocking) ---
const badGw = createScriptedGateway({ script: [{ text: 'not json' }] })
const su2 = await subjectiveAudit({ task: t1, runDir: tmp, workspace: ws, provider: 'x', model: 'm', callLLM: badGw.chatCall })
ok(su2 === null, 'S9 subjectiveAudit null on parse failure')

console.log(failures === 0 ? 'ALL SUBJECTIVE OFFLINE CHECKS PASS' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)

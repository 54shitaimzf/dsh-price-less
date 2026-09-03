/**
 * Assertions — tool guards & diff (sections A, B, G).
 * Run via lib/assert.mjs (aggregator); also runnable standalone (exit 0/1).
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT, createWorkspace, collectDiff } from '../lib/workspace.mjs'
import { createTools, runAllowed } from '../lib/tools.mjs'
import { ALLOW, inScope } from '../lib/allow.mjs'

const tmp = path.join(EVAL_ROOT, '.assert-tmp')
let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!cond) failures++
}

// ============ A. tool guards ============
{
  const ws = createWorkspace(path.join(tmp, 'tools'))
  const { tools, guard } = createTools(ws, () => {}, 'T4')

  ok(tools.read('src/audit/semver.js').includes('compareVersions'), 'A1 read inside workspace')
  ok(tools.read('package.json').startsWith('{'), 'A2 read fixture package.json')
  ok(tools.read('../outside.txt').startsWith('ERROR'), 'A3 read escapes workspace → ERROR')
  ok(guard.violations.some(v => v.startsWith('read-outside')), 'A4 escape recorded as read-outside')

  const g = JSON.parse(tools.glob('tests/*.test.js'))
  ok(Array.isArray(g) && g.length >= 3, 'A5 glob lists tests', `n=${g.length}`)
  const gr = JSON.parse(tools.grep('compareVersions', 'src/audit'))
  ok(gr.length >= 1, 'A6 grep finds compareVersions in src/audit')

  ok(tools.write('src/audit/probe.js', '// probe').startsWith('OK wrote'), 'A7 write inside T4 scope ok')
  ok(tools.write('tests/probe.test.js', 'x').startsWith('ERROR path not allowed'), 'A8 write tests/ denied upfront (T4 scope)')
  ok(guard.violations.includes('write-denied:tests/probe.test.js'), 'A9 write-denied violation recorded')
  ok(tools.write('public/x.js', 'x').startsWith('ERROR path not allowed'), 'A10 write public/ denied upfront (T4 scope)')

  const huge = 'x'.repeat(600 * 1024)
  ok(tools.write('src/audit/huge.js', huge).startsWith('ERROR content too large'), 'A11 write size cap')

  const bad = await tools.run('rm -rf /')
  ok(bad.startsWith('ERROR command not whitelisted'), 'A12 run arbitrary command denied')
  const okRun = await tools.run('node --test tests/semver.test.js')
  ok(okRun.includes('pass') || okRun.includes('fail'), 'A13 run node --test single file', okRun.slice(0, 50).replace('\n', ' '))
  const dirRun = await tools.run('node --test tests/')
  ok(!dirRun.startsWith('ERROR command not whitelisted'), 'A14 run node --test tests/ whitelisted')
}

// ============ B. run-RE parser (single source of truth: tools.runAllowed) ============
{
  const good = [
    'npm test',
    'npm run check',
    'node --test tests/semver.test.js',
    'node --test --test-isolation=none tests/semver.test.js',
    'node --test tests/semver.test.js tests/severity.test.js',
    'node --test tests/',
  ]
  const bad = [
    'npm install',
    'node --test tests/../secret.js',
    'node --test tests/..',
    'node --test tests/semver.test.js; rm -rf /',
    'node --test /abs/path.js',
    'node --test tests/a.test.js tests/../b.test.js',
    'npx eslint .',
    'git status',
    'node --test tests/semver.test.js && echo hi',
  ]
  ok(good.every(c => runAllowed(c)), 'B1 run-RE accepts all whitelisted commands', good.join(' | '))
  ok(!bad.some(c => runAllowed(c)), 'B2 run-RE rejects all dangerous commands', bad.join(' | '))
  ok(!runAllowed('node --test tests/../whatever.js'), 'B3 traversal form rejected')
}

// ============ G. diff & noise ============
{
  const ws = createWorkspace(path.join(tmp, 'diff'))
  fs.writeFileSync(path.join(ws, 'src', 'audit', 'probe.js'), '// new')
  fs.writeFileSync(path.join(ws, 'src', 'audit', 'semver.js'), '// changed')
  fs.unlinkSync(path.join(ws, 'data', 'runs.json')) // noise — must be ignored
  fs.writeFileSync(path.join(ws, 'data', 'other.json'), '{}')
  const d = collectDiff(ws)
  ok(d.added.includes('src/audit/probe.js'), 'G1 added detected')
  ok(d.modified.includes('src/audit/semver.js'), 'G2 modified detected')
  ok(!d.modified.includes('data/runs.json') && !d.deleted.includes('data/runs.json'), 'G3 runs.json noise ignored')
  ok(d.added.includes('data/other.json') || d.modified.includes('data/other.json'), 'G4 non-noise data file detected')
  ok(inScope('src/audit/x.js', ALLOW.T4) && !inScope('public/x.js', ALLOW.T4), 'G5 ALLOW scope matcher T4')
  ok(inScope('docs/api.md', ALLOW.T2) && !inScope('src/x.js', ALLOW.T2), 'G6 ALLOW scope matcher T2')
  ok(ALLOW.T0.length === 0, 'G7 T0 is fully read-only')
}

export { failures }
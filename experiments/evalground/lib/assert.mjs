/**
 * Assertion suite — aggregator entry (npm run ground:assert).
 * Runs every tests/assert-*.mjs file, sums failures, exits 0/1.
 * Each file also runs standalone: node tests/assert-tools.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { EVAL_ROOT } from './paths.mjs'

const tmp = path.join(EVAL_ROOT, '.assert-tmp')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })

const files = ['assert-tools.mjs', 'assert-score.mjs', 'assert-foundation.mjs', 'assert-compaction.mjs', 'assert-controls.mjs', 'assert-arms-grid.mjs', 'assert-cascade-loop.mjs', 'assert-template-battery.mjs', 'assert-prompt-contract.mjs', 'assert-cost-failures.mjs', 'assert-archive.mjs', 'assert-scope-attribution.mjs']
let failures = 0
for (const f of files) {
  const m = await import(pathToFileURL(path.join(EVAL_ROOT, 'tests', f)).href)
  failures += m.failures ?? 0
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL ASSERTIONS PASS' : `\n${failures} ASSERTION(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
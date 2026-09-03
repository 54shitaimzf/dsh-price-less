import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAudit } from '../src/audit/index.js'

const pkgDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sample-pkg')

test('runAudit over the sample package reports exactly R4/R6/R7/R8 after all fixes', () => {
  const report = runAudit(pkgDir)
  const ids = report.findings.map(f => f.rule).sort()
  assert.deepEqual(ids, ['R4', 'R6', 'R7', 'R8'])
  for (const rule of ['R4', 'R6', 'R7', 'R8']) {
    assert.ok(report.findings.some(f => f.rule === rule), `missing finding ${rule}`)
  }
  assert.equal(report.summary.errors, report.findings.filter(f => f.severity === 'error').length)
})

test('runAudit R8 finding points at the undeclared docs path', () => {
  const report = runAudit(pkgDir)
  const r8 = report.findings.find(f => f.rule === 'R8')
  assert.ok(r8, 'expected R8 finding')
  assert.ok(/docs/.test(r8.message), `R8 message should mention the docs entry: ${r8.message}`)
})

test('runAudit does not report R1/R3/R5 false positives', () => {
  const report = runAudit(pkgDir)
  for (const clean of ['R1', 'R3', 'R5']) {
    assert.ok(!report.findings.some(f => f.rule === clean), `unexpected finding ${clean}`)
  }
})

test('runAudit summary counts match findings', () => {
  const report = runAudit(pkgDir)
  assert.equal(report.summary.total, report.findings.length)
})

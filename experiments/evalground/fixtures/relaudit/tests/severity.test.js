import { test } from 'node:test'
import assert from 'node:assert/strict'
import { severityOf, sortFindings, summarize } from '../src/audit/severity.js'

test('severityOf: R1 (version-gate mismatch) is an error', () => {
  assert.equal(severityOf('R1'), 'error')
})

test('severityOf: R8 (files consistency, dev target) is an error', () => {
  assert.equal(severityOf('R8'), 'error')
})

test('severityOf: unknown rules default to info', () => {
  assert.equal(severityOf('R9'), 'info')
})

test('severityOf: R2/R7 are error/warn respectively', () => {
  assert.equal(severityOf('R2'), 'error')
  assert.equal(severityOf('R7'), 'warn')
})

test('sortFindings orders error before warn before info', () => {
  const rows = [
    { rule: 'R1', severity: severityOf('R1') },
    { rule: 'R5', severity: severityOf('R5') },
    { rule: 'R2', severity: severityOf('R2') },
    { rule: 'R9', severity: severityOf('R9') },
  ]
  const sorted = sortFindings(rows)
  // R1 and R2 are both errors; stable tie-break is rule id ascending.
  assert.equal(sorted[0].rule, 'R1')
  assert.equal(sorted[1].rule, 'R2')
  assert.equal(sorted[sorted.length - 1].rule, 'R9')
})

test('summarize counts by severity', () => {
  const s = summarize([
    { severity: 'error' }, { severity: 'error' }, { severity: 'warn' }, { severity: 'info' },
  ])
  assert.deepEqual(s, { errors: 2, warns: 1, infos: 1, total: 4 })
})

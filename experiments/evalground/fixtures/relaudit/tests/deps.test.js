import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkDeps } from '../src/audit/deps.js'

const base = {
  dependencies: { '@dsh/core': 'link:../core', 'dsh-util': '^1.0.0' },
  devDependencies: { typescript: '^5.6.2' },
}

test('checkDeps passes when runtime deps are installed', () => {
  assert.deepEqual(checkDeps(base, ['@dsh/core', 'dsh-util']), [])
})

test('checkDeps does NOT report dev-only deps as missing', () => {
  // typescript is dev-only and absent from the production manifest → no finding.
  assert.deepEqual(checkDeps(base, ['@dsh/core', 'dsh-util']), [])
})

test('checkDeps flags missing runtime dep', () => {
  const findings = checkDeps(base, ['@dsh/core'])
  assert.ok(findings.some(f => f.message.includes('dsh-util')))
})

test('checkDeps flags missing link dep', () => {
  const findings = checkDeps(base, ['dsh-util'])
  assert.ok(findings.some(f => f.message.includes('@dsh/core')))
})

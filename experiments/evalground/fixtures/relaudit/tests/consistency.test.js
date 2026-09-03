import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkConsistency } from '../src/audit/consistency.js'

const staleBadge = [
  '# dsh-sample-plugin',
  '![badge](https://example.invalid/badge/v1.2.0)',
  '',
  '## 更新记录',
  '- v1.3.0 于 2025-12 发布（见 CHANGELOG.md）',
].join('\n')

test('checkConsistency passes when top badge matches', () => {
  const readme = '# x\nbadge v1.3.0\n'
  assert.deepEqual(checkConsistency({ version: '1.3.0' }, readme), [])
})

test('checkConsistency flags stale TOP badge even when a later token matches', () => {
  // Top badge says v1.2.0, changelog section below mentions v1.3.0. The FIRST
  // version token is the badge and must equal package.json version.
  const findings = checkConsistency({ version: '1.3.0' }, staleBadge)
  assert.ok(findings.some(f => f.message.includes('v1.2.0')), `expected badge finding, got ${JSON.stringify(findings)}`)
})

test('checkConsistency flags README without any version token', () => {
  const findings = checkConsistency({ version: '1.3.0' }, 'no versions here')
  assert.ok(findings.some(f => f.message.includes('无版本标注')))
})

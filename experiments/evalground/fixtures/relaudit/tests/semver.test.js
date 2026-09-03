import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVersion, compareVersions, isVersionGreater, changelogHead, releasedHead, checkSemver } from '../src/audit/semver.js'

test('parseVersion accepts valid semver', () => {
  assert.deepEqual(parseVersion('1.3.0'), { major: 1, minor: 3, patch: 0, pre: null })
  assert.deepEqual(parseVersion('2.0.0-beta.1'), { major: 2, minor: 0, patch: 0, pre: 'beta.1' })
})

test('parseVersion rejects malformed versions', () => {
  assert.equal(parseVersion('1.3'), null)
  assert.equal(parseVersion('v1.3.0'), null)
  assert.equal(parseVersion(''), null)
})

test('compareVersions: 1.10.0 > 1.9.0 (numeric, not lexicographic)', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1)
})

test('compareVersions equality', () => {
  assert.equal(compareVersions('1.3.0', '1.3.0'), 0)
  assert.equal(compareVersions('1.10.0', '1.10.0'), 0)
})

test('isVersionGreater refuses release regression against 1.10.0', () => {
  assert.equal(isVersionGreater('1.3.0', '1.10.0'), false)
  assert.equal(isVersionGreater('1.11.0', '1.10.0'), true)
})

test('changelogHead / releasedHead extractors', () => {
  assert.equal(changelogHead('## [1.3.0] - 2026-01-01\n'), '1.3.0')
  assert.equal(changelogHead('# no entries'), null)
  assert.equal(releasedHead(['1.2.0', '1.3.0']), '1.3.0')
  assert.equal(releasedHead([]), null)
})

test('checkSemver flags head/version mismatch', () => {
  const findings = checkSemver({ version: '1.3.0' }, '## [1.2.0] - 2026-01-01\n', ['1.2.0'])
  assert.ok(findings.some(f => f.message.includes('≠')))
})

test('checkSemver flags missing changelog entry', () => {
  const findings = checkSemver({ version: '1.3.0' }, '', ['1.2.0'])
  assert.ok(findings.some(f => f.message.includes('无可解析')))
})

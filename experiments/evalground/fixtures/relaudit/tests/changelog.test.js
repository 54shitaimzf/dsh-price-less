import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkChangelog } from '../src/audit/changelog.js'

const valid = `# Changelog

## [1.3.0] - 2026-01-05

### Added

- x

### Fixed

- y

### Changed

- z

## [1.2.0] - 2025-09-01

### Added

- a

### Fixed

- b

### Changed

- c
`

test('checkChangelog passes a valid changelog', () => {
  assert.deepEqual(checkChangelog(valid), [])
})

test('checkChangelog flags impossible calendar dates (month 13)', () => {
  const bad = valid.replace('2026-01-05', '2026-13-05')
  const findings = checkChangelog(bad)
  assert.ok(findings.some(f => f.message.includes('2026-13-05')), `expected date finding, got ${JSON.stringify(findings)}`)
})

test('checkChangelog flags impossible calendar dates (day 32)', () => {
  const bad = valid.replace('2025-09-01', '2025-09-32')
  const findings = checkChangelog(bad)
  assert.ok(findings.some(f => f.message.includes('2025-09-32')))
})

test('checkChangelog flags missing required section', () => {
  const bad = valid.replace('### Fixed\n\n- y\n', '')
  const findings = checkChangelog(bad)
  assert.ok(findings.some(f => f.message.includes('缺少 Fixed')))
})

test('checkChangelog flags empty changelog', () => {
  assert.ok(checkChangelog('# nothing\n').some(f => f.message.includes('无规范版本条目')))
})

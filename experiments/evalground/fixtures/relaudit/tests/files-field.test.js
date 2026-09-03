/**
 * R8 fixture-spec tests: files-field module is the T4 development target and
 * does not exist in the baseline fixture — these tests fail (import error)
 * until the module is implemented. Do not modify this file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkFilesField } from '../src/audit/files-field.js'

const pkg = {
  files: ['lib/', 'scripts/', 'README.md', 'CHANGELOG.md'],
}

const entries = [
  { name: 'package/package.json', size: 10 },
  { name: 'package/lib/index.js', size: 20 },
  { name: 'package/README.md', size: 30 },
  { name: 'package/CHANGELOG.md', size: 40 },
  { name: 'package/docs/extra/notes.md', size: 50 },
]

test('checkFilesField flags tarball entries not declared in files', () => {
  const findings = checkFilesField(pkg, entries)
  assert.ok(
    findings.some(f => f.message.includes('docs/extra/notes.md') && f.message.includes('未在 files 字段声明')),
    `expected undeclared-entry finding, got ${JSON.stringify(findings)}`,
  )
})

test('checkFilesField flags declared files missing from the tarball', () => {
  const missing = entries.filter(e => !e.name.includes('docs'))
  const findings = checkFilesField({ files: ['lib/', 'scripts/', 'README.md', 'CHANGELOG.md', 'docs/manual.md'] }, missing)
  assert.ok(
    findings.some(f => f.message.includes('docs/manual.md') && f.message.includes('缺失')),
    `expected missing-file finding, got ${JSON.stringify(findings)}`,
  )
})

test('checkFilesField flags declared directories that are absent', () => {
  const missing = entries.filter(e => !e.name.includes('docs') && !e.name.endsWith('/'))
  const findings = checkFilesField({ files: ['lib/', 'scripts/', 'README.md', 'CHANGELOG.md', 'docs/essays/'] }, missing)
  assert.ok(
    findings.some(f => f.message.includes('docs/essays/') && f.message.includes('缺失')),
    `expected missing-dir finding, got ${JSON.stringify(findings)}`,
  )
})

test('checkFilesField passes a fully declared tarball', () => {
  const clean = [
    { name: 'package/package.json', size: 10 },
    { name: 'package/lib/index.js', size: 20 },
    { name: 'package/README.md', size: 30 },
    { name: 'package/CHANGELOG.md', size: 40 },
    // dirs are represented as entries too (they end with '/')
    { name: 'package/scripts/', size: 0 },
    { name: 'package/lib/', size: 0 },
  ]
  assert.deepEqual(checkFilesField(pkg, clean), [])
})

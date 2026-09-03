import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTar } from './helpers/build-tar.js'
import { listTarballEntries, isDeclared } from '../src/audit/tarball.js'

const LONG_DIR = 'segment-notes-archive-card-format-spec-guide-wrapper-2026-so-80-characters-abcdefghijk'

test('listTarballEntries reads a plain ustar archive', () => {
  const tar = buildTar([
    { path: 'package/package.json', data: '{}' },
    { path: 'package/lib/index.js', data: 'x' },
  ])
  const entries = listTarballEntries(tar)
  assert.deepEqual(entries.map(e => e.name), ['package/package.json', 'package/lib/index.js'])
})

test('listTarballEntries handles gzipped archives', async () => {
  const { gzipSync } = await import('node:zlib')
  const tar = buildTar([{ path: 'package/README.md', data: 'r' }])
  const entries = listTarballEntries(gzipSync(tar))
  assert.equal(entries[0].name, 'package/README.md')
})

test('listTarballEntries preserves long paths split into ustar prefix', () => {
  const path = `package/docs/${LONG_DIR}/guide.md`
  assert.ok(path.length > 100, 'fixture path must exceed 100 chars')
  const tar = buildTar([{ path, data: 'guide' }])
  const entries = listTarballEntries(tar)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, path) // full path, not the bare basename
})

test('isDeclared: dir prefixes and exact files', () => {
  assert.equal(isDeclared('package/lib/index.js', ['lib/']), true)
  assert.equal(isDeclared('package/README.md', ['README.md']), true)
  assert.equal(isDeclared('package/package.json', ['lib/']), true)
})

test('isDeclared: undeclared deep paths are rejected', () => {
  assert.equal(isDeclared(`package/docs/${LONG_DIR}/guide.md`, ['lib/', 'README.md']), false)
})

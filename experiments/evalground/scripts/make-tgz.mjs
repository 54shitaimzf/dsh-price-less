/**
 * Deterministic sample tarball builder for the fixture.
 * Regenerates fixture sample-pkg/dist/relaudit-plugin-1.3.0.tgz from the
 * fixture's own sample package files (content is read from disk so the
 * tarball always matches the fixture).
 *
 * Usage: node scripts/make-tgz.mjs  (from experiments/evalground)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { buildTar } from '../fixtures/relaudit/tests/helpers/build-tar.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '../fixtures/relaudit/sample-pkg')
const outFile = path.join(pkgDir, 'dist', 'relaudit-plugin-1.3.0.tgz')

const LONG_DIR = 'segment-notes-archive-card-format-spec-guide-wrapper-2026-so-80-characters-abcdefghijk'
const entries = [
  { path: 'package/package.json', data: fs.readFileSync(path.join(pkgDir, 'package.json')) },
  { path: 'package/lib/index.js', data: fs.readFileSync(path.join(pkgDir, 'lib/index.js')) },
  { path: 'package/README.md', data: fs.readFileSync(path.join(pkgDir, 'README.md')) },
  { path: 'package/CHANGELOG.md', data: fs.readFileSync(path.join(pkgDir, 'CHANGELOG.md')) },
  { path: 'package/scripts/', data: '' },
  { path: `package/docs/${LONG_DIR}/guide.md`, data: 'guide' },
]

const tar = buildTar(entries)
const gz = gzipSync(tar)
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, gz)
console.log(`wrote ${outFile} (${gz.length} bytes, ${entries.length} entries)`)

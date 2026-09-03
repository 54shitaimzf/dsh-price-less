/**
 * Fixture integrity — the relaudit template must be IMMUTABLE (models work on
 * run workspaces, never on fixtures/). hashFixture() fingerprints every file;
 * checkFixture() compares against a committed golden (tests/golden/
 * fixture-hashes.json) and fails loudly so a corrupted template can never
 * silently poison a run matrix.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { FIXTURE_DIR, GOLDEN_DIR } from './paths.mjs'

export const GOLDEN_HASH_FILE = path.join(GOLDEN_DIR, 'fixture-hashes.json')

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function walk(dir, root = dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.tmp')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full, root))
    else out.push(path.relative(root, full).replaceAll('\\', '/'))
  }
  return out.sort()
}

/** Fingerprint the fixture: file list + per-file sha256 + total file count. */
export function hashFixture(fixtureDir = FIXTURE_DIR) {
  const files = walk(fixtureDir)
  const hashes = {}
  for (const rel of files) hashes[rel] = sha256(path.join(fixtureDir, rel))
  const combined = files.map(rel => `${rel}:${hashes[rel]}`).join('\n')
  return { files: hashes, count: files.length, totalHash: createHash('sha256').update(combined).digest('hex') }
}

/** True when the fixture currently matches the committed golden. */
export function checkFixture(goldenFile = GOLDEN_HASH_FILE, fixtureDir = FIXTURE_DIR) {
  if (!fs.existsSync(goldenFile)) return { ok: false, reason: `no golden file at ${goldenFile} (run fixture-hash --write first)` }
  let golden
  try { golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8')) } catch (e) { return { ok: false, reason: `golden unreadable: ${e.message}` } }
  const now = hashFixture(fixtureDir)
  if (now.count !== golden.count) return { ok: false, reason: `file count changed ${golden.count} → ${now.count}` }
  const diffs = []
  for (const rel of Object.keys(golden.files)) {
    if (now.files[rel] !== golden.files[rel]) diffs.push(rel)
  }
  for (const rel of Object.keys(now.files)) if (!(rel in golden.files)) diffs.push(`+${rel}`)
  if (diffs.length > 0) return { ok: false, reason: `${diffs.length} file(s) differ: ${diffs.slice(0, 8).join(', ')}…` }
  return { ok: true }
}

/** Write the current fixture fingerprint as the committed golden. */
export function writeGolden(goldenFile = GOLDEN_HASH_FILE, fixtureDir = FIXTURE_DIR) {
  fs.mkdirSync(path.dirname(goldenFile), { recursive: true })
  fs.writeFileSync(goldenFile, JSON.stringify(hashFixture(fixtureDir), null, 2))
  return goldenFile
}
/**
 * Workspace lifecycle: pristine copy from the fixture template, path guard,
 * diff collection against the template. The model only ever sees/mutates the
 * run workspace; answers/ and the template live outside it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EVAL_ROOT, FIXTURE_DIR, RUNS_DIR, SCRATCH_DIR } from './paths.mjs'

export { EVAL_ROOT, FIXTURE_DIR, RUNS_DIR, SCRATCH_DIR }

const NOISE = new Set(['data/runs.json'])

export function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function listFiles(dir, root = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.tmp-')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, root))
    else out.push(path.relative(root, full).replaceAll('\\', '/'))
  }
  return out.sort()
}

/** Copy the pristine template into a run workspace (guaranteed clean). */
export function createWorkspace(runDir) {
  const ws = path.join(runDir, 'workspace')
  if (fs.existsSync(ws)) fs.rmSync(ws, { recursive: true, force: true })
  fs.cpSync(FIXTURE_DIR, ws, { recursive: true })
  // template fingerprint for diffing
  fs.writeFileSync(path.join(runDir, 'template.sha256'), sha256(path.join(FIXTURE_DIR, 'package.json')))
  return ws
}

/** Diff of workspace vs template: added/modified/deleted, excluding noise. */
export function collectDiff(workspace) {
  const templateFiles = listFiles(FIXTURE_DIR)
  const wsFiles = listFiles(workspace)
  const diff = { modified: [], added: [], deleted: [] }
  for (const rel of templateFiles) {
    if (NOISE.has(rel)) continue
    const t = path.join(FIXTURE_DIR, rel)
    const w = path.join(workspace, rel)
    if (!fs.existsSync(w)) diff.deleted.push(rel)
    else if (sha256(t) !== sha256(w)) diff.modified.push(rel)
  }
  for (const rel of wsFiles) {
    if (NOISE.has(rel)) continue
    if (!templateFiles.includes(rel)) diff.added.push(rel)
  }
  return diff
}

/** Resolve a user-supplied path securely inside the workspace. */
export function guardPath(workspace, rel) {
  const resolved = path.resolve(workspace, rel)
  const root = path.resolve(workspace)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes workspace: ${rel}`)
  }
  return resolved
}

/** Paths outside the workspace that must never be readable (answers, fixture template). */
export function outsidePaths() {
  return [path.join(EVAL_ROOT, 'answers'), path.join(EVAL_ROOT, 'fixtures'), path.join(EVAL_ROOT, 'runs')]
}

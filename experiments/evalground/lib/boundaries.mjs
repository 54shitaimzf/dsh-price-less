/**
 * Boundary marks — the READ side of pre-computed task boundaries.
 *
 * A task-boundary mark is produced offline by preprocessing (the discriminator
 * cuts task segments and records the true cost of that decision) and stored as
 * `boundaries/<id>.boundaries.json`. At experiment runtime the runner reads these
 * marks to locate segment boundaries and compress at segment ends — it does NOT
 * re-run a dynamic task-partition state machine.
 *
 * The mark carries the REAL cost of the task-partition decision (usage + USD),
 * which is attributed to `costs.decision` in the scorecard.
 *
 * Pure read + locate functions, zero IO beyond filesystem access to the mark.
 */
import fs from 'node:fs'
import path from 'node:path'
import { BOUNDARIES_DIR } from './paths.mjs'

/** Boundary mark file for a task id (`boundaries/<id>.boundaries.json`).
 * Kept OUT of tasks/ so tasks.mjs listTasks/loadTask never mistake it for a task. */
export function boundaryMarkPath(taskId) {
  return path.join(BOUNDARIES_DIR, `${taskId}.boundaries.json`)
}

/**
 * Load a task's boundary mark; null when the preprocessing step has not
 * produced one (the caller then falls back to legacy whole-surface behavior).
 * @param {string} taskId
 * @returns {object|null} { taskId, source, cost, boundaries: [{segmentIndex, startSeq, endSeq, verdict}] }
 */
export function loadBoundaries(taskId) {
  const file = boundaryMarkPath(taskId)
  if (!fs.existsSync(file)) return null
  try {
    const mark = JSON.parse(fs.readFileSync(file, 'utf8'))
    return mark && mark.taskId === taskId ? mark : null
  } catch {
    return null
  }
}

/** Persist a boundary mark to disk (creates the boundaries/ dir on demand).
 * This is the preprocessing step's writer — the discriminator results + the
 * real task-partition cost are stored here for the runner and scorecard.
 * Only the mark's core fields are written: `stream` (full message texts) is
 * deliberately stripped so the mark file stays a compact data-mark, not the
 * whole conversation. */
export function writeBoundaries(taskId, mark) {
  fs.mkdirSync(BOUNDARIES_DIR, { recursive: true })
  const file = boundaryMarkPath(taskId)
  const { stream, ...core } = mark
  fs.writeFileSync(file, JSON.stringify({ taskId, ...core }, null, 2))
  return file
}

/**
 * Locate which segment a given seq belongs to.
 * @param {object} mark — a boundary mark (see loadBoundaries)
 * @param {number} seq
 * @returns {{segmentIndex, startSeq, endSeq, verdict}|null} the enclosing segment (or null)
 */
export function findBoundaryAt(mark, seq) {
  if (!mark || !Array.isArray(mark.boundaries) || mark.boundaries.length === 0) return null
  for (const b of mark.boundaries) {
    if (seq >= b.startSeq && seq <= b.endSeq) return b
  }
  return null
}

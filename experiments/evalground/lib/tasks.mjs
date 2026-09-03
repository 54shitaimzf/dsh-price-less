/**
 * Task registry — single loader for tasks/*.json (id lookup by exact id or
 * by prefix, full listing, schema sanity). Replaces the ad-hoc readdir+find
 * snippets duplicated across run-one/run-all/review-packet/score.
 */
import fs from 'node:fs'
import path from 'node:path'
import { TASKS_DIR } from './paths.mjs'

function taskFileName(taskId) {
  return fs.readdirSync(TASKS_DIR).find(f => f.startsWith(taskId) && f.endsWith('.json') && !f.startsWith('.'))
}

/** Load one task by exact id (T3) or prefix ('T3-frontend'); null if missing. */
export function loadTask(taskId) {
  const file = taskFileName(taskId)
  if (!file) return null
  let task
  try { task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8')) } catch { return null }
  return { ...task, file }
}

/** Every task, sorted, as parsed objects. */
export function listTasks() {
  return fs.readdirSync(TASKS_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .sort()
    .map(f => ({ ...JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')), file: f }))
}

/** Sanity: a task must carry an id, a prompt or staged messages, and a valid track. */
export function validateTask(task) {
  const problems = []
  if (!task || typeof task.id !== 'string') problems.push('missing id')
  const promptOk = typeof task.prompt === 'string' && task.prompt.trim().length > 0
  const stagedOk = Array.isArray(task.messages) && task.messages.length > 0 && task.messages.every(m => typeof m === 'string' && m.trim().length > 0)
  if (!promptOk && !stagedOk) problems.push('no prompt or staged messages')
  const t = task.track ?? {}
  // track weights are percent-style (50+20+30=100); sum must be ≈100
  const sum = (t.mech ?? 0) + (t.judge ?? 0) + (t.human ?? 0)
  if (Math.abs(sum - 100) > 1e-9) problems.push(`track weights sum ${sum} (must be 100)`)
  return problems
}
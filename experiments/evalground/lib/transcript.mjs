/**
 * Transcript — the single writer/reader/digester for run transcripts.
 * Entry types are schema'd constants; the digest used by the judge is
 * produced here so every consumer shares one format (V3 adds 'compress'
 * and 'decision' entry types without touching consumers).
 */
import fs from 'node:fs'
import path from 'node:path'

export const ENTRY_TYPES = [
  'assistant', 'tool', 'stage', 'timeout', 'gateway-error',
  'no-tool-no-done', 'step-limit', 'compress', 'decision', 'hard-truncate',
  'task-boundary', 'task-compact',
]

export function validateEntry(entry) {
  const p = []
  if (!entry || typeof entry !== 'object') return ['entry must be an object']
  if (!ENTRY_TYPES.includes(entry.type)) p.push(`unknown type ${entry.type}`)
  if (entry.type === 'assistant' && !entry.content && !entry.toolCalls) p.push('assistant needs content or toolCalls')
  if (entry.type === 'tool' && !entry.tool) p.push('tool entry needs tool name')
  if (entry.type === 'stage' && typeof entry.index !== 'number') p.push('stage needs numeric index')
  if (entry.type === 'compress') {
    if (!entry.mode) p.push('compress entry needs mode')
    if (typeof entry.inputTokens !== 'number') p.push('compress entry needs inputTokens')
    if (entry.ok !== undefined && typeof entry.ok !== 'boolean') p.push('compress ok must be boolean when present')
  }
  if (entry.type === 'hard-truncate') {
    if (typeof entry.floor !== 'number') p.push('hard-truncate entry needs numeric floor')
  }
  if (entry.type === 'task-compact') {
    if (typeof entry.segmentIndex !== 'number') p.push('task-compact needs numeric segmentIndex')
    if (typeof entry.pressuredTokens !== 'number') p.push('task-compact needs pressuredTokens')
    if (typeof entry.retainedTokens !== 'number') p.push('task-compact needs retainedTokens')
  }
  if (entry.type === 'task-boundary') {
    if (typeof entry.segmentIndex !== 'number') p.push('task-boundary needs numeric segmentIndex')
  }
  return p
}

/** Append one entry (validated) to the transcript file. */
export function append(transcriptPath, entry) {
  const problems = validateEntry(entry)
  if (problems.length > 0) throw new Error(`transcript entry rejected: ${problems.join('; ')}`)
  fs.appendFileSync(transcriptPath, JSON.stringify(entry) + '\n')
}

/** Read all entries as parsed objects ([] when missing). */
export function readAll(transcriptPath) {
  if (!fs.existsSync(transcriptPath)) return []
  return fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

/** Per-type counters + step count for a run. */
export function summarize(entries) {
  const byType = {}
  for (const e of entries) byType[e.type] = (byType[e.type] ?? 0) + 1
  return {
    entries: entries.length,
    toolCalls: byType.tool ?? 0,
    gatewayErrors: byType['gateway-error'] ?? 0,
    stages: byType.stage ?? 0,
    compresses: byType.compress ?? 0,
    taskCompacts: byType['task-compact'] ?? 0,
    decisions: byType.decision ?? 0,
    byType,
  }
}

const DEFAULT_LIMITS = { maxLines: 60, assistantSlice: 450, toolArgSlice: 160, toolArgSliceLong: 220 }

/**
 * Judge-facing digest of the last N transcript lines (format shared by every
 * consumer). Extracted from judge.mjs so the digest contract lives here.
 */
export function digest(runDir, opts = {}) {
  const { maxLines, assistantSlice, toolArgSlice, toolArgSliceLong } = { ...DEFAULT_LIMITS, ...opts }
  const file = path.join(runDir, 'transcript.jsonl')
  if (!fs.existsSync(file)) return '(no transcript)'
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const out = []
  for (const line of lines.slice(-maxLines)) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'assistant') out.push(`[model] ${(e.content ?? '').slice(0, assistantSlice)}`)
    else if (e.type === 'tool') {
      const arg = typeof e.arg === 'object' ? JSON.stringify(e.arg).slice(0, toolArgSlice) : String(e.arg ?? '').slice(0, toolArgSliceLong)
      out.push(`[tool ${e.tool}] ${arg}`)
    }
    else if (e.type === 'gateway-error') out.push(`[gateway-error] ${e.message}`)
  }
  return out.join('\n')
}
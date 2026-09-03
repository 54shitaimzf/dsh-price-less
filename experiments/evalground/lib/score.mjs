/**
 * Score assembly: mech + judge (code-subjective) → per-run scorecard with
 * penalties and caps. Human track retired (per approved plan §2): humanRows
 * param is accepted for API compatibility (legacy review flow) but ignored —
 * scoring is entirely mech + judge and track.human is always 0.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT } from './workspace.mjs'

const CONFIG = JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, 'scores.config.json'), 'utf8'))

export function parseHumanCsv(file) {
  if (!file || !fs.existsSync(file)) return null
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  const header = rows[0].split(',').map(s => s.trim())
  const find = (name) => header.findIndex(h => h.startsWith(name))
  const iTask = find('task'); const iDim = find('dim'); const iWeight = find('weight'); const iDelta = find('score')
  if (iTask === -1 || iDelta === -1) return null
  const out = []
  for (const line of rows.slice(1)) {
    const cells = line.split(',').map(s => s.trim())
    if (cells.length <= iDelta) continue
    if (cells[iDelta] === '') continue
    const task = cells[iTask]; const dim = cells[iDim] ?? ''
    const weight = Number(cells[iWeight] ?? 0) || 0
    const delta = Number(cells[iDelta])
    if (Number.isNaN(delta)) continue
    out.push({ task, dim, weight, delta, notes: cells.slice(iDelta + 1).join(',') })
  }
  return out
}

/**
 * Beyond-golden credit: fair value for REAL extra findings beyond the gold set.
 * Only review tasks that carry the judge's `grounded` dimension participate.
 * Gated by how grounded the whole report is, so a model that discovers genuine
 * extra defects gets credit (total may exceed 100 — approved semantics), while
 * an over-reporting run earns nothing (its `grounded`/`precision` already deduct).
 */
function beyondGoldenCredit(judge, subjectivity) {
  const grounded = judge?.dims?.grounded
  if (grounded == null || grounded === undefined || !subjectivity) return 0
  const g = Math.max(0, Math.min(5, Number(grounded) || 0))
  const realExtras = Math.max(0, Math.min(6, Number(subjectivity.realExtras ?? 0) || 0))
  const gate = g >= 4 ? 1 : g >= 3 ? 0.5 : 0
  return Math.round(realExtras * 6 * gate)
}

export function assemble(task, mech, judge, humanRows, penalties = [], subjectivity = null) {
  const track = task.track
  const mechPart = (mech.score / 100) * (track.mech ?? 0)
  const judgePart = ((judge.score ?? 0) / 100) * (track.judge ?? 0)
  // human track retired: track.human must be 0; humanRows is ignored.
  let total = Math.round(mechPart + judgePart)
  // fair extra-findings credit (can push total above 100); gated on grounded.
  const beyondGolden = beyondGoldenCredit(judge, subjectivity)
  total += beyondGolden

  // penalties & caps
  const applied = []
  const p = CONFIG.penalties
  if (mech.violations.includes('tests-tampered')) {
    total = Math.min(total, p.testTamperScore)
    applied.push('test-tampered → mech 0')
  }
  if (mech.violations.some(v => v.startsWith('scope-violation'))) {
    total = Math.min(total, p.harmfulOverflowCap)
    applied.push('scope-violation → cap 60')
  }
  if (mech.violations.some(v => v === 'destructive-overflow')) {
    total = Math.min(total, p.destructiveCap)
    applied.push('destructive-overflow → cap 40')
  }
  if (mech.violations.includes('readonly-violation')) {
    total = Math.max(0, total - p.readonlyViolationPp)
    applied.push(`readonly-violation → −${p.readonlyViolationPp}pp`)
  }
  if ((judge.antiCheat?.verdict) === 'proven') {
    total = Math.max(0, total - 20)
    applied.push('antiCheat proven → −20pp')
  }
  if (judge.antiCheat?.verdict === 'suspect') {
    applied.push('antiCheat suspect (report only)')
  }

  return {
    task: task.id,
    mech: mech.score,
    judge: judge.score,
    total,
    beyondGolden,
    penalties: [...applied, ...penalties],
    antiCheat: judge.antiCheat,
  }
}

/**
 * Cost-per-successful-task — the ONLY cost judgment for the compression domain.
 *   costPerSuccessfulTask = total cost ÷ successful task count
 *   successful = the task cleared the quality gate (finished && total >= qualityGate).
 * A run that does NOT clear the gate is not a "win", however few tokens it spent.
 * The full paired gate (completion-not-degraded + blind-review-not-worse vs the
 * control) is applied in the REPORT layer across arms; this is the per-arm
 * primitive computed from one scorecard (cascade: taskBreakdown; single: total).
 *
 * Returns null when no task clears the gate (then the run is unqualified and must
 * not be compared on cost); never returns a number for a degenerate/no-win run.
 */
export function costPerSuccessfulTask(scorecard, opts = {}) {
  const qualityGate = opts.qualityGate ?? 60
  const sc = scorecard ?? {}
  const costs = sc.costs ?? {}
  const totalTokens = (costs.execution?.tokens ?? 0) + (costs.compression?.tokens ?? 0) + (costs.decision?.tokens ?? 0)
  const totalUsd = (costs.execution?.usd ?? 0) + (costs.compression?.usd ?? 0) + (costs.decision?.usd ?? 0)
  const breakdown = Array.isArray(sc.taskBreakdown) && sc.taskBreakdown.length > 0 ? sc.taskBreakdown : [{ total: sc.total, finished: sc.finished ?? true }]
  const successful = breakdown.filter(t => t.finished !== false && Number(t.total ?? 0) >= qualityGate)
  const n = successful.length
  if (n === 0 || totalTokens === 0) return null
  return {
    tasks: breakdown.length,
    successful: n,
    totalTokens,
    totalUsd,
    perSuccessfulTaskTokens: Math.round(totalTokens / n),
    perSuccessfulTaskUsd: Number((totalUsd / n).toFixed(8)),
  }
}

export function loadScorecard(runDir) {  const file = path.join(runDir, 'scorecard.json')
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

// CLI: merge a filled human sheet into an existing scorecard.
//   node lib/score.mjs --human=runs/<run>/human-sheet.csv --run=runs/<run>
const cliArgs = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v ?? true]
}))
if (cliArgs.human && cliArgs.run) {
  // Legacy human-merge CLI — kept for compatibility with the deprecated
  // review flow. Human track is retired: the merge only re-totals (mech+judge).
  const runDir = path.resolve(EVAL_ROOT, cliArgs.run)
  const sc = loadScorecard(runDir)
  if (!sc) { console.error('scorecard not found'); process.exit(1) }
  const rows = parseHumanCsv(cliArgs.human)
  const taskFile = fs.readdirSync(path.join(EVAL_ROOT, 'tasks')).find(f => f.startsWith(sc.task) && f.endsWith('.json'))
  const task = JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, 'tasks', taskFile), 'utf8'))
  const merged = assemble(task, sc.mech, sc.judge, rows, sc.penalties ?? [])
  sc.total = merged.total
  fs.writeFileSync(path.join(runDir, 'scorecard.json'), JSON.stringify(sc, null, 2))
  console.log(`legacy human-merge (deprecated; track.human retired): task=${sc.task} total=${merged.total}`)
}

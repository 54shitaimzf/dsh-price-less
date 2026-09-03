/**
 * Re-score an existing run WITHOUT re-executing: re-run mech (picks up the
 * gold-set change + report-match partial scoring), re-judge (picks up the new
 * `grounded` dim + golden injection), run the subjective audit, and patch the
 * scorecard (backed up to scorecard.re-score-bak.json). Safety: any judge or
 * subjective failure keeps the prior judge/subjectivity and total intact.
 *
 *   node scripts/re-score-run.mjs --run=runs/T1-industry-mthf84ed [--samples=3]
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT } from '../lib/paths.mjs'
import { loadTask } from '../lib/tasks.mjs'
import { mechCheck } from '../lib/mech.mjs'
import { judgeTask } from '../lib/judge.mjs'
import { subjectiveAudit } from '../lib/subjective.mjs'
import { assemble } from '../lib/score.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v ?? true]
}))
if (!args.run) { console.error('usage: node scripts/re-score-run.mjs --run=runs/<runId> [--samples=N]'); process.exit(1) }

const runDir = path.resolve(EVAL_ROOT, args.run)
const scPath = path.join(runDir, 'scorecard.json')
if (!fs.existsSync(scPath)) { console.error(`scorecard missing: ${scPath}`); process.exit(1) }
const sc = JSON.parse(fs.readFileSync(scPath, 'utf8'))
const task = loadTask(sc.task)
if (!task) { console.error(`task ${sc.task} not found`); process.exit(1) }
const CONFIG = JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, 'scores.config.json'), 'utf8'))
const samples = Number(args.samples) || 1

async function main() {
  const workspace = path.join(runDir, 'workspace')
  // 1. re-mech (deterministic; runner result kept for answer/scope checks)
  const mech = await mechCheck(workspace, task, { finalText: '', violations: sc.mech.violations ?? [] })
  // 2. re-judge (grounded dim + golden injection)
  let judge = await judgeTask({ task, mech, diff: mech.diff, runDir, workspace, provider: CONFIG.judge.provider, model: CONFIG.judge.model, samples })
  // 3. subjective audit (senior-reviewer); failures → null (non-blocking)
  const subjectivity = await subjectiveAudit({ task, runDir, workspace, provider: CONFIG.judge.provider, model: CONFIG.judge.model }).catch(() => null)

  fs.copyFileSync(scPath, path.join(runDir, 'scorecard.re-score-bak.json'))
  sc.mech = mech
  if (judge?.score !== null && judge?.score !== undefined) sc.judge = judge
  sc.subjectivity = subjectivity
  const assembled = assemble(task, sc.mech, judge, null, sc.penalties ?? [], subjectivity)
  sc.total = assembled.total
  sc.beyondGolden = assembled.beyondGolden
  fs.writeFileSync(scPath, JSON.stringify(sc, null, 2))

  console.log(`rescore: ${sc.runId}`)
  console.log(`  mech:   ${mech.score}  (checks: ${mech.checks.map(c => `${c.pass ? '+' : '-'}${c.check}`).join(', ')})`)
  console.log(`  judge:  ${judge?.score ?? '—'}  dims=${JSON.stringify(judge?.dims ?? {})}`)
  console.log(`  subj:   ${JSON.stringify(subjectivity)}`)
  console.log(`  total:  ${sc.total}`)
}
main().catch(e => { console.error(e); process.exit(1) })

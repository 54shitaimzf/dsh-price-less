/**
 * judge-only re-score of an existing run (library; CLI is bin/rejudge.mjs).
 * Re-runs the judge against an already-finished run's workspace/transcript/
 * mech and patches scorecard.json. No executor cost.
 *
 * Safety: a judge failure NEVER touches the scorecard — the previous judge
 * score and total stay intact and the failure is reported. Before writing,
 * the current scorecard is backed up to scorecard.rejudge-bak.json.
 */
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { EVAL_ROOT } from './paths.mjs'
import { judgeTask } from './judge.mjs'
import { subjectiveAudit } from './subjective.mjs'
import { assemble } from './score.mjs'
import { loadTask } from './tasks.mjs'

/**
 * Re-judge one run.
 * @returns {Promise<{ok:boolean, scorecard, judge?, reason?}>}
 */
export async function rejudgeRun({ run, samples = 1, retries = 2, callLLM, judgeModel, judgeProvider }) {
  const runDir = path.resolve(EVAL_ROOT, run)
  const scPath = path.join(runDir, 'scorecard.json')
  if (!fs.existsSync(scPath)) return { ok: false, reason: `scorecard missing: ${scPath}` }
  const sc = JSON.parse(fs.readFileSync(scPath, 'utf8'))
  const task = loadTask(sc.task)
  if (!task) return { ok: false, reason: `task ${sc.task} not found` }
  const CONFIG = JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, 'scores.config.json'), 'utf8'))

  // whole-judgment retry loop: a gateway hiccup must not burn the score
  let judge = null
  let lastFail = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    judge = await judgeTask({
      task, mech: sc.mech, diff: sc.mech.diff, runDir,
      workspace: path.join(runDir, 'workspace'),
      provider: judgeProvider ?? CONFIG.judge.provider,
      model: judgeModel ?? CONFIG.judge.model,
      samples: Number(samples) || 1,
      callLLM,
    })
    if (judge?.score !== null && judge?.score !== undefined) break
    lastFail = judge
    if (attempt < retries) {
      console.error(`judge attempt ${attempt + 1} failed (${judge?.error || judge?.evidence || 'unknown'}) — retrying in 3s…`)
      await sleep(3000)
    }
  }

  if (judge?.score === null || judge?.score === undefined) {
    const reason = [`rejudge FAILED for ${sc.runId} after ${retries + 1} attempts: judge score is null — scorecard NOT touched (previous judge ${sc.judge?.score ?? 'n/a'} kept)`]
    if (lastFail?.error) reason.push(`error: ${lastFail.error}`)
    if (lastFail?.parseFailed) reason.push(`parseFailed — raw head: ${(lastFail.raw ?? '').slice(0, 300)}`)
    if (lastFail?.skipped) reason.push(`skipped: ${lastFail.evidence ?? ''}`)
    return { ok: false, scorecard: sc, judge: lastFail, reason: reason.join('\n  ') }
  }

  // backup, then patch
  fs.copyFileSync(scPath, path.join(runDir, 'scorecard.rejudge-bak.json'))
  const merged = assemble(task, sc.mech, judge, null, sc.penalties ?? [], sc.subjectivity)
  sc.judge = judge
  sc.total = merged.total
  sc.beyondGolden = merged.beyondGolden
  // recompute the subjective (senior-reviewer) audit too; never blocks the
  // rejudge if it fails.
  sc.subjectivity = await subjectiveAudit({
    task, runDir, workspace: path.join(runDir, 'workspace'),
    provider: judgeProvider ?? CONFIG.judge.provider,
    model: judgeModel ?? CONFIG.judge.model,
    callLLM,
  }).catch(() => null)
  fs.writeFileSync(scPath, JSON.stringify(sc, null, 2))
  return { ok: true, scorecard: sc, judge, notes: judge.notes }
}
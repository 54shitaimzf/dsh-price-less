/**
 * run-all: task × arm × reps matrix with per-run scorecards and arm Δ summary.
 * The orchestration is a pure library function (runMatrix) so batch logic can
 * be asserted offline; bin/run-all.mjs is the thin CLI shell.
 *
 *   node bin/run-all.mjs --tasks=T1,T4 --reps=2 --arms=native-auto,self-s2-orig --no-judge
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT, RUNS_DIR } from './paths.mjs'
import { runOne } from './run-one.mjs'
import { loadTask } from './tasks.mjs'
import { renderArmSummary } from './report.mjs'
import { loadScoresConfig } from './config.mjs'

/**
 * Run a task × arm × reps matrix.
 * @param {object} plan { tasks, arms, reps, model, provider, noJudge, contextMode,
 *   samples, timeoutMs, callLLM, budgetUsd, armSpecFile }
 *   budgetUsd: hard cap on execution+judge cost across the whole matrix;
 *   optional (run one task×arm×rep unit-cost probe with --budget to calibrate).
 * @returns {Promise<{scorecards, summaryPath, budgetExceeded, spentUsd}>}
 */
export async function runMatrix(plan) {
  const rawTasks = plan.tasks ?? 'T0,T1,T2,T3,T4,T5,T6,T7'
  const taskIds = Array.isArray(rawTasks) ? rawTasks : String(rawTasks).split(',').filter(Boolean)
  const arms = plan.arms ?? ['native-auto']
  const reps = Number(plan.reps ?? 1)
  const budgetUsd = plan.budgetUsd ? Number(plan.budgetUsd) : null

  const scorecards = []
  let spentUsd = 0
  let budgetExceeded = false
  for (const taskId of taskIds) {
    if (budgetExceeded) break
    const task = loadTask(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    for (const arm of arms) {
      if (budgetExceeded) break
      for (let i = 0; i < reps; i++) {
        const { runDir, scorecard } = await runOne(task, {
          arm,
          model: plan.model,
          provider: plan.provider,
          noJudge: !!plan.noJudge,
          contextMode: plan.contextMode,
          callLLM: plan.callLLM,
          samples: plan.samples ? Number(plan.samples) : undefined,
          timeoutMs: plan.timeoutMs ? Number(plan.timeoutMs) : 25 * 60 * 1000,
        })
        scorecards.push(scorecard)
        const c = scorecard.costs
        const runUsd = (c.execution?.usd ?? 0) + (c.judge?.usd ?? 0) + (c.compression?.usd ?? 0) + (c.decision?.usd ?? 0)
        spentUsd += runUsd
        console.log(`[${task.id}/${arm}/${i}] run=${runDir} total=${scorecard.total} mech=${scorecard.mech.score} judge=${scorecard.judge.score} finished=${scorecard.finished} cost≈$${runUsd.toFixed(6)}`)
        if (budgetUsd !== null && spentUsd > budgetUsd) {
          budgetExceeded = true
          console.error(`\n⚠ BUDGET CAP $${budgetUsd} EXCEEDED at $${spentUsd.toFixed(6)} — matrix stopped (loss limited to this batch)`)
          break
        }
      }
    }
  }
  const summary = path.join(RUNS_DIR, `summary-${Date.now().toString(36)}.md`)
  fs.writeFileSync(summary, renderArmSummary(scorecards))
  return { scorecards, summaryPath: summary, budgetExceeded, spentUsd: Number(spentUsd.toFixed(8)) }
}
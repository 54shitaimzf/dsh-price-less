/**
 * Controlled judge-stability experiment (judge-only, no execution).
 * Re-judge the SAME task artifact from a run dir with several evaluation
 * ARMS (effort × prompt-version), N samples each, and report the per-sample
 * score/dim distribution + spread + output-token mean (cost projection).
 * This isolates judge (grading) variance from executor variance.
 *
 *   node scripts/judge-stability-exp.mjs [--run=runs/CASCADE-self-s1-orig-mtlwulff]
 *        [--task=T1] [--n=5] [--models=deepseek-v4-flash-vision-exp]
 *        [--efforts=none,low] [--prompt-versions=2]
 *
 * Arms are the cross product of --efforts × --prompt-versions; prompt-version 1
 * = the pre-hardening prompt (no SCORING DISCIPLINE block), 2 = current.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT } from '../lib/paths.mjs'
import { loadTask } from '../lib/tasks.mjs'
import { judgeTask } from '../lib/judge.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v ?? true]
}))
const runRel = args.run ?? 'runs/CASCADE-self-s1-orig-mtlwulff'
const n = Number(args.n) || 5
const models = (args.models ?? 'deepseek-v4-flash-vision-exp').split(',').filter(Boolean)
const efforts = (args.efforts ?? 'none').split(',').filter(Boolean)
const promptVersions = (args['prompt-versions'] ?? '2').split(',').flatMap(s => s.split('+')).map(Number).filter(Boolean)
const provider = 'deepseek'
const BUDGET_CAP_USD = Number(args['cap-usd'] ?? 0.20)

const runDir = path.resolve(EVAL_ROOT, runRel)
const sc = JSON.parse(fs.readFileSync(path.join(runDir, 'scorecard.json'), 'utf8'))
const taskId = args.task ?? sc.task
const task = loadTask(String(taskId))
if (!task) { console.error(`no such task: ${taskId}`); process.exit(1) }
const workspace = path.join(runDir, 'workspace')
// Recompute mech EXACTLY like scoreOne does (cascade scorecards store only the
// numeric mech score; judgeTask needs the full {checks, violations, diff}).
const { mechCheck, writtenPathsOf } = await import('../lib/mech.mjs')
const { readAll } = await import('../lib/transcript.mjs')
const { taskFinalText } = await import('../lib/run-one.mjs')
const entries = readAll(path.join(runDir, 'transcript.jsonl'))
const { splitTranscriptByTask, humanTaskStream } = await import('../lib/cascade.mjs')
const tasksAll = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'].map(loadTask).filter(Boolean)
const stream = humanTaskStream(tasksAll)
const window = sc.task === 'CASCADE'
  ? splitTranscriptByTask(entries, stream)[String(taskId)] ?? []
  : entries
const mech = await mechCheck(workspace, task, { ...sc, finalText: taskFinalText(window, String(taskId)) }, {
  writtenPaths: writtenPathsOf(window),
  transcriptText: JSON.stringify(window),
})

const median = (a) => {
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}
const fmt = (a) => {
  if (a.length === 0) return '—'
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - a.reduce((y, t) => y + t, 0) / a.length) ** 2, 0) / a.length)
  return `mean=${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)} med=${median(a)} min=${Math.min(...a)} max=${Math.max(...a)} spread=${Math.max(...a) - Math.min(...a)} sd=${sd.toFixed(1)}`
}

let totalCalls = 0
const report = { run: runRel, task: taskId, n, arms: [] }
for (const model of models) {
  for (const effort of efforts) {
    for (const pv of promptVersions) {
      const scores = []
      const dims = {}
      const outTokens = []
      const can = []
      let fails = 0
      for (let i = 0; i < n; i++) {
        totalCalls++
        if (totalCalls * 0.011 > BUDGET_CAP_USD) {
          console.error(`BUDGET CAP reached (${BUDGET_CAP_USD} USD est) — stopping at call ${totalCalls}`)
          process.exit(2)
        }
        try {
          const j = await judgeTask({ task, mech, diff: mech?.diff, runDir, workspace, provider, model, samples: 1, judgeEffort: effort === 'none' ? undefined : effort, judgePromptVersion: pv })
          if (Number.isFinite(j.score)) {
            scores.push(j.score)
            for (const [d, v] of Object.entries(j.dims ?? {})) (dims[d] ??= []).push(v)
            can.push(j.calibrationSuspect)
            outTokens.push(j.usage?.outputTokens ?? 0)
          } else {
            fails++
          }
        } catch (e) {
          fails++
        }
      }
      const arm = { model, effort, promptVersion: pv, n, fails, scores, dims, outTokens, calibrationSuspect: can.filter(Boolean).length }
      report.arms.push(arm)
      console.log(`\n=== judge ${model} | effort=${effort} | prompt v${pv} (n=${n}, failures=${fails}) ===`)
      console.log(`  score ${fmt(scores)}`)
      for (const [d, vals] of Object.entries(dims)) console.log(`  dim ${d}: ${fmt(vals)}`)
      console.log(`  outTokens: mean=${outTokens.length ? Math.round(outTokens.reduce((a, b) => a + b, 0) / outTokens.length) : '—'} (per call)`)
      console.log(`  calibrationSuspect count: ${arm.calibrationSuspect}`)
    }
  }
}
const outFile = path.join(EVAL_ROOT, 'reports', args.out ?? 'judge-stability-deepseek-2026-09.json')
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
console.log(`\nraw report → ${path.relative(EVAL_ROOT, outFile)} (calls=${totalCalls})`)

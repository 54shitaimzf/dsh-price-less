/**
 * Controlled judge-stability experiment (judge-only, no execution).
 * Re-judge the SAME T1 REVIEW.md artifact with several evaluation models,
 * N samples each, and report the per-sample score/dim distribution + spread.
 * This isolates judge (grading) variance from executor variance.
 *
 *   node scripts/judge-stability-exp.mjs [--run=runs/T1-industry-mthhap1r] [--n=5]
 *   [--models=hy3,deepseek-v4-flash,glm-5.3-flash]
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
const runRel = args.run ?? 'runs/T1-industry-mthhap1r'
const n = Number(args.n) || 5
const models = (args.models ?? 'hy3,deepseek-v4-flash,glm-5.3-flash').split(',').filter(Boolean)
const provider = 'deepseek'

const runDir = path.resolve(EVAL_ROOT, runRel)
const sc = JSON.parse(fs.readFileSync(path.join(runDir, 'scorecard.json'), 'utf8'))
const task = loadTask(sc.task)
const workspace = path.join(runDir, 'workspace')
const mech = sc.mech

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

for (const model of models) {
  const scores = []
  const dims = {}
  const can = []
  let fails = 0
  for (let i = 0; i < n; i++) {
    try {
      const j = await judgeTask({ task, mech, diff: mech.diff, runDir, workspace, provider, model, samples: 1 })
      if (Number.isFinite(j.score)) {
        scores.push(j.score)
        for (const [d, v] of Object.entries(j.dims ?? {})) (dims[d] ??= []).push(v)
        can.push(j.calibrationSuspect)
      } else {
        fails++
      }
    } catch (e) {
      fails++
    }
  }
  console.log(`\n=== judge model ${model} (n=${n}, failures=${fails}) ===`)
  console.log(`  score ${fmt(scores)}`)
  for (const [d, vals] of Object.entries(dims)) {
    console.log(`  dim ${d}: ${fmt(vals)}`)
  }
  console.log(`  calibrationSuspect count: ${can.filter(Boolean).length}`)
}

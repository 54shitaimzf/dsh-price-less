/**
 * Judge-stability audit (read-only, no LLM): scan every run's scorecard,
 * group by judgeModel, and report:
 *   - n runs judged by that model
 *   - count `judge.unstable` (within-run 3-sample spread >= 2)
 *   - count `judge.calibrationSuspect`
 *   - median judge score, and dims seen
 *   - cross-run score list per task/arm (same model re-judged the same report)
 * This tells which evaluation model is the most *consistent* grader.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT } from '../lib/paths.mjs'

const runsDir = path.join(EVAL_ROOT, 'runs')
const groups = {} // judgeModel -> { n, unstable, suspect, scores[], dimsSet, byKey: {key: [scores]} }

for (const dir of fs.readdirSync(runsDir)) {
  const scPath = path.join(runsDir, dir, 'scorecard.json')
  if (!fs.existsSync(scPath)) continue
  let sc
  try { sc = JSON.parse(fs.readFileSync(scPath, 'utf8')) } catch { continue }
  const judge = sc.judge
  const model = sc.judgeModel ?? '?'
  if (!judge || (!Number.isFinite(judge.score) && !judge.dims)) continue
  const g = groups[model] ??= { n: 0, unstable: 0, suspect: 0, scores: [], dimsSet: new Map(), byKey: {} }
  g.n++
  if (judge.unstable) g.unstable++
  if (judge.calibrationSuspect) g.suspect++
  if (Number.isFinite(judge.score)) g.scores.push(judge.score)
  for (const [d, v] of Object.entries(judge.dims ?? {})) {
    const arr = g.dimsSet.get(d) ?? []
    arr.push(v)
    g.dimsSet.set(d, arr)
  }
  const key = `${sc.task}/${sc.arm}`
  const byKey = g.byKey[key] ??= []
  if (Number.isFinite(judge.score)) byKey.push(judge.score)
}

const median = (a) => {
  if (a.length === 0) return null
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

for (const [model, g] of Object.entries(groups).sort()) {
  console.log(`\n=== judge model ${model} ===`)
  console.log(`  runs=${g.n}  unstable=${g.unstable} (${((g.unstable / g.n) * 100).toFixed(0)}%)  calibrationSuspect=${g.suspect}`)
  console.log(`  judge score: median=${median(g.scores)}  min=${Math.min(...g.scores, 0)}  max=${Math.max(...g.scores, 0)}  (n=${g.scores.length})`)
  console.log(`  dims averages: ${Object.entries(g.dimsSet).map(([d, v]) => `${d}=${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)}`).join('  ')}`)
  console.log(`  cross-run same report (task/arm → scores):`)
  for (const [k, scores] of Object.entries(g.byKey)) {
    if (scores.length >= 2) console.log(`    ${k}: ${scores.join(', ')}  spread=${Math.max(...scores) - Math.min(...scores)}`)
  }
}

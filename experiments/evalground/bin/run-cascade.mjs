/**
 * CLI thin shell — run-cascade (whole-stream T0..T7 as one conversation).
 *   node bin/run-cascade.mjs --arm=self-s2-orig [--tasks=T0,T1,...] [--no-judge]
 */
import { runCascade } from '../lib/run-cascade.mjs'
import { loadTask } from '../lib/tasks.mjs'

const rawArgs = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v ?? true]
}))
// Normalize kebab-case → camelCase so `--no-judge` reads as `args.noJudge`.
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
const args = Object.fromEntries(Object.entries(rawArgs).map(([k, v]) => [camel(k), v]))

let tasks = args.tasks
  ? String(args.tasks).split(',').map(s => s.trim()).filter(Boolean).map(loadTask).filter(Boolean)
  : ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'].map(loadTask).filter(Boolean)
if (tasks.length === 0) { console.error('no tasks resolved'); process.exit(1) }

runCascade({
  tasks,
  arm: args.arm,
  model: args.model,
  provider: args.provider,
  noJudge: !!args.noJudge,
  skipScore: !!args.skipScore,
  samples: args.samples ? Number(args.samples) : undefined,
  maxSteps: args.maxSteps ? Number(args.maxSteps) : undefined,
  timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
})
  .then(({ runDir, scorecard }) => {
    console.log(`cascade run ${runDir} (${tasks.length} tasks, arm=${scorecard.arm})`)
    console.log(JSON.stringify({
      finished: scorecard.finished,
      steps: scorecard.steps,
      taskBreakdown: scorecard.taskBreakdown,
      total: scorecard.total,
      avgJudge: scorecard.avgJudge,
      costs: scorecard.costs,
    }, null, 2))
  })
  .catch(e => { console.error(e); process.exit(1) })

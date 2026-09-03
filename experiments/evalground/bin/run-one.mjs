/**
 * CLI thin shell — run-one.
 *   node bin/run-one.mjs --task=T4 [--model=...] [--no-judge] [--contextMode=...]
 */
import { runOne } from '../lib/run-one.mjs'
import { loadTask } from '../lib/tasks.mjs'

const rawArgs = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v ?? true]
}))
// Normalize kebab-case → camelCase so `--no-judge` reads as `args.noJudge`
// (otherwise the flag is silently ignored and the judge runs, wasting cost).
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
const args = Object.fromEntries(Object.entries(rawArgs).map(([k, v]) => [camel(k), v]))

if (!args.task) {
  console.error('usage: node bin/run-one.mjs --task=T4 [--reps=1] [--no-judge] [--contextMode=...] [--samples=N]')
  process.exit(1)
}
const task = loadTask(args.task)
if (!task) { console.error(`task not found: ${args.task}`); process.exit(1) }

runOne(task, {
  arm: args.arm,
  model: args.model,
  noJudge: !!args.noJudge,
  contextMode: args.contextMode,
  samples: args.samples ? Number(args.samples) : undefined,
  timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
})
  .then(({ runDir, scorecard }) => {
    console.log(`run ${runDir}`)
    console.log(JSON.stringify({ total: scorecard.total, mech: scorecard.mech.score, judge: scorecard.judge.score, finished: scorecard.finished, violations: scorecard.mech.violations }, null, 2))
  })
  .catch(e => { console.error(e); process.exit(1) })
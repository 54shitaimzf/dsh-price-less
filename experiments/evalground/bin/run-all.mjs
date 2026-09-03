/**
 * CLI thin shell — run-all matrix.
 *   node bin/run-all.mjs --tasks=T1,T4 --reps=2 --arms=baseline,armA --no-judge
 */
import { runMatrix } from '../lib/run-all.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v ?? true]
}))

runMatrix({
  tasks: args.tasks ? args.tasks.split(',') : undefined,
  arms: args.arms ? args.arms.split(',') : undefined,
  reps: args.reps,
  model: args.model,
  provider: args.provider,
  noJudge: args.noJudge,
  contextMode: args.contextMode,
  samples: args.samples,
  timeoutMs: args.timeoutMs,
  budgetUsd: args.budget ? Number(args.budget) : undefined,
})
  .then(({ summaryPath }) => console.log(`\nsummary: ${summaryPath}`))
  .catch(e => { console.error(e); process.exit(1) })
/**
 * CLI thin shell — rejudge one run.
 *   node bin/rejudge.mjs --run=runs/T5-ground-mtgpx02i [--samples=3] [--retries=2]
 */
import { rejudgeRun } from '../lib/rejudge.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v ?? true]
}))

if (!args.run) { console.error('usage: node bin/rejudge.mjs --run=runs/<runId> [--samples=N] [--retries=N]'); process.exit(1) }

rejudgeRun({ run: args.run, samples: args.samples, retries: args.retries })
  .then(res => {
    if (res.ok) {
      console.log(`rejudged: ${res.scorecard.runId} judge=${res.judge.score} dims=${JSON.stringify(res.judge.dims)} suspect=${res.judge.calibrationSuspect} total=${res.scorecard.total}`)
      console.log(`notes: ${res.notes}`)
    } else {
      console.error(res.reason)
      process.exit(1)
    }
  })
  .catch(e => { console.error(e); process.exit(1) })
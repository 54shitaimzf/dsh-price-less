// one-off live check: NATIVE control arm under the SAME rig as cache-live-check —
// same 3×T0 stream, real gateway, same recording; calibrated small thresholds so
// the whole-surface pressure trigger fires (F1 double-count applies, as in any
// native run). Compares cache hit + per-compression cost vs the PTC self arms.
import { runCascade } from '../lib/run-cascade.mjs'
import { createRecordingGateway } from '../lib/gateway-mock.mjs'
import { createGateway } from '../lib/gateway.mjs'
import { loadTask } from '../lib/tasks.mjs'

function isCompressCall(rec) {
  const msgs = rec.req?.messages ?? []
  const last = msgs[msgs.length - 1]
  return typeof last?.content === 'string' && /compaction engine|compactor/.test(last.content) && last.content.includes('Primary Request')
}

const tasks = [loadTask('T0'), loadTask('T0'), loadTask('T0')]
const inner = createGateway()
const rec = createRecordingGateway({ inner, dir: './.assert-tmp/cache-live-native' })
let b
try {
  b = await runCascade({
    tasks, arm: 'native-auto', callLLM: rec.chatCall,
    model: 'hy3', provider: 'opencode-go-v4',
    skipScore: true,
    // tiny task-scale calib so the F1-double-count trigger fires on this small stream
    calibrated: { retainTokens: 400, thresholdTokens: 700 },
    maxSteps: 20,
  })
} catch (e) {
  console.log('runCascade REJECTED:', String(e?.stack ?? e))
  process.exit(2)
}
console.log('finished=', b.runner.finished, 'steps=', b.runner.steps, 'compressions=', b.runner.compression?.count ?? 0)
const fs = await import('node:fs')
const records = fs.readFileSync(rec.file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
let i = 0
for (const r of records) {
  const u = r.resp?.usage ?? {}
  const msgs = r.req?.messages ?? []
  const last = msgs[msgs.length - 1]
  const isComp = isCompressCall(r)
  console.log(`  ${String(i).padStart(3)}   ${isComp ? 'COMPRESS' : 'execute '}  ${String(u.inputTokens ?? '?').padStart(5)}  ${String(u.cacheReadTokens ?? '?').padStart(6)}  ${String(u.outputTokens ?? '?').padStart(5)}  ${String(msgs.length).padStart(4)}  last=${String(last?.role ?? '').slice(0, 8)}`)
  i++
}
console.log('violations=', JSON.stringify(b.runner.violations ?? []))

// one-off live check: real-gateway cascade with REAL executor interleaving —
// records cacheRead for EVERY call (execution + compression) to answer
// "does the FROZEN-prefix cache scheme actually earn provider cache hits".
import { runCascade } from '../lib/run-cascade.mjs'
import { createRecordingGateway } from '../lib/gateway-mock.mjs'
import { createGateway } from '../lib/gateway.mjs'
import { loadTask } from '../lib/tasks.mjs'

function isCompressCall(rec) {
  const msgs = rec.req?.messages ?? []
  const last = msgs[msgs.length - 1]
  return typeof last?.content === 'string' && /WRITE ONE PROGRAM/.test(last.content)
}

const tasks = [loadTask('T0'), loadTask('T0'), loadTask('T0')]
const boundaryMark = {
  taskId: 'CASCADE', source: 'premark',
  cost: { usage: { inputTokens: 40, outputTokens: 0, cacheReadTokens: 0, calls: 2 }, usd: 0.0004, model: 'deepseek-v4-flash-vision-exp', provider: 'deepseek' },
  boundaries: [
    { segmentIndex: 0, taskId: 'g0', startSeq: 0, endSeq: 0, status: 'closed' },
    { segmentIndex: 1, taskId: 'g1', startSeq: 1, endSeq: 1, status: 'closed' },
    { segmentIndex: 2, taskId: 'g2', startSeq: 2, endSeq: 2, status: 'active' },
  ],
}
const inner = createGateway()
const rec = createRecordingGateway({ inner, dir: './.assert-tmp/cache-live' })
let b
try {
  b = await runCascade({
    tasks, arm: 'self-s2-orig', callLLM: rec.chatCall,
    boundaryMark,
    model: 'deepseek-v4-flash-vision-exp', provider: 'deepseek',
    skipScore: true,
    maxSteps: 15,
  })
} catch (e) {
  console.log('runCascade REJECTED:', String(e?.stack ?? e))
  process.exit(2)
}
console.log('finished=', b.runner.finished, 'steps=', b.runner.steps, 'compactions=', b.runner.compression?.count ?? 0)
console.log('  call#  role      input  cacheRead  out   msgs')
let i = 0
for (const r of rec.records ?? await import('node:fs').then(fs => fs.readFileSync(rec.file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))) {
  const u = r.resp?.usage ?? {}
  console.log(`  ${String(i).padStart(3)}   ${isCompressCall(r) ? 'COMPRESS' : 'execute '}  ${String(u.inputTokens ?? '?').padStart(5)}  ${String(u.cacheReadTokens ?? '?').padStart(6)}  ${String(u.outputTokens ?? '?').padStart(5)}  ${String((r.req?.messages ?? []).length).padStart(4)}`)
  i++
}
console.log('violations=', JSON.stringify(b.runner.violations ?? []))
console.log('gateway-errors=', JSON.stringify(b.runner.transcript.filter(e => e.type === 'gateway-error')))

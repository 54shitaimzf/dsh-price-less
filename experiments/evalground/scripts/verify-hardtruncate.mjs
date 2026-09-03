/* Offline verification of the E3 80% hard-truncate safety valve.
 * Drives runSession with createScriptedGateway (ZERO network) and a very
 * small contextWindow so the floor is crossed in a few steps, then asserts:
 *   1. hard-truncate events are recorded (runner.hardTruncate.count > 0)
 *   2. the run still finishes (DONE reached)
 *   3. with a HUGE window the valve is a no-op (count === 0) — this is the
 *      "current task never touches the boundary" case that keeps existing runs valid.
 *
 * Run from anywhere:  node scripts/verify-hardtruncate.mjs
 */
import { runSession } from '../lib/runner.mjs'
import { createScriptedGateway } from '../lib/gateway-mock.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const scratchA = path.join(ROOT, '.scratch-hardtruncate-a')
const scratchB = path.join(ROOT, '.scratch-hardtruncate-b')
fs.mkdirSync(scratchA, { recursive: true })
fs.mkdirSync(scratchB, { recursive: true })

let failures = 0
const ok = (cond, msg, extra) => { if (cond) console.log('  PASS ' + msg); else { failures++; console.log('  FAIL ' + msg + (extra ? ' | ' + extra : '')) } }

const task = { id: 'T-verify', title: 'verify', messages: [{ role: 'user', content: 'task' }], track: { mech: 45, judge: 55, human: 0 } }
const prompt = 'do the task'
// Each assistant turn emits a big text reply so estimateMessagesTokens grows fast.
const bigText = 'x'.repeat(5000) // ~1250 tokens per reply
const script = [
  { text: bigText, toolCalls: [{ id: 'a1', name: 'glob', args: '{"pattern":"*"}' }] },
  { text: bigText, toolCalls: [{ id: 'a2', name: 'grep', args: '{"pattern":"z"}' }] },
  { text: bigText, toolCalls: [{ id: 'a3', name: 'glob', args: '{"pattern":"**/*"}' }] },
  { text: 'DONE — finished' },
]
const scripted = createScriptedGateway({ script })

console.log('=== CASE A: small window (floor crossed) ===')
const a = await runSession({
  workspace: scratchA, taskId: task.id, task, prompt,
  contextMode: 'plain', compression: 'none', callLLM: scripted.chatCall,
  model: 'mock', provider: 'mock', transcriptPath: path.join(scratchA, 'transcript.jsonl'),
  contextWindow: 2000, truncatePct: 0.8, // floor = 1600
  timeoutMs: 60000, logger: () => {},
})
console.log('  steps=%d finished=%s hardTruncate=%j', a.steps, a.finished, a.hardTruncate)
ok(a.hardTruncate && a.hardTruncate.count > 0, 'hard-truncate fired when floor crossed')
ok(a.finished, 'run finished (DONE reached)')
const ta = a.transcript.filter(e => e.type === 'hard-truncate')
ok(ta.length > 0, 'hard-truncate events recorded in transcript', 'count=' + ta.length)

console.log('=== CASE B: huge window (valve is no-op) — mirrors real T1-full ===')
const scriptedNoop = createScriptedGateway({ script })
const b = await runSession({
  workspace: scratchB, taskId: task.id, task, prompt,
  contextMode: 'plain', compression: 'none', callLLM: scriptedNoop.chatCall,
  model: 'mock', provider: 'mock', transcriptPath: path.join(scratchB, 'transcript.jsonl'),
  contextWindow: 256000, truncatePct: 0.8, // floor = 204800, never reached
  timeoutMs: 60000, logger: () => {},
})
console.log('  steps=%d finished=%s hardTruncate=%j', b.steps, b.finished, b.hardTruncate)
ok(!b.hardTruncate || b.hardTruncate.count === 0, 'no hard-truncate when window not crossed')
ok(b.finished, 'run finished (DONE reached) without truncation')

fs.rmSync(scratchA, { recursive: true, force: true })
fs.rmSync(scratchB, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Code-run worker bootstrap — runs ONE model-written program in a fresh worker.
 *
 * The worker executes `src` (already type-stripped by the host) as the BODY of
 * an async function bound to two globals:
 *   - `tools`: one async callable per binding name; each call posts a message
 *     to the host, which executes the real binding and replies. Intermediates
 *     are execution-local — only the settled value/logs leave the worker.
 *   - `console`: a capture shim; printed lines become `logs` in order.
 *
 * Settlement (exactly one, sent once):
 *   {type:'settle', value?, logs?, error?:{kind,message}}
 *   - success: `value` must be lossless-JSON (validated by round-trip);
 *     `undefined` completion is allowed and reported as absent value.
 *   - failure: error.kind ∈ 'exception' | 'invalid-output' | 'output-limit'.
 *
 * The worker is a fresh isolate with empty env; the HOST owns hard
 * terminate/timeout and budgets (see code-run.mjs). This file is not a
 * security boundary — trust posture equals the bash executor.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { Buffer } from 'node:buffer'

const { src, maxOutputBytes } = workerData

const logs = []
let logBytes = 0
const pending = new Map()
let seq = 0

const consoleShim = {
  log: (...a) => pushLog(a),
  info: (...a) => pushLog(a),
  warn: (...a) => pushLog(a),
  error: (...a) => pushLog(a),
}
function pushLog(args) {
  const line = args.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  logBytes += Buffer.byteLength(line, 'utf8')
  if (maxOutputBytes && logBytes > maxOutputBytes) {
    settle({ error: { kind: 'output-limit', message: `log output exceeded ${maxOutputBytes} bytes` } })
    return
  }
  logs.push(line)
}

function settle(payload) {
  try { parentPort.postMessage({ type: 'settle', ...payload }) } catch { /* port gone — ignore */ }
}

const tools = new Proxy({}, {
  get(_t, name) {
    if (typeof name !== 'string' || name.startsWith('_')) return undefined
    return async (args) => {
      const id = ++seq
      const msg = { id, type: 'request', global: 'tools', name, args: args ?? {} }
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, name })
        parentPort.postMessage(msg)
      })
    }
  },
})

parentPort.on('message', (msg) => {
  if (!msg || msg.type !== 'reply') return
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  if (msg.ok) p.resolve(msg.value)
  else {
    const err = new Error(msg.message ?? `binding ${p.name} failed`)
    err.toolName = p.name
    p.reject(err)
  }
})

async function main() {
  const AsyncFunction = (async function () {}).constructor
  const fn = new AsyncFunction('tools', 'console', src)
  let value
  try {
    value = await fn(tools, consoleShim)
  } catch (e) {
    settle({ error: { kind: 'exception', message: String(e?.message ?? e) } })
    return
  }
  // Lossless-JSON completion value: preserve; undefined → absent.
  if (value === undefined) {
    settle({ logs })
    return
  }
  let json
  try {
    json = JSON.stringify(value)
    if (json === undefined) JSON.parse('null') // force-lossless check
    else JSON.parse(json)
  } catch {
    settle({ error: { kind: 'invalid-output', message: 'completion value is not lossless JSON' } })
    return
  }
  if (maxOutputBytes && logBytes + Buffer.byteLength(json, 'utf8') > maxOutputBytes) {
    settle({ error: { kind: 'output-limit', message: `settled output exceeded ${maxOutputBytes} bytes` } })
    return
  }
  settle({ value, logs })
}

main()

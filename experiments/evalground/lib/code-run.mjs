/**
 * Code-run — the evalground's minimal code-execution seam (mirrors DSH
 * `ctx.codeRuntime` contract shape: `run(program, bindings) → {value, logs, error?}`).
 *
 * The compressor model writes an erasable-TypeScript async function body; the
 * host type-strips, spawns ONE fresh worker (isolate, empty env, heap limits,
 * hard terminate) and bridges the `tools` namespace. Program outcomes NEVER
 * reject — they resolve as result fields, exactly DSH's convention, so callers
 * branch on `error.kind` and never trust a throwing promise.
 *
 * Budgets: resourceLimits (heap), maxWallMs (wall clock; the host timer fires
 * even while the worker spins a hot loop — separate thread), maxOutputBytes
 * (logs+value combined). `computeMs` is accepted for seam parity but the
 * effective bound is maxWallMs (documented above).
 *
 * NOT a security boundary — trust posture equals the bash executor.
 */
import { Worker } from 'node:worker_threads'
import { stripTypeScriptTypes } from 'node:module'

export const DEFAULT_CODE_RUN = {
  maxWallMs: 30000,
  maxOutputBytes: 256 * 1024,
  resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
}

/** Strip erasable TypeScript from an async-function BODY: `stripTypeScriptTypes`
 * parses whole modules (top-level `return` is illegal there), so the body is
 * wrapped in a synthetic async function first, then unwrapped. Keeps worker
 * execution on the pure-JS body. */
function stripBody(program) {
  const wrapped = `async function __body(tools, console){\n${program}\n}`
  const stripped = stripTypeScriptTypes(wrapped)
  const open = stripped.indexOf('{')
  const close = stripped.lastIndexOf('}')
  if (open < 0 || close < 0 || close <= open) throw new Error('unwrapping failed')
  return stripped.slice(open + 1, close)
}

/**
 * Run one model-written program against host bindings.
 * @param {object} opts { program, bindings, budgets? }
 *   program  — erasable-TypeScript async function body (type-stripped here).
 *   bindings — Record<name, (args)=>Promise<any>> exposed as `tools.<name>`.
 * @returns {Promise<{value?, logs:string[], error?:{kind,message}}>}
 *   Error kinds: 'invalid-program' | 'exception' | 'invalid-output' |
 *   'output-limit' | 'timeout' | 'abort'. Never rejects.
 */
export async function runProgram(opts) {
  const { program, bindings = {}, budgets } = opts
  const cfg = { ...DEFAULT_CODE_RUN, ...(budgets ?? {}) }
  if (typeof program !== 'string' || program.trim() === '') {
    return { logs: [], error: { kind: 'invalid-program', message: 'program is empty' } }
  }
  let src
  try {
    src = stripBody(program)
  } catch (e) {
    return { logs: [], error: { kind: 'invalid-program', message: `type-strip failed: ${e.message}` } }
  }
  try {
    // Prelight syntax check inside an AsyncFunction wrapper (rejects noisy
    // syntax before paying for a worker; erasable TS already stripped).
    // eslint-disable-next-line no-new-func
    new Function('return (async function(){' + src + '})')
  } catch (e) {
    return { logs: [], error: { kind: 'invalid-program', message: `syntax error: ${e.message}` } }
  }

  const worker = new Worker(new URL('./code-run.worker.mjs', import.meta.url), {
    workerData: { src, maxOutputBytes: cfg.maxOutputBytes },
    resourceLimits: cfg.resourceLimits,
  })

  return new Promise((resolve) => {
    let settled = false
    let seq = 0
    const callbacks = new Map()
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      finish({ logs: [], error: { kind: 'timeout', message: `program exceeded maxWallMs=${cfg.maxWallMs}` } })
    }, cfg.maxWallMs)

    function finish(result) {
      clearTimeout(timer)
      worker.removeAllListeners()
      worker.terminate().catch(() => {})
      resolve(result)
    }

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'settle') {
        if (settled) return
        settled = true
        finish({ value: msg.value, logs: msg.logs ?? [], error: msg.error })
        return
      }
      if (msg.type === 'reply') {
        const cb = callbacks.get(msg.id)
        if (!cb) return
        callbacks.delete(msg.id)
        if (msg.ok) cb.resolve(msg.value)
        else cb.reject(Object.assign(new Error(msg.message ?? 'binding failed'), { toolName: msg.name }))
        return
      }
      if (msg.type === 'request') {
        // binder call: execute the real binding, reply to the worker
        const name = msg.name
        const fn = bindings[name]
        const reply = (payload) => { try { worker.postMessage({ type: 'reply', id: msg.id, ...payload }) } catch { /* port closing */ } }
        if (typeof fn !== 'function') reply({ ok: false, message: `unknown binding: ${name}` })
        else Promise.resolve()
          .then(() => fn(msg.args))
          .then((value) => reply({ ok: true, value: value === undefined ? null : value }))
          .catch((e) => reply({ ok: false, message: String(e?.message ?? e) }))
      }
    })
    worker.on('error', (err) => {
      if (settled) return
      settled = true
      finish({ logs: [], error: { kind: 'exception', message: `worker error: ${err.message}` } })
    })
    worker.on('exit', (code) => {
      if (settled) return
      settled = true
      finish({ logs: [], error: { kind: 'worker-exit', message: `worker exited with code ${code} before settle` } })
    })
  })
}

/** Convenience: run + require a lossless-JSON value (null when error). */
export async function runProgramValue(program, bindings, budgets) {
  const r = await runProgram({ program, bindings, budgets })
  return r.error ? null : r.value
}

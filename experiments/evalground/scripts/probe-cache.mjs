/**
 * Gateway prompt-cache probe (V1 prerequisite, batch 0; a few real requests,
 * ≈$0.01-0.05). Answers one question before V1 arms are finalized:
 * does the gateway actually honor prefix caching for our request
 * shape — and under what conditions (same prefix, changed tail, changed 1 byte)?
 *
 *   node scripts/probe-cache.mjs [--model=deepseek-v4-flash] [--calls=4]
 *
 * Prints a verdict + a JSON record to runs/.probe-cache.json (ignored by
 * scorecards; safe to delete).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createGateway } from '../lib/gateway.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v ?? true]
}))

const gw = createGateway()
const model = args.model ?? 'deepseek-v4-flash-vision-exp'
const prefixBase = [
  'You are a probe. The following block is FIXED and must be treated as a stable prefix.',
  'TASK: medium audit scenario; keep this text byte-identical across calls.',
  'Rule A: files under src/audit are parsed with semver compare.',
  'Rule B: severity mapping J->info, K->warn, L->error.',
  'Rule C: the tarball must contain package.json and the declared files list.',
  'Rule D: verdict lines must start with "V:".',
  'Examples:',
  '  V: pass 3 errors / 2 warnings',
  '  V: fail missing field files',
].join('\n')

const tailA = '\n\n[incoming] step 1: inspect package.json'
const tailB = '\n\n[incoming] step 2: run the audit over sample-pkg'

function usageRows(r) {
  const d = r.usage ?? {}
  return {
    input: d.inputTokens, output: d.outputTokens,
    cacheRead: d.cacheReadTokens,
    cached: d.completionTokensDetails?.cached_tokens ?? null,
    promptDetails: d.promptTokensDetails ?? null,
    total: d.totalTokens,
  }
}

async function probe() {
  const calls = []
  // 1) warm bucket: same prefix A twice → expect cache hit on 2nd
  for (let i = 0; i < 2; i++) calls.push(await gw.chatCall({ provider: 'deepseek', model, messages: [{ role: 'user', content: prefixBase + tailA }], maxTokens: 20 }))
  // 2) same prefix, changed tail → hit should persist
  calls.push(await gw.chatCall({ provider: 'deepseek', model, messages: [{ role: 'user', content: prefixBase + tailB }], maxTokens: 20 }))
  // 3) prefix changed by ONE byte → hit should drop to 0
  calls.push(await gw.chatCall({ provider: 'deepseek', model, messages: [{ role: 'user', content: prefixBase + '\nX' + tailA }], maxTokens: 20 }))
  // 4) prefix again → hit should return
  calls.push(await gw.chatCall({ provider: 'deepseek', model, messages: [{ role: 'user', content: prefixBase + tailA }], maxTokens: 20 }))

  const rows = calls.map(usageRows)
  const hit = (r) => (r.cacheRead ?? r.promptDetails?.cached_tokens ?? 0) > 0
  const warmHit = hit(rows[1])
  const tailPersist = hit(rows[2])
  const byteDrop = !hit(rows[3]) && rows[3].input > 0
  const reHit = hit(rows[4])

  const verdict = {
    supportsPrefixCache: warmHit,
    tailChangePreservesHit: warmHit && tailPersist,
    singleByteInvalidates: byteDrop,
    reHitAfterInvalidation: reHit,
    conclusion: warmHit
      ? 'gateway honors prefix caching — V1 stable-prefix arm is meaningful'
      : 'no measurable prefix caching — V1 must fall back to measuring trim savings only',
  }

  const out = {
    model, at: new Date().toISOString(), settings: { prefixChars: prefixBase.length, calls: calls.length },
    rows, verdict,
  }
  fs.mkdirSync(path.join(process.cwd(), 'runs'), { recursive: true })
  const file = path.join(process.cwd(), 'runs', '.probe-cache.json')
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  console.log(JSON.stringify(verdict, null, 2))
  console.log(`record: ${file} (delete freely; not part of any scorecard)`)
}

probe().catch(e => { console.error('probe failed:', e); process.exit(1) })
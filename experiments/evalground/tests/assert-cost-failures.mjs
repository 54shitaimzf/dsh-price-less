/**
 * Cost-accounting assertions — failed / retried calls must land their REAL
 * usage (2026-09 计费核验修复)：
 *   CF-1 native whole-surface compression failure → compress event ok:false
 *        carries usage → collectCompressUsage counts it (no silent cost loss).
 *   CF-2 task-boundary PTC failure (bad program) → same.
 *   CF-3 judge strict retry (bad JSON → retry OK) → judge.usage = BOTH calls.
 *   CF-4 multi-sample judge aggregate keeps cacheRead (no forced null).
 *
 * All offline (scripted gateway — zero network). See docs/07 计费核验小节.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT } from '../lib/paths.mjs'
import { createWorkspace } from '../lib/workspace.mjs'
import { runSession } from '../lib/runner.mjs'
import { createScriptedGateway } from '../lib/gateway-mock.mjs'
import { collectCompressUsage } from '../lib/cost-ledger.mjs'
import { writeBoundaries, boundaryMarkPath } from '../lib/boundaries.mjs'
import { loadTask } from '../lib/tasks.mjs'
import { judgeTask } from '../lib/judge.mjs'

const tmp = path.join(EVAL_ROOT, '.assert-tmp', 'cost-failures')
fs.mkdirSync(tmp, { recursive: true })
let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!cond) failures++
}

// ============ CF-1 native compression failure lands its usage ============
{
  // First round: range null (single-message surface swallowed by retain — a
  // correct no-op, no LLM call). Second round: a tool turn added messages, the
  // range is now compactable — the compressor call fires and FAILS validation.
  let toolPending = false
  const dyn = (req) => {
    const msgs = req.messages
    const last = msgs[msgs.length - 1]
    const content = last && last.role === 'user' && typeof last.content === 'string' ? last.content : ''
    if (content.startsWith('You are now acting as a compaction engine')) {
      // too short → validateNativeSummary fails → fail-lazy
      return { text: '(none)', usage: { inputTokens: 900, outputTokens: 60, cacheReadTokens: 0 } }
    }
    if (toolPending) { toolPending = false; return { text: 'DONE stage', usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } } }
    toolPending = true
    return { text: '', toolCalls: [{ id: 'n1', name: 'read', args: JSON.stringify({ path: 'package.json' }) }], usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } }
  }
  const g = createScriptedGateway({ script: () => new Array(200).fill(dyn) })
  const dir = path.join(tmp, 'cf-native')
  fs.mkdirSync(dir, { recursive: true })
  const tpath = path.join(dir, 'tr.jsonl')
  const task = loadTask('T0')
  const res = await runSession({
    workspace: createWorkspace(dir), taskId: 'CASCADE', task, prompt: task.prompt ?? '',
    stagedMessages: (task?.messages ?? ['x']).map(m => m + ' ' + 'z'.repeat(3000)),
    model: 'm', provider: 'x', transcriptPath: tpath, callLLM: g.chatCall,
    compression: 'native-auto', calibrated: { retainTokens: 50, thresholdTokens: 500, domain: 1000 }, maxCompressions: 2, maxSteps: 12,
  })
  const failed = res.transcript.filter(e => e.type === 'compress' && e.ok === false)
  ok(failed.length >= 1, 'CF-1 native compress failure lands compress event ok:false', String(failed.length))
  ok(failed.length > 0 && failed.every(e => e.inputTokens > 0), 'CF-1 failed compress event carries the real billed usage', JSON.stringify(failed[0] ?? {}))
  const agg = collectCompressUsage(tpath)
  ok(agg.inputTokens > 0, 'CF-1 collectCompressUsage counts the failed call (no silent loss)', `${agg.inputTokens}`)
  ok(res.violations.some(v => v.includes('compression-failed')), 'CF-1 violation still recorded', '')
}

// ============ CF-2 task-boundary PTC failure lands its usage ============
{
  const markFile = boundaryMarkPath('CASCADE')
  const existed = fs.existsSync(markFile)
  const backup = existed ? fs.readFileSync(markFile, 'utf8') : null
  writeBoundaries('CASCADE', {
    taskId: 'CASCADE', source: 'premark',
    cost: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 }, usd: 0, model: 'm', provider: 'x' },
    boundaries: [
      { segmentIndex: 0, taskId: 't0', startSeq: 0, endSeq: 0, status: 'closed' },
      { segmentIndex: 1, taskId: 't1', startSeq: 1, endSeq: 1, status: 'closed' },
      { segmentIndex: 2, taskId: 't2', startSeq: 2, endSeq: 2, status: 'active' },
    ],
  })
  let toolPending = false
  const dyn = (req) => {
    const msgs = req.messages
    const last = msgs[msgs.length - 1]
    const content = last && last.role === 'user' && typeof last.content === 'string' ? last.content : ''
    if (content.includes('COMPRESSOR SDK')) {
      // invalid program → runProgram syntax-error → PTC fail-lazy with real usage
      return { text: 'this is not a program', usage: { inputTokens: 700, outputTokens: 30, cacheReadTokens: 0 } }
    }
    if (toolPending) { toolPending = false; return { text: 'DONE stage', usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } } }
    toolPending = true
    return { text: '', toolCalls: [{ id: 'r1', name: 'read', args: JSON.stringify({ path: 'package.json' }) }], usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } }
  }
  const g = createScriptedGateway({ script: () => new Array(200).fill(dyn) })
  const dir = path.join(tmp, 'cf-ptc')
  fs.mkdirSync(dir, { recursive: true })
  const tpath = path.join(dir, 'tr.jsonl')
  const task = loadTask('T0')
  const res = await runSession({
    workspace: createWorkspace(dir), taskId: 'CASCADE', task, prompt: task.prompt ?? '',
    stagedMessages: ['msg one', 'msg two', 'msg three'],
    model: 'm', provider: 'x', transcriptPath: tpath, callLLM: g.chatCall,
    compression: 'task-boundary', a1: 's2', a2: 'keep-original', maxCompressions: 99, maxSteps: 12,
  })
  const failed = res.transcript.filter(e => e.type === 'compress' && e.ok === false)
  ok(failed.length >= 1, 'CF-2 PTC failure lands compress event ok:false', String(failed.length))
  ok(failed.length > 0 && failed.every(e => e.inputTokens > 0), 'CF-2 failed PTC call carries real billed usage', JSON.stringify(failed[0] ?? {}))
  const agg = collectCompressUsage(tpath)
  ok(agg.inputTokens > 0, 'CF-2 collectCompressUsage counts the failed PTC call', `${agg.inputTokens}`)
  ok(res.violations.some(v => v.includes('compression-failed:task-boundary')), 'CF-2 task-boundary violation recorded', '')

  if (existed) fs.writeFileSync(markFile, backup)
  else if (fs.existsSync(markFile)) fs.rmSync(markFile)
}

// ============ CF-3 judge strict retry: usage = BOTH calls ============
{
  const task = loadTask('T1')
  const ids = (task.rubric?.dims ?? []).map(d => d.id)
  const good = {
    dims: Object.fromEntries(ids.map(id => [id, { score: 4, why: 'fine' }])),
    antiCheat: { verdict: 'none', evidence: '' },
    notes: 'ok.',
  }
  const dir = path.join(tmp, 'cf-judge')
  fs.mkdirSync(dir, { recursive: true })
  const g = createScriptedGateway({ script: [
    { text: '{broken json', usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0 } },
    { text: JSON.stringify(good), usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 } },
  ] })
  const mech = { score: 0, checks: [], violations: [], diff: { modified: [] } }
  const j = await judgeTask({ task, mech, diff: mech.diff, runDir: dir, workspace: dir, provider: 'x', model: 'm', samples: 1, callLLM: g.chatCall })
  ok(j.usage?.inputTokens === 15 && j.usage?.outputTokens === 15 && j.usage?.calls === 2,
    'CF-3 judge retry usage = BOTH calls (not last-only)', JSON.stringify(j.usage))
  ok(Number.isFinite(j.score), 'CF-3 judge scores after retry', String(j.score))
}

// ============ CF-4 multi-sample judge aggregate keeps cacheRead ============
{
  const task = loadTask('T1')
  const ids = (task.rubric?.dims ?? []).map(d => d.id)
  const good = {
    dims: Object.fromEntries(ids.map(id => [id, { score: 4, why: 'fine' }])),
    antiCheat: { verdict: 'none', evidence: '' },
    notes: 'ok.',
  }
  const dir = path.join(tmp, 'cf-judge-ms')
  fs.mkdirSync(dir, { recursive: true })
  const g = createScriptedGateway({ script: [
    { text: JSON.stringify(good), usage: { inputTokens: 3, outputTokens: 3, cacheReadTokens: 2 } },
    { text: JSON.stringify(good), usage: { inputTokens: 7, outputTokens: 7, cacheReadTokens: 4 } },
  ] })
  const mech = { score: 0, checks: [], violations: [], diff: { modified: [] } }
  const j = await judgeTask({ task, mech, diff: mech.diff, runDir: dir, workspace: dir, provider: 'x', model: 'm', samples: 2, callLLM: g.chatCall })
  ok(j.usage?.inputTokens === 10 && j.usage?.outputTokens === 10 && j.usage?.cacheReadTokens === 6 && j.usage?.calls === 2,
    'CF-4 multi-sample judge aggregate keeps cacheRead (not forced null)', JSON.stringify(j.usage))
}

export { failures }

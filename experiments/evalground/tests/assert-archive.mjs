/**
 * Archive-completeness assertions (2026-09 计费核验补齐)：
 *   AC-1 runCascade (record:true) lands the FULL request log (calls.jsonl —
 *        every req/resp with complete messages + usage) next to the run.
 *   AC-2 compress snapshots (before/after each compaction) are persisted JSONL.
 *   AC-3 cascade scorecard keeps per-task judgment detail (judgeDetail /
 *        subjectivity / mechViolations) — not just scores.
 *
 * Offline (scripted gateway), but runCascade is exercised end-to-end (incl.
 * per-task mech on T0, which is a fast no-test check). Run dir + CASCADE
 * boundary mark are cleaned up afterwards.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT } from '../lib/paths.mjs'
import { runCascade } from '../lib/run-cascade.mjs'
import { createScriptedGateway } from '../lib/gateway-mock.mjs'
import { writeBoundaries, boundaryMarkPath } from '../lib/boundaries.mjs'
import { loadTask } from '../lib/tasks.mjs'
import { TEMPLATE_S2 } from '../lib/sdk.mjs'

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!cond) failures++
}

const markFile = boundaryMarkPath('CASCADE')
const existed = fs.existsSync(markFile)
const backup = existed ? fs.readFileSync(markFile, 'utf8') : null

try {
  // minimal stream: two T0 messages → one closed segment → one compaction
  const t0 = loadTask('T0')
  const mark = {
    taskId: 'CASCADE', source: 'premark',
    cost: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 }, usd: 0, model: 'm', provider: 'x' },
    boundaries: [
      { segmentIndex: 0, taskId: 't0', startSeq: 0, endSeq: 0, status: 'closed' },
      { segmentIndex: 1, taskId: 't1', startSeq: 1, endSeq: 1, status: 'active' },
    ],
  }
  let toolPending = false
  const dyn = (req) => {
    const msgs = req.messages
    const last = msgs[msgs.length - 1]
    const content = last && last.role === 'user' && typeof last.content === 'string' ? last.content : ''
    if (content.includes('COMPRESSOR SDK')) {
      return { text: TEMPLATE_S2, usage: { inputTokens: 900, outputTokens: 300, cacheReadTokens: 0 } }
    }
    if (toolPending) { toolPending = false; return { text: 'DONE stage 8', usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } } }
    toolPending = true
    return { text: '', toolCalls: [
      { id: 'a1', name: 'read', args: JSON.stringify({ path: 'package.json' }) },
      { id: 'a2', name: 'write', args: JSON.stringify({ path: 'src/audit/x.js', content: 'function fc() {\n  return 8\n}\n' }) },
    ], usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } }
  }
  const g = createScriptedGateway({ script: () => new Array(400).fill(dyn) })
  const { runDir, scorecard } = await runCascade({
    tasks: [t0, t0], arm: 'self-s2-orig', callLLM: g.chatCall, boundaryMark: mark, record: true,
    model: 'm', provider: 'x',
  })

  // AC-1 full request log (complete messages + usage per call)
  const logPath = path.join(runDir, 'calls.jsonl')
  ok(fs.existsSync(logPath), 'AC-1 request log recorded (calls.jsonl)')
  const logLines = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []
  ok(logLines.length === g.calls(), 'AC-1 one log line per LLM call', `${logLines.length}/${g.calls()}`)
  let shaped = true
  for (const l of logLines) {
    try {
      const r = JSON.parse(l)
      if (!Array.isArray(r.req?.messages) || r.req.messages.length === 0 || typeof r.resp?.usage?.inputTokens !== 'number') shaped = false
    } catch { shaped = false }
  }
  ok(shaped, 'AC-1 every record carries full messages + usage (byte-level replayable)')

  // AC-2 compress snapshots
  const snapPath = path.join(runDir, 'compress-snapshots.jsonl')
  const snapLines = fs.existsSync(snapPath) ? fs.readFileSync(snapPath, 'utf8').split('\n').filter(Boolean) : []
  ok(snapLines.length === 1, 'AC-2 compress snapshot persisted for the compaction', String(snapLines.length))
  let snapShaped = snapLines.length === 1
  if (snapShaped) {
    const s = JSON.parse(snapLines[0])
    snapShaped = Array.isArray(s.before) && Array.isArray(s.after) && s.before.length > 0 && typeof s.range?.start === 'number'
  }
  ok(snapShaped, 'AC-2 snapshot carries before/after full message lists (压缩前原文可复验)')
  ok(scorecard.archived?.compressSnapshots === snapLines.length, 'AC-2 scorecard.archived reports the snapshot count', `${scorecard.archived?.compressSnapshots}`)

  // AC-3 per-task judgment detail survives in the cascade scorecard
  const td = scorecard.taskBreakdown ?? []
  ok(td.length === 2, 'AC-3 per-task breakdown present', String(td.length))
  ok(td.every(t => t.judgeDetail && typeof t.judgeDetail === 'object' && 'dims' in t.judgeDetail && 'usage' in t.judgeDetail),
    'AC-3 judgeDetail (dims/antiCheat/notes/usage) archived per task', JSON.stringify(td[0]?.judgeDetail ?? null))
  ok(td.every(t => 'subjectivity' in t && Array.isArray(t.mechViolations)), 'AC-3 subjectivity + mechViolations fields archived')

  // costs sanity: compression accounted from the real PTC usage
  ok(scorecard.costs?.compression?.usd > 0, 'AC-1/2 costs.compression computed from recorded usage', `${scorecard.costs?.compression?.usd ?? 0}`)

  fs.rmSync(runDir, { recursive: true, force: true })
} finally {
  if (existed) fs.writeFileSync(markFile, backup)
  else if (fs.existsSync(markFile)) fs.rmSync(markFile)
}

export { failures }

#!/usr/bin/env node
/**
 * F9 真机回放对照（可选；机器本地会话日志，不进 CI）。
 * 用法：node scripts/verify-f9-replay.mjs <session.v2.jsonl.zstd> [workspaceRoot]
 * 口径：取会话最后一次 `compaction/summary` 的 **rawOutput**（模型原始 JSON 产物）与 `summary`（旧渲染文本），
 * 把旧 blocks 映射为新 steps（wrap→note；refs 空）、旧 hotTail 申报按 span 重放，用 **F9 装配器**重渲染，
 * 对照「同申报、新结构」的体量差（摘要/热尾/总量/路径字节）。
 * 注意：热尾坐标（通道 A 盘上取真）在本回放中降级为 span（无盘），故热尾体量与真机 6,697 不完全可比。
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import {
  DEFAULT_ASSEMBLE_POLICY,
  assembleArchive,
  foldAssembleInputs,
} from '../lib/core/assemble/index.js'
import { renderRegionTranscript } from '../lib/core/compress/index.js'
import { estimateTokens, flatDensity } from '../lib/core/meter/index.js'

const logPath = process.argv[2]
const workspaceRoot = (process.argv[3] ?? 'C:/Users/Administrator/Desktop/Chinese-Resume-in-Typst').replaceAll('\\', '/')
if (logPath === undefined || !fs.existsSync(logPath)) {
  console.error('usage: node scripts/verify-f9-replay.mjs <session.v2.jsonl.zstd> [workspaceRoot]')
  process.exit(2)
}

const buf = fs.readFileSync(logPath)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
let start = 0
const frames = []
for (;;) {
  const idx = buf.indexOf(MAGIC, start + 1)
  if (idx === -1) { frames.push(buf.subarray(start)); break }
  frames.push(buf.subarray(start, idx))
  start = idx
}
let text = ''
for (const frame of frames) {
  try { text += zlib.zstdDecompressSync(frame).toString('utf8') } catch { /* 尾部残帧忽略 */ }
}
const events = []
for (const line of text.split('\n')) {
  if (line === '') continue
  try { events.push(JSON.parse(line)) } catch { /* 坏行忽略 */ }
}
console.log('events = ' + events.length)

let summaryIndex = -1
let summary = null
for (let i = events.length - 1; i >= 0; i--) {
  const event = events[i]
  if (event.type === 'compaction/summary' && Array.isArray(event.data?.rawOutput)) {
    summaryIndex = i
    summary = event.data
    break
  }
}
if (summary === null) {
  console.error('未找到带 rawOutput 的 compaction/summary（旧构建可能未落 rawOutput）')
  process.exit(2)
}
const raw = summary.rawOutput.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('')
const open = raw.indexOf('{')
const close = raw.lastIndexOf('}')
const oldProduct = JSON.parse(raw.slice(open, close + 1))
const range = summary.shadowedRange
const pre = events.slice(0, summaryIndex)
const rangeObj = { startSeq: Number(range.start), endSeq: Number(range.end) }
const regionText = renderRegionTranscript(pre, rangeObj)
const visible = pre.filter((event) => event.type === 'tool/call' || event.surfaceOp === 'append')
const units = foldAssembleInputs(visible).units
  .filter((unit) => unit.seqStart >= rangeObj.startSeq && unit.seqEnd <= rangeObj.endSeq)

const steps = (oldProduct.digest?.blocks ?? [])
  .filter((block) => typeof block?.text === 'string' && block.text.trim() !== '')
  .map((block) => ({
    type: block.type === 'wrap' ? 'note' : ['plan', 'impl', 'verify'].includes(block.type) ? block.type : 'note',
    text: block.text.trim(),
    refs: [],
  }))
const hotTail = (Array.isArray(oldProduct.hotTail) ? oldProduct.hotTail : []).map((decl) => ({ unitId: decl.unitId }))
const outcome = assembleArchive({
  units,
  root: workspaceRoot,
  rootKind: 'session',
  regionTokens: estimateTokens(regionText, flatDensity(1.5)),
  digest: { gist: '', steps },
  hotTail,
  policy: DEFAULT_ASSEMBLE_POLICY,
})
const oldText = (summary.summary ?? []).map((block) => block.text ?? '').join('')
const density = DEFAULT_ASSEMBLE_POLICY.density
const oldEst = estimateTokens(oldText, density)
console.log('')
console.log('| 口径 | 旧产物（真机） | F9 重装配（同申报） |')
console.log('|---|---|---|')
console.log('| 字符 | ' + oldText.length + ' | ' + (outcome.ok ? outcome.result.rendered.length : '—') + ' |')
console.log('| est（两桶） | ' + oldEst + ' | ' + (outcome.ok ? estimateTokens(outcome.result.rendered, density) : '—') + ' |')
console.log('| 摘要头 est | — | ' + (outcome.ok ? outcome.result.digestPlan.tokens : '—') + ' |')
console.log('| 热尾 est | — | ' + (outcome.ok ? outcome.result.hotTail.tokens : '—') + ' |')
console.log('| 路径表条目 | 0 | ' + (outcome.ok ? outcome.result.pathTableEntries : '—') + ' |')
console.log('| 路径字节省 | 0 | ' + (outcome.ok ? outcome.result.pathBytesSaved : '—') + ' |')
console.log('| 事实泄漏 | 未观测 | ' + (outcome.ok ? outcome.result.digestPlan.factLeaks : '—') + ' |')
console.log('')
if (!outcome.ok) {
  console.error('装配失败：' + outcome.reason)
  process.exit(1)
}
console.log('ok=true（对照仅供参考：新结构体量取决于模型产出 gist/steps 的精简度）')

#!/usr/bin/env node
/**
 * N2 只读探针（docs/implement/N2-conclusion-contract.md §6/§9；为 N3 影子模式定参）。
 * 三组读数：① 可剪候选的关键事实条数分布（结论契约可行性）；② 历史 assistant 回复里的
 * CUT-OK/CUT-HOLD 标记（v1 模板合规证据）；③ 标记 ↔ 最近前置工具结果的配对保真校验。
 * 零写零网络零模型：只读已解压会话 JSONL，判定/抽取走已构建纯核 lib/core/shear/*.js。
 * 用法：node scripts/probe-n2.mjs [--dir <会话目录>] [--top <n>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyToolResult } from '../lib/core/shear/classify.js'
import { KEY_FACT_LIMIT, extractKeyFacts, judgeConclusion, parseConclusion } from '../lib/core/shear/conclusion.js'

const MIN_BYTES = 2048
const MARKER_RE = /CUT-(?:OK|HOLD)\s*[:：]/i
const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const pct = (x, n) => (n === 0 ? '0.0%' : ((100 * x) / n).toFixed(1) + '%')
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)
const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))

function resolveDir() {
  const given = argOf('--dir', null)
  if (given !== null) return given
  const tmp = path.join(os.tmpdir(), 'ce-sessions')
  if (fs.existsSync(tmp) && fs.readdirSync(tmp).some((f) => f.endsWith('.jsonl'))) return tmp
  return path.join(os.homedir(), '.dsh', 'sessions')
}
function* events(file) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try { yield JSON.parse(line) } catch { /* 坏行跳过 */ }
  }
}
function resultTextOf(data) {
  const blocks = data?.message?.content
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const b of blocks) {
    if (b?.type !== 'tool-result' || !Array.isArray(b.content)) continue
    for (const c of b.content) if (c?.type === 'text' && typeof c.text === 'string') out += c.text
  }
  return out
}
function assistantTextOf(data) {
  const blocks = data?.message?.content
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const b of blocks) if (b?.type === 'text' && typeof b.text === 'string') out += (out === '' ? '' : '\n') + b.text
  return out
}

const dir = resolveDir()
if (!fs.existsSync(dir) || fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length === 0) {
  console.error(`probe-n2: 无可用会话数据（${dir}）；先解压会话日志或 --dir 指定目录。`)
  process.exit(1)
}
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()

let candidates = 0
let candBytes = 0
const factBuckets = new Map()
const factHist = new Map()
const factClass = new Map()
const coreBuckets = new Map()
const numVerBuckets = new Map()
const NUMBER_FACT = /^\d+(?:\.\d+)?\s*(?:ms|s|KB|MB|GB|tests?|files?|lines?|tokens?|%)/i
const VERSION_FACT = /^v?\d+\.\d+\.\d+/
const PATH_FACT = /\.(?:ts|tsx|js|mjs|cjs|json|md|sh|yml|yaml|py|css|html|toml)$/i
function classifyFact(f) {
  if (NUMBER_FACT.test(f)) return 'number'
  if (VERSION_FACT.test(f)) return 'version'
  if (PATH_FACT.test(f)) return 'path'
  return 'quoted'
}
let zeroFact = 0
let assistantTotal = 0
let okSeen = 0
let holdSeen = 0
let markerNotLast = 0
let paired = 0
let noted = 0
let notedComplied = 0
let verifyOk = 0
let verifyMissing = 0
let complete = 0
const missingHist = new Map()

for (const file of files) {
  const calls = new Map()
  const ordered = []
  for (const ev of events(path.join(dir, file))) {
    if (ev?.type === 'tool/call') {
      const d = ev.data ?? {}
      if (typeof d.callId === 'string' && typeof d.name === 'string') calls.set(d.callId, { name: d.name, args: d.arguments })
    } else if (ev?.type === 'tool/result') {
      const data = ev.data ?? {}
      const callId = data?.message?.source?.callId
      const call = typeof callId === 'string' ? calls.get(callId) : undefined
      ordered.push({ kind: 'result', seq: ev.seq ?? 0, name: call?.name ?? 'unknown', call, data, text: resultTextOf(data) })
    } else if (ev?.type === 'assistant/message') {
      ordered.push({ kind: 'assistant', seq: ev.seq ?? 0, text: assistantTextOf(ev.data ?? {}) })
    }
  }
  let lastResult
  let pendingNote = false
  for (const item of ordered) {
    if (item.kind === 'result') {
      lastResult = item
      pendingNote = item.text.includes('原始日志将被剪除')
      const bytes = Buffer.byteLength(item.text, 'utf8')
      if (bytes < MIN_BYTES) continue
      let args
      if (typeof item.call?.args === 'string' && item.call.args.trim() !== '') { try { args = JSON.parse(item.call.args) } catch { args = undefined } }
      const decision = classifyToolResult({
        name: item.name,
        ...(item.name === 'run_code' ? { kind: 'execute' } : {}),
        ...(item.name === 'bash' || item.name === 'pwsh' ? { card: 'terminal' } : {}),
        ...(item.name === 'read' ? { kind: 'read', card: 'generic' } : {}),
        ...(item.name === 'grep' || item.name === 'glob' ? { kind: 'search', card: 'search' } : {}),
        ...(item.name === 'job_output' ? { kind: 'read', card: 'generic' } : {}),
        ...(args === undefined ? {} : { args }),
        resultText: item.text,
        resultBytes: bytes,
        isError: item.data?.error !== undefined,
      })
      if (decision.verdict !== 'cuttable') continue
      candidates++
      candBytes += bytes
      const facts = extractKeyFacts(item.text)
      for (const f of facts) bump(factClass, classifyFact(f))
      bump(coreBuckets, String(facts.filter((f) => classifyFact(f) !== 'path').length))
      bump(numVerBuckets, String(facts.filter((f) => ['number', 'version'].includes(classifyFact(f))).length))
      if (facts.length === 0) zeroFact++
      bump(factBuckets, facts.length === 0 ? '0' : facts.length <= 3 ? '1-3' : facts.length <= 6 ? '4-6' : facts.length < KEY_FACT_LIMIT ? '7-11' : `${KEY_FACT_LIMIT}(可能截断)`)
      bump(factHist, String(facts.length))
      continue
    }
    // assistant 回复
    assistantTotal++
    if (pendingNote) { noted++; if (MARKER_RE.test(item.text)) notedComplied++; pendingNote = false }
    if (item.text === '') continue
    if (!MARKER_RE.test(item.text)) continue
    const parsed = parseConclusion(item.text)
    if (parsed.marker === 'ok') okSeen++
    else if (parsed.marker === 'hold') holdSeen++
    else markerNotLast++
    if (lastResult !== undefined) {
      paired++
      const judged = judgeConclusion(lastResult.text, item.text)
      if (judged.parsed.complete) complete++
      if (judged.verify.ok) verifyOk++
      else if (judged.verify.missing.length > 0) { verifyMissing++; bump(missingHist, String(judged.verify.missing.length)) }
    }
  }
}

const top = Number(argOf('--top', '12'))
console.log('=== N2 探针（只读回放，零写零网络） ===')
console.log(`数据源: ${dir} / 文件 ${files.length} 个`)
console.log('')
console.log(`-- ① 可剪候选的关键事实条数（cuttable ${candidates} 条，平均 ${candidates === 0 ? 0 : Math.round(candBytes / candidates)} B/条） --`)
for (const [k, n] of [...factBuckets.entries()].sort()) console.log(`  ${k.padEnd(12)} ${String(n).padStart(5)}  ${pct(n, candidates)}`)
console.log(`  0 条事实（结论 + 重取即可，不强制列事实） ${zeroFact}  ${pct(zeroFact, candidates)}`)
console.log(`  事实条数直方图（top ${top}）: ${[...factHist.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, n]) => k + ':' + n).join('  ')}`)
console.log(`  首 12 条事实的类别构成: ${[...factClass.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ' ' + n).join(' / ')}`)
console.log(`  非路径事实条数分布（若只校验 number/version/quoted）: ${[...coreBuckets.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, n]) => k + ':' + n).join('  ')}`)
console.log(`  number+version 条数分布（最强校验集）: ${[...numVerBuckets.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, n]) => k + ':' + n).join('  ')}`)
console.log('')
console.log('-- ② 历史协商标记（v1 模板期） --')
console.log(`  assistant 回复 ${assistantTotal} 条；含标记 ${okSeen + holdSeen + markerNotLast} 条`)
console.log(`  CUT-OK（末行可解析）${okSeen}；CUT-HOLD ${holdSeen}；标记不在末行 ${markerNotLast}`)
console.log(`  注记后紧跟的回复：${noted} 条 → 其中给出标记 ${notedComplied}  ${pct(notedComplied, noted)}（v1 注记的真实配合率）`)
console.log('')
console.log('-- ③ 标记 ↔ 最近前置工具结果 配对保真 --')
console.log(`  配对 ${paired} 条；三件套齐全 ${complete}；保真通过 ${verifyOk}；缺事实 ${verifyMissing}`)
if (verifyMissing > 0) console.log(`  缺事实条数分布: ${[...missingHist.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, n]) => k + ':' + n).join('  ')}`)
if (okSeen === 0) console.log('  （历史期无 CUT-OK 回音——v1 模板未产生合规样本，真机数据只能由 N3 影子模式采集）')

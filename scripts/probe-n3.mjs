#!/usr/bin/env node
/**
 * N3 协商通道探针（docs/implement/N3-shadow-mode.md §2.2/§4/§6；N3a 报告生成器）。
 * 在真实会话回放上按**新规则**统计：选样数（basis/channel）、配合率三档、三件套齐全率、
 * 保真率、深度中位数，以及每个 basis 的 N4 晋升门槛（样本 ≥30 / CUT-HOLD <5% / 保真 ≥95%）。
 * 零写零网络零模型：只读已解压会话 JSONL（默认 %TEMP%/ce-sessions），判定走已构建纯核 lib/。
 *
 * 口径说明：① 判定用静态签名表（运行期真实值来自 ctx.tools.get + presentCall，覆盖率更高）；
 * ② 被协商文本 = 结果事件里的原文去掉尾部注记（新会话已含模型实际看到的版本，旧会话为近似）；
 * ③ 配合率分母 = 选样数（每条注记恰好结算一次）。
 * 用法：node scripts/probe-n3.mjs [--dir <会话目录>] [--top <n>] [--min <样本门槛>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { judgeNegotiationReply, selectNegotiation } from '../lib/core/shear/negotiate.js'

/** 静态签名表（与 probe-n1 同源；2026-09-09 按 harness checkout 核对）。 */
const KNOWN = {
  read: { kind: 'read', card: 'generic', meta: true },
  read_image: { kind: 'read', card: 'generic', meta: true },
  write: { card: 'diff', meta: true },
  edit: { card: 'diff', meta: true },
  str_replace_editor: { card: 'diff' },
  grep: { kind: 'search', card: 'generic', meta: true },
  glob: { kind: 'search', card: 'generic', meta: true },
  web_search: { kind: 'search', card: 'generic' },
  web_fetch: { kind: 'fetch', card: 'generic' },
  bash: { card: 'terminal' },
  pwsh: { card: 'terminal' },
  run_code: { kind: 'execute' },
  job_output: { kind: 'read', card: 'generic' },
  job_list: { kind: 'read', card: 'generic' },
  job_kill: { kind: 'execute', card: 'generic' },
  todo_write: { kind: 'other', card: 'generic' },
  subagent: {},
  ask_user_question: {},
}
/** 注记尾巴标记（新 v2 / 旧 v1）；探针据此剥离注记并统计通道是否真的挂上了。 */
const NOTE_MARKERS = ['（协商：', '（本结果较长。']
const PROMOTION = { samples: 30, holdRate: 0.05, verifyOkRate: 0.95 }

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const pct = (x, n) => (n === 0 ? '0.0%' : ((100 * x) / n).toFixed(1) + '%')
const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
const median = (values) => {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

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
    try { yield JSON.parse(line) } catch { /* 坏行跳过（只读探针不修数据） */ }
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
function messageTextOf(data) {
  const content = data?.message?.content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const b of content) if (b?.type === 'text' && typeof b.text === 'string') out += b.text
  return out
}
function splitNote(text) {
  let cut = -1
  for (const marker of NOTE_MARKERS) {
    const at = text.lastIndexOf(marker)
    if (at > cut) cut = at
  }
  return cut < 0 ? { text, attached: false } : { text: text.slice(0, cut).replace(/\n$/, ''), attached: true }
}

const dir = resolveDir()
if (!fs.existsSync(dir)) {
  console.error(`probe-n3: 会话目录不存在: ${dir}\n先解压会话日志或 --dir 指定目录。`)
  process.exit(1)
}
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
if (files.length === 0) {
  console.error(`probe-n3: ${dir} 下没有 .jsonl；若只有 .zstd，请先解压。`)
  process.exit(1)
}

const byBasis = new Map() // basis -> { notes, ok, hold, none, complete, verifyOk, depths[] }
const totals = { results: 0, candidates: 0, attached: 0, notes: 0, control: 0, ok: 0, hold: 0, none: 0, complete: 0, verifyOk: 0 }
const depths = []
const legacy = { attached: 0, marked: 0 }

const bucket = (basis) => {
  const found = byBasis.get(basis) ?? { notes: 0, ok: 0, hold: 0, none: 0, complete: 0, verifyOk: 0, depths: [] }
  byBasis.set(basis, found)
  return found
}

for (const file of files) {
  const evs = [...events(path.join(dir, file))]
  const calls = new Map()
  for (const ev of evs) {
    if (ev?.type !== 'tool/call') continue
    const d = ev.data ?? {}
    if (typeof d.callId === 'string' && typeof d.name === 'string') calls.set(d.callId, { name: d.name, args: d.arguments })
  }
  const assistants = evs.filter((ev) => ev?.type === 'assistant/message')
  for (const [index, ev] of evs.entries()) {
    if (ev?.type !== 'tool/result') continue
    totals.results++
    const data = ev.data ?? {}
    const callId = data?.message?.source?.callId
    const call = typeof callId === 'string' ? calls.get(callId) : undefined
    const name = call?.name ?? 'unknown'
    const split = splitNote(resultTextOf(data))
    const text = split.text
    const bytes = Buffer.byteLength(text, 'utf8')
    let args
    if (typeof call?.args === 'string' && call.args.trim() !== '') { try { args = JSON.parse(call.args) } catch { args = undefined } }
    const sig = KNOWN[name]
    const raw = resultTextOf(data)
    const isLegacyNote = raw.includes(NOTE_MARKERS[1])
    const selection = selectNegotiation({
      name,
      ...(sig ?? {}),
      ...(args === undefined ? {} : { args }),
      resultText: text,
      resultBytes: bytes,
      isError: data?.error !== undefined,
    }, String(callId ?? ev.seq ?? ''))
    if (selection === undefined) continue
    totals.candidates++
    if (split.attached) totals.attached++
    if (isLegacyNote) legacy.attached++
    totals.notes++
    if (selection.channel === 'control') totals.control++
    const bucketStats = bucket(selection.basis)
    bucketStats.notes++
    // 回复机会 = 该结果之后的第一条 assistant 消息。
    const reply = assistants.find((a) => Number(a.seq) > Number(ev.seq))
    const replyText = reply === undefined ? '' : messageTextOf(reply.data ?? {})
    if (isLegacyNote && replyText.includes('CUT-')) legacy.marked++
    const judged = judgeNegotiationReply(text, replyText, bytes)
    if (judged.marker === 'ok') {
      totals.ok++; bucketStats.ok++
      if (judged.complete) { totals.complete++; bucketStats.complete++ }
      if (judged.verifyOk) { totals.verifyOk++; bucketStats.verifyOk++ }
      if (judged.depthRatio > 0) { depths.push(judged.depthRatio); bucketStats.depths.push(judged.depthRatio) }
    } else if (judged.marker === 'hold') { totals.hold++; bucketStats.hold++ }
    else { totals.none++; bucketStats.none++ }
  }
}

const top = Number(argOf('--top', '20'))
const minSamples = Number(argOf('--min', String(PROMOTION.samples)))
console.log('=== N3 协商通道探针（只读回放，零写零网络） ===')
console.log(`数据源: ${dir}`)
console.log(`文件 ${files.length} 个 / tool/result ${totals.results} 条 / 选样 ${totals.candidates} 条`)
console.log('')
console.log('-- 选样与配合率（分母 = 选样数） --')
console.log(`  选样 ${totals.notes}（其中对照组 ${totals.control}）｜已挂注记 ${totals.attached}（未挂 = 历史会话跑的是旧通道）`)
console.log(`  CUT-OK ${totals.ok} ${pct(totals.ok, totals.notes)}｜CUT-HOLD ${totals.hold} ${pct(totals.hold, totals.notes)}｜无回复 ${totals.none} ${pct(totals.none, totals.notes)}`)
console.log(`  三件套齐全 ${totals.complete} / CUT-OK ${totals.ok} ${pct(totals.complete, totals.ok)}｜保真通过 ${totals.verifyOk} / CUT-OK ${pct(totals.verifyOk, totals.ok)}`)
console.log(`  深度比中位数 ${median(depths).toFixed(4)}（目标 ≤ 0.1）`)
console.log('')
console.log(`-- 按 basis（N4 晋升门槛：样本 ≥${minSamples} ∧ CUT-HOLD <${PROMOTION.holdRate * 100}% ∧ 保真 ≥${PROMOTION.verifyOkRate * 100}%） --`)
for (const [basis, s] of sorted(new Map([...byBasis].map(([k, v]) => [k, v.notes]))).slice(0, top)) {
  const v = byBasis.get(basis)
  const holdRate = v.notes === 0 ? 0 : v.hold / v.notes
  const verifyRate = v.ok === 0 ? 0 : v.verifyOk / v.ok
  const pass = v.notes >= minSamples && holdRate < PROMOTION.holdRate && verifyRate >= PROMOTION.verifyOkRate
  console.log(`  ${basis.padEnd(10)} 样本 ${String(v.notes).padStart(5)}  OK ${String(v.ok).padStart(4)}  HOLD ${String(v.hold).padStart(4)}  无回复 ${String(v.none).padStart(4)}  保真 ${pct(v.verifyOk, v.ok).padStart(6)}  深度 ${median(v.depths).toFixed(4)}  ${pass ? 'PASS' : 'fail'}`)
}
console.log('')
console.log(`-- 旧 v1 注记基线：挂出 ${legacy.attached} 条，其中收到标记 ${legacy.marked} 条 ${pct(legacy.marked, legacy.attached)}`)
if (totals.attached === 0) console.log('（没有任何结果挂上新注记：这些会话跑的是旧构建；请在 shadow 模式下重开会话后再跑本探针。）')

#!/usr/bin/env node
/**
 * N1 只读探针（docs/implement/N1-identity-and-eligible.md §3 交付物 3 / §5 验收）。
 * 在真实会话回放上统计：签名覆盖率、判定分布、basis 分布、needs-result 子类、对照组采样率。
 * 零写零网络零模型：只读已解压会话 JSONL（默认 %TEMP%/ce-sessions），判定走已构建纯核 lib/core/shear/classify.js。
 * 用法：node scripts/probe-n1.mjs [--dir <会话目录>] [--top <n>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyToolResult } from '../lib/core/shear/classify.js'

const MIN_BYTES = 2048
/** 静态签名表（2026-09-09 按 harness checkout 核对；运行期真实值来自 ctx.tools.get + presentCall）。 */
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

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const pct = (x, n) => (n === 0 ? '0.0%' : ((100 * x) / n).toFixed(1) + '%')
const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by)
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
/** 确定性对照组采样（禁运行期随机，可回放）：FNV-1a 折叠到 100 桶。 */
function sampleBucket(key) {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h % 100
}

const dir = resolveDir()
if (!fs.existsSync(dir)) {
  console.error(`probe-n1: 会话目录不存在: ${dir}\n先解压会话日志（zstd -d -c 逐帧 → %TEMP%/ce-sessions）或 --dir 指定目录。`)
  process.exit(1)
}
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
if (files.length === 0) {
  console.error(`probe-n1: ${dir} 下没有 .jsonl；若只有 .zstd，请先解压（多帧需逐帧 zstd -d）。`)
  process.exit(1)
}

let total = 0
let big = 0
let nonText = 0
let eventsSeen = 0
const byName = new Map()
const verdicts = new Map()
const bases = new Map()
const cuttableBasis = new Map()
const cuttableName = new Map()
const reasons = new Map()
const stages = new Map()
let control = 0
let controlTotal = 0

for (const file of files) {
  const calls = new Map()
  const evs = [...events(path.join(dir, file))]
  eventsSeen += evs.length
  for (const ev of evs) {
    if (ev?.type !== 'tool/call') continue
    const d = ev.data ?? {}
    if (typeof d.callId === 'string' && typeof d.name === 'string') calls.set(d.callId, { name: d.name, args: d.arguments })
  }
  for (const ev of evs) {
    if (ev?.type !== 'tool/result') continue
    total++
    const data = ev.data ?? {}
    const callId = data?.message?.source?.callId
    const call = typeof callId === 'string' ? calls.get(callId) : undefined
    const name = call?.name ?? 'unknown'
    const text = resultTextOf(data)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes < MIN_BYTES) continue
    big++
    if (data?.message?.content?.some?.((b) => b?.content?.some?.((c) => c && c.type !== 'text'))) nonText++
    bump(byName, name)
    const sig = KNOWN[name]
    let args
    if (typeof call?.args === 'string' && call.args.trim() !== '') { try { args = JSON.parse(call.args) } catch { args = undefined } }
    const decision = classifyToolResult({
      name,
      ...(sig ?? {}),
      ...(args === undefined ? {} : { args }),
      resultText: text,
      resultBytes: bytes,
      isError: data?.error !== undefined,
    })
    bump(verdicts, decision.verdict)
    bump(bases, decision.basis)
    if (decision.verdict === 'cuttable') { bump(cuttableBasis, decision.basis); bump(cuttableName, name) }
    bump(stages, decision.stage)
    bump(reasons, decision.reason)
    if (decision.verdict === 'never') {
      controlTotal++
      if (sampleBucket(String(callId ?? ev.seq ?? '')) === 0) control++
    }
  }
}

const top = Number(argOf('--top', '15'))
console.log('=== N1 探针（只读回放，零写零网络） ===')
console.log(`数据源: ${dir}`)
console.log(`文件 ${files.length} 个 / 事件行 ${eventsSeen} / tool/result ${total} 条 / ≥2KB ${big} 条 (${pct(big, total)})`)
console.log('')
console.log(`-- 按工具（≥2KB，top ${top}） --`)
for (const [name, n] of sorted(byName).slice(0, top)) {
  const sig = KNOWN[name]
  const tag = sig === undefined ? '未知签名' : [sig.kind ? 'kind=' + sig.kind : '', sig.card ? 'card=' + sig.card : '', sig.meta ? 'meta' : ''].filter(Boolean).join(' ') || '无声明'
  console.log(`  ${String(n).padStart(5)}  ${name.padEnd(22)} ${tag}`)
}
console.log('')
console.log('-- 签名覆盖率（按 ≥2KB 条数加权；运行期真实值更高——未收录工具由 ctx.tools.get 补齐） --')
const covered = (pred) => [...byName.entries()].filter(([n]) => KNOWN[n] !== undefined && pred(KNOWN[n])).reduce((s, [, n]) => s + n, 0)
const kindCount = covered((s) => s?.kind !== undefined)
const cardCount = covered((s) => s?.card !== undefined)
const metaCount = covered((s) => s?.meta === true)
const unknownCount = big - covered(() => true)
console.log(`  有 kind 声明 ${kindCount}  ${pct(kindCount, big)}`)
console.log(`  有 card 声明 ${cardCount}  ${pct(cardCount, big)}`)
console.log(`  有 meta 声明（静态表） ${metaCount}  ${pct(metaCount, big)}`)
console.log(`  静态表未收录（运行期可由签名通道补齐） ${unknownCount}  ${pct(unknownCount, big)}`)
console.log('')
console.log('-- 判定分布（≥2KB） --')
for (const [k, n] of sorted(verdicts)) console.log(`  ${k.padEnd(9)} ${String(n).padStart(5)}  ${pct(n, big)}`)
console.log('-- 定音阶段 --')
for (const [k, n] of sorted(stages)) console.log(`  ${k.padEnd(9)} ${String(n).padStart(5)}  ${pct(n, big)}`)
console.log('-- basis 分布（全部 ≥2KB） --')
for (const [k, n] of sorted(bases)) console.log(`  ${k.padEnd(10)} ${String(n).padStart(5)}  ${pct(n, big)}`)
console.log('-- cuttable 的 basis 分布（N4 白名单起点） --')
for (const [k, n] of sorted(cuttableBasis)) console.log(`  ${k.padEnd(10)} ${String(n).padStart(5)}  ${pct(n, (verdicts.get('cuttable') ?? 0))}`)
console.log('-- cuttable 的工具分布 --')
for (const [k, n] of sorted(cuttableName)) console.log(`  ${k.padEnd(22)} ${String(n).padStart(5)}`)
console.log('-- 判据命中（top 12） --')
for (const [k, n] of sorted(reasons).slice(0, 12)) console.log(`  ${k.padEnd(14)} ${String(n).padStart(5)}`)
console.log('')
console.log(`-- 对照组（never 的 1% 确定性采样）：${control} / ${controlTotal} 条将被挂注记（只问不剪）`)
if (nonText > 0) console.log(`（含非 text 块的结果 ${nonText} 条，已按 never 计）`)

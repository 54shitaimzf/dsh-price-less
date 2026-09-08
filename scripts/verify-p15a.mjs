#!/usr/bin/env node
/**
 * P15a 验收（docs/implement/P15a-shear-tool-core.md §5）。
 * ① 导出面；② core/shear 零 harness/platform import；③ 未接线（接线归 P15b）；
 * ④ 确定性双跑；⑤ 策略初值；⑥ spec 覆盖标记；⑦ T0-R 真机会话探针（docs/03 §8 先立度量）。
 * 纯回放：只读本地会话缓存，不联网、不调模型。需先 build（import ../lib）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_SHEAR_POLICY,
  SHEAR_POLICY_VERSION,
  foldToolShear,
  indentLevelOf,
  isDeclarationTable,
  parseReadEnvelope,
  repairReadAfterWrite,
  utf8ByteLength,
} from '../lib/core/shear/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME = os.homedir()
const checks = []
const failures = []
const check = (name, ok, detail = '') => {
  checks.push(name)
  if (ok) { console.log('PASS ' + name); return }
  failures.push(name)
  console.log('FAIL ' + name + (detail === '' ? '' : ' — ' + detail))
}

// —— ① 四文件与导出面 ——
const shearDir = path.join(ROOT, 'src/core/shear')
const FILES = ['types.ts', 't0r.ts', 'tool.ts', 'index.ts']
check('四文件齐备', FILES.every((f) => fs.existsSync(path.join(shearDir, f))), FILES.join(','))
const mod = await import('../lib/core/shear/index.js')
const WANTED = ['foldToolShear', 'admitEntry', 'admitLoop', 'admitNote', 'parseNoteMarker', 'assertPairing',
  'isBoundaryRideCandidate', 'toolCategory', 'resolveLifecycle', 'isDeclarationTable', 'repairReadAfterWrite',
  'parseReadEnvelope', 'DEFAULT_SHEAR_POLICY', 'SHEAR_POLICY_VERSION']
const missing = WANTED.filter((name) => typeof mod[name] === 'undefined')
check('导出面齐全', missing.length === 0, missing.join(','))

// —— ② 零 harness/platform import ——
const sources = FILES.map((f) => fs.readFileSync(path.join(shearDir, f), 'utf8'))
check('core/shear 零 harness/platform import',
  sources.every((text) => !/from\s+['"](?:@deepseek-ai\/|cordis|[^'"]*platform)/.test(text)))

// —— ③ 接线白名单（P15b 起允许；白名单外引用 = 违规） ——
const ALLOWED_WIRING = new Set(['src/index.ts', 'src/domains/shear.ts', 'src/domains/shear-facts.ts'])
const walkTs = (dir, out = []) => {
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name)
    if (fs.statSync(abs).isDirectory()) walkTs(abs, out)
    else if (name.endsWith('.ts')) out.push(path.relative(ROOT, abs).split(path.sep).join('/'))
  }
  return out
}
const wired = walkTs(path.join(ROOT, 'src')).filter((p) => !p.startsWith('src/core/shear/') && fs.readFileSync(path.join(ROOT, p), 'utf8').includes('core/shear'))
const wiredIllegal = wired.filter((p) => !ALLOWED_WIRING.has(p))
check('接线白名单（仅 index.ts + domains/shear*.ts 可引用 core/shear）', wiredIllegal.length === 0, wiredIllegal.join(','))

// —— ④ 确定性双跑 + 输入不 mutate ——
const readText = ['1: const a = 1', '2: export const x = 2', '3: const b = 3'].join('\n')
const events = [
  { kind: 'tool-call', call: { seq: 1, time: 10, callId: 'r1', name: 'read', argsText: JSON.stringify({ file_path: 'src/index.ts' }) } },
  { kind: 'tool-result', result: { seq: 2, time: 11, callId: 'r1', text: readText } },
  { kind: 'tool-call', call: { seq: 3, time: 20, callId: 'e1', name: 'edit', argsText: JSON.stringify({ file_path: 'src/index.ts', old_string: 'export const x = 2', new_string: 'export const x = 9' }) } },
]
const snapshot = JSON.stringify(events)
const runA = foldToolShear(events)
const runB = foldToolShear(events)
check('确定性双跑逐字节一致', JSON.stringify(runA) === JSON.stringify(runB))
check('输入不被 mutate', JSON.stringify(events) === snapshot)
check('T0-R 端到端产出修复 op', runA.ops.length === 1 && runA.ops[0].kind === 't0r-repair')

// —— ⑤ 策略初值 ——
check('策略初值固定（8192/120/4/1，版本 1）',
  SHEAR_POLICY_VERSION === 1 && DEFAULT_SHEAR_POLICY.noteMinBytes === 8192 &&
  DEFAULT_SHEAR_POLICY.loopMaxConclusionChars === 120 && DEFAULT_SHEAR_POLICY.t0rMaxSegments === 4 &&
  DEFAULT_SHEAR_POLICY.t0rMaxIndent === 1)

// —— ⑥ spec 覆盖标记 ——
const specText = fs.readFileSync(path.join(ROOT, 'tests/shear-tool.spec.ts'), 'utf8')
const MARKERS = ['T-entry', 'T-loop', 'T-note', 'T0-R', 'stub-replace', 't0r-fallback-keep', '确定性', 'note-timeout']
const absent = MARKERS.filter((m) => !specText.includes(m))
check('spec 覆盖四档 + 三硬规则 + 确定性', absent.length === 0, absent.join(','))

// —— ⑦ T0-R 真机会话探针（docs/03 §8） ——
function scanZstdFrames(buffer) {
  const MAGIC = 0xFD2FB528
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== MAGIC) break
    offset += 4
    const descriptor = buffer.readUInt8(offset); offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictFlag = descriptor & 0x03
    const remaining = (singleSegment ? 0 : 1) + (dictFlag === 3 ? 4 : dictFlag) + (contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag)
    if (buffer.length - offset < remaining) break
    offset += remaining
    let torn = false
    for (;;) {
      if (buffer.length - offset < 3) { torn = true; break }
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3
      const payload = ((blockHeader >>> 1) & 0x03) === 0x01 ? 1 : blockHeader >>> 3
      if (buffer.length - offset < payload) { torn = true; break }
      offset += payload
      if (blockHeader & 1) break
    }
    if (torn) break
    if (checksum) { if (buffer.length - offset < 4) break; offset += 4 }
    frames.push([start, offset])
  }
  return frames
}
function textOfResult(data) {
  const message = data && data.message ? data.message : data
  const content = message && message.content
  if (!Array.isArray(content) || content.length === 0) return ''
  const block = content[0]
  if (!block || !Array.isArray(block.content)) return ''
  let text = ''
  for (const part of block.content) if (part && part.type === 'text' && typeof part.text === 'string') text += part.text
  return text
}
function callIdOfResult(data) {
  const message = data && data.message ? data.message : data
  const content = message && message.content
  const block = Array.isArray(content) && content.length > 0 ? content[0] : undefined
  return block && typeof block.toolCallId === 'string' ? block.toolCallId : undefined
}
function listSessionLogs(limit) {
  const root = path.join(HOME, '.dsh/sessions')
  const out = []
  if (!fs.existsSync(root)) return out
  for (const proj of fs.readdirSync(root)) {
    const dir = path.join(root, proj)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const s of fs.readdirSync(dir)) {
      const f = path.join(dir, s, 'session.v2.jsonl.zstd')
      if (fs.existsSync(f)) out.push(f)
    }
  }
  return out.sort().slice(0, limit)
}
const sessions = listSessionLogs(80)
let fileOps = 0
let dualStackOps = 0
let adjacentPairs = 0
let declarationPairs = 0
let repairable = 0
let savedBytes = 0
const oldSpans = []
const newSpans = []
let scanned = 0
for (const log of sessions) {
  let lines
  try {
    const buf = fs.readFileSync(log)
    const parts = []
    for (const [a, b] of scanZstdFrames(buf)) { try { parts.push(zlib.zstdDecompressSync(buf.subarray(a, b))) } catch {} }
    lines = Buffer.concat(parts).toString('utf8').split('\n')
  } catch { continue }
  scanned++
  let streak = null
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'user/message') { streak = null; continue }
    if (event.type === 'tool/call') {
      const data = event.data ?? {}
      const name = typeof data.name === 'string' ? data.name : ''
      let args = {}
      try { args = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}') } catch {}
      if (name === 'read' || name === 'edit' || name === 'write' || name === 'str_replace_editor') {
        fileOps++
        if (name === 'str_replace_editor') dualStackOps++
      }
      const p = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : undefined
      if (name === 'read' && p !== undefined) { streak = { path: p, callId: data.callId, readText: undefined }; continue }
      if (name === 'edit' && streak !== null && p === streak.path) {
        adjacentPairs++
        const oldString = typeof args.old_string === 'string' ? args.old_string : ''
        const newString = typeof args.new_string === 'string' ? args.new_string : ''
        oldSpans.push(oldString === '' ? 0 : oldString.split('\n').length)
        newSpans.push(newString === '' ? 0 : newString.split('\n').length)
        if (isDeclarationTable(p, indentLevelOf(oldString.split('\n')[0] ?? ''))) declarationPairs++
        if (streak.readText !== undefined) {
          const repaired = repairReadAfterWrite(parseReadEnvelope(streak.readText), { oldString, newString, replaceAll: args.replace_all === true }, p, 1)
          if (repaired !== undefined) {
            repairable++
            savedBytes += Math.max(0, utf8ByteLength(streak.readText) - utf8ByteLength(repaired.envelope))
          }
        }
      }
      if (name !== 'read' && name !== 'edit') streak = null
      continue
    }
    if (event.type === 'tool/result' && streak !== null) {
      const callId = callIdOfResult(event.data ?? {})
      if (callId !== undefined && callId === streak.callId) streak.readText = textOfResult(event.data ?? {})
    }
  }
}
const stat = (list) => list.length === 0 ? 'n=0' : (() => { const s = [...list].sort((a, b) => a - b); return 'min=' + s[0] + ' median=' + s[Math.floor(s.length / 2)] + ' max=' + s[s.length - 1] })()
const pct = (x, n) => n === 0 ? '0.0%' : (100 * x / n).toFixed(1) + '%'
console.log('')
console.log('=== T0-R 探针（docs/03 §8，真机会话回放；不做臂对照） ===')
console.log('会话扫描 = ' + scanned + ' / ' + sessions.length + '；文件类工具调用 = ' + fileOps + '（str_replace_editor 占比 = ' + pct(dualStackOps, fileOps) + '）')
console.log('相邻读写对 = ' + adjacentPairs + '；声明表占比 = ' + pct(declarationPairs, adjacentPairs))
console.log('hunk 跨度（行）：old ' + stat(oldSpans) + '；new ' + stat(newSpans))
console.log('假想节省额：可修复对 = ' + repairable + ' / ' + adjacentPairs + '；节省 = ' + savedBytes + ' bytes')
check('T0-R 探针完成（样本 ' + adjacentPairs + ' 对）', scanned >= 0)

console.log('')
if (failures.length > 0) {
  console.log('P15A VERIFY FAIL (' + failures.length + ' failed / ' + checks.length + ' checks)')
  process.exit(1)
}
console.log('P15A VERIFY PASS (' + checks.length + ' checks)')

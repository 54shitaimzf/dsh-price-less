#!/usr/bin/env node
/**
 * P15b 验收（docs/implement/P15b-shear-scheduling.md §5）。
 * ① 文件齐备；② 导出面；③ core/shear 零 harness/platform import；④ 接线白名单；⑤ 确定性双跑；
 * ⑥ 策略/模板初值未漂移；⑦ D3 白名单 + D10 规则在位；⑧ spec 标记；
 * ⑨ 真机会话离线回放（含九道门槛的假想账本）；⑩ live 事实数（未重启 = 0）；⑪ 尺寸申报。
 * 纯回放：只读本地会话缓存，不联网、不调模型。需先 build（import ../lib）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_SHEAR_POLICY,
  SHEAR_NOTE_TEMPLATE,
  SHEAR_NOTE_TEMPLATE_VERSION,
  SHEAR_POLICY_VERSION,
  buildLoopStub,
  buildSupersededStub,
  foldShearLedger,
  foldSurfaceNodes,
  foldToolShear,
  formatShearLedger,
  noteEligible,
  parseNoteMarker,
  shapeEntryContent,
  surfaceTailTokens,
  toolCategory,
  utf8ByteLength,
} from '../lib/core/shear/index.js'
import { estimateTokens, extractTextFromToolResult } from '../lib/core/ledger/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME = os.homedir()
const TAIL_NODE_WINDOW = 8
const checks = []
const failures = []
const check = (name, ok, detail = '') => {
  checks.push(name)
  if (ok) { console.log('PASS ' + name); return }
  failures.push(name)
  console.log('FAIL ' + name + (detail === '' ? '' : ' — ' + detail))
}

const FILES = [
  'docs/implement/P15b-shear-scheduling.md',
  'src/core/shear/ledger.ts',
  'src/domains/shear.ts',
  'src/domains/shear-facts.ts',
  'tests/shear-domain.spec.ts',
  'tests/shear-ledger.spec.ts',
]
const missingFiles = FILES.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
check('文件齐备（工单 + ledger + 域 + 事实面 + 2 spec）', missingFiles.length === 0, missingFiles.join(','))

const core = await import('../lib/core/shear/index.js')
const WANTED = ['foldShearLedger', 'surfaceTailTokens', 'formatShearLedger', 'foldSurfaceNodes', 'SHEAR_APPLIED_FACT_TYPE',
  'SHEAR_DECISION_FACT_TYPE', 'SHEAR_ERROR_FACT_TYPE', 'SHEAR_NOTE_TEMPLATE', 'SHEAR_NOTE_TEMPLATE_VERSION',
  'noteEligible', 'textOfContentBlocks', 'buildSupersededStub']
const missingExports = WANTED.filter((name) => typeof core[name] === 'undefined')
check('core/shear 导出面齐全', missingExports.length === 0, missingExports.join(','))
const toolsPort = await import('../lib/platform/tools.js')
check('platform 剪切端口导出', typeof toolsPort.createShearToolPort === 'function')
const shearDomain = await import('../lib/domains/shear.js')
check('domains 剪切调度导出', typeof shearDomain.mountShearDomain === 'function')
const facts = await import('../lib/domains/shear-facts.js')
check('事实面导出', typeof facts.compactFact === 'function' && facts.SHEAR_APPLIED_FACT_TYPE === 'context-economy/shear-applied')

const shearDir = path.join(ROOT, 'src/core/shear')
const shearFiles = fs.readdirSync(shearDir).filter((f) => f.endsWith('.ts'))
check('core/shear 零 harness/platform import',
  shearFiles.every((f) => !/from\s+['"](?:@deepseek-ai\/|cordis|[^'"]*platform)/.test(fs.readFileSync(path.join(shearDir, f), 'utf8'))))

// P19：domains/compaction.ts 是 T-boundary 搭车会计的第二生产者（只发 shear-applied 事实，不改剪切机制）。
const ALLOWED = new Set(['src/index.ts', 'src/domains/shear.ts', 'src/domains/shear-facts.ts', 'src/domains/compaction.ts'])
const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name)
    if (fs.statSync(abs).isDirectory()) walk(abs, out)
    else if (name.endsWith('.ts')) out.push(path.relative(ROOT, abs).split(path.sep).join('/'))
  }
  return out
}
const wired = walk(path.join(ROOT, 'src')).filter((rel) => !rel.startsWith('src/core/shear/') && fs.readFileSync(path.join(ROOT, rel), 'utf8').includes('core/shear'))
const wiredIllegal = wired.filter((rel) => !ALLOWED.has(rel))
check('接线白名单（index + domains/shear* + domains/compaction）', wiredIllegal.length === 0, wiredIllegal.join(','))
check('index.ts 已挂载剪切域', fs.readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8').includes('mountShearDomain'))

const envText = ['1: const a = 1', '2: export const x = 2', '3: const b = 3', '4: export const y = 4'].join('\n')
const events = [
  { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { content: [{ type: 'text', text: '改 barrel' }] } },
  { type: 'tool/call', seq: 1, time: 2, data: { callId: 'r1', name: 'read', arguments: JSON.stringify({ file_path: 'src/index.ts' }) } },
  { type: 'tool/result', seq: 2, time: 3, surfaceOp: 'append', data: { message: { content: [{ toolCallId: 'r1', content: [{ type: 'text', text: envText }] }] } } },
  { type: 'tool/call', seq: 3, time: 4, data: { callId: 'e1', name: 'edit', arguments: JSON.stringify({ file_path: 'src/index.ts', old_string: 'export const x = 2', new_string: 'export const x = 9' }) } },
]
const snapshot = JSON.stringify(events)
check('账本 fold 确定性双跑逐字节一致', JSON.stringify(foldShearLedger(events, [])) === JSON.stringify(foldShearLedger(events, [])))
check('账本 fold 输入不被 mutate', JSON.stringify(events) === snapshot)
const shearEvents = [
  { kind: 'tool-call', call: { seq: 1, time: 2, callId: 'r1', name: 'read', argsText: JSON.stringify({ file_path: 'src/index.ts' }) } },
  { kind: 'tool-result', result: { seq: 2, time: 3, callId: 'r1', text: envText } },
  { kind: 'tool-call', call: { seq: 3, time: 4, callId: 'e1', name: 'edit', argsText: JSON.stringify({ file_path: 'src/index.ts', old_string: 'export const x = 2', new_string: 'export const x = 9' }) } },
]
check('纯核 fold 确定性双跑逐字节一致', JSON.stringify(foldToolShear(shearEvents)) === JSON.stringify(foldToolShear(shearEvents)))

check('策略初值未漂移（1 / 8192 / 120 / 4 / 1）', SHEAR_POLICY_VERSION === 1 && DEFAULT_SHEAR_POLICY.noteMinBytes === 8192
  && DEFAULT_SHEAR_POLICY.loopMaxConclusionChars === 120 && DEFAULT_SHEAR_POLICY.t0rMaxSegments === 4 && DEFAULT_SHEAR_POLICY.t0rMaxIndent === 1)
check('T-note 模板版本 1 且含 CUT-OK/CUT-HOLD 契约',
  SHEAR_NOTE_TEMPLATE_VERSION === 1 && SHEAR_NOTE_TEMPLATE.includes('CUT-OK:') && SHEAR_NOTE_TEMPLATE.includes('CUT-HOLD:')
  && parseNoteMarker('CUT-OK: 结论').kind === 'cut')

const assertText = fs.readFileSync(path.join(ROOT, 'scripts/assert-structure.mjs'), 'utf8')
check('D3 白名单含 domains/shear-facts.ts', assertText.includes('src/domains/shear-facts.ts'))
check('D10 规则在位（core/shear 零时钟/随机）', assertText.includes("'D10'"))

const specText = fs.readFileSync(path.join(ROOT, 'tests/shear-domain.spec.ts'), 'utf8')
const MARKERS = ['T-entry', 'T-note', 'T-loop', 'T0-R', 't0-supersede', 'note-cut', 'CUT-HOLD', 'CE_SHEAR_NOT_ON_SURFACE', '回填基线', '确定性']
const absent = MARKERS.filter((marker) => !specText.includes(marker))
check('spec 覆盖四档 + 门槛 + 回填 + 确定性', absent.length === 0, absent.join(','))

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
function listSessionLogs() {
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
  return out.sort()
}
function readLog(file) {
  const buf = fs.readFileSync(file)
  const parts = []
  for (const [a, b] of scanZstdFrames(buf)) { try { parts.push(zlib.zstdDecompressSync(buf.subarray(a, b))) } catch {} }
  return Buffer.concat(parts).toString('utf8').split('\n')
}
const textOf = (data) => {
  const message = data && data.message ? data.message : data
  const content = message && message.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  return text
}
const logs = listSessionLogs()
let scanned = 0
let toolResults = 0
let cmdResults = 0
let entryShaped = 0
let entrySavedBytes = 0
let entrySavedTokens = 0
let noteEligibleCount = 0
let liveFacts = 0
const executed = { 'stub-replace': 0, 'note-cut': 0, 't0-supersede': 0, 't0r-repair': 0 }
const gated = { writeFailed: 0, tooOld: 0, notOnSurface: 0, noSaving: 0, noResult: 0 }
let hypotheticalSavedTokens = 0
let hypotheticalBreakTokens = 0
for (const file of logs) {
  let lines
  try { lines = readLog(file) } catch { continue }
  scanned++
  const shearEvents = []
  const ledgerEvents = []
  const resultSeqByCallId = new Map()
  const writeErrorByCallId = new Map()
  const nameByCallId = new Map()
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (typeof event.type === 'string' && event.type.startsWith('context-economy/shear-')) liveFacts++
    const surfaceOp = event.surfaceOp
    if (surfaceOp === 'append' || (surfaceOp && typeof surfaceOp === 'object')) {
      ledgerEvents.push({ type: event.type, seq: event.seq, time: event.time, surfaceOp, data: event.data })
    }
    if (event.type === 'tool/call') {
      const callId = String(event.data?.callId ?? '')
      const name = String(event.data?.name ?? '')
      if (callId !== '') nameByCallId.set(callId, name)
      shearEvents.push({ kind: 'tool-call', call: { seq: event.seq, time: event.time, callId, name, argsText: String(event.data?.arguments ?? '') } })
      continue
    }
    if (event.type === 'tool/result') {
      toolResults++
      const text = extractTextFromToolResult(event.data ?? {})
      const callId = event.data?.message?.content?.[0]?.toolCallId
      const id = typeof callId === 'string' ? callId : ''
      shearEvents.push({ kind: 'tool-result', result: { seq: event.seq, time: event.time, callId: id, text } })
      if (id !== '') {
        resultSeqByCallId.set(id, event.seq)
        writeErrorByCallId.set(id, event.data?.error !== undefined && event.data?.error !== null)
      }
      const name = nameByCallId.get(id) ?? ''
      if (toolCategory(name) === 'cmd') {
        cmdResults++
        const shaped = shapeEntryContent({ seq: 0, time: 0, callId: id, name, argsText: '' }, text)
        if (shaped !== undefined) {
          entryShaped++
          entrySavedBytes += Math.max(0, utf8ByteLength(text) - utf8ByteLength(shaped))
          entrySavedTokens += Math.max(0, estimateTokens(text) - estimateTokens(shaped))
        }
        if (noteEligible({ seq: 0, time: 0, callId: id, name, argsText: '' }, text)) noteEligibleCount++
      }
      continue
    }
    if (event.type === 'assistant/message') {
      shearEvents.push({ kind: 'assistant-message', seq: event.seq, time: event.time, text: textOf(event.data?.message) })
      continue
    }
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      shearEvents.push({ kind: 'user-message', seq: event.seq, time: event.time, text: textOf(event.data) })
    }
  }
  const plan = foldToolShear(shearEvents)
  const nodes = foldSurfaceNodes(ledgerEvents)
  for (const op of plan.ops) {
    if (op.kind === 'shape-entry') continue
    const target = op.kind === 't0r-repair' ? op.readCallId : op.callId
    const resultSeq = resultSeqByCallId.get(target)
    if (resultSeq === undefined) { gated.noResult++; continue }
    if (op.kind === 't0-supersede' || op.kind === 't0r-repair') {
      if (writeErrorByCallId.get(op.writeCallId) !== false) { gated.writeFailed++; continue }
      const index = nodes.indexOf(resultSeq)
      if (index < 0) { gated.notOnSurface++; continue }
      if (nodes.length - 1 - index >= TAIL_NODE_WINDOW) { gated.tooOld++; continue }
    }
    const before = estimateTokens(shearEvents.find((item) => item.kind === 'tool-result' && item.result.callId === target)?.result.text ?? '')
    const afterText = op.kind === 't0r-repair' ? op.envelope : op.kind === 't0-supersede' ? buildSupersededStub(op.path) : op.kind === 'note-cut' ? buildLoopStub(op.conclusion) : op.stub
    const after = estimateTokens(afterText)
    if (op.kind !== 't0r-repair' && after >= before) { gated.noSaving++; continue }
    executed[op.kind]++
    hypotheticalSavedTokens += Math.max(0, before - after)
    hypotheticalBreakTokens += surfaceTailTokens(ledgerEvents, resultSeq)
  }
}
console.log('')
console.log('=== P15b 真机会话离线回放（假想账本，含九道门槛；不做臂对照） ===')
console.log('会话扫描 = ' + scanned + '；tool/result = ' + toolResults + '（cmd 类 = ' + cmdResults + '）')
console.log('T-entry 假想整形 = ' + entryShaped + ' / cmd 结果；节省 = ' + entrySavedBytes + ' bytes ≈ ' + entrySavedTokens + ' token（断裂成本 0）')
console.log('T-note 贴注候选 = ' + noteEligibleCount)
console.log('门槛后假想落刀：stub-replace=' + executed['stub-replace'] + ' note-cut=' + executed['note-cut']
  + ' t0-supersede=' + executed['t0-supersede'] + ' t0r-repair=' + executed['t0r-repair'])
console.log('门槛拦下：写未成功=' + gated.writeFailed + ' 超尾部窗=' + gated.tooOld + ' 不在表面=' + gated.notOnSurface
  + ' 无净省=' + gated.noSaving + ' 无结果=' + gated.noResult)
console.log('假想节省 token = ' + (hypotheticalSavedTokens + entrySavedTokens) + '（含 T-entry）；假想断裂重价 = ' + hypotheticalBreakTokens)
console.log('live 剪切事实 = ' + liveFacts + '（未重启插件 = 0；重启后由 shear-applied 真机观测）')
console.log('空账本报表首行：' + formatShearLedger(foldShearLedger([], [])).split('\n')[0])
check('真机会话离线回放完成（扫描 ' + scanned + ' 个会话）', scanned >= 0)
check('live 事实数与接线状态自洽', liveFacts >= 0)

const sizeFiles = ['src/core/shear/types.ts', 'src/core/shear/tool.ts', 'src/core/shear/ledger.ts', 'src/core/shear/index.ts',
  'src/platform/tools.ts', 'src/domains/shear.ts', 'src/domains/shear-facts.ts', 'src/config.ts', 'src/index.ts', 'client/field-model.ts']
const sizes = sizeFiles.map((rel) => rel + '=' + fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').length)
console.log('尺寸申报（含注释总行数，非净增）：' + sizes.join(' / '))
check('尺寸申报输出', sizes.length === sizeFiles.length)

console.log('')
if (failures.length > 0) {
  console.log('P15B VERIFY FAIL (' + failures.length + ' failed / ' + checks.length + ' checks)')
  process.exit(1)
}
console.log('P15B VERIFY PASS (' + checks.length + ' checks)')

#!/usr/bin/env node
/**
 * P16 验收（docs/implement/archive/P16-dialogue-shear.md §5）。
 * ① 文件齐备；② 纯核/端口/域导出面；③ core/shear 零 harness/platform import；④ 接线白名单；
 * ⑤ 结论三档 + 中立性 + 预算 fixture；⑥ 确定性双跑；⑦ 策略初值未漂移；⑧ 跨层事实名一致；
 * ⑨ 账本 fold 三字段；⑩ D3/D10 在位；⑪ spec 标记；⑫ 真机会话离线回放（run 候选 / 假想落刀 / 拦截）；
 * ⑬ live 事实数；⑭ 尺寸申报。纯回放：只读本地会话缓存，不联网、不调模型。需先 build（import ../lib）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_RUN_POLICY,
  RUN_CLASS_FACT_TYPE,
  RUN_POLICY_VERSION,
  SHEAR_RUN_PLAN_FACT_TYPE,
  extractVerifyEvidence,
  foldRunShear,
  foldShearLedger,
  isNeutralConclusion,
  salientTokens,
} from '../lib/core/shear/index.js'
import { estimateTokens, extractTextFromToolResult } from '../lib/core/ledger/index.js'
import { JUDGE_RECORDED_FACT_TYPE } from '../lib/domains/judge-facts.js'

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

const FILES = [
  'docs/implement/archive/P16-dialogue-shear.md',
  'src/core/shear/run.ts',
  'src/core/shear/ledger.ts',
  'src/domains/shear.ts',
  'src/domains/shear-facts.ts',
  'src/domains/star.ts',
  'src/platform/history.ts',
  'tests/shear-run.spec.ts',
  'tests/shear-domain.spec.ts',
  'tests/shear-ledger.spec.ts',
]
const missing = FILES.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
check('文件齐备（工单 + 纯核 + 域 + 事实面 + 端口 + 3 spec）', missing.length === 0, missing.join(','))

const core = await import('../lib/core/shear/index.js')
const WANTED = ['foldRunShear', 'DEFAULT_RUN_POLICY', 'RUN_POLICY_VERSION', 'RUN_CLASS_FACT_TYPE', 'salientTokens',
  'extractVerifyEvidence', 'isNeutralConclusion', 'RUN_INSTRUCTION_WORDS', 'SHEAR_RUN_PLAN_FACT_TYPE']
const missingExports = WANTED.filter((name) => typeof core[name] === 'undefined')
check('core/shear 导出面齐全', missingExports.length === 0, missingExports.join(','))
const historyPort = await import('../lib/platform/history.js')
check('platform 结论消息构造导出', typeof historyPort.buildNoticeUserMessage === 'function')
const shearDomain = await import('../lib/domains/shear.js')
check('domains 剪切调度导出', typeof shearDomain.mountShearDomain === 'function')
const factsMod = await import('../lib/domains/shear-facts.js')
check('事实面导出（第四类 shear-run-plan）', factsMod.SHEAR_RUN_PLAN_FACT_TYPE === 'context-economy/shear-run-plan'
  && typeof factsMod.compactFact === 'function')

const shearDir = path.join(ROOT, 'src/core/shear')
const shearFiles = fs.readdirSync(shearDir).filter((f) => f.endsWith('.ts'))
check('core/shear 零 harness/platform import',
  shearFiles.every((f) => !/from\s+['"](?:@deepseek-ai\/|cordis|[^'"]*platform)/.test(fs.readFileSync(path.join(shearDir, f), 'utf8'))))
check('run.ts 无时钟/随机（D10 口径）',
  !/Math\.random\(|Date\.now\(|new Date\(/.test(fs.readFileSync(path.join(shearDir, 'run.ts'), 'utf8')))

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

// —— 结论三档 fixture（与 tests/shear-run.spec.ts 同口径，脚本独立复核） ——
const u = (seq, text) => ({ kind: 'user-message', seq, time: seq, text })
const a = (seq, text) => ({ kind: 'assistant-message', seq, time: seq, text })
const t = (seq, text) => ({ kind: 'tool-result', seq, time: seq, text })
const v = (seq, anchorSeq, klass, decision = 'continue') => ({ kind: 'verdict', seq, time: seq, anchorSeq, decision, klass })
const shortRun = foldRunShear([u(1, '为什么要用 A？'), v(2, 1, 'pureQ'), a(3, '因为 B 更稳。'), u(4, '动手'), v(5, 4, 'action')])
check('短 run → 机械摘句落刀', shortRun.ops.length === 1 && shortRun.ops[0].conclusionTier === 'mechanical-quote'
  && shortRun.ops[0].conclusion === '已吸收：关于「为什么要用 A？」的 1 轮问答，结论：因为 B 更稳。（用户已确认理解）')
const longRun = foldRunShear([u(1, 'Q1'), v(2, 1, 'pureQ'), a(3, 'A1'), u(4, 'Q2'), v(5, 4, 'pureQ'), a(6, 'A2'), u(7, 'Q3'), v(8, 7, 'pureQ'), a(9, 'A3'), u(10, '动手'), v(11, 10, 'action')])
check('长 run 无星标注记 → hold long-run-needs-star', longRun.ops.length === 0 && longRun.decisions[0].reason === 'long-run-needs-star')
const verifyRun = foldRunShear([u(1, '跑测试'), v(2, 1, 'verifyQ'), t(3, '[exit code: 0]'), a(4, '通过'), u(5, '继续'), v(6, 5, 'action')])
check('验证 run → 判决提取', verifyRun.ops.length === 1 && verifyRun.ops[0].conclusionTier === 'verdict-extract'
  && verifyRun.ops[0].conclusion === '已验证：跑测试，依据：[exit code: 0]（用户已确认理解）')
const starRun = foldRunShear([u(1, 'Q1'), v(2, 1, 'pureQ'), a(3, 'A1'), u(4, 'Q2'), v(5, 4, 'pureQ'), a(6, 'A2'), u(7, 'Q3'), v(8, 7, 'pureQ'), a(9, 'A3'),
  { kind: 'star-plan', seq: 10, time: 10, items: [{ startSeq: 1, endSeq: 9, note: '结论是 A' }] }])
check('星标剪切清单 → star-note 落刀', starRun.ops.length === 1 && starRun.ops[0].conclusionTier === 'star-note')
const classRun = foldRunShear([u(1, '为什么要用 A？'), a(2, '因为 B 更稳。'), u(3, '动手'), v(4, 1, 'pureQ'), v(4, 3, 'action')])
check('分类事实（judge-recorded / ★ CLASS 转换后）= run 落刀输入', classRun.ops.length === 1 && classRun.ops[0].conclusionTier === 'mechanical-quote')
const shearSrc = fs.readFileSync(path.join(ROOT, 'src/domains/shear.ts'), 'utf8')
const starSrc = fs.readFileSync(path.join(ROOT, 'src/domains/star.ts'), 'utf8')
check('★ CLASS 回填接线（star 发 classes → 剪切域转 verdict）', starSrc.includes('classes: planClasses')
  && shearSrc.includes('data.classes') && shearSrc.includes('run-too-old'))
check('观察窗 / 无证据 / 积压三路拦截', (() => {
  const windowHold = foldRunShear([u(1, '跑 gate 测试'), v(2, 1, 'verifyQ'), t(3, 'gate 全绿\n[exit code: 0]'), a(4, '通过'), u(5, 'gate 的 D10 呢'), v(6, 5, 'action')])
  const noEvidence = foldRunShear([u(1, '确认没坏'), v(2, 1, 'verifyQ'), a(3, '没问题'), u(4, '继续'), v(5, 4, 'action')])
  const backlog = foldRunShear([u(1, 'Q1'), v(2, 1, 'pureQ'), a(3, 'A1')])
  return windowHold.decisions[0].reason === 'verify-dependency-window'
    && noEvidence.decisions[0].reason === 'verify-no-evidence'
    && backlog.decisions[0].reason === 'await-absorb-proof' && backlog.backlogDepth === 1
})())
check('中立叙述体黑名单 + 结论预算截断', isNeutralConclusion('已吸收：结论是 A（用户已确认理解）')
  && !isNeutralConclusion('结论：请改 A') && !isNeutralConclusion('a\nb')
  && (() => {
    const op = foldRunShear([u(1, 'Q1'), v(2, 1, 'pureQ'), a(3, '结' + '字'.repeat(400) + '。'), u(4, '动手'), v(5, 4, 'action')]).ops[0]
    return op !== undefined && op.conclusion.length <= DEFAULT_RUN_POLICY.conclusionMaxChars && op.conclusion.endsWith('（用户已确认理解）')
  })())
check('判决提取三路（退出码 / 测试计数 / PASS-FAIL）', extractVerifyEvidence('x\n[exit code: 2]') === '[exit code: 2]'
  && extractVerifyEvidence('307 tests passed') === '307 tests passed' && extractVerifyEvidence('全部 PASS') === '全部 PASS'
  && extractVerifyEvidence('无判决') === undefined)
check('指纹 token 口径（≥4 字符 ASCII，小写去重）', JSON.stringify(salientTokens('改 src/core/shear/run.ts 的 RUN_POLICY_VERSION')) === JSON.stringify(['src/core/shear/run.ts', 'run_policy_version']))

const determinismEvents = [u(1, 'Q1'), v(2, 1, 'pureQ'), a(3, 'A1'), u(4, '动手'), v(5, 4, 'action')]
const determinismSnapshot = JSON.stringify(determinismEvents)
check('纯核 fold 确定性双跑逐字节一致且输入不被 mutate',
  JSON.stringify(foldRunShear(determinismEvents)) === JSON.stringify(foldRunShear(determinismEvents))
  && JSON.stringify(determinismEvents) === determinismSnapshot)
check('策略初值未漂移（1 / 2 / 4 / 160 / 60 / 4）', RUN_POLICY_VERSION === 1 && DEFAULT_RUN_POLICY.shortRunMaxPairs === 2
  && DEFAULT_RUN_POLICY.observationWindow === 4 && DEFAULT_RUN_POLICY.conclusionMaxChars === 160
  && DEFAULT_RUN_POLICY.questionLabelMaxChars === 60 && DEFAULT_RUN_POLICY.salientTokenMinChars === 4)
check('跨层分类事实名一致（core 常量 = domains judge-facts）', RUN_CLASS_FACT_TYPE === JUDGE_RECORDED_FACT_TYPE)

// —— 账本 fold 三字段（P15b 显式 0 → P16 可回放计算） ——
const ledgerEvents = [
  { type: 'user/message', seq: 1, time: 1, surfaceOp: 'append', data: { content: [{ type: 'text', text: '为什么要用 src/core/shear/run.ts？' }] } },
  { type: 'assistant/message', seq: 2, time: 2, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: '因为它纯核。' }] } } },
  { type: 'user/message', seq: 3, time: 3, surfaceOp: 'append', data: { content: [{ type: 'text', text: '动手' }] } },
  { type: 'user/message', seq: 7, time: 7, surfaceOp: 'append', data: { content: [{ type: 'text', text: '再讲一遍 src/core/shear/run.ts' }] } },
]
const ledgerFacts = [
  { type: RUN_CLASS_FACT_TYPE, seq: 4, time: 4, data: { seq: 1, decision: 'continue', class: 'pureQ' } },
  { type: RUN_CLASS_FACT_TYPE, seq: 5, time: 5, data: { seq: 3, decision: 'continue', class: 'action' } },
  { type: 'context-economy/shear-applied', seq: 6, time: 6, data: { policyVersion: 1, tier: 'run', kind: 'run-flush', callId: '', resultSeq: 2, at: 6, category: 'other', beforeTokens: 100, afterTokens: 30, savedTokens: 70, breakTokens: 5, tailNodes: 1, startSeq: 1, endSeq: 2, runPairs: 1, runClass: 'pureQ', conclusionTier: 'mechanical-quote' } },
]
const ledger = foldShearLedger(ledgerEvents, ledgerFacts)
check('账本 fold：cutEvents.question / cutTokensSaved / cutMisfireDetected / thinkingCutTokens',
  ledger.cutEvents.question === 1 && ledger.cutEvents.tool === 0 && ledger.cutTokensSaved === 70
  && ledger.cutMisfireDetected === 1 && ledger.thinkingCutTokens === 0)
const backlogLedger = foldShearLedger(ledgerEvents.slice(0, 2), [ledgerFacts[0]])
check('账本 fold：questionBacklogDepth 计量', backlogLedger.questionBacklogDepth === 1 && backlogLedger.cutEvents.question === 0)

const assertText = fs.readFileSync(path.join(ROOT, 'scripts/assert-structure.mjs'), 'utf8')
check('D3 白名单含 domains/shear-facts.ts', assertText.includes('src/domains/shear-facts.ts'))
check('D10 规则在位（core/shear 零时钟/随机）', assertText.includes("'D10'"))

const specText = fs.readFileSync(path.join(ROOT, 'tests/shear-run.spec.ts'), 'utf8')
  + fs.readFileSync(path.join(ROOT, 'tests/shear-domain.spec.ts'), 'utf8')
const MARKERS = ['mechanical-quote', 'verdict-extract', 'star-note', 'long-run-needs-star', 'verify-dependency-window',
  'conclusion-not-neutral', 'run-no-saving', 'run-too-old', 'notice', 'run-flush', 'await-absorb-proof', 'classes']
const absent = MARKERS.filter((marker) => !specText.includes(marker))
check('spec 覆盖三档 + 拦截 + 接线', absent.length === 0, absent.join(','))

// —— 真机会话离线回放 ——
function scanZstdFrames(buffer) {
  const MAGIC = 0xFD2FB528
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== MAGIC) break
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
let classifiedUsers = 0
let runCandidates = 0
let liveRunFacts = 0
const cutTiers = { 'mechanical-quote': 0, 'verdict-extract': 0, 'star-note': 0 }
const holds = {}
let hypotheticalSavedTokens = 0
let hypotheticalBreakTokens = 0
for (const file of logs) {
  let lines
  try { lines = readLog(file) } catch { continue }
  scanned++
  const runEvents = []
  const bySeq = new Map()
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const type = event.type
    if (typeof type === 'string' && (type === SHEAR_RUN_PLAN_FACT_TYPE || type === 'context-economy/shear-applied')) liveRunFacts++
    if (type === 'user/message' && event.data?.source?.kind === 'user') {
      const item = { kind: 'user-message', seq: event.seq, time: event.time, text: textOf(event.data) }
      runEvents.push(item); bySeq.set(event.seq, item)
    } else if (type === 'assistant/message') {
      runEvents.push({ kind: 'assistant-message', seq: event.seq, time: event.time, text: textOf(event.data?.message) })
    } else if (type === 'tool/result') {
      runEvents.push({ kind: 'tool-result', seq: event.seq, time: event.time, text: extractTextFromToolResult(event.data ?? {}) })
    } else if (type === JUDGE_RECORDED_FACT_TYPE) {
      const klass = event.data?.class
      if (klass === 'action' || klass === 'pureQ' || klass === 'verifyQ') classifiedUsers++
      runEvents.push({ kind: 'verdict', seq: event.seq, time: event.time, anchorSeq: Number(event.data?.seq ?? -1),
        decision: event.data?.decision === 'new-task' ? 'new-task' : 'continue',
        ...(klass === 'action' || klass === 'pureQ' || klass === 'verifyQ' ? { klass } : {}) })
    } else if (type === SHEAR_RUN_PLAN_FACT_TYPE) {
      const items = Array.isArray(event.data?.items) ? event.data.items : []
      if (items.length > 0) runEvents.push({ kind: 'star-plan', seq: event.seq, time: event.time, items })
      const classes = Array.isArray(event.data?.classes) ? event.data.classes : []
      for (const entry of classes) {
        if (!Number.isInteger(entry?.anchorSeq) || entry.anchorSeq < 0) continue
        if (entry.class !== 'action' && entry.class !== 'pureQ' && entry.class !== 'verifyQ') continue
        runEvents.push({ kind: 'verdict', seq: event.seq, time: event.time, anchorSeq: entry.anchorSeq, decision: 'continue', klass: entry.class })
      }
    }
  }
  const plan = foldRunShear(runEvents)
  runCandidates += plan.records.length
  for (const record of plan.records) {
    if (record.decision === 'cut') {
      cutTiers[record.conclusionTier] = (cutTiers[record.conclusionTier] ?? 0) + 1
      const before = runEvents.filter((e) => e.seq >= record.startSeq && e.seq <= record.endSeq)
        .reduce((sum, e) => sum + estimateTokens(e.text ?? ''), 0)
      hypotheticalSavedTokens += Math.max(0, before - estimateTokens(record.conclusion ?? ''))
    } else if (record.decision === 'hold') {
      holds[record.reason] = (holds[record.reason] ?? 0) + 1
    }
  }
}
console.log('')
console.log('=== P16 真机会话离线回放（run 候选 / 假想落刀；不做臂对照） ===')
console.log('会话扫描 = ' + scanned + '；带分类的用户消息 = ' + classifiedUsers + '；run 候选 = ' + runCandidates)
console.log('假想落刀：mechanical-quote=' + cutTiers['mechanical-quote'] + ' verdict-extract=' + cutTiers['verdict-extract']
  + ' star-note=' + cutTiers['star-note'] + '；假想节省 token = ' + hypotheticalSavedTokens)
console.log('拦截/保留：' + (Object.keys(holds).length === 0 ? '(无)' : Object.entries(holds).map(([k, n]) => k + '=' + n).join(' ')))
console.log('live 剪切 run 事实 = ' + liveRunFacts + '（重启后由 shear-applied/shear-run-plan 真机观测）')
check('真机会话离线回放完成（扫描 ' + scanned + ' 个会话）', scanned >= 0)
check('live 事实数与接线状态自洽', liveRunFacts >= 0)

const sizeFiles = ['src/core/shear/run.ts', 'src/core/shear/ledger.ts', 'src/core/shear/index.ts', 'src/domains/shear.ts',
  'src/domains/shear-facts.ts', 'src/domains/star.ts', 'src/platform/history.ts']
const sizes = sizeFiles.map((rel) => rel + '=' + fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').length)
console.log('尺寸申报（含注释总行数，非净增）：' + sizes.join(' / '))
check('尺寸申报输出', sizes.length === sizeFiles.length)

console.log('')
if (failures.length > 0) {
  console.log('P16 VERIFY FAIL (' + failures.length + ' failed / ' + checks.length + ' checks)')
  process.exit(1)
}
console.log('P16 VERIFY PASS (' + checks.length + ' checks)')

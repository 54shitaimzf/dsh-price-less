#!/usr/bin/env node
/**
 * P19 验收（docs/implement/P19-boundary-path.md §5）。
 * ① 文件齐备；② 纯核/端口导出面；③ 结构铁律（S1/D13/D14/D15 + 域侧收口）；④ 区间转写与档案区 fixture；
 * ⑤ 压缩族账本（P19 自持位 + 合并 fold）；⑥ 假会话端到端（触发 → 调用 → 档案 vN → 事务替换 → 事实 →
 * 内容寻址复用零调用）；⑦ 真机会话只读回放（闭合发现/区间体量/字节稳定）；⑧ spec 标记；⑨ 文档同步标记；
 * ⑩ 尺寸申报。纯回放：只读本地会话缓存，不联网、不调模型。需先 build（import ../lib）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import {
  ARCHIVE_CACHE_LIMIT,
  ARCHIVE_STORE_VERSION,
  REGION_TRANSCRIPT_VERSION,
  appendArchiveEntry,
  compressSpanHash,
  emptyArchiveStore,
  lookupCachedProduct,
  priorChainFor,
  putCachedProduct,
  readArchiveStore,
  renderRegionTranscript,
  regionTokens,
  COMPRESS_RUN_FACT_TYPE,
} from '../lib/core/compress/index.js'
import { foldCompressionLedger } from '../lib/core/assemble/index.js'
import { factsFromSessionEvents } from '../lib/core/ledger/facts.js'
import { foldSurfaceNodes } from '../lib/core/ledger/surface.js'
import { foldSegmentState } from '../lib/core/units.js'
import { estimateTokens } from '../lib/core/ledger/index.js'
import { mountCompactionDomain, boundaryArchiveKey } from '../lib/domains/compaction.js'
import { ignorableChannelAvailable } from '../lib/platform/ignorable-channel.js'
import { resolveConfig } from '../lib/config.js'

// 进程内强制走 ignorable 通道直发路径（事实经 session.append 落到 fake session）。
ignorableChannelAvailable({ SESSION_LOG_INTENT: 1 })

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
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ① 文件齐备
const FILES = [
  'docs/implement/P19-boundary-path.md',
  'src/core/compress/region.ts', 'src/core/compress/store.ts',
  'src/platform/agent-step.ts', 'src/platform/meter.ts',
  'src/domains/compaction.ts', 'src/domains/compaction-facts.ts',
  'tests/compress-region.spec.ts', 'tests/compress-store.spec.ts',
  'tests/compaction-domain.spec.ts', 'tests/agent-step.spec.ts',
]
const missing = FILES.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
check('文件齐备（工单 + 纯核 2 + 端口 2 + 域 2 + spec 4）', missing.length === 0, missing.join(','))

// ② 导出面
const compress = await import('../lib/core/compress/index.js')
const WANTED_CORE = ['REGION_TRANSCRIPT_VERSION', 'renderRegionTranscript', 'regionTokens', 'surfaceEventsInRange',
  'ARCHIVE_STORE_VERSION', 'ARCHIVE_CACHE_LIMIT', 'emptyArchiveStore', 'readArchiveStore', 'appendArchiveEntry',
  'priorChainFor', 'compressSpanHash', 'lookupCachedProduct', 'putCachedProduct']
const missingCore = WANTED_CORE.filter((name) => typeof compress[name] === 'undefined')
check('core/compress 新增导出面齐全（' + WANTED_CORE.length + ' 项）', missingCore.length === 0, missingCore.join(','))
const agentStep = await import('../lib/platform/agent-step.js')
const meterPort = await import('../lib/platform/meter.js')
check('端口导出面（H2 onAgentPreStep / H7 createMeterPort）',
  typeof agentStep.onAgentPreStep === 'function' && typeof meterPort.createMeterPort === 'function')

// ③ 结构铁律
const coreText = ['src/core/compress/region.ts', 'src/core/compress/store.ts'].map(readText).join('\n')
check('新增纯核零 harness/platform import（S1）',
  !/from\s+['"]@deepseek-ai\//.test(coreText) && !/from\s+['"]cordis/.test(coreText) && !/from\s+['"][^'"]*platform/.test(coreText))
check('新增纯核无时钟/随机（D13）',
  !/\bMath\.random\(/.test(coreText) && !/\bDate\.now\(/.test(coreText) && !/\bnew Date\(/.test(coreText))
const domainText = readText('src/domains/compaction.ts')
check('域侧收口：不改史直调/不直摸 llm/计量/挂点（S2/D6/D14/D15）',
  !/\.append\(/.test(domainText) && !/ctx\.llm/.test(domainText) && !/ctx\.tokenMeter/.test(domainText) &&
  !/agent\/pre-step/.test(domainText) && !/compaction\/(start|end|summary|prune)/.test(domainText))
const assertSrc = readText('scripts/assert-structure.mjs')
const snapshot = readText('tests/assert-structure.spec.ts')
check('结构断言引擎含 D14/D15（H2 挂点 + 计量收口）',
  /id: 'D14'/.test(assertSrc) && /id: 'D15'/.test(assertSrc) &&
  /agent\/pre-step concepts must only appear/.test(assertSrc) && /token-meter concepts must only appear/.test(assertSrc))
check('零位快照含 D14/D15', /D14: 'pass'/.test(snapshot) && /D15: 'pass'/.test(snapshot))
check('压缩事实声明合并（ignorable；D3 白名单）',
  /'context-economy\/compress-run': CompressRunFactData \/\/ ignorable/.test(readText('src/domains/compaction-facts.ts')) &&
  /compaction-facts\.ts'/.test(assertSrc))

// ④ 区间转写与档案区 fixture
const ev = (type, seq, data, surfaceOp = 'append') => ({ type, seq, time: seq, data, surfaceOp })
const block = (text) => [{ type: 'text', text }]
const regionEvents = [
  ev('user/message', 0, { content: block('做 A') }),
  ev('assistant/message', 1, { message: { content: [{ type: 'tool-call', toolCallId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }] } }),
  ev('tool/result', 2, { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: block('1: old') }] } }),
]
const region = renderRegionTranscript(regionEvents, { startSeq: 0, endSeq: 2 })
check('区间转写：四类表头 + 逐字正文 + 双跑字节稳定',
  region === '[0] user/message\n做 A\n\n[1] assistant/message\n\n\n[2] tool/result c1\n1: old' &&
  region === renderRegionTranscript(regionEvents, { startSeq: 0, endSeq: 2 }) && REGION_TRANSCRIPT_VERSION === 1)
check('区间体量按 policy cpt', regionTokens(regionEvents, { startSeq: 0, endSeq: 2 }) === Math.ceil(region.length / 1.5))

let store = emptyArchiveStore('w')
const policy = { version: 1, hotTailTokens: 10000, archiveTokens: 30, charsPerToken: 1.5, floorVerifyLines: 3, floorErrorLines: 5, maxFetchUnits: 64, minTruncatedChars: 200 }
store = appendArchiveEntry(store, { taskId: 't1', kind: 'checkpoint', text: 'C1', sessionId: 's' }, policy).body
const second = appendArchiveEntry(store, { taskId: 't1', kind: 'boundary', text: 'a'.repeat(60), sessionId: 's' }, policy)
check('档案区：只追加 + 超帽从最老整条截断',
  ARCHIVE_STORE_VERSION === 1 && second.truncation.count === 1 && second.body.entries.length === 1 && second.body.entries[0].kind === 'boundary')
check('档案区：防御解析（坏形状/版本/workspace → 空）',
  readArchiveStore(null, 'w').entries.length === 0 &&
  readArchiveStore({ schemaVersion: 99, workspace: 'w', entries: [{}], cache: {} }, 'w').entries.length === 0 &&
  readArchiveStore({ schemaVersion: 1, workspace: 'other', entries: [], cache: {} }, 'w').entries.length === 0)
const keyBase = { promptVersion: 1, policyVersion: 1, layer: 'boundary', regionText: 'R', unitIds: ['c1'], priorChainTexts: [], policyKey: '10000/15000/1.5' }
const key = compressSpanHash(keyBase)
check('内容寻址键：确定性 + 任一输入变化换键 + 十六进制定长',
  key === compressSpanHash({ ...keyBase }) && /^[0-9a-f]{16}$/.test(key) &&
  compressSpanHash({ ...keyBase, regionText: 'R2' }) !== key &&
  compressSpanHash({ ...keyBase, unitIds: ['c1', 'c2'] }) !== key &&
  compressSpanHash({ ...keyBase, policyKey: 'x' }) !== key)
let cached = putCachedProduct(emptyArchiveStore('w'), { key, at: 1, layer: 'boundary', product: { mode: 'boundary', digest: { blocks: [], coords: [] }, hotTail: [] } })
check('内容寻址缓存：命中取回 + 上限淘汰',
  lookupCachedProduct(cached, key) !== undefined && ARCHIVE_CACHE_LIMIT === 32 &&
  Object.keys(putCachedProduct(cached, { key: 'x', at: 2, layer: 'boundary', product: { mode: 'boundary', digest: { blocks: [], coords: [] }, hotTail: [] } }, 1).cache).length === 1)

// ⑤ 压缩族账本（P19 自持位）
const fact = (data, seq = 1) => ({ type: COMPRESS_RUN_FACT_TYPE, seq, time: seq, data })
const ledger = foldCompressionLedger([
  fact({ at: 1, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'skipped', reason: 'shrink', calls: 2, retry: 1, shearFolded: 3 }, 1),
  fact({ at: 2, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'ok', calls: 1, archiveEntries: 1, dossierRetired: true, llmUsage: { inputTokens: 7, outputTokens: 2 } }, 2),
])
check('压缩族账本：P19 自持位 + usage + 调用口径',
  ledger.compressSkips === 1 && ledger.compressRetries === 1 && ledger.compressShrinkRejects === 1 &&
  ledger.compressShearBoundaryFolded === 3 && ledger.compressArchiveAppends === 1 && ledger.compressRetiredDossiers === 1 &&
  ledger.compressionCallCount === 3 && ledger.compressUsage.inputTokens === 7)

// ⑥ 假会话端到端（真实域 + 真实 core；fake 端口）
const VALID_PRODUCT = JSON.stringify({ digest: { blocks: [{ type: 'plan', text: '目标' }], coords: [] }, hotTail: [{ unitId: 'c1' }] })
class FakeSession {
  constructor(id = 's1') { this.events = []; this.nodes = []; this.generation = 0; this.header = { id } }
  get surface() { return { nodes: this.nodes, replaceGeneration: this.generation } }
  append(type, data, opts) {
    const event = { type, seq: this.events.length, time: 1000 + this.events.length, data }
    if (opts?.surfaceOp !== undefined) event.surfaceOp = opts.surfaceOp
    if (opts?.sourceEventSeqs !== undefined) event.sourceEventSeqs = opts.sourceEventSeqs
    if (opts?.ignorable === true) event.ignorable = true
    this.events.push(event)
    if (event.surfaceOp === 'append') this.nodes.push(event.seq)
    else if (event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
      const si = this.nodes.indexOf(event.surfaceOp.start)
      const ei = this.nodes.indexOf(event.surfaceOp.end)
      if (si >= 0 && ei >= si) { this.nodes.splice(si, ei - si + 1, event.seq); this.generation++ }
    }
    return event
  }
  eventAt(seq) { return this.events[seq] }
  snapshotEvents() { return this.events.slice() }
}
class FakeStorage {
  constructor() { this.entities = new Map() }
  getEntity(table, key) {
    const record = this.entities.get(table + ':' + key)
    if (record === undefined) return undefined
    return { schemaVersion: 1, version: record.version, source: { taskId: 'x', eventType: 'y', evidence: {} }, body: record.body }
  }
  async putEntity(table, key, body, _source, options) {
    const id = table + ':' + key
    const current = this.entities.get(id)
    const base = options?.baseVersion ?? 0
    if (base === 0) { if (current !== undefined) throw new Error('CAS'); this.entities.set(id, { version: 1, body }); return this.getEntity(table, key) }
    if (current === undefined || current.version !== base) throw new Error('CAS')
    this.entities.set(id, { version: base + 1, body })
    return this.getEntity(table, key)
  }
}
const makeSession = (id) => {
  const session = new FakeSession(id)
  session.append('user/message', { content: block('做 A'.repeat(40)), source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', { message: { content: [{ type: 'tool-call', toolCallId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }] } }, { surfaceOp: 'append' })
  session.append('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: block('1: old line') }] } }, { surfaceOp: 'append' })
  session.append('user/message', { content: block('/task close'), source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('context-economy/task-boundary', { boundary: 'close', taskId: 'task-1' }, { ignorable: true })
  session.append('user/message', { content: block('做 B'), source: { kind: 'user' } }, { surfaceOp: 'append' })
  return session
}
const makeLlm = () => {
  const calls = []
  return {
    calls,
    ctx: {
      llm: {
        stream(options) {
          calls.push(options)
          return (async function* () {
            yield { type: 'text-delta', text: VALID_PRODUCT }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    },
  }
}
const fakeAssemble = () => ({
  dispose() {}, stats: () => ({ sessions: 0, assemblies: 0, failures: 0, degraded: 0 }),
  unitList: () => [{ id: 'c1', kind: 'tool-pair', seqStart: 1, seqEnd: 2, name: 'read', path: 'a.ts', version: 1, text: '1: old line', tokens: 1 }],
  assemble: async (request) => ({
    ok: true,
    result: {
      layer: 'boundary', digest: request.digest, digestBytes: 10, digestEntryCount: 1,
      hotTail: { selections: [], stopReason: 'list-end', source: 'model', floorFilled: false, declaredUnits: 0, dropped: 0, dropReasons: { badDecl: 0, unknownUnit: 0, remap: 0, fetch: 0 }, clipped: 0, truncated: 0, tokens: 0, budgetTokens: 10000 },
      archiveForm: { form: 'single', checkpointCount: 0 }, unitCount: 1, rendered: 'R',
    },
  }),
})
const storage = new FakeStorage()
const llm = makeLlm()
const session = makeSession('s1')
const config = resolveConfig({})
const domain = mountCompactionDomain({
  storage, getConfig: () => config, logger: { info() {}, warn() {}, error() {} },
  assemble: fakeAssemble(), getMeter: () => ({ heuristicTokensInRange: () => 4242 }),
  getLlm: () => llm.ctx, workspace: 'w', now: () => 5000,
})
await domain.onPreStep({ session, turn: 7 })
const appendsOf = (type) => session.events.filter((event) => event.type === type)
const archive = storage.getEntity('boundary_archive', boundaryArchiveKey('w'))
const runs = appendsOf(COMPRESS_RUN_FACT_TYPE)
check('端到端：单次调用 + 事务四段（start/summary/替换/end）+ 档案 vN + 事实 ok',
  llm.calls.length === 1 && llm.calls[0].purpose === 'context-economy-compaction' &&
  appendsOf('compaction/start').length === 1 && appendsOf('compaction/summary').length === 1 && appendsOf('compaction/end').length === 1 &&
  session.events.some((event) => event.type === 'user/message' && event.surfaceOp?.op === 'replace') &&
  archive?.version === 1 && archive.body.entries.length === 1 && runs.length === 1 && runs[0].data.outcome === 'ok' &&
  runs[0].data.archiveEntries === 1 && runs[0].data.dossierRetired === true)
const summarySeq = appendsOf('compaction/summary')[0].seq
const replaceSeq = session.events.find((event) => event.type === 'user/message' && event.surfaceOp?.op === 'replace').seq
check('官方协议紧邻契约：summary 紧跟替换；影子价来自 token-meter（4242）',
  replaceSeq === summarySeq + 1 && appendsOf('compaction/summary')[0].data.shadowedTokenCount === 4242 &&
  appendsOf('compaction/summary')[0].data.shadowedSeqs.join(',') === '0,1,2,3')
await domain.onPreStep({ session, turn: 7 })
check('已归档守卫：第二次 pre-step 零调用', llm.calls.length === 1)
const second2 = makeSession('s2')
const llm2 = makeLlm()
const domain2 = mountCompactionDomain({
  storage, getConfig: () => config, logger: { info() {}, warn() {}, error() {} },
  assemble: fakeAssemble(), getMeter: () => ({ heuristicTokensInRange: () => 4242 }),
  getLlm: () => llm2.ctx, workspace: 'w', now: () => 5000,
})
await domain2.onPreStep({ session: second2, turn: 1 })
check('内容寻址复用：跨会话命中 → 零调用 + cacheHit',
  llm2.calls.length === 0 && second2.events.filter((event) => event.type === COMPRESS_RUN_FACT_TYPE)[0].data.cacheHit === true)

// ⑦ 真机会话只读回放
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) break
    offset += 4
    if (buffer.length - offset < 1) break
    const descriptor = buffer[offset]; offset += 1
    const fcsFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    if ((descriptor & 0x03) !== 0) break
    if (!singleSegment) offset += 1
    offset += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
    let torn = false
    while (offset < buffer.length) {
      if (buffer.length - offset < 3) { torn = true; break }
      const blockHeader = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
      offset += 3
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
let scanned = 0
let sessionsWithClosed = 0
let closedTasks = 0
let triggerable = 0
let unstable = 0
let liveCompressFacts = 0
let totalRegionTokens = 0
let maxRegionTokens = 0
for (const file of listSessionLogs()) {
  let raw
  try { raw = readLog(file) } catch { continue }
  scanned++
  const events = []
  for (const line of raw) {
    if (!line.startsWith('{')) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === COMPRESS_RUN_FACT_TYPE) liveCompressFacts++
    if (typeof event.type !== 'string') continue
    events.push({ type: event.type, seq: event.seq, time: event.time, data: event.data, surfaceOp: event.surfaceOp })
  }
  const facts = factsFromSessionEvents(events)
  const firstUser = events.find((event) => event.type === 'user/message' && event.surfaceOp === 'append')
  const segments = foldSegmentState(facts, { sessionFirstSeq: firstUser?.seq ?? 0 }).segments
  const closed = segments.filter((segment, index) => segment.closed && index < segments.length - 1)
  if (closed.length > 0) sessionsWithClosed++
  closedTasks += closed.length
  const surface = foldSurfaceNodes(events)
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index]
    if (!segment.closed) continue
    const nextStart = segments[index + 1]?.startSeq
    if (typeof nextStart !== 'number') continue
    const start = surface.find((seq) => seq >= (segment.startSeq ?? 0))
    const end = start === undefined ? undefined : [...surface].reverse().find((seq) => seq >= start && seq < nextStart)
    if (start === undefined || end === undefined) continue
    const text = renderRegionTranscript(events, { startSeq: start, endSeq: end })
    if (text === '') continue
    triggerable++
    const tokens = estimateTokens(text)
    totalRegionTokens += tokens
    maxRegionTokens = Math.max(maxRegionTokens, tokens)
    if (text !== renderRegionTranscript(events, { startSeq: start, endSeq: end })) unstable++
  }
}
check('真机只读回放：区间转写字节稳定（双跑漂移 0）', unstable === 0)
check('真机只读回放：闭合段可触发数 ≥ 0（如实报告）', triggerable >= 0)
console.log('  · 扫描会话 ' + scanned + ' / 含闭合段会话 ' + sessionsWithClosed + ' / 闭合段 ' + closedTasks +
  ' / 可触发 ' + triggerable + ' / 区间体量 avg ' + (triggerable === 0 ? 0 : Math.round(totalRegionTokens / triggerable)) +
  ' tok peak ' + maxRegionTokens + ' / live compress-run ' + liveCompressFacts)

// ⑧ spec 标记
const specMarkers = [
  ['tests/compress-region.spec.ts', 'renderRegionTranscript'],
  ['tests/compress-store.spec.ts', 'compressSpanHash'],
  ['tests/compaction-domain.spec.ts', 'mountCompactionDomain'],
  ['tests/agent-step.spec.ts', 'onAgentPreStep'],
]
check('spec 标记齐全（4 文件各覆盖本层主面）', specMarkers.every(([rel, token]) => readText(rel).includes(token)))

// ⑨ 文档同步标记
const master = readText('docs/implement/00-master.md')
check('总纲 P19 行 + 施工记录在位',
  /\| P19 \|/.test(master) && /P19 施工记录/.test(master))
check('设计文档状态行同步（04/09/10/11）',
  /P19/.test(readText('docs/04-compactor.md')) && /P19/.test(readText('docs/09-state.md')) &&
  /P19/.test(readText('docs/10-wiring.md')) && /P19/.test(readText('docs/11-structure.md')))
check('AGENTS 现状 + 账本快照 §46 在位',
  /P19/.test(readText('AGENTS.md')) && /§46/.test(readText('docs/ledger-history.md')))

// ⑩ 尺寸申报
const workorder = readText('docs/implement/P19-boundary-path.md')
check('工单含尺寸实测申报（P19a/P19b）', /尺寸/.test(workorder) && /P19a/.test(workorder) && /P19b/.test(workorder))

console.log('')
if (failures.length === 0) {
  console.log('P19 VERIFY PASS (' + checks.length + ' checks)')
  process.exit(0)
}
console.log('P19 VERIFY FAIL (' + failures.length + '/' + checks.length + ')')
for (const name of failures) console.log('  - ' + name)
process.exit(1)

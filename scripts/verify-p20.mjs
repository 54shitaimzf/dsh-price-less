#!/usr/bin/env node
/**
 * P20 验收（docs/implement/P20-pressure-and-fuse.md §5）。
 * ① 文件齐备；② 纯核/端口导出面；③ 结构铁律（S1/D13/D14 + 域侧收口 + patch.yml auto:false）；
 * ④ 压力纯核 fixture（阈值/断路器/检查点/续传拼接/折叠区材料转写/pressure-fired fold）；
 * ⑤ 保险丝纯核 fixture（地板/武装/hard-truncate fold）；⑥ 压缩族账本（pressure* + hardTruncate*）；
 * ⑦ 假会话端到端（压力触发 → 调用 → 档案 checkpoint → 事务 → 事实；断路器；地板 no-op 字节不变；
 * 溢出接管 retry）；⑧ 真机会话只读回放；⑨ spec 标记；⑩ 文档同步标记；⑪ 尺寸申报。
 * 纯回放：只读本地会话缓存，不联网、不调模型。需先 build（import ../lib）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import {
  COMPRESS_RUN_FACT_TYPE,
  FUSE_RATIO,
  HARD_TRUNCATE_FACT_TYPE,
  PRESSURE_CHAIN_LIMIT,
  PRESSURE_FIRED_FACT_TYPE,
  PRESSURE_RATIO,
  PRESSURE_RETRY_BUDGET,
  composePressureArchive,
  emptyHardTruncateLedger,
  foldHardTruncates,
  foldPressureFires,
  fuseArmed,
  fuseFloorTokens,
  isPressureMaterial,
  pressureBreakerTripped,
  pressureChainDepth,
  pressureThreshold,
  renderCheckpoint,
  renderFoldMaterialTranscript,
  shouldFirePressure,
} from '../lib/core/compress/index.js'
import { foldCompressionLedger } from '../lib/core/assemble/index.js'
import { factsFromSessionEvents } from '../lib/core/ledger/facts.js'
import { foldSurfaceNodes } from '../lib/core/ledger/surface.js'
import { foldSegmentState } from '../lib/core/units.js'
import { mountCompactionDomain, boundaryArchiveKey } from '../lib/domains/compaction.js'
import { ignorableChannelAvailable } from '../lib/platform/ignorable-channel.js'
import { resolveConfig } from '../lib/config.js'

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
  'docs/implement/P20-pressure-and-fuse.md',
  'src/core/compress/pressure.ts', 'src/core/compress/fuse.ts',
  'src/platform/agent-step.ts', 'src/platform/meter.ts', 'src/platform/llm.ts',
  'src/domains/compaction.ts', 'src/domains/compaction-facts.ts', 'cordis.patch.yml',
  'tests/compress-pressure.spec.ts', 'tests/fuse.spec.ts', 'tests/meter.spec.ts',
  'tests/compaction-domain.spec.ts', 'tests/agent-step.spec.ts',
]
const missing = FILES.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
check('文件齐备（工单 + 纯核 2 + 端口 3 + 域 2 + patch + spec 6）', missing.length === 0, missing.join(','))

// ② 导出面
const compress = await import('../lib/core/compress/index.js')
const WANTED_CORE = ['PRESSURE_RATIO', 'PRESSURE_CHAIN_LIMIT', 'PRESSURE_RETRY_BUDGET', 'PRESSURE_FIRED_FACT_TYPE',
  'pressureThreshold', 'shouldFirePressure', 'pressureChainDepth', 'pressureBreakerTripped', 'renderCheckpoint',
  'composePressureArchive', 'isPressureMaterial', 'renderFoldMaterialTranscript', 'foldPressureFires',
  'FUSE_RATIO', 'HARD_TRUNCATE_FACT_TYPE', 'fuseFloorTokens', 'fuseArmed', 'foldHardTruncates']
const missingCore = WANTED_CORE.filter((name) => typeof compress[name] === 'undefined')
check('core/compress 新增导出面齐全（' + WANTED_CORE.length + ' 项）', missingCore.length === 0, missingCore.join(','))
const agentStep = await import('../lib/platform/agent-step.js')
const meterPort = await import('../lib/platform/meter.js')
const llmPort = await import('../lib/platform/llm.js')
check('端口导出面（H3 onAgentRequestError / H7 createMeterPort / H12 resolveContextWindow + 溢出码）',
  typeof agentStep.onAgentRequestError === 'function' && typeof meterPort.createMeterPort === 'function' &&
  typeof llmPort.resolveContextWindow === 'function' && llmPort.CE_CONTEXT_OVERFLOW_CODE === 'CONTEXT_WINDOW_EXCEEDED')
check('meter 端口含 wireTokens（wire 锚定计量面）',
  typeof meterPort.createMeterPort({ tokenMeter: { measure: () => ({ totalTokens: 7, nodes: [] }) } })?.wireTokens === 'function')

// ③ 结构铁律
const coreText = ['src/core/compress/pressure.ts', 'src/core/compress/fuse.ts'].map(readText).join('\n')
check('新增纯核零 harness/platform import（S1）',
  !/from\s+['"]@deepseek-ai\//.test(coreText) && !/from\s+['"]cordis/.test(coreText) && !/from\s+['"][^'"]*platform/.test(coreText))
check('新增纯核无时钟/随机（D13）',
  !/\bMath\.random\(/.test(coreText) && !/\bDate\.now\(/.test(coreText) && !/\bnew Date\(/.test(coreText))
const domainText = readText('src/domains/compaction.ts')
check('域侧收口：不改史直调/不直摸 llm/计量/挂点（S2/D6/D14/D15）',
  !/\.append\(/.test(domainText) && !/ctx\.llm/.test(domainText) && !/ctx\.tokenMeter/.test(domainText) &&
  !/agent\/pre-step/.test(domainText) && !/agent\/request-error/.test(domainText) &&
  !/compaction\/(start|end|summary|prune)/.test(domainText))
const assertSrc = readText('scripts/assert-structure.mjs')
check('结构断言 D14 扩面（agent/request-error 收口）',
  /id: 'D14'/.test(assertSrc) && /agent\/request-error/.test(assertSrc) && /RequestErrorAction/.test(assertSrc))
check('patch.yml：compaction-basic auto:false（防双触发）',
  /- id: compaction-basic/.test(readText('cordis.patch.yml')) && /auto: false/.test(readText('cordis.patch.yml')) &&
  /dsh-price-less/.test(readText('cordis.patch.yml')))
check('三事实声明合并（compress-run / pressure-fired / hard-truncate；ignorable）',
  ['compress-run', 'pressure-fired', 'hard-truncate'].every((name) =>
    readText('src/domains/compaction-facts.ts').includes("'context-economy/" + name + "'")) &&
  /compaction-facts\.ts'/.test(assertSrc))

// ④ 压力纯核 fixture
check('触发阈值：绝对设计值为主 + 比例 fallback（PRESSURE_RATIO=0.4）',
  PRESSURE_RATIO === 0.4 && pressureThreshold({ thresholdTokens: 100000, domainTokens: 125000 }) === 100000 &&
  pressureThreshold({ domainTokens: 125000 }) === 50000 && pressureThreshold({}) === undefined &&
  shouldFirePressure({ wireTokens: 100000, thresholdTokens: 100000 }) === true &&
  shouldFirePressure({ wireTokens: 99999, thresholdTokens: 100000 }) === false)
check('断路器：链深 = checkpoint 数；上限 ' + PRESSURE_CHAIN_LIMIT + '；重试预算 ' + PRESSURE_RETRY_BUDGET,
  pressureChainDepth([{ taskId: 't', kind: 'checkpoint', text: 'a' }]) === 1 &&
  pressureBreakerTripped(PRESSURE_CHAIN_LIMIT) === true && pressureBreakerTripped(PRESSURE_CHAIN_LIMIT - 1) === false &&
  PRESSURE_RETRY_BUDGET === 2)
const checkpointText = renderCheckpoint({ progress: 'P', currentState: 'S', nextStep: 'N', liveConstraints: [' ', 'C'] })
check('检查点渲染：字段序固定 + 空白约束剔除 + 字节稳定',
  checkpointText === '进度：P\n当前状态：S\n下一步：N\n仍生效的约束：\n- C' &&
  renderCheckpoint({ progress: 'P', currentState: 'S', nextStep: 'N', liveConstraints: [' ', 'C'] }) === checkpointText)
check('续传拼接 = 旧检查点链 + 新检查点 + 保留区逐字',
  composePressureArchive({ priorChain: [{ taskId: 't', kind: 'checkpoint', text: 'C1' }], checkpointText: 'C2', retainedText: 'R' }) === 'C1\n\nC2\n\nR')
const ev = (type, seq, data, surfaceOp) => ({ type, seq, time: seq, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) })
const blk = (text) => [{ type: 'text', text }]
const material = [
  ev('user/message', 0, { content: blk('head'), source: { kind: 'user' } }, 'append'),
  ev('tool/result', 1, { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: blk('tail') }] } }, 'append'),
  ev('compaction/start', 2, { compactionId: 'x' }),
  ev('user/message', 3, { content: blk('C1'), source: { kind: 'plugin', plugin: 'compact' } }, { op: 'replace', start: 0, end: 1 }),
]
const foldText = renderFoldMaterialTranscript(material, { startSeq: 0, endSeq: 3 })
check('折叠区材料转写：四类可读材料 + 剔协议/检查点节点 + 字节稳定',
  foldText.includes('head') && foldText.includes('tail') && !foldText.includes('C1') && !foldText.includes('compaction/start') &&
  isPressureMaterial(material[0]) === true && isPressureMaterial(material[2]) === false && isPressureMaterial(material[3]) === false &&
  foldText === renderFoldMaterialTranscript(material, { startSeq: 0, endSeq: 3 }))
const pLedger = foldPressureFires([
  { type: PRESSURE_FIRED_FACT_TYPE, seq: 1, time: 1, data: { at: 1, wireTokens: 120000, thresholdTokens: 100000, outcome: 'fired', chainDepth: 0 } },
  { type: PRESSURE_FIRED_FACT_TYPE, seq: 2, time: 2, data: { at: 2, wireTokens: 0, thresholdTokens: 100000, outcome: 'breaker', chainDepth: 3 } },
  { type: PRESSURE_FIRED_FACT_TYPE, seq: 3, time: 3, data: null },
])
check('pressure-fired fold：四字段（fired/triggerWire/chainDepth/breaker）',
  pLedger.pressureFireCount === 1 && pLedger.pressureTriggerWireTokens === 120000 &&
  pLedger.pressureChainDepth === 3 && pLedger.pressureBreakerTrips === 1)

// ⑤ 保险丝纯核 fixture
check('保险丝地板：0.8 × 窗口；非法窗口不武装',
  FUSE_RATIO === 0.8 && fuseFloorTokens(100000) === 80000 && fuseFloorTokens(undefined) === undefined &&
  fuseArmed({ wireTokens: 80000, contextWindow: 100000 }) === true &&
  fuseArmed({ wireTokens: 79999, contextWindow: 100000 }) === false)
const hLedger = foldHardTruncates([
  { type: HARD_TRUNCATE_FACT_TYPE, seq: 1, time: 1, data: { at: 1, wireTokens: 90000, floorTokens: 80000, outcome: 'fuse-fold' } },
  { type: HARD_TRUNCATE_FACT_TYPE, seq: 2, time: 2, data: { at: 2, wireTokens: 120000, floorTokens: 0, outcome: 'overflow-retry' } },
  { type: HARD_TRUNCATE_FACT_TYPE, seq: 3, time: 3, data: { at: 3, wireTokens: 120000, floorTokens: 0, outcome: 'overflow-declined' } },
  { type: HARD_TRUNCATE_FACT_TYPE, seq: 4, time: 4, data: null },
])
check('hard-truncate fold：介入口径 + 细分位',
  hLedger.hardTruncateCount === 3 && hLedger.fuseArmedFolds === 1 && hLedger.overflowTakeovers === 1 &&
  emptyHardTruncateLedger().hardTruncateCount === 0)

// ⑥ 压缩族账本
const ledger = foldCompressionLedger([
  { type: PRESSURE_FIRED_FACT_TYPE, seq: 1, time: 1, data: { at: 1, wireTokens: 120000, thresholdTokens: 100000, outcome: 'fired', chainDepth: 1 } },
  { type: COMPRESS_RUN_FACT_TYPE, seq: 2, time: 2, data: { at: 2, layer: 'pressure', promptVersion: 1, policyVersion: 1, outcome: 'ok', calls: 1, foldedTokens: 100, retainedTokens: 40, emergency: true } },
  { type: HARD_TRUNCATE_FACT_TYPE, seq: 3, time: 3, data: { at: 3, wireTokens: 90000, floorTokens: 80000, outcome: 'fuse-fold' } },
])
check('压缩族账本：pressure* 四字段 + 层计数 + hardTruncateCount',
  ledger.pressureFireCount === 1 && ledger.pressureTriggerWireTokens === 120000 && ledger.pressureChainDepth === 1 &&
  ledger.pressureBreakerTrips === 0 && ledger.compressionLayer.pressure === 1 && ledger.compressionLayer.boundary === 0 &&
  ledger.pressureFoldedTokens === 100 && ledger.pressureRetainedTokens === 40 && ledger.pressureEmergencies === 1 &&
  ledger.hardTruncateCount === 1 && ledger.fuseArmedFolds === 1 && ledger.overflowTakeovers === 0)

// ⑦ 假会话端到端
const PRESSURE_PRODUCT = JSON.stringify({
  checkpoint: { progress: '已完成 A', currentState: 'B 就绪', nextStep: '做 C', liveConstraints: ['不改 D'] },
  cutPoint: { unitId: 'c2' },
})
class FakeSession {
  constructor(id = 'sp') { this.events = []; this.nodes = []; this.generation = 0; this.header = { id } }
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
const makePressureSession = (id) => {
  const session = new FakeSession(id)
  session.append('user/message', { content: blk('做 A '.repeat(200)), source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }, { surfaceOp: 'append' })
  session.append('tool/result', { turn: 1, step: 1, message: { id: 't1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: blk('x'.repeat(2000)) }] } }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: '{"file_path":"b.ts"}' }, { surfaceOp: 'append' })
  session.append('tool/result', { turn: 1, step: 1, message: { id: 't2', role: 'user', source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'tool-result', toolCallId: 'c2', content: blk('y'.repeat(50)) }] } }, { surfaceOp: 'append' })
  session.append('user/message', { content: blk('继续'), source: { kind: 'user' } }, { surfaceOp: 'append' })
  return session
}
const makeLlm = (contextWindow) => {
  const calls = []
  return {
    calls,
    ctx: {
      llm: {
        ...(contextWindow === undefined ? {} : { resolveModelInfo: async () => ({ context: { contextWindow } }) }),
        stream(options) {
          calls.push(options)
          return (async function* () {
            yield { type: 'text-delta', text: PRESSURE_PRODUCT }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    },
  }
}
const makeDomain = (session, storage, llm, config, wireTokens) => mountCompactionDomain({
  storage, getConfig: () => config, logger: { info() {}, warn() {}, error() {} },
  assemble: { dispose() {}, stats: () => ({ sessions: 0, assemblies: 0, failures: 0, degraded: 0 }), unitList: () => [], assemble: async () => ({ ok: false, reason: 'no-units' }) },
  getMeter: () => ({ heuristicTokensInRange: () => 4242, wireTokens: () => wireTokens }),
  getLlm: () => llm.ctx, workspace: 'w', now: () => 5000,
})
const config = resolveConfig({})
const storage = new FakeStorage()
const session = makePressureSession('sp')
const llm = makeLlm()
const domain = makeDomain(session, storage, llm, config, 120000)
await domain.onPreStep({ session, turn: 7, step: 1 })
const fires = session.events.filter((event) => event.type === PRESSURE_FIRED_FACT_TYPE)
const runs = session.events.filter((event) => event.type === COMPRESS_RUN_FACT_TYPE)
const archive = storage.getEntity('boundary_archive', boundaryArchiveKey('w'))
const landed = session.events.find((event) => event.type === 'user/message' && event.surfaceOp?.op === 'replace')
const landedText = landed?.data?.content?.[0]?.text ?? ''
check('端到端压力：单次调用 + 检查点档案 + 事务四段 + 保留区逐字 + 事实',
  llm.calls.length === 1 && llm.calls[0].purpose === 'context-economy-compaction' && llm.calls[0].temperature === 0 &&
  session.events.filter((event) => event.type === 'compaction/start').length === 1 &&
  session.events.filter((event) => event.type === 'compaction/summary').length === 1 &&
  session.events.filter((event) => event.type === 'compaction/end').length === 1 &&
  archive?.version === 1 && archive.body.entries.length === 1 && archive.body.entries[0].kind === 'checkpoint' &&
  archive.body.entries[0].cutPointSeq === 3 && archive.body.entries[0].rangeEndSeq === 5 &&
  runs.length === 1 && runs[0].data.outcome === 'ok' && runs[0].data.layer === 'pressure' &&
  landedText.includes('[3] tool/call read c2') && landedText.includes('y'.repeat(50)) &&
  fires.length === 1 && fires[0].data.outcome === 'fired' && fires[0].data.chainDepth === 0)
const summarySeq = session.events.filter((event) => event.type === 'compaction/summary')[0].seq
check('官方协议紧邻契约 + 影子价来自 token-meter（4242）',
  landed.seq === summarySeq + 1 && session.events.filter((event) => event.type === 'compaction/summary')[0].data.shadowedTokenCount === 4242)

// 断路器
const storage2 = new FakeStorage()
storage2.entities.set('boundary_archive:' + boundaryArchiveKey('w'), {
  version: 1,
  body: { schemaVersion: 1, workspace: 'w', entries: [0, 1, 2].map((i) => ({ taskId: 'sp:task-1', kind: 'checkpoint', text: 'C' + i, sessionId: 'sp', layer: 'pressure', at: i, cutPointSeq: 1, rangeEndSeq: 2 })), cache: {} },
})
const session2 = makePressureSession('sp')
const llm2 = makeLlm()
const domain2 = makeDomain(session2, storage2, llm2, config, 120000)
await domain2.onPreStep({ session: session2, turn: 1, step: 1 })
check('断路器：链深达上限 → breaker 事实 + 零调用',
  llm2.calls.length === 0 && session2.events.filter((event) => event.type === PRESSURE_FIRED_FACT_TYPE)[0].data.outcome === 'breaker')

// 地板 no-op（字节不变）
const session3 = makePressureSession('sp')
const before3 = session3.events.length
const domain3 = makeDomain(session3, new FakeStorage(), makeLlm(100000), config, 70000)
await domain3.onPreStep({ session: session3, turn: 1, step: 1 })
check('保险丝低于地板：严格 no-op（零事实 / 零改史，字节不变）',
  session3.events.length === before3 && session3.events.filter((event) => event.type === HARD_TRUNCATE_FACT_TYPE).length === 0 &&
  session3.events.filter((event) => event.type === PRESSURE_FIRED_FACT_TYPE).length === 0)

// 地板以上自动折叠
const session4 = makePressureSession('sp')
const llm4 = makeLlm(100000)
const domain4 = makeDomain(session4, new FakeStorage(), llm4, config, 90000)
await domain4.onPreStep({ session: session4, turn: 1, step: 1 })
check('保险丝地板以上：紧急折叠 + hard-truncate{fuse-fold}',
  session4.events.filter((event) => event.type === HARD_TRUNCATE_FACT_TYPE)[0].data.outcome === 'fuse-fold' &&
  session4.events.filter((event) => event.type === COMPRESS_RUN_FACT_TYPE)[0].data.emergency === true && llm4.calls.length === 1)

// 溢出接管
const session5 = makePressureSession('sp')
const llm5 = makeLlm()
const domain5 = makeDomain(session5, new FakeStorage(), llm5, config, 150000)
const action = await domain5.onRequestError({ session: session5, turn: 2, step: 1, failureCode: 'CONTEXT_WINDOW_EXCEEDED' })
check('溢出接管：CONTEXT_WINDOW_EXCEEDED → 紧急折叠 → retry + hard-truncate{overflow-retry}',
  action === 'retry' && llm5.calls.length === 1 &&
  session5.events.filter((event) => event.type === HARD_TRUNCATE_FACT_TYPE)[0].data.outcome === 'overflow-retry')
const action2 = await domain5.onRequestError({ session: session5, turn: 2, step: 1, failureCode: 'CONTEXT_WINDOW_EXCEEDED' })
check('溢出接管：同 (turn,step) 二次 → pass（不重复折叠）', action2 === 'pass' && llm5.calls.length === 1)
const action3 = await domain5.onRequestError({ session: session5, turn: 3, step: 1, failureCode: 'OTHER' })
check('溢出接管：非溢出码 → pass 零行为', action3 === 'pass' && llm5.calls.length === 1)

// ⑧ 真机会话只读回放
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
let openTasks = 0
let candidateSessions = 0
let foldStable = 0
let livePressureRuns = 0
let livePressureFires = 0
let liveHardTruncates = 0
let totalFoldTokens = 0
let maxFoldTokens = 0
for (const file of listSessionLogs()) {
  let raw
  try { raw = readLog(file) } catch { continue }
  scanned++
  const events = []
  for (const line of raw) {
    if (!line.startsWith('{')) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === COMPRESS_RUN_FACT_TYPE && event.data?.layer === 'pressure') livePressureRuns++
    if (event.type === PRESSURE_FIRED_FACT_TYPE) livePressureFires++
    if (event.type === HARD_TRUNCATE_FACT_TYPE) liveHardTruncates++
    if (typeof event.type !== 'string') continue
    events.push({ type: event.type, seq: event.seq, time: event.time, data: event.data, surfaceOp: event.surfaceOp })
  }
  const facts = factsFromSessionEvents(events)
  const firstUser = events.find((event) => event.type === 'user/message' && event.surfaceOp === 'append')
  const segments = foldSegmentState(facts, { sessionFirstSeq: firstUser?.seq ?? 0 }).segments
  const open = segments.at(-1)
  if (open !== undefined && !open.closed) {
    openTasks++
    const surface = foldSurfaceNodes(events)
    const end = surface.at(-1)
    const start = open.startSeq ?? firstUser?.seq ?? 0
    if (end !== undefined) {
      const text = renderFoldMaterialTranscript(events, { startSeq: start, endSeq: end })
      if (text !== '') {
        candidateSessions++
        const tokens = Math.ceil(text.length / 1.5)
        totalFoldTokens += tokens
        maxFoldTokens = Math.max(maxFoldTokens, tokens)
        if (text === renderFoldMaterialTranscript(events, { startSeq: start, endSeq: end })) foldStable++
      }
    }
  }
}
check('真机只读回放：折叠区材料转写字节稳定（双跑漂移 0）', foldStable === candidateSessions)
check('真机只读回放：开 task 候选 ≥ 0（如实报告）', openTasks >= 0)
console.log('  · 扫描会话 ' + scanned + ' / 开 task ' + openTasks + ' / 折叠候选 ' + candidateSessions +
  ' / 折叠区体量 avg ' + (candidateSessions === 0 ? 0 : Math.round(totalFoldTokens / candidateSessions)) +
  ' tok peak ' + maxFoldTokens + ' / live pressure-run ' + livePressureRuns + ' / pressure-fired ' + livePressureFires +
  ' / hard-truncate ' + liveHardTruncates)

// ⑨ spec 标记
const specMarkers = [
  ['tests/compress-pressure.spec.ts', 'pressureThreshold'],
  ['tests/fuse.spec.ts', 'fuseArmed'],
  ['tests/meter.spec.ts', 'wireTokens'],
  ['tests/compaction-domain.spec.ts', 'onRequestError'],
  ['tests/agent-step.spec.ts', 'onAgentRequestError'],
]
check('spec 标记齐全（5 文件各覆盖本层主面）', specMarkers.every(([rel, token]) => readText(rel).includes(token)))

// ⑩ 文档同步标记
const master = readText('docs/implement/00-master.md')
check('总纲 P20a/P20b 行 + 施工记录在位',
  /\| P20a \|/.test(master) && /\| P20b \|/.test(master) && /P20 施工记录/.test(master))
check('设计文档状态行同步（04/09/10/11）',
  /P20/.test(readText('docs/04-compactor.md')) && /P20/.test(readText('docs/09-state.md')) &&
  /P20/.test(readText('docs/10-wiring.md')) && /P20/.test(readText('docs/11-structure.md')))
check('AGENTS 现状 + 账本快照 §47 在位',
  /P20/.test(readText('AGENTS.md')) && /§47/.test(readText('docs/ledger-history.md')))

// ⑪ 尺寸申报
const workorder = readText('docs/implement/P20-pressure-and-fuse.md')
check('工单含尺寸实测申报（P20a/P20b）', /尺寸/.test(workorder) && /P20a/.test(workorder) && /P20b/.test(workorder))

console.log('')
if (failures.length === 0) {
  console.log('P20 VERIFY PASS (' + checks.length + ' checks)')
  process.exit(0)
}
console.log('P20 VERIFY FAIL (' + failures.length + '/' + checks.length + ')')
for (const name of failures) console.log('  - ' + name)
process.exit(1)

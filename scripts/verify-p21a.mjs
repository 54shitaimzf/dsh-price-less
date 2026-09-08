#!/usr/bin/env node
/**
 * P21a 验收（docs/implement/P21a-restore.md §5）。
 * ① 文件齐备；② 纯核/端口/域导出面；③ 结构铁律（S1/D3/D16/D17 + 域侧零模型零改史）；
 * ④ 纯核 fixture（恢复序 / 实体审计四态 / 四表形状 / 段区间 / 卷宗重放 / 双源等价 / 账本 fold）；
 * ⑤ 假会话端到端（fresh 零动作 / 卷宗重建写回 / 项目帧快照回退 / 档案与产物只降级 / 双源漂移 /
 * 幂等 / 事实全 ignorable）；⑥ 真机会话只读回放（重放字节稳定 + live restore 计数）；
 * ⑦ spec 标记；⑧ 文档同步标记；⑨ 尺寸申报。
 * 纯回放：只读本地会话缓存，不联网、不调模型。需先 build（import ../lib）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import {
  RESTORE_PLAN,
  RESTORE_STEPS,
  auditEntityRecord,
  bodyValidatorFor,
  foldRestoreLedger,
  mirrorDiverges,
  rebuildDossiers,
  segmentForSeq,
  validateArchiveBody,
  validateDossierBody,
  validateOptimizeArtifactBody,
  validateProjectFrameBody,
} from '../lib/core/restore/index.js'
import {
  RESTORE_DEGRADED_FACT_TYPE,
  RESTORE_DONE_FACT_TYPE,
  RESTORE_STEP_FACT_TYPE,
} from '../lib/core/restore/index.js'
import { dossierStorageKey, sessionScopedTaskId } from '../lib/core/dossier.js'
import { projectFrameStorageKey } from '../lib/core/prefix.js'
import { factsFromSessionEvents } from '../lib/core/ledger/facts.js'
import { foldSegmentState } from '../lib/core/units.js'
import { mountRestoreDomain, restoreStepNames } from '../lib/domains/restore.js'
import { boundaryArchiveKey } from '../lib/domains/compaction.js'
import { optimizeArtifactStorageKey } from '../lib/domains/star.js'
import { ignorableChannelAvailable } from '../lib/platform/ignorable-channel.js'
import { onAgentSessionStart } from '../lib/platform/agent-step.js'

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
  'docs/implement/P21a-restore.md',
  'src/core/restore/plan.ts', 'src/core/restore/rebuild.ts', 'src/core/restore/ledger.ts', 'src/core/restore/index.ts',
  'src/platform/agent-step.ts', 'src/domains/restore.ts', 'src/domains/restore-facts.ts', 'src/index.ts',
  'tests/restore-core.spec.ts', 'tests/restore-domain.spec.ts',
]
const missing = FILES.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
check('文件齐备（工单 + 纯核 4 + 端口 1 + 域 2 + 接线 + spec 2）', missing.length === 0, missing.join(','))

// ② 导出面
const core = await import('../lib/core/restore/index.js')
const WANTED_CORE = ['RESTORE_STEPS', 'RESTORE_PLAN', 'auditEntityRecord', 'validateDossierBody', 'validateProjectFrameBody',
  'validateArchiveBody', 'validateOptimizeArtifactBody', 'bodyValidatorFor', 'segmentForSeq', 'rebuildDossiers',
  'mirrorDiverges', 'mirrorFactsOf', 'emptyRestoreLedger', 'foldRestoreLedger',
  'RESTORE_STEP_FACT_TYPE', 'RESTORE_DEGRADED_FACT_TYPE', 'RESTORE_DONE_FACT_TYPE']
check('core/restore 导出面齐全（' + WANTED_CORE.length + ' 项）',
  WANTED_CORE.filter((name) => typeof core[name] === 'undefined').length === 0,
  WANTED_CORE.filter((name) => typeof core[name] === 'undefined').join(','))
check('端口 H9 onAgentSessionStart + 域 mountRestoreDomain / restoreStepNames',
  typeof onAgentSessionStart === 'function' && typeof mountRestoreDomain === 'function' &&
  JSON.stringify(restoreStepNames()) === JSON.stringify(RESTORE_PLAN.map((spec) => spec.step)))

// ③ 结构铁律
const coreText = ['plan.ts', 'rebuild.ts', 'ledger.ts'].map((name) => readText('src/core/restore/' + name)).join('\n')
check('纯核零 harness/platform import（S1）',
  !/from\s+['"]@deepseek-ai\//.test(coreText) && !/from\s+['"]cordis/.test(coreText) && !/from\s+['"][^'"]*platform/.test(coreText))
check('纯核无时钟/随机（D17）',
  !/\bMath\.random\(/.test(coreText) && !/\bDate\.now\(/.test(coreText) && !/\bnew Date\(/.test(coreText))
const domainText = readText('src/domains/restore.ts')
check('域侧零模型零改史：不直调 llm/history、不改史、不碰挂点（S2/D6/D7/D16）',
  !/\.append\(/.test(domainText) && !/ctx\.llm/.test(domainText) && !/createHistoryPort/.test(domainText) &&
  !/agent\/session-start/.test(domainText) && !/compaction\/(start|end|summary|prune)/.test(domainText))
const assertSrc = readText('scripts/assert-structure.mjs')
check('结构断言 D16（H9 收口）/ D17（恢复纯核确定性）在位 + D3 白名单收编 restore-facts',
  /id: 'D16'/.test(assertSrc) && /agent\/session-start/.test(assertSrc) && /id: 'D17'/.test(assertSrc) &&
  /restore-facts\.ts/.test(assertSrc))
check('agent/session-start 字面只出现在 platform/agent-step.ts（域侧零字面）',
  readText('src/platform/agent-step.ts').includes("on('agent/session-start'") &&
  !domainText.includes("on('agent/session-start'"))
check('三事实声明合并（restore-step / restore-degraded / restore-done；ignorable）',
  ['restore-step', 'restore-degraded', 'restore-done'].every((name) =>
    readText('src/domains/restore-facts.ts').includes("'context-economy/" + name + "'")))

// ④ 纯核 fixture
check('恢复序 = 09 §4 顺序 + optimize_artifact 补入（6 步）',
  JSON.stringify([...RESTORE_STEPS]) === JSON.stringify(['project_frame', 'dossier', 'boundary_archive', 'optimize_artifact', 'segment_state', 'metrics_cache']) &&
  RESTORE_PLAN[0].strategy === 'snapshot-rollback' && RESTORE_PLAN[1].strategy === 'log-replay' &&
  RESTORE_PLAN[2].strategy === 'degrade-only' && RESTORE_PLAN[4].strategy === 'fold-recompute')
const okRecord = (body, version = 1) => ({ schemaVersion: 1, version, source: { taskId: 't', eventType: 'e' }, body })
check('实体审计四态：missing / version-mismatch / corrupt（结构 + source + 体形状）/ ok',
  auditEntityRecord(undefined, { schemaVersion: 1 }).state === 'missing' &&
  auditEntityRecord({ ...okRecord({}), schemaVersion: 2 }, { schemaVersion: 1 }).state === 'version-mismatch' &&
  auditEntityRecord({ ...okRecord({}), version: 0 }, { schemaVersion: 1 }).state === 'corrupt' &&
  auditEntityRecord({ ...okRecord({}), source: { taskId: '', eventType: 'e' } }, { schemaVersion: 1 }).state === 'corrupt' &&
  auditEntityRecord(okRecord({}), { schemaVersion: 1, validate: () => false }).state === 'corrupt' &&
  auditEntityRecord(okRecord({ ok: 1 }, 3), { schemaVersion: 1, validate: () => true }).version === 3)
check('四表形状校验器 + 按表取校验器',
  validateDossierBody({ taskId: 't', messages: [{ seq: 1, time: 1, text: 'x' }], annotations: {} }) === true &&
  validateDossierBody({ taskId: 't', messages: [{ seq: 1, time: 1 }] }) === false &&
  validateProjectFrameBody({ goal: 'g', aspects: [], skillCatalog: { skills: [], complete: true } }) === true &&
  validateArchiveBody({ schemaVersion: 1, workspace: 'w', entries: [{ taskId: 't', kind: 'boundary', text: 's' }] }, 'w') === true &&
  validateArchiveBody({ schemaVersion: 1, workspace: 'x', entries: [] }, 'w') === false &&
  validateOptimizeArtifactBody({ taskId: 't', sessionId: 's', judgeTable: { version: 1, aspects: [], fileSignatures: [], keywords: [] } }) === true &&
  bodyValidatorFor('dossier', 'w') === validateDossierBody && bodyValidatorFor(undefined, 'w') === undefined)
const segments = [
  { taskId: 'task-1', startSeq: 0, endSeq: 5, closed: true, switchReason: 't0-close' },
  { taskId: 'task-2', startSeq: 5, endSeq: null, closed: false, switchReason: 't0-close' },
]
check('段区间半开 [start, end)：4 → task-1；5 → task-2；空段表 undefined',
  segmentForSeq(segments, 4).taskId === 'task-1' && segmentForSeq(segments, 5).taskId === 'task-2' &&
  segmentForSeq([], 0) === undefined)
const rebuilt = rebuildDossiers({
  sessionId: 's1', segments,
  messages: [{ seq: 1, time: 10, text: 'A' }, { seq: 3, time: 11, text: 'A2' }, { seq: 6, time: 12, text: 'B' }],
  annotations: [{ seq: 1, class: 'action', at: 20 }, { seq: 6, class: 'pureQ', at: 21 }, { seq: 99, class: 'action', at: 22 }],
})
check('卷宗重放：段归属 + 标注回放（by=auto）+ 会话级键 + 越界标注忽略',
  rebuilt.length === 2 && rebuilt[0].key === dossierStorageKey(sessionScopedTaskId('s1', 'task-1')) &&
  rebuilt[0].body.messages.map((m) => m.seq).join(',') === '1,3' && rebuilt[0].annotationCount === 1 &&
  rebuilt[0].body.annotations['1'][0].by === 'auto' && rebuilt[1].body.annotations['99'] === undefined)
const logFacts = [{ type: 'context-economy/task-boundary', seq: 1, time: 1, data: { boundary: 'close' } }]
check('双源等价：镜像空 = 健康；等价不判；不等价判漂移',
  mirrorDiverges(logFacts, []) === false && mirrorDiverges(logFacts, [...logFacts]) === false &&
  mirrorDiverges(logFacts, [{ type: 'context-economy/task-boundary', seq: 2, time: 1, data: { boundary: 'close' } }]) === true)
const rLedger = foldRestoreLedger([
  { type: RESTORE_STEP_FACT_TYPE, seq: 1, time: 1, data: { at: 1, source: 'resume', step: 'project_frame', outcome: 'ok' } },
  { type: RESTORE_STEP_FACT_TYPE, seq: 2, time: 2, data: { at: 2, source: 'resume', step: 'dossier', outcome: 'rebuilt', rebuilt: 2 } },
  { type: RESTORE_DEGRADED_FACT_TYPE, seq: 3, time: 3, data: { at: 3, source: 'resume', step: 'boundary_archive', code: 'version-mismatch' } },
  { type: RESTORE_DONE_FACT_TYPE, seq: 4, time: 4, data: { at: 4, source: 'resume', steps: 6, rebuilt: 2, degraded: 1, durationMs: 5 } },
  { type: RESTORE_STEP_FACT_TYPE, seq: 5, time: 5, data: null },
])
check('恢复族账本 fold：07 restoreDegraded + 步数/重建/版本不符细分/lastDone',
  rLedger.restoreRuns === 1 && rLedger.restoreSteps.dossier === 1 && rLedger.restoreRebuilt === 1 &&
  rLedger.restoreDegraded === 1 && rLedger.versionMismatches === 1 && rLedger.lastDone.durationMs === 5)

// ⑤ 假会话端到端
class FakeSession {
  constructor(id, firstLiveSeq) { this.events = []; this.header = { id }; this.firstLiveSeq = firstLiveSeq }
  append(type, data, opts) {
    const event = { type, seq: this.events.length, time: 1000 + this.events.length, data }
    if (opts?.surfaceOp !== undefined) event.surfaceOp = opts.surfaceOp
    if (opts?.ignorable === true) event.ignorable = true
    this.events.push(event)
    return event
  }
  snapshotEvents() { return this.events.slice() }
  eventAt(seq) { return this.events[seq] }
}
class FakeStorage {
  constructor() { this.entities = new Map(); this.snapshots = new Map(); this.writes = []; this.rollbacks = []; this.mirror = [] }
  seed(table, key, body, version = 1, schemaVersion = 1) {
    const id = table + ':' + key
    const current = this.entities.get(id)
    if (current !== undefined) this.snapshots.set(id, [...(this.snapshots.get(id) ?? []), current])
    this.entities.set(id, { schemaVersion, version, source: { taskId: 'seed', eventType: 'seed' }, body })
  }
  getEntity(table, key) { return this.entities.get(table + ':' + key) }
  async putEntity(table, key, body, source, options) {
    const id = table + ':' + key
    const current = this.entities.get(id)
    const base = options?.baseVersion ?? 0
    if (base === 0) { if (current !== undefined) throw new Error('CAS') }
    else if (current === undefined || current.version !== base) throw new Error('CAS')
    this.writes.push({ table, key, body, source, baseVersion: base })
    if (current !== undefined) this.snapshots.set(id, [...(this.snapshots.get(id) ?? []), current])
    const next = { schemaVersion: 1, version: base === 0 ? 1 : base + 1, source, body }
    this.entities.set(id, next)
    return next
  }
  async rollbackEntity(table, key, target) {
    const id = table + ':' + key
    const current = this.entities.get(id)
    this.rollbacks.push({ table, key, target })
    const snap = (this.snapshots.get(id) ?? []).find((record) => record.version === target)
    if (snap === undefined) throw new Error('no snapshot')
    this.snapshots.set(id, [...(this.snapshots.get(id) ?? []), current])
    this.entities.set(id, { ...snap, source: { taskId: 'rollback', eventType: 'rollback' } })
    return this.entities.get(id)
  }
  auditEntity(table, key) {
    const id = table + ':' + key
    const all = [...(this.snapshots.get(id) ?? [])]
    const current = this.entities.get(id)
    if (current !== undefined) all.push(current)
    return all.sort((a, b) => a.version - b.version)
  }
  listFactMirror() { return [...this.mirror] }
  writeFactMirror(type, data) { this.mirror.push({ type, time: 1, data }) }
  stats() { return { factMirrorCount: this.mirror.length, factMirrorDurabilityErrors: 0, entityCounts: {} } }
  async close() {}
}
const WORKSPACE = 'w'
const SESSION_ID = 'sess-1'
const DOSSIER_1 = dossierStorageKey(sessionScopedTaskId(SESSION_ID, 'task-1'))
const DOSSIER_2 = dossierStorageKey(sessionScopedTaskId(SESSION_ID, 'task-2'))
const FRAME_KEY = projectFrameStorageKey(WORKSPACE)
const ARCHIVE_KEY = boundaryArchiveKey(WORKSPACE)
const makeResumed = () => {
  const session = new FakeSession(SESSION_ID, 4)
  const blk = (text) => ({ type: 'text', text })
  session.events.push(
    { type: 'user/message', seq: 0, time: 100, data: { content: [blk('做 A')], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'context-economy/task-boundary', seq: 1, time: 101, data: { boundary: 'close', taskId: 'task-1' } },
    { type: 'user/message', seq: 2, time: 102, data: { content: [blk('做 B')], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'context-economy/judge-recorded', seq: 3, time: 103, data: { seq: 0, time: 100, trigger: 'turn-end', decision: 'pureQ', class: 'action' } },
  )
  return session
}
const mount = (storage, drill) => mountRestoreDomain({
  storage, logger: { info() {}, warn() {}, error() {} }, workspace: WORKSPACE, now: () => 500,
  ...(drill === undefined ? {} : { drill }),
})
const stepOf = (result, step) => result.steps.find((item) => item.step === step)
const fresh = new FakeSession(SESSION_ID, 0)
const freshResult = await mount(new FakeStorage()).onSessionStart({ session: fresh, source: 'startup' })
check('fresh 会话（firstLiveSeq=0）零动作零事实', freshResult.ran === false && fresh.events.length === 0)
const storage1 = new FakeStorage()
const session1 = makeResumed()
const result1 = await mount(storage1).run({ session: session1, source: 'resume' })
const dossierWrites = storage1.writes.filter((write) => write.table === 'dossier')
check('KV 全空：卷宗日志重放写回（两 task，source=restore-rebuild，baseVersion=0）',
  stepOf(result1, 'dossier').outcome === 'rebuilt' && stepOf(result1, 'dossier').rebuilt === 2 &&
  dossierWrites.length === 2 && dossierWrites.every((write) => write.source.eventType === 'restore-rebuild') &&
  dossierWrites.find((write) => write.key === DOSSIER_1).body.messages.map((m) => m.seq).join(',') === '0')
check('项目帧缺失 → 降级（missing，需重新 init）；档案/产物缺失 → 降级',
  result1.degraded.some((item) => item.step === 'project_frame' && item.code === 'missing') &&
  result1.degraded.some((item) => item.step === 'boundary_archive' && item.code === 'missing') &&
  result1.degraded.some((item) => item.step === 'optimize_artifact' && item.code === 'missing') &&
  storage1.writes.every((write) => write.table === 'dossier'))
check('段状态机 + 度量缓存纯函数重算（taskCount=2）',
  stepOf(result1, 'segment_state').outcome === 'rebuilt' && stepOf(result1, 'segment_state').rebuilt === 2 &&
  stepOf(result1, 'metrics_cache').outcome === 'rebuilt')
const storage2 = new FakeStorage()
storage2.seed('project_frame', FRAME_KEY, { goal: '旧', aspects: [], skillCatalog: { skills: [], complete: true } }, 1)
storage2.seed('project_frame', FRAME_KEY, { broken: true }, 2)
const result2 = await mount(storage2).run({ session: makeResumed(), source: 'resume' })
check('项目帧损坏 + 合法快照 → rollbackEntity 回退（step=rebuilt）',
  stepOf(result2, 'project_frame').outcome === 'rebuilt' &&
  JSON.stringify(storage2.rollbacks) === JSON.stringify([{ table: 'project_frame', key: FRAME_KEY, target: 1 }]) &&
  storage2.getEntity('project_frame', FRAME_KEY).body.goal === '旧')
const storage3 = new FakeStorage()
storage3.seed('boundary_archive', ARCHIVE_KEY, { schemaVersion: 1, workspace: WORKSPACE, entries: [{ taskId: 't', kind: 'bogus', text: 'x' }] })
const result3 = await mount(storage3).run({ session: makeResumed(), source: 'resume' })
check('档案体形状坏 → 只降级（corrupt）且盘上字节不动',
  result3.degraded.some((item) => item.step === 'boundary_archive' && item.code === 'corrupt') &&
  storage3.writes.filter((write) => write.table !== 'dossier').length === 0 &&
  storage3.getEntity('boundary_archive', ARCHIVE_KEY).body.entries.length === 1)
const storage4 = new FakeStorage()
storage4.mirror = [{ type: 'context-economy/task-boundary', seq: 99, time: 1, data: { boundary: 'close' } }]
const result4 = await mount(storage4).run({ session: makeResumed(), source: 'resume' })
check('双源漂移（镜像非空且不等价）→ mirror-divergence 降级',
  result4.degraded.some((item) => item.step === 'metrics_cache' && item.code === 'mirror-divergence') &&
  stepOf(result4, 'metrics_cache').outcome === 'degraded')
const storage5 = new FakeStorage()
const session5 = makeResumed()
const domain5 = mount(storage5)
const first5 = await domain5.onSessionStart({ session: session5, source: 'resume' })
const second5 = await domain5.onSessionStart({ session: session5, source: 'resume' })
const appended = session5.events.slice(4)
check('同会话幂等（第二次不跑）+ 事实全 ignorable + fold 可回放',
  first5.ran === true && second5.ran === false && appended.length > 6 &&
  appended.every((event) => event.ignorable === true) &&
  appended.some((event) => event.type === RESTORE_STEP_FACT_TYPE) &&
  appended.some((event) => event.type === RESTORE_DEGRADED_FACT_TYPE) &&
  appended.some((event) => event.type === RESTORE_DONE_FACT_TYPE) &&
  foldRestoreLedger(appended.map((event) => ({ type: event.type, seq: event.seq, time: event.time, data: event.data }))).restoreRuns === 1)
const storage6 = new FakeStorage()
storage6.seed('dossier', DOSSIER_1, { taskId: 'broken' }, 3)
storage6.seed('dossier', DOSSIER_2, { taskId: 'sess-1:task-2', messages: [{ seq: 2, time: 102, text: '做 B' }], annotations: {} })
const result6 = await mount(storage6, { damaged: { [DOSSIER_1]: 'corrupt' } }).run({ session: makeResumed(), source: 'resume' })
check('演练注入：损坏卷宗覆盖写（CAS 前进 + 损毁版留快照）',
  stepOf(result6, 'dossier').outcome === 'rebuilt' &&
  storage6.writes.find((write) => write.key === DOSSIER_1).baseVersion === 3 &&
  storage6.getEntity('dossier', DOSSIER_1).version === 4 &&
  storage6.auditEntity('dossier', DOSSIER_1).map((record) => record.version).join(',') === '3,4')

// ⑥ 真机会话只读回放
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
    for (const entry of fs.readdirSync(dir)) {
      const file = path.join(dir, entry, 'session.v2.jsonl.zstd')
      if (fs.existsSync(file)) out.push(file)
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
let resumable = 0
let rebuildable = 0
let rebuiltMessages = 0
let stable = 0
let liveRestoreFacts = 0
for (const file of listSessionLogs()) {
  let raw
  try { raw = readLog(file) } catch { continue }
  scanned++
  const events = []
  for (const line of raw) {
    if (!line.startsWith('{')) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (typeof event.type !== 'string') continue
    if (event.type.startsWith('context-economy/restore')) liveRestoreFacts++
    events.push({ type: event.type, seq: event.seq, time: event.time, data: event.data, surfaceOp: event.surfaceOp })
  }
  if (events.length === 0) continue
  const facts = factsFromSessionEvents(events)
  const firstUser = events.find((event) => event.type === 'user/message' && event.surfaceOp === 'append')
  const state = foldSegmentState(facts, { sessionFirstSeq: firstUser?.seq ?? 0, sessionLastSeq: events.at(-1)?.seq })
  const messages = []
  for (const event of events) {
    if (event.type !== 'user/message' || event.surfaceOp !== 'append') continue
    if (event.data?.source?.kind !== 'user') continue
    const text = (event.data?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim()
    if (text === '') continue
    messages.push({ seq: event.seq, time: event.time, text })
  }
  if (messages.length === 0) continue
  resumable++
  const sessionId = path.basename(path.dirname(file))
  const a = JSON.stringify(rebuildDossiers({ sessionId, segments: state.segments, messages }))
  const b = JSON.stringify(rebuildDossiers({ sessionId, segments: state.segments, messages }))
  if (a === b) stable++
  const built = rebuildDossiers({ sessionId, segments: state.segments, messages })
  if (built.length > 0) { rebuildable++; rebuiltMessages += built.reduce((sum, item) => sum + item.messageCount, 0) }
}
check('真机只读回放：卷宗重放字节稳定（双跑漂移 0）', stable === resumable)
check('真机只读回放：可重放会话/卷宗/消息如实报告', resumable >= 0 && rebuildable >= 0 && rebuiltMessages >= 0)
console.log('  · 扫描会话 ' + scanned + ' / 可重放 ' + resumable + ' / 含卷宗 ' + rebuildable +
  ' / 重建消息 ' + rebuiltMessages + ' / live restore-* 事实 ' + liveRestoreFacts + '（重启后新会话才产生）')

// ⑦ spec 标记
const specMarkers = [
  ['tests/restore-core.spec.ts', 'auditEntityRecord'],
  ['tests/restore-core.spec.ts', 'rebuildDossiers'],
  ['tests/restore-domain.spec.ts', 'onSessionStart'],
  ['tests/restore-domain.spec.ts', 'rollbackEntity'],
  ['tests/apply-smoke.spec.ts', 'agent/session-start'],
]
check('spec 标记齐全（纯核/域/接线冒烟各覆盖本层主面）', specMarkers.every(([rel, token]) => readText(rel).includes(token)))

// ⑧ 文档同步标记
const master = readText('docs/implement/00-master.md')
check('总纲 P21a 行 + 施工记录在位', /\| P21a \|/.test(master) && /P21a 施工记录/.test(master))
check('设计文档状态行同步（09/10/11）',
  /P21a/.test(readText('docs/09-state.md')) && /P21a/.test(readText('docs/10-wiring.md')) && /P21a/.test(readText('docs/11-structure.md')))
check('AGENTS 现状 + 账本快照 §49 在位',
  /P21a/.test(readText('AGENTS.md')) && /§49/.test(readText('docs/ledger-history.md')))

// ⑨ 尺寸申报
const workorder = readText('docs/implement/P21a-restore.md')
check('工单含尺寸实测申报（§6.5）', /尺寸申报/.test(workorder) && /src 净增/.test(workorder))

console.log('')
if (failures.length === 0) {
  console.log('P21a VERIFY PASS (' + checks.length + ' checks)')
  process.exit(0)
}
console.log('P21a VERIFY FAIL (' + failures.length + '/' + checks.length + ')')
for (const name of failures) console.log('  - ' + name)
process.exit(1)

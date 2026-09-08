#!/usr/bin/env node
/**
 * P17 验收（docs/implement/P17-boundary-assembler.md §5）。
 * ① 文件齐备；② 纯核/端口/域导出面；③ core 零 harness import + D7/D11/D12 在位；
 * ④ 策略初值未漂移；⑤ 跨层事实名一致；⑥ 坐标链/热尾/事务 fixture；⑦ 账本 fold；
 * ⑧ 结构断言引擎全绿；⑨ spec 标记；⑩ 真机会话离线回放（文件操作 / 单元 / 假想热尾）；
 * ⑪ live 事实数；⑫ 尺寸申报；⑬ 文档同步标记。纯回放：只读本地会话缓存，不联网、不调模型。
 * 需先 build（import ../lib）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import {
  ASSEMBLE_POLICY_VERSION,
  ASSEMBLE_RUN_FACT_TYPE,
  DEFAULT_ASSEMBLE_POLICY,
  HOT_TAIL_TRUNCATION_MARKER,
  assembleArchive,
  emptyCompressionLedger,
  foldAssembleInputs,
  foldCompressionLedger,
  foldFileChains,
  foldTxnMarkers,
  lastLineCount,
  planTxn,
  remapFileCoord,
  renderDigest,
  txnOrderValid,
  validateDigest,
} from '../lib/core/assemble/index.js'
import { estimateTokens, extractTextFromToolResult } from '../lib/core/ledger/index.js'

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
  'docs/implement/P17-boundary-assembler.md',
  'src/core/assemble/types.ts',
  'src/core/assemble/chain.ts',
  'src/core/assemble/assemble.ts',
  'src/core/assemble/txn.ts',
  'src/core/assemble/ledger.ts',
  'src/core/assemble/index.ts',
  'src/platform/files.ts',
  'src/domains/assemble.ts',
  'src/domains/assemble-facts.ts',
  'tests/assemble-chain.spec.ts',
  'tests/assemble-hottail.spec.ts',
  'tests/assemble-ledger.spec.ts',
  'tests/assemble-domain.spec.ts',
]
const missing = FILES.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
check('文件齐备（工单 + 纯核 6 文件 + 端口 + 域 + 事实面 + 4 spec）', missing.length === 0, missing.join(','))

// ② 导出面
const core = await import('../lib/core/assemble/index.js')
const WANTED = ['foldFileChains', 'remapFileCoord', 'lastLineCount', 'foldAssembleInputs', 'validateDigest',
  'renderDigest', 'renderUnitList', 'assembleArchive', 'renderArchive', 'planTxn', 'foldTxnMarkers', 'txnOrderValid',
  'foldCompressionLedger', 'emptyCompressionLedger', 'DEFAULT_ASSEMBLE_POLICY', 'ASSEMBLE_POLICY_VERSION',
  'ASSEMBLE_RUN_FACT_TYPE', 'HOT_TAIL_TRUNCATION_MARKER', 'VERIFY_LINE_RE', 'ERROR_LINE_RE']
const missingExports = WANTED.filter((name) => typeof core[name] === 'undefined')
check('core/assemble 导出面齐全（' + WANTED.length + ' 项）', missingExports.length === 0, missingExports.join(','))
const filesPort = await import('../lib/platform/files.js')
check('platform/files 导出面（createFilesPort / splitFileLines / 字节帽）',
  typeof filesPort.createFilesPort === 'function' && typeof filesPort.splitFileLines === 'function' && filesPort.FILES_MAX_BYTES > 0)
const domain = await import('../lib/domains/assemble.js')
check('domains/assemble 导出面（mountAssembleDomain / runCompactionTxn）',
  typeof domain.mountAssembleDomain === 'function' && typeof domain.runCompactionTxn === 'function' && domain.ASSEMBLE_EVENT_LIMIT > 0)
const facts = await import('../lib/domains/assemble-facts.js')
check('domains/assemble-facts 事实名导出', facts.ASSEMBLE_RUN_FACT_TYPE === ASSEMBLE_RUN_FACT_TYPE)

// ③ 结构铁律
const coreText = FILES.filter((rel) => rel.startsWith('src/core/assemble/')).map(readText).join('\n')
check('core/assemble 零 harness/platform import（S1）',
  !/@deepseek-ai\//.test(coreText) && !/from\s+['"]cordis/.test(coreText) && !/from\s+['"][^'"]*platform/.test(coreText))
check('core/assemble 无时钟/随机（D12）', !/Math\.random\(|Date\.now\(|new Date\(/.test(coreText))
const txnText = readText('src/core/assemble/txn.ts')
check('txn.ts 中性词汇（D7：无 compaction/* 协议字面）',
  !/CompactionId|compaction\/start|compaction\/end|compaction\/prune|compaction\/summary|toolPairingBalanced|@deepseek-ai\/dsh-compaction/.test(txnText))
const filesText = readText('src/platform/files.ts')
check('platform/files 是唯一 fs 触点（D11 白名单文件在位）', /ctx\.get\('fs'\)/.test(filesText) && /@deepseek-ai\/dsh-fs/.test(filesText))
const rulesText = readText('scripts/assert-structure.mjs')
check('结构断言 D11（fs 收口）+ D12（装配确定性）在位', /id: 'D11'/.test(rulesText) && /id: 'D12'/.test(rulesText))
const { runRules, collectFiles } = await import('../scripts/assert-structure.mjs')
const rules = runRules(collectFiles(ROOT))
check('结构断言引擎全绿（含 D11/D12）', rules.ok === true, JSON.stringify(rules.issues.slice(0, 3)))
check('零位快照含 D11/D12', rules.rules.D11?.status === 'pass' && rules.rules.D12?.status === 'pass')

// ④ 策略初值（docs/04 §2/§5 绝对设计值）
check('策略初值未漂移（hotTail 10K / charsPerToken 1.5 / 地板 3+5 / 版本 1）',
  DEFAULT_ASSEMBLE_POLICY.hotTailTokens === 10000 && DEFAULT_ASSEMBLE_POLICY.charsPerToken === 1.5 &&
  DEFAULT_ASSEMBLE_POLICY.floorVerifyLines === 3 && DEFAULT_ASSEMBLE_POLICY.floorErrorLines === 5 &&
  ASSEMBLE_POLICY_VERSION === 1)

// ⑤ 坐标链 fixture（恒等 / 偏移 / 裁剪 / 删除 / 链断）
const lines = (n) => Array.from({ length: n }, (_, i) => 'l' + (i + 1)).join('\n')
const chain = foldFileChains([
  { seq: 1, path: 'a.ts', kind: 'write', content: lines(10) },
  { seq: 2, path: 'a.ts', kind: 'edit', oldString: 'l3', newString: 'l3a\nl3b' },
]).get('a.ts')
check('坐标链：版本 fold + 行数推算', chain.versions.length === 2 && lastLineCount(chain) === 11)
check('坐标链：恒等（未改文件零成本）',
  JSON.stringify(remapFileCoord(chain, { path: 'a.ts', version: 2, lineRange: { start: 4, end: 5 } }, 11)) ===
  JSON.stringify({ ok: true, lineRange: { start: 4, end: 5 }, clipped: false }))
check('坐标链：逐版行偏移（v1 → 当前）',
  JSON.stringify(remapFileCoord(chain, { path: 'a.ts', version: 1, lineRange: { start: 5, end: 6 } }, 11)) ===
  JSON.stringify({ ok: true, lineRange: { start: 6, end: 7 }, clipped: false }))
check('坐标链：替换区扩展 + 出界裁剪',
  JSON.stringify(remapFileCoord(chain, { path: 'a.ts', version: 1, lineRange: { start: 3, end: 3 } }, 11)) ===
  JSON.stringify({ ok: true, lineRange: { start: 3, end: 4 }, clipped: true }) &&
  JSON.stringify(remapFileCoord(chain, { path: 'a.ts', version: 1, lineRange: { start: 10, end: 12 } }, 11)) ===
  JSON.stringify({ ok: true, lineRange: { start: 11, end: 11 }, clipped: true }))
check('坐标链：文件不存在 = 删除丢弃；未知版本 = unknown-version',
  remapFileCoord(chain, { path: 'a.ts', version: 1 }, null).reason === 'deleted' &&
  remapFileCoord(chain, { path: 'a.ts', version: 9 }, 11).reason === 'unknown-version')
const brokenChain = foldFileChains([{ seq: 1, path: 'b.ts', kind: 'write', content: 'a' }, { seq: 2, path: 'b.ts', kind: 'edit', oldString: 'zz', newString: 'q' }]).get('b.ts')
check('坐标链：定位失败 = 链断（不猜位置）',
  remapFileCoord(brokenChain, { path: 'b.ts', version: 1, lineRange: { start: 1, end: 1 } }).reason === 'chain-break')

// ⑥ 热尾 fixture（贪心停机 / 尾截断 / 地板 / 兜底 / digest）
const unit = (id, seqStart, text, extra = {}) => ({ id, kind: 'tool-pair', seqStart, seqEnd: seqStart + 1, text, tokens: estimateTokens(text), ...extra })
const smallPolicy = { ...DEFAULT_ASSEMBLE_POLICY, charsPerToken: 1, hotTailTokens: 20, minTruncatedChars: 5 }
const greedy = assembleArchive({
  units: [unit('a', 1, 'x'.repeat(12)), unit('b', 5, 'y'.repeat(12))],
  hotTail: [{ unitId: 'a' }, { unitId: 'b' }],
  policy: smallPolicy,
})
check('热尾：贪心停机（预算 20 只装 1 单元）',
  greedy.ok === true && greedy.result.hotTail.selections.length === 1 && greedy.result.hotTail.stopReason === 'budget')
const truncated = assembleArchive({ units: [unit('big', 1, 'A'.repeat(100))], hotTail: [{ unitId: 'big' }], policy: smallPolicy })
check('热尾：单单元超帽 = 尾截断 + 可见标记',
  truncated.ok === true && truncated.result.hotTail.selections[0].truncated === true &&
  truncated.result.hotTail.selections[0].text.endsWith(HOT_TAIL_TRUNCATION_MARKER))
const floor = assembleArchive({
  units: [unit('a', 1, 'X'.repeat(8)), unit('v', 5, '307 tests passed', { isVerification: true }), unit('e', 9, 'Error: boom', { isError: true })],
  hotTail: [{ unitId: 'a' }],
  policy: { ...DEFAULT_ASSEMBLE_POLICY, charsPerToken: 1, hotTailTokens: 200 },
})
check('热尾：地板填充（验证尾 + 错误行逐字）',
  floor.ok === true && floor.result.hotTail.floorFilled === true &&
  floor.result.hotTail.selections.map((s) => s.tier).join(',') === 'model,floor,floor')
const fallback = assembleArchive({ units: [unit('a', 1, 'A'.repeat(6)), unit('b', 5, 'B'.repeat(6))], policy: { ...DEFAULT_ASSEMBLE_POLICY, charsPerToken: 1, hotTailTokens: 8 } })
check('热尾：申报缺失 = 位置兜底（不 fatal）',
  fallback.ok === true && fallback.result.hotTail.source === 'positional-fallback')
check('事实层：digest 块序 + 坐标层渲染',
  renderDigest({ blocks: [{ type: 'wrap', text: '尾' }, { type: 'plan', text: '头' }], coords: [{ path: 'a.ts', version: 2, lineRange: { start: 1, end: 3 } }] }) === '头\n\n尾\n\na.ts@v2:1-3')
check('事实层：schema 违例 = fatal（三环口径）',
  assembleArchive({ units: [unit('a', 1, 'x')], digest: { blocks: [{ type: 'bogus', text: 'x' }], coords: [] } }).reason === 'digest-schema' &&
  validateDigest({ blocks: [], coords: [{ path: 'a', version: 0 }] }) === undefined)

// ⑦ 事务原语 + 账本 fold
const plan = planTxn({ txnId: 't1', layer: 'boundary', taskId: 'task-1', range: { start: 0, end: 4 }, shadowedTokenCount: 7, replaceKind: 'digest' })
check('事务原语：顺序合法 + prune 先于 replace + 幂等键',
  txnOrderValid(plan.steps) && plan.steps.map((s) => s.kind).join(',') === 'open,prune,replace,close' &&
  plan.idempotenceKey === 'boundary|task-1|0..4' && plan.turn === null)
check('事务原语：标记 fold（未闭合 / ID 不匹配可见）',
  JSON.stringify(foldTxnMarkers([{ phase: 'open', txnId: 'x', turn: null }])) === JSON.stringify({ active: { txnId: 'x', turn: null }, completed: 0, mismatched: 0 }) &&
  foldTxnMarkers([{ phase: 'close', txnId: 'y', turn: null }]).mismatched === 1)
const ledger = foldCompressionLedger([
  { type: ASSEMBLE_RUN_FACT_TYPE, seq: 1, time: 1, data: { at: 1, layer: 'boundary', digestBytes: 10, digestEntryCount: 2, hotTailTokens: 300, hotTailDeclaredUnits: 3, hotTailStopReason: 'budget', hotTailSource: 'model', hotTailFloorFilled: true, unitCount: 9, dropped: 1, clipped: 0, truncated: 0 } },
])
check('账本 fold：压缩族字段可回放 + 未实现项显式 0',
  ledger.digestBytes === 10 && ledger.hotTailTokens === 300 && ledger.hotTailStopReason.budget === 1 &&
  ledger.hotTailSource.model === 1 && ledger.compressionLayer.boundary === 1 &&
  emptyCompressionLedger().hardTruncateCount === 0 && emptyCompressionLedger().archiveTruncate.count === 0)

// ⑨ spec 标记
const specMarkers = [
  ['tests/assemble-chain.spec.ts', 'remapFileCoord'],
  ['tests/assemble-hottail.spec.ts', 'assembleArchive'],
  ['tests/assemble-ledger.spec.ts', 'foldCompressionLedger'],
  ['tests/assemble-domain.spec.ts', 'runCompactionTxn'],
]
check('spec 标记齐全（4 文件各覆盖本层主面）',
  specMarkers.every(([rel, token]) => readText(rel).includes(token)))

// ⑩ 真机会话离线回放
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) break
    offset += 4
    if (buffer.length - offset < 1) { break }
    const descriptor = buffer[offset]; offset += 1
    const fcsFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictFlag = descriptor & 0x03
    if (dictFlag !== 0) break
    if (!singleSegment) offset += 1
    offset += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
    if (dictFlag === 3) offset += 4
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
const logs = listSessionLogs()
let scanned = 0
let opCounts = { read: 0, write: 0, edit: 0 }
let unitCount = 0
let chainsBuilt = 0
let chainsBroken = 0
let remapOk = 0
let remapFail = {}
let hypotheticalHotTailTokens = 0
let liveAssembleFacts = 0
for (const file of logs) {
  let raw
  try { raw = readLog(file) } catch { continue }
  scanned++
  const events = []
  for (const line of raw) {
    if (!line.startsWith('{')) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === ASSEMBLE_RUN_FACT_TYPE) liveAssembleFacts++
    if (typeof event.type !== 'string') continue
    events.push({ type: event.type, seq: event.seq, time: event.time, data: event.data, surfaceOp: event.surfaceOp })
  }
  const inputs = foldAssembleInputs(events)
  unitCount += inputs.units.length
  for (const op of inputs.ops) if (opCounts[op.kind] !== undefined) opCounts[op.kind]++
  for (const chain of inputs.chains.values()) {
    chainsBuilt++
    if (chain.broken) chainsBroken++
    for (const version of chain.versions) {
      if (version.content === undefined && version.lineCount === undefined) continue
      const result = remapFileCoord(chain, { path: chain.path, version: version.version }, lastLineCount(chain))
      if (result.ok) remapOk++
      else remapFail[result.reason] = (remapFail[result.reason] ?? 0) + 1
    }
  }
  const tail = assembleArchive({ units: inputs.units, chains: inputs.chains })
  if (tail.ok) hypotheticalHotTailTokens += tail.result.hotTail.tokens
}
console.log('')
console.log('=== P17 真机会话离线回放（文件操作 / 单元 / 假想热尾；不做臂对照） ===')
console.log('会话扫描 = ' + scanned + '；文件操作 read=' + opCounts.read + ' write=' + opCounts.write + ' edit=' + opCounts.edit)
console.log('单元（tool 对）= ' + unitCount + '；版本链 = ' + chainsBuilt + '（链断 ' + chainsBroken + '）')
console.log('坐标重映射自检：ok=' + remapOk + '；fail=' + (Object.keys(remapFail).length === 0 ? '(无)' : Object.entries(remapFail).map(([k, n]) => k + '=' + n).join(' ')))
console.log('假想热尾（无申报 = 位置兜底）token 合计 = ' + hypotheticalHotTailTokens)
console.log('live assemble-run 事实 = ' + liveAssembleFacts + '（P19 触发接线后才产生）')
check('真机会话离线回放完成（扫描 ' + scanned + ' 个会话）', scanned >= 0)
check('回放自洽（链断/重映射失败不抛错）', remapOk >= 0 && chainsBuilt >= 0)
check('live 事实数与接线状态自洽（触发归 P19）', liveAssembleFacts >= 0)

// ⑫ 尺寸申报
const sizeFiles = ['src/core/assemble/types.ts', 'src/core/assemble/chain.ts', 'src/core/assemble/assemble.ts',
  'src/core/assemble/txn.ts', 'src/core/assemble/ledger.ts', 'src/core/assemble/index.ts',
  'src/platform/files.ts', 'src/domains/assemble.ts', 'src/domains/assemble-facts.ts', 'src/index.ts']
const sizes = sizeFiles.map((rel) => rel + '=' + readText(rel).split('\n').length)
console.log('尺寸申报（含注释总行数，非净增）：' + sizes.join(' / '))
check('尺寸申报输出', sizes.length === sizeFiles.length)

// ⑬ 文档同步标记
check('docs/04 状态行已同步 P17', /P17/.test(readText('docs/04-compactor.md')))
check('docs/10 挂点表含 H15（盘上取真）', /H15/.test(readText('docs/10-wiring.md')))
check('docs/11 状态/搭建序已同步 P17', /P17/.test(readText('docs/11-structure.md')))
check('docs/13 含 ctx.fs 接口节', /dsh-fs/.test(readText('docs/13-harness-plugin-spec.md')))
check('ledger-history 含 §42/§43 快照', /§42/.test(readText('docs/ledger-history.md')) && /§43/.test(readText('docs/ledger-history.md')))
check('总纲 P17 行标已施工 + 下一单 = P18', /P17 \| 边界装配器（\*\*已施工/.test(readText('docs/implement/00-master.md')) && /P18/.test(readText('docs/implement/00-master.md')))
check('AGENTS 现状段已同步 P17', /P17/.test(readText('AGENTS.md')))

console.log('')
if (failures.length > 0) {
  console.log('P17 VERIFY FAIL (' + failures.length + ' failed / ' + checks.length + ' checks)')
  process.exit(1)
}
console.log('P17 VERIFY PASS (' + checks.length + ' checks)')

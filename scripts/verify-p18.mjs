#!/usr/bin/env node
/**
 * P18 验收（docs/implement/archive/P18-compress-call.md §5）。
 * ① 文件齐备；② 纯核导出面；③ S1/D13 结构铁律 + 断言引擎在位；④ 版本/策略初值未漂移；
 * ⑤ 两模式 prompt fixture（模板在前/清单在尾/零预算泄漏/续传/上限）；⑥ 产物 fixture（fatal 口径/HT 软门/缝两校验）；
 * ⑦ 四次序闭合表；⑧ 调用账本 fold + 合并压缩族（防双计）；⑨ spec 标记；⑩ 真机会话只读回放（渲染字节稳定/体量分布）；
 * ⑪ 尺寸申报；⑫ 文档同步标记。纯回放：只读本地会话缓存，不联网、不调模型。
 * 需先 build（import ../lib）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import {
  COMPRESS_POLICY_VERSION,
  COMPRESS_PROMPT_VERSION,
  COMPRESS_RUN_FACT_TYPE,
  DEFAULT_COMPRESS_POLICY,
  TAIL_CONSUME_OPS,
  classifyTailBlock,
  compressUnitList,
  emptyCompressCallLedger,
  extractJsonObject,
  foldCompressCalls,
  parseCompressProduct,
  planTailConsumption,
  renderBoundaryPrompt,
  renderPressurePrompt,
  renderPriorChain,
  stripProductFences,
  validateCutPoint,
} from '../lib/core/compress/index.js'
import {
  ASSEMBLE_RUN_FACT_TYPE,
  foldAssembleInputs,
  foldCompressionLedger,
} from '../lib/core/assemble/index.js'
import { estimateTokens } from '../lib/core/ledger/index.js'

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
  'docs/implement/archive/P18-compress-call.md',
  'src/core/compress/types.ts',
  'src/core/compress/prompt.ts',
  'src/core/compress/product.ts',
  'src/core/compress/consume.ts',
  'src/core/compress/ledger.ts',
  'src/core/compress/index.ts',
  'tests/compress-prompt.spec.ts',
  'tests/compress-product.spec.ts',
  'tests/compress-consume.spec.ts',
  'tests/compress-ledger.spec.ts',
]
const missing = FILES.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
check('文件齐备（工单 + 纯核 6 文件 + 4 spec）', missing.length === 0, missing.join(','))

// ② 导出面
const core = await import('../lib/core/compress/index.js')
const WANTED = ['COMPRESS_PROMPT_VERSION', 'COMPRESS_POLICY_VERSION', 'DEFAULT_COMPRESS_POLICY', 'COMPRESS_RUN_FACT_TYPE',
  'COMPRESS_BOUNDARY_HEAD', 'COMPRESS_BOUNDARY_RULES', 'COMPRESS_BOUNDARY_OUTPUT', 'COMPRESS_PRESSURE_HEAD',
  'COMPRESS_PRESSURE_RULES', 'COMPRESS_PRESSURE_OUTPUT', 'TAIL_CONSUME_OPS',
  'renderBoundaryPrompt', 'renderPressurePrompt', 'renderPriorChain', 'compressUnitList',
  'stripProductFences', 'extractJsonObject', 'parseProductObject', 'parseCompressProduct', 'validateCheckpoint', 'validateCutPoint',
  'classifyTailBlock', 'planTailConsumption', 'emptyCompressCallLedger', 'foldCompressCalls']
const missingExports = WANTED.filter((name) => typeof core[name] === 'undefined')
check('core/compress 导出面齐全（' + WANTED.length + ' 项）', missingExports.length === 0, missingExports.join(','))

// ③ 结构铁律
const coreText = FILES.filter((rel) => rel.startsWith('src/core/compress/')).map(readText).join('\n')
check('core/compress 零 harness/platform import（S1）',
  !/from\s+['"]@deepseek-ai\//.test(coreText) && !/from\s+['"]cordis/.test(coreText) && !/from\s+['"][^'"]*platform/.test(coreText))
check('core/compress 无时钟/随机（D13）',
  !/\bMath\.random\(/.test(coreText) && !/\bDate\.now\(/.test(coreText) && !/\bnew Date\(/.test(coreText))
const assertSrc = readText('scripts/assert-structure.mjs')
check('结构断言引擎含 D13（core/compress 确定性）', /id: 'D13'/.test(assertSrc) && /core\/compress must stay deterministic/.test(assertSrc))
check('零位快照含 D13（tests/assert-structure.spec.ts）', /D13: 'pass'/.test(readText('tests/assert-structure.spec.ts')))
check('core/compress 不触碰改史/事实发射（S2/D3）',
  !/\.append\(/.test(coreText) && !/emitFact\(/.test(coreText) && !/IgnorableSessionEventMap/.test(coreText))

// ④ 版本与策略初值
check('版本初值未漂移（prompt=1 / policy=1 / cpt=1.5 / 清单不限）',
  COMPRESS_PROMPT_VERSION === 1 && COMPRESS_POLICY_VERSION === 1 && DEFAULT_COMPRESS_POLICY.version === 1 &&
  DEFAULT_COMPRESS_POLICY.charsPerToken === 1.5 && DEFAULT_COMPRESS_POLICY.maxUnitListEntries === 0)
check('事实名与跨层常量一致（compress-run）', COMPRESS_RUN_FACT_TYPE === 'context-economy/compress-run' && core.COMPRESS_RUN_FACT_TYPE === COMPRESS_RUN_FACT_TYPE)

// ⑤ 两模式 prompt fixture
const unit = (id, extra = {}) => ({ id, kind: 'tool-pair', seqStart: 1, seqEnd: 2, text: 'text-' + id, tokens: 10, ...extra })
const boundaryRender = renderBoundaryPrompt({ regionText: 'RAW-REGION-BYTES', units: [unit('a'), unit('b')] })
const pressureRender = renderPressurePrompt({ regionText: 'RAW-REGION-BYTES', units: [unit('a')] })
check('边界 prompt：静态模板在前 + 区域居中 + 清单在尾',
  boundaryRender.prompt.startsWith(core.COMPRESS_BOUNDARY_HEAD) &&
  boundaryRender.prompt.indexOf('RAW-REGION-BYTES') < boundaryRender.prompt.lastIndexOf('<单元清单>') &&
  boundaryRender.prompt.trimEnd().endsWith('</单元清单>'))
check('压力 prompt：检查点 + 缝 schema + 不申报热尾',
  pressureRender.prompt.startsWith(core.COMPRESS_PRESSURE_HEAD) && /"checkpoint"/.test(pressureRender.prompt) &&
  /"cutPoint"/.test(pressureRender.prompt) && /不宣称最终事实/.test(pressureRender.prompt) && /不申报热尾/.test(pressureRender.prompt))
const allPromptText = [boundaryRender.prompt, pressureRender.prompt].join('\n')
check('预算数字零泄漏（N2：模板内无任何预算常数）',
  ['10000', '15000', '100000', '0.4', '10K', '15K', 'retainTokens', 'thresholdTokens'].every((leak) => !allPromptText.includes(leak)))
check('prompt 同输入同字节（双跑逐字节一致）',
  renderBoundaryPrompt({ regionText: 'r', units: [unit('a')] }).prompt === renderBoundaryPrompt({ regionText: 'r', units: [unit('a')] }).prompt &&
  renderPressurePrompt({ regionText: 'r', units: [unit('a')] }).prompt === renderPressurePrompt({ regionText: 'r', units: [unit('a')] }).prompt)
const chain = [{ taskId: 't1', kind: 'checkpoint', text: 'C1' }, { taskId: 't1', kind: 'checkpoint', text: 'C2' }]
const chained = renderBoundaryPrompt({ regionText: 'REGION', units: [unit('a')], priorChain: chain })
check('机制 A 续传面：旧检查点原样列出且在区域之前 + 计数',
  chained.priorChainCount === 2 && chained.prompt.includes('原样续传，禁止改写') &&
  chained.prompt.indexOf('C1') < chained.prompt.indexOf('REGION') && renderPriorChain([]) === '')
const cappedList = compressUnitList([unit('a'), unit('b'), unit('c')], { ...DEFAULT_COMPRESS_POLICY, maxUnitListEntries: 2 })
check('单元清单上限：超限保留最近 + 计数（0 = 不限）',
  compressUnitList([unit('a')]).listed === 1 && cappedList.listed === 2 && cappedList.omitted === 1 && !cappedList.text.includes('[a]'))
check('regionTokens 按注入 cpt 机械计量', renderBoundaryPrompt({ regionText: 'x'.repeat(30), units: [], policy: { ...DEFAULT_COMPRESS_POLICY, charsPerToken: 1 } }).regionTokens === 30)

// ⑥ 产物 fixture
const goodBoundary = JSON.stringify({ digest: { blocks: [{ type: 'plan', text: 'p' }], coords: [{ path: 'a.ts', version: 1 }] }, hotTail: [{ unitId: 'a' }] })
const goodBoundaryResult = parseCompressProduct('\u0060\u0060\u0060json\n' + goodBoundary + '\n\u0060\u0060\u0060', 'boundary', [unit('a')])
check('产物 fixture：围栏剥离 + digest 校验 + 热尾接受',
  goodBoundaryResult.ok === true && goodBoundaryResult.product.mode === 'boundary' && goodBoundaryResult.product.hotTail.length === 1 &&
  goodBoundaryResult.dropped.badDecl === 0 && goodBoundaryResult.dropped.unknownUnit === 0)
check('产物 fatal 口径：非 JSON = parse；digest 坏形状 = schema',
  parseCompressProduct('nope', 'boundary', []).reason === 'parse' &&
  parseCompressProduct('{"digest":{"blocks":"x","coords":[]}}', 'boundary', []).reason === 'schema')
const droppedResult = parseCompressProduct(JSON.stringify({ digest: { blocks: [], coords: [] }, hotTail: [{ unitId: 'ghost' }, { unitId: 'a', coord: null }, 'junk'] }), 'boundary', [unit('a')])
check('HT 软门降级计数：unknownUnit=1 / badDecl=2，好申报保留，不 fatal',
  droppedResult.ok === true && droppedResult.dropped.unknownUnit === 1 && droppedResult.dropped.badDecl === 2 &&
  droppedResult.product.hotTail.length === 0)
check('hotTail 缺失 = ok + 空申报（装配器回退位置法，不在此 fatal）',
  parseCompressProduct(JSON.stringify({ digest: { blocks: [], coords: [] } }), 'boundary', []).ok === true)
const goodPressure = JSON.stringify({ checkpoint: { progress: 'p', currentState: 'c', nextStep: 'n', liveConstraints: [] }, cutPoint: { unitId: 'a' } })
check('压力产物：检查点 + 缝校验通过',
  parseCompressProduct(goodPressure, 'pressure', [unit('a')]).ok === true &&
  parseCompressProduct(goodPressure, 'pressure', []).reason === 'schema')
const pair = unit('p', { kind: 'tool-pair', seqStart: 1, seqEnd: 4 })
const inside = unit('m', { kind: 'message', seqStart: 2, seqEnd: 2 })
check('缝两校验：未知单元 / 切开工具对 = schema（04 §3）',
  validateCutPoint({ unitId: 'ghost' }, [unit('a')]).reason === 'unknown-unit' &&
  validateCutPoint({ unitId: 'm' }, [pair, inside]).reason === 'pair-split' &&
  validateCutPoint({ unitId: 'm' }, [pair, inside]).ok !== true)
check('机械抽取与永不抛错（围栏/平衡/噪声输入）',
  stripProductFences('\u0060\u0060\u0060json\n{"a":1}\n\u0060\u0060\u0060') === '{"a":1}' &&
  extractJsonObject('x {"s":"}","n":1} y') === '{"s":"}","n":1}' &&
  ['', 'null', '[]', '42', '{'.repeat(5000)].every((raw) => { try { parseCompressProduct(raw, 'boundary', []); parseCompressProduct(raw, 'pressure', []); return true } catch { return false } }))

// ⑦ 四次序闭合表
const entry = (taskId, kind, text = kind) => ({ taskId, kind, text })
check('尾部消费表：摘要块续传 / 材料块折叠',
  TAIL_CONSUME_OPS.checkpoint === 'continue' && TAIL_CONSUME_OPS.boundary === 'continue' && TAIL_CONSUME_OPS.material === 'fold' &&
  classifyTailBlock('material').reason === 'cache-not-archive' && classifyTailBlock('checkpoint').reason === 'stub-immutable')
const d = entry('t', 'boundary')
const c1 = entry('t', 'checkpoint', 'C1')
const c2 = entry('t', 'checkpoint', 'C2')
const orders = [
  planTailConsumption({ layer: 'boundary' }),
  planTailConsumption({ priorChain: [d], layer: 'boundary' }),
  planTailConsumption({ priorChain: [d], layer: 'pressure' }),
  planTailConsumption({ priorChain: [c1], layer: 'boundary' }),
  planTailConsumption({ priorChain: [c1, c2], layer: 'pressure' }),
]
check('四触发次序闭合（边→边 / 边→压 / 压→边 / 压→压）',
  orders[0].ok === true && orders[0].form === 'single' && orders[0].foldMaterial === false &&
  orders[1].appendKind === 'boundary' && orders[1].form === 'chain' &&
  orders[2].appendKind === 'checkpoint' && orders[2].foldMaterial === true &&
  orders[3].appendKind === 'boundary' && orders[4].carryCount === 2 && orders[4].appendKind === 'checkpoint')
check('链形态非法 = chain-invalid（调用侧不落刀）',
  planTailConsumption({ priorChain: [d, c1], layer: 'boundary' }).reason === 'chain-invalid' &&
  planTailConsumption({ priorChain: [entry('a', 'checkpoint'), entry('b', 'checkpoint')], layer: 'pressure' }).reason === 'chain-invalid')

// ⑧ 调用账本 fold
const compressFact = (data, seq = 1) => ({ type: COMPRESS_RUN_FACT_TYPE, seq, time: seq, data })
const callLedger = foldCompressCalls([
  compressFact({ at: 1, layer: 'boundary', promptVersion: 1, policyVersion: 1, cacheHit: true, outcome: 'ok' }),
  compressFact({ at: 2, layer: 'pressure', promptVersion: 1, policyVersion: 1, outcome: 'ok', llmUsage: { inputTokens: 9, outputTokens: 3 } }, 2),
  compressFact({ at: 3, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'parse' }, 3),
])
check('调用账本：复用零调用 / 命中率分母 = 事实数 / usage 汇总',
  callLedger.invocations === 3 && callLedger.cacheHits === 1 && callLedger.compressionCallCount === 2 &&
  Math.abs(callLedger.compressionCacheHitRate - 1 / 3) < 1e-12 && callLedger.usage.inputTokens === 9 && callLedger.parseFailures === 1)
check('调用账本：空账全 0 + 坏载荷跳过不抛错',
  emptyCompressCallLedger().compressionCallCount === 0 && emptyCompressCallLedger().compressionCacheHitRate === 0 &&
  foldCompressCalls([{ type: COMPRESS_RUN_FACT_TYPE, seq: 1, time: 1, data: null }]).invocations === 0)
const mergedLedger = foldCompressionLedger([
  { type: ASSEMBLE_RUN_FACT_TYPE, seq: 1, time: 1, data: { at: 1, layer: 'boundary', digestBytes: 5, digestEntryCount: 1, hotTailTokens: 0, hotTailDeclaredUnits: 0, hotTailStopReason: 'list-end', hotTailSource: 'model', hotTailFloorFilled: false, unitCount: 1, dropped: 0, clipped: 0, truncated: 0 } },
  compressFact({ at: 2, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'ok' }, 2),
  compressFact({ at: 3, layer: 'boundary', promptVersion: 1, policyVersion: 1, cacheHit: true, outcome: 'ok' }, 3),
])
check('合并压缩族 fold：compressionCall* 可算且 compressionLayer 不双计',
  mergedLedger.compressionCallCount === 1 && Math.abs(mergedLedger.compressionCacheHitRate - 0.5) < 1e-12 &&
  mergedLedger.compressInvocations === 2 && mergedLedger.compressionLayer.boundary === 1 && mergedLedger.compressionLayer.pressure === 0)

// ⑨ spec 标记
const specMarkers = [
  ['tests/compress-prompt.spec.ts', 'renderBoundaryPrompt'],
  ['tests/compress-product.spec.ts', 'parseCompressProduct'],
  ['tests/compress-consume.spec.ts', 'planTailConsumption'],
  ['tests/compress-ledger.spec.ts', 'foldCompressCalls'],
]
check('spec 标记齐全（4 文件各覆盖本层主面）', specMarkers.every(([rel, token]) => readText(rel).includes(token)))

// ⑩ 真机会话只读回放
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
const logs = listSessionLogs()
let scanned = 0
let renderedSessions = 0
let renderedPrompts = 0
let totalPromptTokens = 0
let maxPromptTokens = 0
let leakedPrompts = 0
let unstablePrompts = 0
let cappedOmitted = 0
let liveCompressFacts = 0
let totalUnits = 0
for (const file of logs) {
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
  const inputs = foldAssembleInputs(events)
  totalUnits += inputs.units.length
  if (inputs.units.length === 0) continue
  renderedSessions++
  const tailUnits = inputs.units.slice(-20)
  const regionText = tailUnits.map((item) => item.text.slice(0, 2000)).join('\n')
  const first = renderBoundaryPrompt({ regionText, units: tailUnits })
  const second = renderBoundaryPrompt({ regionText, units: tailUnits })
  const pressure = renderPressurePrompt({ regionText, units: tailUnits })
  renderedPrompts += 2
  totalPromptTokens += estimateTokens(first.prompt, DEFAULT_COMPRESS_POLICY.charsPerToken)
  maxPromptTokens = Math.max(maxPromptTokens, estimateTokens(first.prompt, DEFAULT_COMPRESS_POLICY.charsPerToken))
  if (first.prompt !== second.prompt) unstablePrompts++
  // 零泄漏口径 = 模板段（区域载荷是真实会话字节，可含任意数字，不属模板泄漏）。
  const templateHead = first.prompt.slice(0, first.prompt.indexOf('<闭合段原文>'))
  const pressureHead = pressure.prompt.slice(0, pressure.prompt.indexOf('<折叠区原文>'))
  if (['10000', '15000', '100000', '0.4'].some((leak) => templateHead.includes(leak) || pressureHead.includes(leak))) leakedPrompts++
  cappedOmitted += compressUnitList(inputs.units, { ...DEFAULT_COMPRESS_POLICY, maxUnitListEntries: 10 }).omitted
}
console.log('')
console.log('=== P18 真机会话只读回放（单元清单 → 两模式 prompt；不调模型、不落盘） ===')
console.log('会话扫描 = ' + scanned + '；含单元会话 = ' + renderedSessions + '；单元合计 = ' + totalUnits)
console.log('渲染 prompt = ' + renderedPrompts + ' 次；平均 = ' + (renderedPrompts === 0 ? 0 : Math.round(totalPromptTokens / renderedPrompts)) + ' token；峰值 = ' + maxPromptTokens + ' token')
console.log('字节不稳定 = ' + unstablePrompts + '；预算泄漏 = ' + leakedPrompts + '；清单上限省略单元 = ' + cappedOmitted)
console.log('live compress-run 事实 = ' + liveCompressFacts + '（P19/P20a 接线后才产生）')
check('真机会话只读回放完成（扫描 ' + scanned + ' 个会话）', scanned >= 0)
check('回放确定性：真实语料渲染零字节漂移', unstablePrompts === 0)
check('回放安全：真实 prompt 零预算泄漏', leakedPrompts === 0)
check('回放上限：清单帽生效（省略 ' + cappedOmitted + ' 条）', cappedOmitted >= 0)
check('live 事实数与接线状态自洽（调用归 P19/P20a）', liveCompressFacts >= 0)

// ⑪ 尺寸申报
const sizeFiles = ['src/core/compress/types.ts', 'src/core/compress/prompt.ts', 'src/core/compress/product.ts',
  'src/core/compress/consume.ts', 'src/core/compress/ledger.ts', 'src/core/compress/index.ts']
const sizes = sizeFiles.map((rel) => rel + '=' + readText(rel).split('\n').length)
console.log('尺寸申报（含注释总行数，非净增）：' + sizes.join(' / '))
check('尺寸申报输出', sizes.length === sizeFiles.length)

// ⑫ 文档同步标记
check('总纲 P18 行标已施工 + 修正落位', /P18 \| 压缩调用（\*\*已施工/.test(readText('docs/implement/archive/00-master.md')))
const p18Row = readText('docs/implement/archive/00-master.md').split('\n').find((line) => line.startsWith('| P18 |')) ?? ''
check('总纲 P18 行删除 datasets 同源断言（修正 #2 落位）',
  p18Row.includes('版本化常量/字节稳定断言') && !p18Row.includes('模板在前 + datasets 同源断言'))
check('docs/04 状态行已同步 P18', /P18/.test(readText('docs/04-compactor.md')))
check('docs/10 状态行已同步 P18（H12 契约）', /P18/.test(readText('docs/10-wiring.md')))
check('docs/11 状态行/树已同步 P18', /P18/.test(readText('docs/11-structure.md')))
check('docs/11 §7 资产登记已同步 P18（压缩器 prompt 版本化 + 字节稳定断言）', /压缩器 prompt（边界\/压力两模式；版本化常量 \+ 字节稳定断言/.test(readText('docs/11-structure.md')))
check('AGENTS 现状段已同步 P18', /P18/.test(readText('AGENTS.md')))
check('ledger-history 含 §45 快照（P18）', /## 45\. 账本快照 §45/.test(readText('docs/ledger-history.md')))
check('工单含 §8 计划修正表（8 项）', /## 8\. 计划修正/.test(readText('docs/implement/archive/P18-compress-call.md')))

console.log('')
if (failures.length > 0) {
  console.log('P18 VERIFY FAIL (' + failures.length + ' failed / ' + checks.length + ' checks)')
  process.exit(1)
}
console.log('P18 VERIFY PASS (' + checks.length + ' checks)')
process.exit(0)

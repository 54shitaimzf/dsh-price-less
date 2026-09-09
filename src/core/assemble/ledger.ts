/**
 * 压缩族账本 fold（docs/07 §0.5 压缩族；docs/04 §7；P17a 度量先行）。
 * 纯函数：同输入同账；输入 = `context-economy/assemble-run` 事实（+ 后续 P19/P20/P20b 事实）。
 * ①③ 落地：extraSearchCalls（压缩后窗口内重发已见调用）由 events 回放；hotTailLocated/
 * hotTailUnlocated 由 assemble-run 事实汇总。
 * P20b：hardTruncateCount 由 hard-truncate 事实 fold（纯核 = core/compress/fuse.ts）。
 * P20a：pressure* 四字段由 pressure-fired 事实 fold（纯核 = core/compress/pressure.ts）；
 * compressionLayer.pressure 由 compress-run（layer=pressure ∧ outcome=ok）计数——
 * 压力路径不经边界装配器（保留区无帽、无热尾语义），两源各自唯一不双计（P18 N6 口径修正）。
 * P17c：`archiveTruncate` fold 路径打通（纯核截断 = `core/assemble/archive.ts`；生产者 = P19 档案区）。
 * P18：`compressionCallCount`/`compressionCacheHitRate` fold 路径打通（事实 = `compress-run`，
 * 纯核 = `core/compress/ledger.ts`；生产者 = P19/P20a）。
 * P19：边界路径生产者落位（`domains/compaction.ts`），新增自持位（skips/retries/shrink/storage/archive/shearFold）。
 *
 * 模块: core 压缩账本 fold（零 harness/platform import）
 * 平面: L0（确定性重放；无模型、无 IO）
 * 回退链步数: 0（纯计算）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D12）；不写事实、不改史、不读盘。
 * 度量: 本文件即压缩族账本 fold（07 回放管道消费面）。
 */
import { COMPRESS_RUN_FACT_TYPE, foldCompressCalls } from '../compress/ledger.ts'
import { foldPressureFires } from '../compress/pressure.ts'
import { foldHardTruncates } from '../compress/fuse.ts'
import type { LedgerFact, LedgerSessionEvent } from '../ledger/types.ts'
import type { AssembleLayer, HotTailDropCounts, HotTailSource, HotTailStopReason } from './types.ts'

export const ASSEMBLE_RUN_FACT_TYPE = 'context-economy/assemble-run' // ignorable

/** 每次装配一条（P17b 发射；度量先行，注入/档案落盘归 P19）。 */
export interface AssembleRunFactData {
  readonly at: number
  readonly layer: AssembleLayer
  readonly digestBytes: number
  readonly digestEntryCount: number
  // —— F9 摘要/热尾事实面（旧事实缺省 = 0） ——
  readonly digestTokens?: number
  readonly gistBytes?: number
  readonly stepCount?: number
  readonly stepTokens?: number
  readonly factLeaks?: number
  /** F10：配额不足被丢弃条数（原 pointerOnlyCount）。 */
  readonly quotaDrops?: number
  readonly factRejects?: number
  readonly dupDrops?: number
  /** F10：错误/失败单元不进热尾的丢弃数。 */
  readonly errorDrops?: number
  readonly hotTailPointers?: number
  /** F9f：申报洪泛被 maxFetchUnits 截断的坐标数（明账，原为静默 break）。 */
  readonly fetchCapped?: number
  /** F9d（档案硬帽面；生产者逐步接入）。 */
  readonly archiveOverCap?: boolean
  readonly rootKind?: string
  readonly hotTailTokens: number
  readonly hotTailDeclaredUnits: number
  readonly hotTailStopReason: HotTailStopReason
  readonly hotTailSource: HotTailSource
  readonly hotTailFloorFilled: boolean
  /** v4：带定位标注的条目数 / 不自证位置且无坐标的条目数。 */
  readonly hotTailLocated?: number
  readonly hotTailUnlocated?: number
  readonly unitCount: number
  readonly dropped: number
  /** 丢弃归因（P17c；缺省 = 旧事实无归因）。 */
  readonly dropReasons?: Partial<HotTailDropCounts>
  readonly clipped: number
  readonly truncated: number
  /** 档案形态（F9f：single = 无续传链 / chain = [C…] 续传 + 追加；审计面）。 */
  readonly archiveForm?: 'single' | 'chain'
  /** 档案区硬帽截断（P17c；生产者 = P19 档案区，缺省 0）。 */
  readonly archiveTruncateCount?: number
  readonly archiveTruncateTokens?: number
}

export interface CompressionLedger {
  digestBytes: number
  digestEntryCount: number
  /** F9 摘要/热尾事实面（assemble-run 源）。 */
  digestTokens: number
  gistBytes: number
  stepCount: number
  stepTokens: number
  factLeaks: number
  quotaDrops: number
  factRejects: number
  dupDrops: number
  errorDrops: number
  hotTailPointers: number
  fetchCapped: number
  archiveOverCap: number
  archiveTruncate: { count: number; tokens: number }
  compressionCallCount: number
  compressionCacheHitRate: number
  extraSearchCalls: number
  hotTailTokens: number
  hotTailDeclaredUnits: number
  hotTailStopReason: { budget: number; 'list-end': number }
  hotTailSource: { model: number; 'positional-fallback': number }
  hotTailFloorFilled: number
  /** v4：热尾定位标注审计（assemble-run 源）。 */
  hotTailLocated: number
  hotTailUnlocated: number
  pressureFireCount: number
  pressureTriggerWireTokens: number
  pressureChainDepth: number
  pressureBreakerTrips: number
  compressionLayer: { boundary: number; pressure: number }
  hardTruncateCount: number
  /** 装配规模（本 fold 自持的观测位，不属 07 字段但同源可回放）。 */
  assembleRuns: number
  assembleDropped: number
  assembleClipped: number
  assembleTruncated: number
  /** 压缩调用规模（P18 自持观测位；07 缺压缩 usage 字段，见 P18 工单 N7）。 */
  compressInvocations: number
  compressCacheHits: number
  compressUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  compressParseFailures: number
  compressSchemaFailures: number
  /** P19 边界路径自持观测位（07 缺压缩族细分字段；同 assembleRuns 先例）。 */
  compressSkips: number
  compressRetries: number
  compressShrinkRejects: number
  compressStorageFailures: number
  compressArchiveAppends: number
  compressShearBoundaryFolded: number
  compressRetiredDossiers: number
  /** P20a 压力自持观测位（07 pressure* 四字段见上；此处为折叠/保留体量与 skip/紧急细分）。 */
  pressureFoldedTokens: number
  pressureRetainedTokens: number
  pressureSkips: number
  pressureEmergencies: number
  /** P20b 保险丝自持观测位（07 hardTruncateCount 见上）。 */
  fuseArmedFolds: number
  overflowTakeovers: number
}

export function emptyCompressionLedger(): CompressionLedger {
  return {
    digestBytes: 0,
    digestEntryCount: 0,
    digestTokens: 0,
    gistBytes: 0,
    stepCount: 0,
    stepTokens: 0,
    factLeaks: 0,
    quotaDrops: 0,
    factRejects: 0,
    dupDrops: 0,
    errorDrops: 0,
    hotTailPointers: 0,
    fetchCapped: 0,
    archiveOverCap: 0,
    archiveTruncate: { count: 0, tokens: 0 },
    compressionCallCount: 0,
    compressionCacheHitRate: 0,
    extraSearchCalls: 0,
    hotTailTokens: 0,
    hotTailDeclaredUnits: 0,
    hotTailStopReason: { budget: 0, 'list-end': 0 },
    hotTailSource: { model: 0, 'positional-fallback': 0 },
    hotTailFloorFilled: 0,
    hotTailLocated: 0,
    hotTailUnlocated: 0,
    pressureFireCount: 0,
    pressureTriggerWireTokens: 0,
    pressureChainDepth: 0,
    pressureBreakerTrips: 0,
    compressionLayer: { boundary: 0, pressure: 0 },
    hardTruncateCount: 0,
    assembleRuns: 0,
    assembleDropped: 0,
    assembleClipped: 0,
    assembleTruncated: 0,
    compressInvocations: 0,
    compressCacheHits: 0,
    compressUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    compressParseFailures: 0,
    compressSchemaFailures: 0,
    compressSkips: 0,
    compressRetries: 0,
    compressShrinkRejects: 0,
    compressStorageFailures: 0,
    compressArchiveAppends: 0,
    compressShearBoundaryFolded: 0,
    compressRetiredDossiers: 0,
    pressureFoldedTokens: 0,
    pressureRetainedTokens: 0,
    pressureSkips: 0,
    pressureEmergencies: 0,
    fuseArmedFolds: 0,
    overflowTakeovers: 0,
  }
}

function numberField(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 额外搜索窗口（压缩事件之后看多少次工具调用；docs/07 `extraSearchCalls`）。 */
export const EXTRA_SEARCH_WINDOW = 30

/** 工具调用签名（同名同参 = 同一次调用；tool/call 与 run_code 内层 dispatch 都认）。 */
function callSignatureOf(event: LedgerSessionEvent): string | undefined {
  const data = (event.data ?? {}) as Record<string, unknown>
  const name = typeof data.name === 'string' ? data.name : undefined
  if (name === undefined) return undefined
  const args = data.arguments
  if (typeof args === 'string') return `${name}\u0000${args}`
  if (typeof args === 'object' && args !== null) {
    try {
      return `${name}\u0000${JSON.stringify(args)}`
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * `extraSearchCalls`（docs/07 压缩族）：压缩事件后 `EXTRA_SEARCH_WINDOW` 次工具调用里，
 * 签名在压缩前已出现过的调用数——"丢了内容 → 重新找"的直接读数（归因诊断，不入质量判定）。
 * 边界取装配/成功压缩两类事实；窗口重叠按首个边界归并（不重复计）。
 */
export function countExtraSearchCalls(
  facts: readonly LedgerFact[],
  events: readonly LedgerSessionEvent[],
): number {
  const boundaries: number[] = []
  for (const fact of facts) {
    if (typeof fact.seq !== 'number') continue
    if (fact.type === ASSEMBLE_RUN_FACT_TYPE) {
      boundaries.push(fact.seq)
      continue
    }
    if (fact.type !== COMPRESS_RUN_FACT_TYPE) continue
    const data = (fact.data ?? {}) as Record<string, unknown>
    if (data.outcome === 'ok') boundaries.push(fact.seq)
  }
  if (boundaries.length === 0) return 0
  boundaries.sort((a, b) => a - b)
  const calls: Array<{ seq: number; signature: string }> = []
  for (const event of events) {
    if (event.type !== 'tool/call' && event.type !== 'tool/code-dispatch-start') continue
    if (typeof event.seq !== 'number') continue
    const signature = callSignatureOf(event)
    if (signature === undefined) continue
    calls.push({ seq: event.seq, signature })
  }
  if (calls.length === 0) return 0
  const firstAt = new Map<string, number>()
  for (let i = 0; i < calls.length; i++) {
    const signature = (calls[i] as { signature: string }).signature
    if (!firstAt.has(signature)) firstAt.set(signature, i)
  }
  let total = 0
  let coveredUntil = -1
  for (const boundary of boundaries) {
    const start = calls.findIndex((call) => call.seq > boundary)
    if (start < 0 || start <= coveredUntil) continue
    const end = Math.min(calls.length, start + EXTRA_SEARCH_WINDOW)
    for (let i = start; i < end; i++) {
      const signature = (calls[i] as { signature: string }).signature
      const first = firstAt.get(signature)
      if (first !== undefined && first < start) total++
    }
    coveredUntil = end - 1
  }
  return total
}

/** 压缩族账本（事实序回放；坏载荷跳过，绝不抛错）。 */
export function foldCompressionLedger(
  facts: readonly LedgerFact[],
  events: readonly LedgerSessionEvent[] = [],
): CompressionLedger {
  const ledger = emptyCompressionLedger()
  for (const fact of facts) {
    if (fact.type !== ASSEMBLE_RUN_FACT_TYPE) continue
    const data = (fact.data ?? {}) as Record<string, unknown>
    ledger.assembleRuns++
    ledger.digestBytes += numberField(data.digestBytes)
    ledger.digestEntryCount += numberField(data.digestEntryCount)
    ledger.digestTokens += numberField(data.digestTokens)
    ledger.gistBytes += numberField(data.gistBytes)
    ledger.stepCount += numberField(data.stepCount)
    ledger.stepTokens += numberField(data.stepTokens)
    ledger.factLeaks += numberField(data.factLeaks)
    ledger.quotaDrops += numberField(data.quotaDrops)
    ledger.factRejects += numberField(data.factRejects)
    ledger.dupDrops += numberField(data.dupDrops)
    ledger.errorDrops += numberField(data.errorDrops)
    ledger.hotTailPointers += numberField(data.hotTailPointers)
    ledger.fetchCapped += numberField(data.fetchCapped)
    if (data.archiveOverCap === true) ledger.archiveOverCap++
    ledger.hotTailTokens += numberField(data.hotTailTokens)
    ledger.hotTailDeclaredUnits += numberField(data.hotTailDeclaredUnits)
    ledger.assembleDropped += numberField(data.dropped)
    ledger.assembleClipped += numberField(data.clipped)
    ledger.assembleTruncated += numberField(data.truncated)
    ledger.archiveTruncate.count += numberField(data.archiveTruncateCount)
    ledger.archiveTruncate.tokens += numberField(data.archiveTruncateTokens)
    const stop = data.hotTailStopReason
    if (stop === 'budget' || stop === 'list-end') ledger.hotTailStopReason[stop]++
    const source = data.hotTailSource
    if (source === 'model' || source === 'positional-fallback') ledger.hotTailSource[source]++
    if (data.hotTailFloorFilled === true) ledger.hotTailFloorFilled++
    ledger.hotTailLocated += numberField(data.hotTailLocated)
    ledger.hotTailUnlocated += numberField(data.hotTailUnlocated)
    const layer = data.layer
    if (layer === 'boundary' || layer === 'pressure') ledger.compressionLayer[layer]++
  }
  // P18：调用口径由 compress-run 事实汇总（层计数见下方两源相加，各自唯一）。
  const calls = foldCompressCalls(facts)
  // P19：边界路径的档案硬帽截断经 compress-run 生产（装配路径经 assemble-run）——两源相加，各自唯一。
  ledger.archiveTruncate.count += calls.archiveTruncate.count
  ledger.archiveTruncate.tokens += calls.archiveTruncate.tokens
  ledger.compressionCallCount = calls.compressionCallCount
  ledger.compressionCacheHitRate = calls.compressionCacheHitRate
  ledger.compressInvocations = calls.invocations
  ledger.compressCacheHits = calls.cacheHits
  ledger.compressUsage = calls.usage
  ledger.compressParseFailures = calls.parseFailures
  ledger.compressSchemaFailures = calls.schemaFailures
  ledger.compressSkips = calls.skips
  ledger.compressRetries = calls.retries
  ledger.compressShrinkRejects = calls.shrinkRejects
  ledger.compressStorageFailures = calls.storageFailures
  ledger.compressArchiveAppends = calls.archiveAppends
  ledger.compressShearBoundaryFolded = calls.shearBoundaryFolded
  ledger.compressRetiredDossiers = calls.retiredDossiers
  // P20a：压力触发口径由 pressure-fired 事实汇总；层计数 pressure 由成功压力折叠唯一产出。
  const fires = foldPressureFires(facts)
  ledger.pressureFireCount = fires.pressureFireCount
  ledger.pressureTriggerWireTokens = fires.pressureTriggerWireTokens
  ledger.pressureChainDepth = fires.pressureChainDepth
  ledger.pressureBreakerTrips = fires.pressureBreakerTrips
  ledger.pressureSkips = fires.skips
  // 紧急折叠计数源 = compress-run（每次尝试一条，含失败）；pressure-fired 只记"决定开火"。
  ledger.pressureEmergencies = calls.pressureEmergencies
  ledger.pressureFoldedTokens = calls.pressureFoldedTokens
  ledger.pressureRetainedTokens = calls.pressureRetainedTokens
  // 两源各自唯一（P19 archiveTruncate 先例）：assemble-run 源 = 边界装配路径（含 P17 fixture）；
  // compress-run 源 = 压力折叠（压力路径不经装配器）。同一 fold 不会两源同时出现。
  ledger.compressionLayer.pressure += calls.pressureOk
  // P20b：保险丝介入口径由 hard-truncate 事实汇总（07 hardTruncateCount）。
  const fuse = foldHardTruncates(facts)
  ledger.hardTruncateCount = fuse.hardTruncateCount
  ledger.fuseArmedFolds = fuse.fuseArmedFolds
  ledger.overflowTakeovers = fuse.overflowTakeovers
  // ①：压缩后窗口内重发已见调用（无 events = 0，旧调用方零改动）。
  ledger.extraSearchCalls = countExtraSearchCalls(facts, events)
  return ledger
}

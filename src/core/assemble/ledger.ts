/**
 * 压缩族账本 fold（docs/07 §0.5 压缩族；docs/04 §7；P17a 度量先行）。
 * 纯函数：同输入同账；输入 = `context-economy/assemble-run` 事实（+ 后续 P19/P20/P20b 事实）。
 * 未实现项显式 0（口径先立不空转）：pressure* 归 P20a、hardTruncateCount 归 P20b、
 * extraSearchCalls 归 P21b。
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
import { foldCompressCalls } from '../compress/ledger.ts'
import type { LedgerFact } from '../ledger/types.ts'
import type { AssembleLayer, HotTailDropCounts, HotTailSource, HotTailStopReason } from './types.ts'

export const ASSEMBLE_RUN_FACT_TYPE = 'context-economy/assemble-run' // ignorable

/** 每次装配一条（P17b 发射；度量先行，注入/档案落盘归 P19）。 */
export interface AssembleRunFactData {
  readonly at: number
  readonly layer: AssembleLayer
  readonly digestBytes: number
  readonly digestEntryCount: number
  readonly hotTailTokens: number
  readonly hotTailDeclaredUnits: number
  readonly hotTailStopReason: HotTailStopReason
  readonly hotTailSource: HotTailSource
  readonly hotTailFloorFilled: boolean
  readonly unitCount: number
  readonly dropped: number
  /** 丢弃归因（P17c；缺省 = 旧事实无归因）。 */
  readonly dropReasons?: Partial<HotTailDropCounts>
  readonly clipped: number
  readonly truncated: number
  /** 档案区硬帽截断（P17c；生产者 = P19 档案区，缺省 0）。 */
  readonly archiveTruncateCount?: number
  readonly archiveTruncateTokens?: number
}

export interface CompressionLedger {
  digestBytes: number
  digestEntryCount: number
  archiveTruncate: { count: number; tokens: number }
  compressionCallCount: number
  compressionCacheHitRate: number
  extraSearchCalls: number
  hotTailTokens: number
  hotTailDeclaredUnits: number
  hotTailStopReason: { budget: number; 'list-end': number }
  hotTailSource: { model: number; 'positional-fallback': number }
  hotTailFloorFilled: number
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
}

export function emptyCompressionLedger(): CompressionLedger {
  return {
    digestBytes: 0,
    digestEntryCount: 0,
    archiveTruncate: { count: 0, tokens: 0 },
    compressionCallCount: 0,
    compressionCacheHitRate: 0,
    extraSearchCalls: 0,
    hotTailTokens: 0,
    hotTailDeclaredUnits: 0,
    hotTailStopReason: { budget: 0, 'list-end': 0 },
    hotTailSource: { model: 0, 'positional-fallback': 0 },
    hotTailFloorFilled: 0,
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
  }
}

function numberField(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 压缩族账本（事实序回放；坏载荷跳过，绝不抛错）。 */
export function foldCompressionLedger(facts: readonly LedgerFact[]): CompressionLedger {
  const ledger = emptyCompressionLedger()
  for (const fact of facts) {
    if (fact.type !== ASSEMBLE_RUN_FACT_TYPE) continue
    const data = (fact.data ?? {}) as Record<string, unknown>
    ledger.assembleRuns++
    ledger.digestBytes += numberField(data.digestBytes)
    ledger.digestEntryCount += numberField(data.digestEntryCount)
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
    const layer = data.layer
    if (layer === 'boundary' || layer === 'pressure') ledger.compressionLayer[layer]++
  }
  // P18：调用口径由 compress-run 事实汇总（compressionLayer 仍只由 assemble-run 计数，防双计）。
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
  return ledger
}

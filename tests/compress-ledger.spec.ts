/**
 * P18 压缩调用账本单测（docs/implement/P18-compress-call.md §5；docs/07 §0.5 压缩族）。
 * 调用/复用口径 + 合并进压缩族 fold（防双计）+ 同输入同账。
 */
import { describe, expect, it } from 'vitest'
import {
  COMPRESS_RUN_FACT_TYPE,
  emptyCompressCallLedger,
  foldCompressCalls,
  type CompressRunFactData,
} from '../src/core/compress/index.ts'
import { ASSEMBLE_RUN_FACT_TYPE, emptyCompressionLedger, foldCompressionLedger } from '../src/core/assemble/index.ts'
import { PRESSURE_FIRED_FACT_TYPE } from '../src/core/compress/index.ts'
import type { LedgerFact } from '../src/core/ledger/types.ts'

const fact = (data: Partial<CompressRunFactData>, seq = 1): LedgerFact => ({ type: COMPRESS_RUN_FACT_TYPE, seq, time: seq, data })

describe('P18 账本：调用口径', () => {
  it('空账全 0（含命中率分母口径）', () => {
    const ledger = emptyCompressCallLedger()
    expect(ledger.compressionCallCount).toBe(0)
    expect(ledger.compressionCacheHitRate).toBe(0)
    expect(ledger.invocations).toBe(0)
    expect(ledger.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })

  it('cacheHit = 零调用；未命中/显式 calls/skipped 口径', () => {
    const ledger = foldCompressCalls([
      fact({ at: 1, layer: 'boundary', promptVersion: 1, policyVersion: 1, cacheHit: true, outcome: 'ok' }),
      fact({ at: 2, layer: 'pressure', promptVersion: 1, policyVersion: 1, outcome: 'ok' }, 2),
      fact({ at: 3, layer: 'boundary', promptVersion: 1, policyVersion: 1, calls: 2, outcome: 'ok' }, 3),
      fact({ at: 4, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'skipped' }, 4),
    ])
    expect(ledger.invocations).toBe(4)
    expect(ledger.cacheHits).toBe(1)
    expect(ledger.compressionCallCount).toBe(3)
    expect(ledger.compressionCacheHitRate).toBe(0.25)
  })

  it('usage 汇总 + fatal 计数 + 坏载荷跳过不抛错', () => {
    const ledger = foldCompressCalls([
      fact({ at: 1, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'parse', llmUsage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } }),
      fact({ at: 2, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'schema' }, 2),
      fact({ at: 3, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'ok', llmUsage: { inputTokens: 5, outputTokens: 1 } }, 3),
      { type: COMPRESS_RUN_FACT_TYPE, seq: 4, time: 4, data: null },
      { type: 'other/fact', seq: 5, time: 5, data: {} },
    ])
    expect(ledger.usage).toEqual({ inputTokens: 15, outputTokens: 3, cacheReadTokens: 3, cacheWriteTokens: 4 })
    expect(ledger.parseFailures).toBe(1)
    expect(ledger.schemaFailures).toBe(1)
    expect(ledger.compressionCallCount).toBe(3)
  })

  it('合并进压缩族 fold：compressionCall* 可算且 compressionLayer 不双计', () => {
    const assemble = (layer: 'boundary' | 'pressure'): LedgerFact => ({
      type: ASSEMBLE_RUN_FACT_TYPE, seq: 1, time: 1,
      data: { at: 1, layer, digestBytes: 10, digestEntryCount: 1, hotTailTokens: 0, hotTailDeclaredUnits: 0, hotTailStopReason: 'list-end', hotTailSource: 'model', hotTailFloorFilled: false, unitCount: 1, dropped: 0, clipped: 0, truncated: 0 },
    })
    const ledger = foldCompressionLedger([
      assemble('boundary'),
      fact({ at: 2, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'ok' }, 2),
      fact({ at: 3, layer: 'boundary', promptVersion: 1, policyVersion: 1, cacheHit: true, outcome: 'ok' }, 3),
    ])
    expect(ledger.compressionCallCount).toBe(1)
    expect(ledger.compressionCacheHitRate).toBe(0.5)
    expect(ledger.compressInvocations).toBe(2)
    expect(ledger.compressionLayer).toEqual({ boundary: 1, pressure: 0 })
    expect(emptyCompressionLedger().compressInvocations).toBe(0)
  })

  it('P19 自持位：skips/retries/shrink/storage/archive/shearFold/dossier', () => {
    const ledger = foldCompressCalls([
      fact({ at: 1, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'skipped', reason: 'llm-unavailable' }),
      fact({ at: 2, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'skipped', reason: 'shrink', retry: 1, calls: 2 }, 2),
      fact({ at: 3, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'skipped', reason: 'storage', calls: 1 }, 3),
      fact({ at: 4, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'ok', archiveEntries: 2, shearFolded: 3, dossierRetired: true }, 4),
    ])
    expect(ledger.skips).toBe(3)
    expect(ledger.retries).toBe(1)
    expect(ledger.shrinkRejects).toBe(1)
    expect(ledger.storageFailures).toBe(1)
    expect(ledger.archiveAppends).toBe(1)
    expect(ledger.shearBoundaryFolded).toBe(3)
    expect(ledger.retiredDossiers).toBe(1)
    expect(ledger.compressionCallCount).toBe(4)
  })

  it('合并进压缩族 fold 时 P19 自持位同步透出', () => {
    const ledger = foldCompressionLedger([
      fact({ at: 1, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'skipped', reason: 'shrink', calls: 1, retry: 1, shearFolded: 2 }),
    ])
    expect(ledger.compressSkips).toBe(1)
    expect(ledger.compressRetries).toBe(1)
    expect(ledger.compressShrinkRejects).toBe(1)
    expect(ledger.compressShearBoundaryFolded).toBe(2)
  })

  it('P19 档案硬帽截断：compress-run 源计入 07 archiveTruncate（与 assemble-run 源相加）', () => {
    const ledger = foldCompressionLedger([
      fact({ at: 1, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'ok', archiveTruncateCount: 2, archiveTruncateTokens: 30 }),
    ])
    expect(ledger.archiveTruncate).toEqual({ count: 2, tokens: 30 })
  })

  it('P20a 压力自持位 + 层计数：pressure 由 compress-run(ok) 唯一产出，boundary 仍由 assemble-run', () => {
    const pressureFact: LedgerFact = {
      type: PRESSURE_FIRED_FACT_TYPE, seq: 9, time: 9,
      data: { at: 1, wireTokens: 120000, thresholdTokens: 100000, outcome: 'fired', chainDepth: 1 },
    }
    const ledger = foldCompressionLedger([
      pressureFact,
      fact({ at: 2, layer: 'pressure', promptVersion: 1, policyVersion: 1, outcome: 'ok', foldedTokens: 100, retainedTokens: 40, emergency: true }, 2),
      fact({ at: 3, layer: 'pressure', promptVersion: 1, policyVersion: 1, outcome: 'skipped', reason: 'shrink' }, 3),
      fact({ at: 4, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'ok' }, 4),
    ])
    expect(ledger.pressureFireCount).toBe(1)
    expect(ledger.pressureTriggerWireTokens).toBe(120000)
    expect(ledger.pressureChainDepth).toBe(1)
    expect(ledger.pressureBreakerTrips).toBe(0)
    expect(ledger.compressionLayer.pressure).toBe(1)
    expect(ledger.compressionLayer.boundary).toBe(0)
    expect(ledger.pressureSkips).toBe(0)
    expect(ledger.pressureFoldedTokens).toBe(100)
    expect(ledger.pressureRetainedTokens).toBe(40)
    expect(ledger.pressureEmergencies).toBe(1)
  })

  it('同输入同账（双跑逐字节一致）', () => {
    const facts = [fact({ at: 1, layer: 'boundary', promptVersion: 1, policyVersion: 1, outcome: 'ok' })]
    expect(JSON.stringify(foldCompressCalls(facts))).toBe(JSON.stringify(foldCompressCalls(facts)))
  })
})

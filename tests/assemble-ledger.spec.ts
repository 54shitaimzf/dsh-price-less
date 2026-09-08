/**
 * P17a 压缩族账本单测（docs/07 §0.5 压缩族；docs/implement/P17-boundary-assembler.md §5）。
 * 同输入同账；未实现项显式 0（口径先立不空转）。
 */
import { describe, expect, it } from 'vitest'
import {
  ASSEMBLE_RUN_FACT_TYPE,
  emptyCompressionLedger,
  foldCompressionLedger,
  type AssembleRunFactData,
} from '../src/core/assemble/index.ts'
import type { LedgerFact } from '../src/core/ledger/types.ts'

const fact = (data: Partial<AssembleRunFactData>, seq = 1): LedgerFact => ({
  type: ASSEMBLE_RUN_FACT_TYPE,
  seq,
  time: seq,
  data,
})

describe('P17a 压缩族账本', () => {
  it('空账全 0（未实现项显式 0）', () => {
    const ledger = emptyCompressionLedger()
    expect(ledger.digestBytes).toBe(0)
    expect(ledger.hotTailTokens).toBe(0)
    expect(ledger.archiveTruncate).toEqual({ count: 0, tokens: 0 })
    expect(ledger.compressionCallCount).toBe(0)
    expect(ledger.pressureFireCount).toBe(0)
    expect(ledger.hardTruncateCount).toBe(0)
    expect(ledger.extraSearchCalls).toBe(0)
  })

  it('assemble-run 事实逐项汇总（hotTail* / digest* / layer / 计数）', () => {
    const ledger = foldCompressionLedger([
      fact({ at: 1, layer: 'boundary', digestBytes: 100, digestEntryCount: 3, hotTailTokens: 900, hotTailDeclaredUnits: 4, hotTailStopReason: 'budget', hotTailSource: 'model', hotTailFloorFilled: true, unitCount: 10, dropped: 1, clipped: 0, truncated: 0 }),
      fact({ at: 2, layer: 'pressure', digestBytes: 50, digestEntryCount: 1, hotTailTokens: 0, hotTailDeclaredUnits: 0, hotTailStopReason: 'list-end', hotTailSource: 'positional-fallback', hotTailFloorFilled: false, unitCount: 8, dropped: 2, clipped: 1, truncated: 0 }, 2),
    ])
    expect(ledger.assembleRuns).toBe(2)
    expect(ledger.digestBytes).toBe(150)
    expect(ledger.digestEntryCount).toBe(4)
    expect(ledger.hotTailTokens).toBe(900)
    expect(ledger.hotTailDeclaredUnits).toBe(4)
    expect(ledger.hotTailStopReason).toEqual({ budget: 1, 'list-end': 1 })
    expect(ledger.hotTailSource).toEqual({ model: 1, 'positional-fallback': 1 })
    expect(ledger.hotTailFloorFilled).toBe(1)
    expect(ledger.compressionLayer).toEqual({ boundary: 1, pressure: 1 })
    expect(ledger.assembleDropped).toBe(3)
    expect(ledger.assembleClipped).toBe(1)
    expect(ledger.archiveTruncate).toEqual({ count: 0, tokens: 0 })
  })

  it('坏载荷跳过（不抛错、不污染账目）', () => {
    const ledger = foldCompressionLedger([
      { type: ASSEMBLE_RUN_FACT_TYPE, seq: 1, time: 1, data: undefined },
      { type: ASSEMBLE_RUN_FACT_TYPE, seq: 2, time: 2, data: { digestBytes: 'x', layer: 'nope', hotTailStopReason: 'nope' } },
      { type: 'context-economy/other', seq: 3, time: 3, data: { digestBytes: 999 } },
    ])
    expect(ledger.assembleRuns).toBe(2)
    expect(ledger.digestBytes).toBe(0)
    expect(ledger.compressionLayer).toEqual({ boundary: 0, pressure: 0 })
    expect(ledger.hotTailStopReason).toEqual({ budget: 0, 'list-end': 0 })
  })

  it('archiveTruncate 由事实汇总（P17c：生产者 = P19 档案区；缺省 0 向后兼容）', () => {
    const ledger = foldCompressionLedger([
      fact({ at: 1, layer: 'boundary', archiveTruncateCount: 2, archiveTruncateTokens: 700 }),
      fact({ at: 2, layer: 'boundary' }, 2),
    ])
    expect(ledger.archiveTruncate).toEqual({ count: 2, tokens: 700 })
  })

  it('同输入同账（双跑相等）', () => {
    const facts = [fact({ at: 1, layer: 'boundary', digestBytes: 7 }), fact({ at: 2, layer: 'boundary', digestBytes: 9 }, 2)]
    expect(JSON.stringify(foldCompressionLedger(facts))).toBe(JSON.stringify(foldCompressionLedger(facts)))
  })
})

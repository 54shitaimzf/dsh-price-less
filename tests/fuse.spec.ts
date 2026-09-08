/**
 * P20b 保险丝纯核单测（docs/implement/P20-pressure-and-fuse.md §5；docs/04 §4；docs/07 压缩族 hardTruncateCount）。
 * 地板判定 / 武装谓词 / 事实 fold / 同输入同账。
 */
import { describe, expect, it } from 'vitest'
import {
  FUSE_RATIO,
  HARD_TRUNCATE_FACT_TYPE,
  emptyHardTruncateLedger,
  foldHardTruncates,
  fuseArmed,
  fuseFloorTokens,
} from '../src/core/compress/index.ts'

describe('P20b 保险丝纯核：地板与武装', () => {
  it('地板 = floor(contextWindow × 0.8)；窗口非法/缺失 = undefined（不武装）', () => {
    expect(FUSE_RATIO).toBe(0.8)
    expect(fuseFloorTokens(100000)).toBe(80000)
    expect(fuseFloorTokens(131073)).toBe(104858)
    expect(fuseFloorTokens(undefined)).toBeUndefined()
    expect(fuseFloorTokens(0)).toBeUndefined()
    expect(fuseFloorTokens(Number.NaN)).toBeUndefined()
  })

  it('武装 = wire ≥ 地板；低于地板 = 严格 no-op', () => {
    expect(fuseArmed({ wireTokens: 80000, contextWindow: 100000 })).toBe(true)
    expect(fuseArmed({ wireTokens: 79999, contextWindow: 100000 })).toBe(false)
    expect(fuseArmed({ wireTokens: 999999 })).toBe(false)
    expect(fuseArmed({ wireTokens: Number.NaN, contextWindow: 1 })).toBe(false)
  })

  it('hard-truncate 账本：介入口径 + 细分位；坏载荷跳过', () => {
    const fact = (data: unknown, seq: number) => ({ type: HARD_TRUNCATE_FACT_TYPE, seq, time: seq, data })
    const ledger = foldHardTruncates([
      fact({ at: 1, wireTokens: 90000, floorTokens: 80000, outcome: 'fuse-fold', landed: true }, 1),
      fact({ at: 2, wireTokens: 120000, floorTokens: 0, outcome: 'overflow-retry', landed: true }, 2),
      fact({ at: 3, wireTokens: 120000, floorTokens: 0, outcome: 'overflow-declined', landed: false }, 3),
      fact({ at: 4, wireTokens: 1, floorTokens: 1, outcome: 'unknown' }, 4),
      { type: HARD_TRUNCATE_FACT_TYPE, seq: 5, time: 5, data: null },
    ])
    expect(ledger.hardTruncateCount).toBe(3)
    expect(ledger.fuseArmedFolds).toBe(1)
    expect(ledger.overflowTakeovers).toBe(1)
    expect(emptyHardTruncateLedger().hardTruncateCount).toBe(0)
  })

  it('同输入同账（双跑逐字节一致）', () => {
    const facts = [{ type: HARD_TRUNCATE_FACT_TYPE, seq: 1, time: 1, data: { at: 1, wireTokens: 1, floorTokens: 1, outcome: 'fuse-fold' } }]
    expect(JSON.stringify(foldHardTruncates(facts))).toBe(JSON.stringify(foldHardTruncates(facts)))
  })
})

/**
 * 保险丝纯核（docs/04 §4 层 4：地板 = contextWindow × 0.8 / 低于地板完全 no-op /
 * hard-truncate 事件与计数器；docs/07 §0.5 压缩族 hardTruncateCount；P20b）。
 * 纯函数：地板判定 + 事实载荷 + fold。低于地板 = 零行为（不调用、不改史、不写事实）。
 *
 * 模块: core 压缩调用纯核（保险丝）
 * 平面: L0（确定性判定/重放；零模型、零 IO）
 * 回退链步数: 1（窗口缺失 = 不武装；no-op 是设计语义而非降级）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D13）；不读盘、不写事实、不改史。
 * 度量: hardTruncateCount（07 压缩族）由 hard-truncate 事实 fold。
 */
import type { LedgerFact } from '../ledger/types.ts'

/** 保险丝地板比例（04 §4 默认 0.8 × 模型真实窗口；裸窗口只喂保险丝，永不作压缩触发）。 */
export const FUSE_RATIO = 0.8

/** 保险丝事实（ignorable log-only；声明合并随 domains/compaction-facts.ts）。 */
export const HARD_TRUNCATE_FACT_TYPE = 'context-economy/hard-truncate' // ignorable

/** 地板 = floor(contextWindow × FUSE_RATIO)；窗口非法/缺失 = undefined（不武装）。 */
export function fuseFloorTokens(contextWindow?: number): number | undefined {
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined
  return Math.floor(contextWindow * FUSE_RATIO)
}

/** 是否武装（wire 锚定计量 ≥ 地板；低于地板 = 严格 no-op）。 */
export function fuseArmed(input: { wireTokens: number; contextWindow?: number }): boolean {
  if (!Number.isFinite(input.wireTokens) || input.wireTokens <= 0) return false
  const floor = fuseFloorTokens(input.contextWindow)
  return floor !== undefined && input.wireTokens >= floor
}

/** 保险丝介入事实：地板以上紧急折叠 / 溢出接管 / 接管未成（失败方向 = 原错误交上游）。 */
export interface HardTruncateFactData {
  readonly at: number
  readonly wireTokens: number
  readonly floorTokens: number
  readonly contextWindow?: number
  readonly outcome: 'fuse-fold' | 'overflow-retry' | 'overflow-declined'
  /** 紧急折叠是否落刀（overflow-declined = false）。 */
  readonly landed?: boolean
}

export interface HardTruncateLedger {
  /** 07 字段：保险丝介入次数（地板折叠 + 溢出接管，含未落刀）。 */
  hardTruncateCount: number
  /** 自持观测位：地板以上自动折叠次数。 */
  fuseArmedFolds: number
  /** 自持观测位：溢出接管返回 retry 次数。 */
  overflowTakeovers: number
}

export function emptyHardTruncateLedger(): HardTruncateLedger {
  return { hardTruncateCount: 0, fuseArmedFolds: 0, overflowTakeovers: 0 }
}

function numberField(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** hard-truncate 账本（事实序回放；坏载荷跳过，绝不抛错）。 */
export function foldHardTruncates(facts: readonly LedgerFact[]): HardTruncateLedger {
  const ledger = emptyHardTruncateLedger()
  for (const fact of facts) {
    if (fact.type !== HARD_TRUNCATE_FACT_TYPE) continue
    const raw = fact.data
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const data = raw as Record<string, unknown>
    if (data.outcome !== 'fuse-fold' && data.outcome !== 'overflow-retry' && data.outcome !== 'overflow-declined') continue
    ledger.hardTruncateCount++
    if (data.outcome === 'fuse-fold') ledger.fuseArmedFolds++
    if (data.outcome === 'overflow-retry') ledger.overflowTakeovers++
    // numberField 仅用于保持坏载荷容错（字段值本身不参与计数）。
    numberField(data.wireTokens)
  }
  return ledger
}

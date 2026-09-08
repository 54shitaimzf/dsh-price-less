/**
 * 压缩调用账本 fold（docs/07 §0.5 压缩族；docs/04 §6/§7；P18 度量先行）。
 * 纯函数：同输入同账；输入 = `context-economy/compress-run` 事实（生产者 = P19/P20a）。
 * P17 N5 显式留 0 的 `compressionCallCount`/`compressionCacheHitRate` 在此打通——
 * P18 只立口径（零调用零接线）；P19 起生产者为边界路径（`domains/compaction.ts`，内容寻址复用键 = `compress/store.ts`）。
 *
 * 模块: core 压缩调用纯核（调用账本）
 * 平面: L0（确定性重放；无模型、无 IO）
 * 回退链步数: 0（坏载荷跳过，绝不抛错）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D13）；不写事实、不改史、不读盘。
 * 度量: 本文件即压缩族调用口径（07 回放管道消费面）。
 */
import type { LedgerFact } from '../ledger/types.ts'
import type { CompressMode, CompressOutcome } from './types.ts'

/** 压缩调用事实（ignorable log-only；声明合并随生产者 P19 落 domains/compaction-facts.ts）。 */
export const COMPRESS_RUN_FACT_TYPE = 'context-economy/compress-run' // ignorable

/** 压缩调用 usage 回执（与 platform/llm.ts CeLlmUsage 结构同构；本层只承载）。 */
export interface CompressLlmUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

export interface CompressRunFactData {
  readonly at: number
  readonly layer: CompressMode
  readonly promptVersion: number
  readonly policyVersion: number
  /** 内容寻址复用命中（04 §6）：true = 零调用回放。 */
  readonly cacheHit?: boolean
  /** 实际发起的辅助调用数；缺省 = cacheHit/skipped ? 0 : 1。 */
  readonly calls?: number
  readonly regionTokens?: number
  readonly promptTokens?: number
  readonly productBytes?: number
  readonly outcome?: CompressOutcome
  readonly droppedHotTail?: number
  readonly llmUsage?: CompressLlmUsage
  // —— P19 边界路径归因（压力路径 P20a 复用同字段） ——
  /** 会话级 taskId（`sessionScopedTaskId`；一次尝试一条事实，重放可判"已归档"）。 */
  readonly taskId?: string
  /** 未落刀/降级原因（skipped 细分：llm-unavailable / parse / schema / shrink / storage / range / no-units）。 */
  readonly reason?: string
  /** 被压区间体量（缩水校验分母）。 */
  readonly shadowedTokens?: number
  /** 产物（替换文本）体量（缩水校验分子）。 */
  readonly productTokens?: number
  /** 缩水校验重试次数（边界档 ≤1）。 */
  readonly retry?: number
  /** 续传链条数（机制 A）。 */
  readonly carried?: number
  /** 档案区条目数（落盘后）。 */
  readonly archiveEntries?: number
  /** 档案区硬帽截断（04 §6）。 */
  readonly archiveTruncateCount?: number
  readonly archiveTruncateTokens?: number
  /** T-boundary 搭车折叠的老调用对数（会计）。 */
  readonly shearFolded?: number
  /** 卷宗清空（结构性：新 task 新卷宗；本字段仅审计）。 */
  readonly dossierRetired?: boolean
}

export interface CompressCallLedger {
  /** 07 字段：实际调用次数（复用/短路不计）。 */
  compressionCallCount: number
  /** 07 字段：内容寻址复用命中率（invocations 为分母；空账 = 0）。 */
  compressionCacheHitRate: number
  /** 调用事实条数（自持观测位；分母）。 */
  invocations: number
  cacheHits: number
  /** 压缩调用 usage 自持位（07 缺压缩 usage 字段，见工单 N7）。 */
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  parseFailures: number
  schemaFailures: number
  /** P19 自持观测位（不属 07 字段；同 `assembleRuns` 先例，07 缺压缩族细分字段）。 */
  skips: number
  retries: number
  shrinkRejects: number
  storageFailures: number
  archiveAppends: number
  shearBoundaryFolded: number
  retiredDossiers: number
}

export function emptyCompressCallLedger(): CompressCallLedger {
  return {
    compressionCallCount: 0,
    compressionCacheHitRate: 0,
    invocations: 0,
    cacheHits: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    parseFailures: 0,
    schemaFailures: 0,
    skips: 0,
    retries: 0,
    shrinkRejects: 0,
    storageFailures: 0,
    archiveAppends: 0,
    shearBoundaryFolded: 0,
    retiredDossiers: 0,
  }
}

function numberField(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 压缩调用账本（事实序回放；坏载荷跳过）。 */
export function foldCompressCalls(facts: readonly LedgerFact[]): CompressCallLedger {
  const ledger = emptyCompressCallLedger()
  for (const fact of facts) {
    if (fact.type !== COMPRESS_RUN_FACT_TYPE) continue
    const raw = fact.data
    // 坏载荷跳过（data 非对象 / null / 数组），绝不抛错。
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const data = raw as Record<string, unknown>
    ledger.invocations++
    const cacheHit = data.cacheHit === true
    if (cacheHit) ledger.cacheHits++
    const skipped = data.outcome === 'skipped'
    const calls = data.calls === undefined ? (cacheHit || skipped ? 0 : 1) : numberField(data.calls)
    ledger.compressionCallCount += calls
    const usage = (typeof data.llmUsage === 'object' && data.llmUsage !== null ? data.llmUsage : {}) as Record<string, unknown>
    ledger.usage.inputTokens += numberField(usage.inputTokens)
    ledger.usage.outputTokens += numberField(usage.outputTokens)
    ledger.usage.cacheReadTokens += numberField(usage.cacheReadTokens)
    ledger.usage.cacheWriteTokens += numberField(usage.cacheWriteTokens)
    if (data.outcome === 'parse') ledger.parseFailures++
    if (data.outcome === 'schema') ledger.schemaFailures++
    if (data.outcome === 'skipped') ledger.skips++
    ledger.retries += numberField(data.retry)
    if (data.reason === 'shrink') ledger.shrinkRejects++
    if (data.reason === 'storage') ledger.storageFailures++
    if (numberField(data.archiveEntries) > 0) ledger.archiveAppends++
    ledger.shearBoundaryFolded += numberField(data.shearFolded)
    if (data.dossierRetired === true) ledger.retiredDossiers++
  }
  ledger.compressionCacheHitRate = ledger.invocations === 0 ? 0 : ledger.cacheHits / ledger.invocations
  return ledger
}

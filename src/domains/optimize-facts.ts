/**
 * optimize-run 两相事实载荷与声明合并（P14b1；docs/02 §7 / docs/07 §0.5 / docs/12 §2 编译闸）。
 * 同一事件类型两相：preview（断面跑完即发，含 LLM 成本）/ applied（用户确认后发）。
 * 只做可序列化载荷与 fold；不发射事实、不 import 运行期 harness。
 */
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import { foldOptimizeLedger, type OptimizeLedger, type OptimizeLlmUsage, type OptimizeRecord } from '../core/optimize.ts'

declare module '@deepseek-ai/dsh-session/types' {
  // ignorable: optimize-run 为 log-only 事实（两相共用同一事件类型），须同步并入 IgnorableSessionEventMap。
  interface SessionEventMap {
    'context-economy/optimize-run': OptimizeRunFactData // ignorable
  }
  interface IgnorableSessionEventMap {
    'context-economy/optimize-run': OptimizeRunFactData // ignorable
  }
}

// ignorable：optimize-run 事实常量（经 emitCeFact 发射，路由见 docs/12 §2）。
export const OPTIMIZE_RUN_FACT_TYPE = 'context-economy/optimize-run'

export interface OptimizeRunFactData {
  phase: 'preview' | 'applied'
  previewId: string
  taskId: string
  sessionId: string
  at: number
  // preview 相（含失败相：errorCode 非空时其余字段为已观测部分）
  /** P14c 语义修订：true = 本次组装无历史素材（historyCount === 0）。 */
  short?: boolean
  /** 本次组装用到的 task 内用户消息条数（P14c）。 */
  historyCount?: number
  ctxTokens?: number
  productChars?: number
  verdictCount?: number
  droppedLines?: number
  keptSpanCount?: number
  missingAuthorityCount?: number
  /** P14d：产品开头被机械剥离的元注释行数（prompt v2 效果读数）。 */
  metaStrippedLines?: number
  /** P14d：★ 断面请求的推理档（adapter 词汇，如 off）与实发档（模型不支持时省略）。 */
  requestedEffort?: string
  sentEffort?: string
  shearPairs?: number
  shearTokens?: number
  latencyMs?: number
  llmUsage?: OptimizeLlmUsage
  errorCode?: string
  // applied 相
  backfillCount?: number
  backfillConflicts?: number
}

export type OptimizeRunBase = { previewId: string; taskId: string; sessionId: string; at: number }
export type OptimizeRunFields = Omit<OptimizeRunFactData, 'phase' | keyof OptimizeRunBase>

/** 去掉 undefined 键（事实事件载荷不落空键；JSONL 可回放、逐字确定）。 */
function compact(value: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = item
  return out
}

export function previewRunFact(base: OptimizeRunBase, fields: OptimizeRunFields): OptimizeRunFactData {
  return compact({ phase: 'preview', ...base, ...fields }) as unknown as OptimizeRunFactData
}

export function appliedRunFact(base: OptimizeRunBase, fields: OptimizeRunFields): OptimizeRunFactData {
  return compact({ phase: 'applied', ...base, ...fields }) as unknown as OptimizeRunFactData
}

/**
 * 两相按 previewId 归并 → 一次断面恰一条 OptimizeRecord（docs/07 §0.5 断面族）：
 * optimizeCount = distinct previewId（含未确认）；tokens/体积取自 preview 相；
 * backfill/shear 取自 applied 相（无 applied 记 0）——无重复计数。
 */
export function foldOptimizeRunFacts(facts: readonly OptimizeRunFactData[]): OptimizeLedger {
  const byId = new Map<string, { preview?: OptimizeRunFactData; applied?: OptimizeRunFactData }>()
  for (const fact of facts) {
    let entry = byId.get(fact.previewId)
    if (entry === undefined) byId.set(fact.previewId, (entry = {}))
    if (fact.phase === 'preview') { if (entry.preview === undefined) entry.preview = fact }
    else if (entry.applied === undefined) entry.applied = fact
  }
  const records: OptimizeRecord[] = []
  for (const entry of byId.values()) {
    const preview = entry.preview
    const applied = entry.applied
    const record: OptimizeRecord = {
      time: preview?.at ?? applied?.at ?? 0,
      short: preview?.short ?? false,
      ctxTokens: preview?.ctxTokens ?? 0,
      backfillCount: applied?.backfillCount ?? 0,
      backfillConflicts: applied?.backfillConflicts ?? 0,
      shearPairs: applied?.shearPairs ?? 0,
      shearTokens: applied?.shearTokens ?? 0,
      metaStrippedLines: preview?.metaStrippedLines ?? 0,
    }
    if (preview?.llmUsage !== undefined) record.llmUsage = preview.llmUsage
    records.push(record)
  }
  return foldOptimizeLedger(records)
}

/**
 * 事实源抽象（docs/12 §2–§3；docs/07 §5）：会话 ignorable 事件与 KV 镜像共用同一
 * LedgerFact 交换格式。本模块只做抽取/等价/计数，不感知通道来源。
 */
import type { LedgerFact, LedgerSessionEvent } from './types.ts'

/** 自定义会话事实命名空间前缀（ignorable 事件；S3 同源纪律仅在 facts.ts 收口）。 */
export const FACT_TYPE_PREFIX = 'context-economy/'

/** task 闭口计数事实名（ignorable 闭口事实；决策点②；P8 后只换来源）。 */
export const TASK_BOUNDARY_FACT_TYPE = 'context-economy/task-boundary'

/** 从会话事件中抽取自定义事实命名空间行；保事件序、保原 data 引用。 */
export function factsFromSessionEvents(events: LedgerSessionEvent[]): LedgerFact[] {
  const facts: LedgerFact[] = []
  for (const event of events) {
    if (event.type.startsWith(FACT_TYPE_PREFIX)) {
      facts.push({ type: event.type, seq: event.seq, time: event.time, data: event.data })
    }
  }
  return facts
}

/** 排序后逐字段 JSON 比较：会话源 ↔ 镜像源等价断言（docs/12 §3）。 */
export function assertFactSourcesEquivalent(a: LedgerFact[], b: LedgerFact[]): boolean {
  const normalize = (facts: LedgerFact[]): string =>
    JSON.stringify(
      facts
        .map((f) => ({ type: f.type, seq: f.seq ?? null, time: f.time, data: f.data }))
        .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
    )
  return normalize(a) === normalize(b)
}

/** 去掉 undefined 键（事实事件载荷不落空键；JSONL 可回放、逐字确定）。 */
export function compactFact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = item
  return out as T
}

/** 按类型计数（闭口计数用；不做语义解析）。 */
export function countFactsOfType(facts: LedgerFact[], type: string): number {
  let count = 0
  for (const fact of facts) if (fact.type === type) count++
  return count
}

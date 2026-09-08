/**
 * R2 段末账本快照回放（docs/ledger-history.md §32；docs/07 §0.5/§5）。
 * 纯回放管道：会话事实（fixture）→ factsFromSessionEvents → 判别族/断面族 fold；
 * 同输入同账（三跑逐字节相等）——不依赖实验批、不依赖真机。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { factsFromSessionEvents } from '../src/core/ledger/facts.ts'
import type { LedgerSessionEvent } from '../src/core/ledger/types.ts'
import { FAIL_LAZY_JUDGE_DECISION, foldJudgeLedger, type JudgeRecord } from '../src/core/judge.ts'
import {
  JUDGE_ERROR_FACT_TYPE, JUDGE_RECORDED_FACT_TYPE, factDataToJudgeRecord,
  type JudgeErrorFactData, type JudgeRecordedFactData,
} from '../src/domains/judge-facts.ts'
import { OPTIMIZE_RUN_FACT_TYPE, foldOptimizeRunFacts, type OptimizeRunFactData } from '../src/domains/optimize-facts.ts'

const EVENTS = JSON.parse(readFileSync(new URL('./fixtures/r2/session-events.json', import.meta.url), 'utf8')) as LedgerSessionEvent[]

/** 回放管道（与 src/domains/input.ts 运行期同口径：错误事实 → fail-lazy 记录）。 */
function replay(events: LedgerSessionEvent[]) {
  const facts = factsFromSessionEvents(events)
  const records: JudgeRecord[] = facts
    .filter((fact) => fact.type === JUDGE_RECORDED_FACT_TYPE)
    .map((fact) => factDataToJudgeRecord(fact.data as JudgeRecordedFactData))
  for (const fact of facts) {
    if (fact.type !== JUDGE_ERROR_FACT_TYPE) continue
    const data = fact.data as JudgeErrorFactData
    records.push({ seq: data.seq, time: data.time, trigger: 'error-fallback', decision: FAIL_LAZY_JUDGE_DECISION, error: { code: data.code, message: data.message } })
  }
  const optimizeFacts = facts
    .filter((fact) => fact.type === OPTIMIZE_RUN_FACT_TYPE)
    .map((fact) => fact.data as OptimizeRunFactData)
  return { judge: foldJudgeLedger(records), optimize: foldOptimizeRunFacts(optimizeFacts) }
}

describe('R2 ledger replay (§32)', () => {
  it('判别族：trigger 分布 / 命中率 / 错误率 / usage / 裁决分布', () => {
    const { judge } = replay(EVENTS)
    expect(judge).toEqual({
      judgeCount: 5,
      judgeErrorRate: 0.2,
      judgeCacheHitRate: 0.2,
      judgeLatencyMs: 200.75,
      l0CaptureRate: 0.2,
      tableHitRate: 0.5,
      tableShadowHitCount: 0,
      tableShadowMissedBoundaryCount: 0,
      judgeLLMUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      judgeCtxTokens: 560,
      judgeVerdictDist: { action: 2, pureQ: 1, verifyQ: 1 },
    })
  })

  it('断面族：两相归并（preview×2，其一无 applied）', () => {
    const { optimize } = replay(EVENTS)
    expect(optimize).toEqual({
      optimizeCount: 2,
      optimizePromptTokens: { inputTokens: 250, outputTokens: 90, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      verdictBackfill: { count: 2, conflicts: 1 },
      shearAtStar: { pairs: 1, tokens: 30 },
      metaStrippedLines: 0,
    })
  })

  it('确定性：同输入三跑逐字节相等（回放管道口径）', () => {
    const runs = [1, 2, 3].map(() => JSON.stringify(replay(EVENTS)))
    expect(runs[0]).toBe(runs[1])
    expect(runs[1]).toBe(runs[2])
  })
})

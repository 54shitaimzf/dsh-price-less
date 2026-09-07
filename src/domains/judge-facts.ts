/**
 * 判别事实载荷与声明合并（P12；docs/10 §1 H14 / docs/12 §2 编译闸）。
 * 只做可序列化载荷搬运与逆映射；不发射事实、不 import 运行期 harness。
 */
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { JudgeDecision, JudgeErrorInfo, JudgeLlmUsage, JudgeRecord } from '../core/judge.ts'
import type { JudgeVerdictFactData } from '../core/units.ts'
import { JUDGE_VERDICT_FACT_TYPE } from '../core/units.ts'

declare module '@deepseek-ai/dsh-session/types' {
  // 以下三事件均为 ignorable 事实，须同步并入 IgnorableSessionEventMap（append 侧编译闸）。
  interface SessionEventMap { // ignorable: 载荷声明侧
    'context-economy/judge-recorded': JudgeRecordedFactData // ignorable
    'context-economy/judge-error': JudgeErrorFactData // ignorable
    'context-economy/judge-verdict': JudgeVerdictFactData // ignorable
  }
  interface IgnorableSessionEventMap { // ignorable: append 编译闸侧
    'context-economy/judge-recorded': JudgeRecordedFactData // ignorable
    'context-economy/judge-error': JudgeErrorFactData // ignorable
    'context-economy/judge-verdict': JudgeVerdictFactData // ignorable
  }
}

export interface JudgeRecordedFactData {
  seq: number
  time: number
  trigger: JudgeRecord['trigger']
  decision: JudgeDecision
  class?: JudgeRecord['class']
  latencyMs?: number
  ctxTokens?: number
  llmUsage?: JudgeLlmUsage
}

export interface JudgeErrorFactData {
  seq: number
  time: number
  code: string
  message: string
}

export function judgeRecordToFactData(record: JudgeRecord): JudgeRecordedFactData {
  const data: JudgeRecordedFactData = {
    seq: record.seq,
    time: record.time,
    trigger: record.trigger,
    decision: record.decision,
  }
  if (record.class !== undefined) data.class = record.class
  if (record.latencyMs !== undefined) data.latencyMs = record.latencyMs
  if (record.ctxTokens !== undefined) data.ctxTokens = record.ctxTokens
  if (record.llmUsage !== undefined) data.llmUsage = record.llmUsage
  return data
}

export function factDataToJudgeRecord(data: JudgeRecordedFactData): JudgeRecord {
  const record: JudgeRecord = {
    seq: data.seq,
    time: data.time,
    trigger: data.trigger,
    decision: data.decision,
  }
  if (data.class !== undefined) record.class = data.class
  if (data.latencyMs !== undefined) record.latencyMs = data.latencyMs
  if (data.ctxTokens !== undefined) record.ctxTokens = data.ctxTokens
  if (data.llmUsage !== undefined) record.llmUsage = data.llmUsage
  return record
}

// ignorable 事实常量：经 emitCeFact 发射，路由见 docs/12 §2。
export const JUDGE_RECORDED_FACT_TYPE = 'context-economy/judge-recorded'
// ignorable：judge-error 常量。
export const JUDGE_ERROR_FACT_TYPE = 'context-economy/judge-error'
export { JUDGE_VERDICT_FACT_TYPE }

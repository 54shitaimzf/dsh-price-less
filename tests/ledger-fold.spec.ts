/**
 * P2 度量底座测试（docs/implement/archive/P2-ledger-base.md §3.5）：
 * 通用族 fold、facts 源等价、缺价 null、确定性、报表模板。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertFactSourcesEquivalent,
  countFactsOfType,
  estimateTokens,
  extractTextFromToolResult,
  factsFromSessionEvents,
  foldCommon,
  formatLedgerReport,
  TASK_BOUNDARY_FACT_TYPE,
} from '../src/core/ledger/index.ts'
import type { CommonLedger, LedgerFact, LedgerSessionEvent } from '../src/core/ledger/index.ts'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures/ledger', name), 'utf8')
const events = JSON.parse(fixture('session-events.json')) as LedgerSessionEvent[]
const expected = JSON.parse(fixture('session-events.expected.json')) as CommonLedger
const mirrorFacts = JSON.parse(fixture('mirror-facts.json')) as LedgerFact[]
const pricing = JSON.parse(fixture('pricing.json'))

describe('estimateTokens', () => {
  it('ceil(chars/1.5) 固定校准，支持注入 charsPerToken', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('ab')).toBe(2)
    expect(estimateTokens('abc')).toBe(2)
    expect(estimateTokens('abcd', 4)).toBe(1)
  })
})

describe('extractTextFromToolResult', () => {
  it('harness ToolResultMessage 形状取 text blocks', () => {
    const data = { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] }] } }
    expect(extractTextFromToolResult(data)).toBe('hello world')
  })
  it('空/坏形状不抛并返回空串', () => {
    expect(extractTextFromToolResult(null)).toBe('')
    expect(extractTextFromToolResult({})).toBe('')
    expect(extractTextFromToolResult({ message: { content: [{ type: 'tool-result', content: [] }] } })).toBe('')
  })
})

describe('foldCommon fixture 回放', () => {
  it('与手算冻结期望逐字段相等', () => {
    const sessionFacts = factsFromSessionEvents(events)
    expect(foldCommon(events, { facts: sessionFacts, pricing, successfulTaskCount: 2 })).toEqual(expected)
  })
  it('同输入同账：连续 3 次输出逐字节一致', () => {
    const a = JSON.stringify(foldCommon(events, { facts: factsFromSessionEvents(events), pricing, successfulTaskCount: 2 }))
    const b = JSON.stringify(foldCommon(events, { facts: factsFromSessionEvents(events), pricing, successfulTaskCount: 2 }))
    const c = JSON.stringify(foldCommon(events, { facts: factsFromSessionEvents(events), pricing, successfulTaskCount: 2 }))
    expect(a).toBe(b)
    expect(b).toBe(c)
  })
  it('facts 源抽象等价：会话源 ↔ 镜像源', () => {
    const sessionFacts = factsFromSessionEvents(events)
    expect(assertFactSourcesEquivalent(sessionFacts, mirrorFacts)).toBe(true)
    const fromSession = foldCommon(events, { facts: sessionFacts, pricing, successfulTaskCount: 2 })
    const fromMirror = foldCommon(events, { facts: mirrorFacts, pricing, successfulTaskCount: 2 })
    expect(JSON.stringify(fromSession)).toBe(JSON.stringify(fromMirror))
    expect(countFactsOfType(mirrorFacts, TASK_BOUNDARY_FACT_TYPE)).toBe(1)
  })
  it('缺价记 null：无 pricing → cost/costPerSuccessfulTask null；无成功数 → costPerSuccessfulTask null', () => {
    const noPrice = foldCommon(events, { facts: mirrorFacts, successfulTaskCount: 2 })
    expect(noPrice.cost).toBeNull()
    expect(noPrice.costPerSuccessfulTask).toBeNull()
    const noSuccess = foldCommon(events, { facts: mirrorFacts, pricing })
    expect(noSuccess.cost).not.toBeNull()
    expect(noSuccess.costPerSuccessfulTask).toBeNull()
  })
  it('formatLedgerReport 包含通用与成本两段且数字一致', () => {
    const ledger = foldCommon(events, { facts: factsFromSessionEvents(events), pricing, successfulTaskCount: 2 })
    const report = formatLedgerReport(ledger, { id: 'p2' })
    expect(report).toContain('通用：')
    expect(report).toContain('成本：')
    expect(report).toContain(`roundsPerTask: 1`)
    expect(report).toContain(`totalCost: 423.65`)
    expect(report).toContain(`costPerSuccessfulTask: 211.825`)
  })
})

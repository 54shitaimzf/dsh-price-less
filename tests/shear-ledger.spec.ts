/**
 * P15b 剪切族账本 fold 单测（docs/07 §0.5 剪切族；工单 §5）——纯 fixture 回放。
 * 覆盖：事实聚合（cut* / tableRepair / toolPruneByClass）、裁决分布重算（shearDecision）、
 * 误伤信号（rereadAfterRepair / rerunAfterCut）、表面尾部计价、确定性双跑、空输入全 0。
 */
import { describe, expect, it } from 'vitest'
import {
  RUN_CLASS_FACT_TYPE,
  SHEAR_APPLIED_FACT_TYPE,
  SHEAR_DECISION_FACT_TYPE,
  SHEAR_RUN_PLAN_FACT_TYPE,
  foldShearLedger,
  foldSurfaceNodes,
  formatShearLedger,
  surfaceTailTokens,
  type ShearAppliedFactData,
} from '../src/core/shear/index.ts'
import type { LedgerFact, LedgerSessionEvent } from '../src/core/ledger/index.ts'

const envelope = ['1: const a = 1', '2: export const x = 2', '3: const b = 3', '4: export const y = 4', '5: const c = 5'].join('\n')
const longLog = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')

const events: LedgerSessionEvent[] = [
  { type: 'user/message', seq: 1, time: 1, surfaceOp: 'append', data: { content: [{ type: 'text', text: '改一下 index' }] } },
  { type: 'tool/call', seq: 2, time: 2, data: { callId: 'r1', name: 'read', arguments: JSON.stringify({ file_path: 'src/index.ts' }) } },
  { type: 'tool/result', seq: 3, time: 3, surfaceOp: 'append', data: { message: { content: [{ toolCallId: 'r1', content: [{ type: 'text', text: envelope }] }] } } },
  { type: 'assistant/message', seq: 4, time: 4, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: '看到了 barrel' }] } } },
  { type: 'tool/call', seq: 5, time: 5, data: { callId: 'e1', name: 'edit', arguments: JSON.stringify({ file_path: 'src/index.ts', old_string: 'export const x = 2', new_string: 'export const x = 9' }) } },
  { type: 'tool/result', seq: 6, time: 6, surfaceOp: 'append', data: { message: { content: [{ toolCallId: 'e1', content: [{ type: 'text', text: 'ok' }] }] } } },
  { type: 'assistant/message', seq: 7, time: 7, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: '已改' }] } } },
  { type: 'tool/call', seq: 8, time: 8, data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) } },
  { type: 'tool/result', seq: 9, time: 9, surfaceOp: 'append', data: { message: { content: [{ toolCallId: 'c1', content: [{ type: 'text', text: longLog }] }] } } },
  { type: 'assistant/message', seq: 10, time: 10, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: '全绿' }] } } },
  { type: 'tool/call', seq: 11, time: 11, data: { callId: 'c2', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) } },
  { type: 'tool/call', seq: 12, time: 12, data: { callId: 'r2', name: 'read', arguments: JSON.stringify({ file_path: 'src/index.ts' }) } },
]

const applied: ShearAppliedFactData[] = [
  { policyVersion: 1, tier: 'T-entry', kind: 'shape-entry', callId: 'c0', resultSeq: 2, at: 20, category: 'cmd', beforeTokens: 200, afterTokens: 100, savedTokens: 100, breakTokens: 0, tailNodes: 0 },
  { policyVersion: 1, tier: 'T-loop', kind: 'stub-replace', callId: 'c1', resultSeq: 9, at: 21, category: 'cmd', beforeTokens: 5100, afterTokens: 100, savedTokens: 5000, breakTokens: 300, tailNodes: 3 },
  { policyVersion: 1, tier: 'T0-R', kind: 't0r-repair', callId: 'r1', resultSeq: 3, at: 22, path: 'src/index.ts', version: 1, category: 'read', beforeTokens: 60, afterTokens: 50, savedTokens: 10, breakTokens: 40, tailNodes: 9, segments: 2, windowLines: 5, repairCoverage: 0.4 },
]
const facts: LedgerFact[] = [
  ...applied.map((data) => ({ type: SHEAR_APPLIED_FACT_TYPE, seq: data.resultSeq, time: data.at, data })),
  { type: SHEAR_DECISION_FACT_TYPE, time: 23, data: { policyVersion: 1, tier: 'T-note', decision: 'note-attached', reason: 'note-eligible', callId: 'c1', at: 23, noteBytes: 120 } },
  { type: SHEAR_DECISION_FACT_TYPE, time: 24, data: { policyVersion: 1, tier: 'T-note', decision: 'hold', reason: 'note-hold', callId: 'c9', at: 24 } },
]

describe('foldShearLedger（剪切族账本）', () => {
  it('事实聚合：cutEvents / cutTokensSaved / cutBreakCost / toolPruneByClass', () => {
    const ledger = foldShearLedger(events, facts)
    expect(ledger.cutEvents).toEqual({ question: 0, tool: 3 })
    expect(ledger.cutTokensSaved).toBe(100 + 5000 + 10)
    expect(ledger.cutBreakCost).toBe(0 + 300 + 40)
    expect(ledger.toolPruneByClass.cmd).toBe(2)
    expect(ledger.toolPruneByClass.read).toBe(1)
    expect(ledger.shearNoteAttached).toBe(1)
  })

  it('tableRepair / repairCoverage 取自 t0r 事实', () => {
    const ledger = foldShearLedger(events, facts)
    expect(ledger.tableRepair).toEqual({ count: 1, tokens: 10 })
    expect(ledger.repairCoverage).toBeCloseTo(2 / 5)
  })

  it('误伤信号重算：修复后重读同路径 + 剪后重跑同名同参', () => {
    const ledger = foldShearLedger(events, facts)
    expect(ledger.rereadAfterRepair).toBe(1)
    expect(ledger.rerunAfterCut).toBe(1)
  })

  it('裁决分布来自重跑 foldToolShear（cut+hold+keep = 裁决条数，cut ≥ 1）', () => {
    const ledger = foldShearLedger(events, facts)
    const total = ledger.shearDecision.cut + ledger.shearDecision.hold + ledger.shearDecision.keep
    expect(total).toBeGreaterThanOrEqual(2)
    expect(ledger.shearDecision.cut).toBeGreaterThanOrEqual(1)
  })

  it('P16 面字段在位且为 0', () => {
    const ledger = foldShearLedger(events, facts)
    expect(ledger.cutMisfireDetected).toBe(0)
    expect(ledger.questionBacklogDepth).toBe(0)
    expect(ledger.thinkingCutTokens).toBe(0)
  })

  it('确定性双跑逐字节一致 + 输入不被 mutate', () => {
    const snapshot = JSON.stringify({ events, facts })
    const a = JSON.stringify(foldShearLedger(events, facts))
    const b = JSON.stringify(foldShearLedger(events, facts))
    expect(a).toBe(b)
    expect(JSON.stringify({ events, facts })).toBe(snapshot)
  })

  it('空输入全 0 + 报表段可渲染', () => {
    const ledger = foldShearLedger([], [])
    expect(ledger.cutEvents).toEqual({ question: 0, tool: 0 })
    expect(ledger.cutTokensSaved).toBe(0)
    expect(ledger.shearDecision).toEqual({ cut: 0, hold: 0, keep: 0 })
    expect(formatShearLedger(ledger)).toContain('剪切：')
  })
})

describe('表面 fold 与尾部计价', () => {
  it('foldSurfaceNodes：append 入尾 / replace 遮蔽区间换节点', () => {
    const seqs = foldSurfaceNodes([
      { type: 'user/message', seq: 1, time: 1, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 2, time: 2, surfaceOp: 'append' },
      { type: 'tool/result', seq: 3, time: 3, surfaceOp: 'append' },
      { type: 'tool/result', seq: 4, time: 4, surfaceOp: { op: 'replace', start: 3, end: 3 } },
    ])
    expect(seqs).toEqual([1, 2, 4])
  })

  it('surfaceTailTokens：剪点之后存活节点 token；节点不在表面 → 0', () => {
    const tail = surfaceTailTokens(events, 3)
    expect(tail).toBeGreaterThan(0)
    expect(surfaceTailTokens(events, 999)).toBe(0)
  })
})

// —— P16 对话半边：cutEvents{question} / questionBacklogDepth / cutMisfireDetected / thinkingCutTokens ——
const runEvents: LedgerSessionEvent[] = [
  { type: 'user/message', seq: 1, time: 1, surfaceOp: 'append', data: { content: [{ type: 'text', text: '为什么要用 src/core/shear/run.ts？' }] } },
  { type: 'assistant/message', seq: 2, time: 2, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: '因为它纯核。' }] } } },
  { type: 'user/message', seq: 3, time: 3, surfaceOp: 'append', data: { content: [{ type: 'text', text: '动手' }] } },
  { type: 'user/message', seq: 7, time: 7, surfaceOp: 'append', data: { content: [{ type: 'text', text: '再讲一遍 src/core/shear/run.ts 的边界' }] } },
]
const classFacts: LedgerFact[] = [
  { type: RUN_CLASS_FACT_TYPE, seq: 4, time: 4, data: { seq: 1, decision: 'continue', class: 'pureQ' } },
  { type: RUN_CLASS_FACT_TYPE, seq: 5, time: 5, data: { seq: 3, decision: 'continue', class: 'action' } },
]
const runFlushFact: LedgerFact = {
  type: SHEAR_APPLIED_FACT_TYPE, seq: 6, time: 6,
  data: {
    policyVersion: 1, tier: 'run', kind: 'run-flush', callId: '', resultSeq: 2, at: 6, category: 'other',
    beforeTokens: 100, afterTokens: 30, savedTokens: 70, breakTokens: 5, tailNodes: 1,
    startSeq: 1, endSeq: 2, runPairs: 1, runClass: 'pureQ', conclusionTier: 'mechanical-quote',
  } satisfies ShearAppliedFactData,
}

describe('foldShearLedger · P16 对话半边', () => {
  it('run 落刀事实 → cutEvents.question / cutTokensSaved / cutBreakCost / shearDecision', () => {
    const ledger = foldShearLedger(runEvents, [...classFacts, runFlushFact])
    expect(ledger.cutEvents).toEqual({ question: 1, tool: 0 })
    expect(ledger.cutTokensSaved).toBe(70)
    expect(ledger.cutBreakCost).toBe(5)
    expect(ledger.shearDecision.cut).toBe(1)
    expect(ledger.thinkingCutTokens).toBe(0)
  })

  it('吸收证明未到 → questionBacklogDepth 计数、零落刀', () => {
    const ledger = foldShearLedger(runEvents.slice(0, 3), [classFacts[0]!])
    expect(ledger.cutEvents.question).toBe(0)
    expect(ledger.questionBacklogDepth).toBe(1)
    expect(ledger.shearDecision.hold).toBe(1)
  })

  it('剪后重问被剪内容 → cutMisfireDetected（指纹检出，不静默）', () => {
    const withMisfire = foldShearLedger(runEvents, [...classFacts, runFlushFact])
    expect(withMisfire.cutMisfireDetected).toBe(1)
    const withoutMisfire = foldShearLedger(runEvents.slice(0, 3), [...classFacts, runFlushFact])
    expect(withoutMisfire.cutMisfireDetected).toBe(0)
  })

  it('星标剪切清单事实 = 吸收证明 + 结论来源（star-note 落刀）', () => {
    const starEvents: LedgerSessionEvent[] = [
      { type: 'user/message', seq: 1, time: 1, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'Q1' }] } },
      { type: 'assistant/message', seq: 2, time: 2, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'A1' }] } } },
      { type: 'user/message', seq: 3, time: 3, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'Q2' }] } },
      { type: 'assistant/message', seq: 4, time: 4, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'A2' }] } } },
      { type: 'user/message', seq: 5, time: 5, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'Q3' }] } },
      { type: 'assistant/message', seq: 6, time: 6, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'A3' }] } } },
    ]
    const starFacts: LedgerFact[] = [
      { type: RUN_CLASS_FACT_TYPE, seq: 7, time: 7, data: { seq: 1, decision: 'continue', class: 'pureQ' } },
      { type: RUN_CLASS_FACT_TYPE, seq: 8, time: 8, data: { seq: 3, decision: 'continue', class: 'pureQ' } },
      { type: RUN_CLASS_FACT_TYPE, seq: 9, time: 9, data: { seq: 5, decision: 'continue', class: 'pureQ' } },
      { type: SHEAR_RUN_PLAN_FACT_TYPE, seq: 10, time: 10, data: { at: 10, source: 'star', items: [{ startSeq: 1, endSeq: 6, note: '结论是 A' }] } },
    ]
    const ledger = foldShearLedger(starEvents, starFacts)
    expect(ledger.shearDecision.cut).toBe(1)
    expect(ledger.questionBacklogDepth).toBe(0)
  })

  it('同输入同账（含 run 半边）', () => {
    const first = JSON.stringify(foldShearLedger(runEvents, [...classFacts, runFlushFact]))
    const second = JSON.stringify(foldShearLedger(runEvents, [...classFacts, runFlushFact]))
    expect(second).toBe(first)
  })
})

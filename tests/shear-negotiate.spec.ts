/**
 * N3 协商纯核单测（docs/implement/N3-shadow-mode.md §3/§4）——纯 fixture，零运行时。
 * 覆盖：三态判定、对照组采样、选样（cuttable/never/too-small）、回复判定、中位数、
 * 账本 fold（率的分母、按 basis 分组）、确定性双跑、报表段。
 */
import { describe, expect, it } from 'vitest'
import {
  CONTROL_GROUP_MODULUS,
  DEFAULT_NEGOTIATION_MODE,
  NEGOTIATION_MODES,
  NEGOTIATION_PENDING_LIMIT,
  controlSlot,
  foldNegotiation,
  foldShearLedger,
  formatNegotiationLedger,
  isNegotiationMode,
  judgeNegotiationReply,
  median,
  selectNegotiation,
  SHEAR_NEGOTIATION_NOTE_FACT_TYPE,
  SHEAR_NEGOTIATION_REPLY_FACT_TYPE,
  type ShearNegotiationNoteFactData,
  type ShearNegotiationReplyFactData,
} from '../src/core/shear/index.ts'
import type { LedgerFact } from '../src/core/ledger/index.ts'

const BIG = 'x'.repeat(9000)
const keyWithSlot = (slot: number): string =>
  Array.from({ length: 2000 }, (_, i) => `k${i}`).find((id) => controlSlot(id) === slot) as string

describe('N3 协商纯核 · 模式与采样', () => {
  it('三态词汇与默认值', () => {
    expect(NEGOTIATION_MODES).toEqual(['off', 'shadow', 'live'])
    expect(DEFAULT_NEGOTIATION_MODE).toBe('off')
    for (const mode of NEGOTIATION_MODES) expect(isNegotiationMode(mode)).toBe(true)
    expect(isNegotiationMode('observe')).toBe(false)
    expect(isNegotiationMode(undefined)).toBe(false)
    expect(NEGOTIATION_PENDING_LIMIT).toBe(64)
    expect(CONTROL_GROUP_MODULUS).toBe(100)
  })

  it('controlSlot：确定性、0..99、与 FNV-1a 折叠一致', () => {
    expect(controlSlot('')).toBe(2166136261 % 100)
    expect(controlSlot('abc')).toBe(controlSlot('abc'))
    for (const key of ['a', 'b', 'call-1', 'call-2', 'x'.repeat(200)]) {
      const slot = controlSlot(key)
      expect(Number.isInteger(slot)).toBe(true)
      expect(slot).toBeGreaterThanOrEqual(0)
      expect(slot).toBeLessThan(CONTROL_GROUP_MODULUS)
    }
  })

  it('选样：低于候选下限不挂；cuttable 走 note；never 走 1% 对照组', () => {
    expect(selectNegotiation({ name: 'run_code', args: { code: 'console.log(1)' }, resultText: 'tiny', resultBytes: 100 }, 'c1')).toBeUndefined()
    expect(selectNegotiation({ name: 'run_code', args: { code: 'console.log(1)' }, resultText: BIG, resultBytes: 9000 }, 'c1'))
      .toEqual({ channel: 'note', basis: 'name', reason: 'conclusion' })
    const controlKey = keyWithSlot(0)
    expect(selectNegotiation({ name: 'read', resultText: BIG, resultBytes: 9000 }, controlKey))
      .toEqual({ channel: 'control', basis: 'none', reason: 'unknown' })
    expect(selectNegotiation({ name: 'read', resultText: BIG, resultBytes: 9000 }, keyWithSlot(1))).toBeUndefined()
  })
})

describe('N3 协商纯核 · 回复判定', () => {
  it('CUT-OK 三件套齐全 + 保真通过 + 深度比', () => {
    const judged = judgeNegotiationReply('build ok at src/a.ts v1.2.3', 'CUT-OK: 结论:构建通过｜事实:src/a.ts；v1.2.3｜重取:重跑 npm test', 400)
    expect(judged.marker).toBe('ok')
    expect(judged.complete).toBe(true)
    expect(judged.verifyOk).toBe(true)
    expect(judged.missingCount).toBe(0)
    expect(judged.depthRatio).toBeCloseTo(4 / 400)
  })

  it('缺事实 → verifyOk=false + missingCount>0；CUT-HOLD / 无标记 → 深度比 0', () => {
    const missing = judgeNegotiationReply('build ok at src/a.ts v1.2.3', 'CUT-OK: 结论:好了｜事实:无关｜重取:重跑', 400)
    expect(missing.verifyOk).toBe(false)
    expect(missing.missingCount).toBeGreaterThan(0)
    expect(judgeNegotiationReply(BIG, 'CUT-HOLD: 还要看', 9000)).toMatchObject({ marker: 'hold', depthRatio: 0, complete: false })
    expect(judgeNegotiationReply(BIG, '继续干活', 9000)).toMatchObject({ marker: 'none', depthRatio: 0 })
    expect(judgeNegotiationReply(BIG, '', 0)).toMatchObject({ marker: 'none', depthRatio: 0 })
  })

  it('median：奇数 / 偶数 / 空', () => {
    expect(median([])).toBe(0)
    expect(median([3])).toBe(3)
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
})

const noteFacts: LedgerFact[] = [
  { type: SHEAR_NEGOTIATION_NOTE_FACT_TYPE, time: 1, data: { at: 1, callId: 'a', name: 'run_code', resultSeq: 2, basis: 'name', reason: 'conclusion', resultBytes: 1000, channel: 'note', noteBytes: 60, templateVersion: 2 } satisfies ShearNegotiationNoteFactData },
  { type: SHEAR_NEGOTIATION_NOTE_FACT_TYPE, time: 2, data: { at: 2, callId: 'b', name: 'run_code', resultSeq: 4, basis: 'name', reason: 'conclusion', resultBytes: 2000, channel: 'note', noteBytes: 60, templateVersion: 2 } satisfies ShearNegotiationNoteFactData },
  { type: SHEAR_NEGOTIATION_NOTE_FACT_TYPE, time: 3, data: { at: 3, callId: 'c', name: 'bash', resultSeq: 6, basis: 'command', reason: 'conclusion', resultBytes: 3000, channel: 'control', noteBytes: 60, templateVersion: 2 } satisfies ShearNegotiationNoteFactData },
]
const replyFacts: LedgerFact[] = [
  { type: SHEAR_NEGOTIATION_REPLY_FACT_TYPE, time: 3, data: { at: 3, callId: 'a', resultSeq: 2, replySeq: 3, basis: 'name', marker: 'ok', complete: true, verifyOk: true, missingCount: 0, conclusionChars: 10, depthRatio: 0.01 } satisfies ShearNegotiationReplyFactData },
  { type: SHEAR_NEGOTIATION_REPLY_FACT_TYPE, time: 5, data: { at: 5, callId: 'b', resultSeq: 4, replySeq: 5, basis: 'name', marker: 'hold', complete: false, verifyOk: false, missingCount: 0, conclusionChars: 0, depthRatio: 0 } satisfies ShearNegotiationReplyFactData },
  { type: SHEAR_NEGOTIATION_REPLY_FACT_TYPE, time: 7, data: { at: 7, callId: 'c', resultSeq: 6, replySeq: 7, basis: 'command', marker: 'none', complete: false, verifyOk: false, missingCount: 0, conclusionChars: 0, depthRatio: 0 } satisfies ShearNegotiationReplyFactData },
]

describe('N3 协商纯核 · 账本 fold', () => {
  it('空输入全 0', () => {
    const ledger = foldNegotiation([])
    expect(ledger).toMatchObject({ notes: 0, replies: 0, ok: 0, hold: 0, noReply: 0, okRate: 0, medianDepth: 0 })
    expect(ledger.notesByBasis).toEqual({})
  })

  it('notes / replies / 三档率 / 保真率 / 深度中位数（按 basis）', () => {
    const ledger = foldNegotiation([...noteFacts, ...replyFacts])
    expect(ledger.notes).toBe(3)
    expect(ledger.notesByBasis).toEqual({ name: 2, command: 1 })
    expect(ledger.controlNotes).toBe(1)
    expect(ledger.replies).toBe(3)
    expect(ledger).toMatchObject({ ok: 1, hold: 1, noReply: 1 })
    expect(ledger.okRate).toBeCloseTo(1 / 3)
    expect(ledger.holdRate).toBeCloseTo(1 / 3)
    expect(ledger.noReplyRate).toBeCloseTo(1 / 3)
    expect(ledger.completeRate).toBe(1)
    expect(ledger.verifyOkRate).toBe(1)
    expect(ledger.medianDepth).toBeCloseTo(0.01)
    expect(ledger.medianDepthByBasis).toEqual({ name: 0.01 })
  })

  it('foldShearLedger 并入协商段（shearNoteAttached = 注记数）', () => {
    const ledger = foldShearLedger([], [...noteFacts, ...replyFacts])
    expect(ledger.negotiation.notes).toBe(3)
    expect(ledger.shearNoteAttached).toBe(3)
    const report = formatNegotiationLedger(ledger.negotiation)
    expect(report).toContain('协商剪除：')
    expect(report).toContain('notes: 3')
    expect(report).toContain('medianDepth')
  })

  it('W2(B)：attached=false 的 shadow 样本不计入率的分母', () => {
    const shadowNotes: LedgerFact[] = [
      { type: SHEAR_NEGOTIATION_NOTE_FACT_TYPE, time: 1, data: { at: 1, callId: 'a', name: 'run_code', resultSeq: 2, basis: 'name', reason: 'conclusion', resultBytes: 1000, channel: 'note', noteBytes: 60, templateVersion: 2, attached: false } satisfies ShearNegotiationNoteFactData },
    ]
    const ledger = foldNegotiation(shadowNotes)
    expect(ledger.notes).toBe(1)
    expect(ledger.attachedNotes).toBe(0)
    expect(ledger.okRate).toBe(0)
    expect(formatNegotiationLedger(ledger)).toContain('attached=0')
  })

  it('确定性双跑逐字节一致 + 输入不 mutate', () => {
    const snapshot = JSON.stringify([...noteFacts, ...replyFacts])
    const a = JSON.stringify(foldNegotiation([...noteFacts, ...replyFacts]))
    const b = JSON.stringify(foldNegotiation([...noteFacts, ...replyFacts]))
    expect(a).toBe(b)
    expect(JSON.stringify([...noteFacts, ...replyFacts])).toBe(snapshot)
  })

  it('坏载荷跳过（KV 镜像可能截断）', () => {
    const ledger = foldNegotiation([
      { type: SHEAR_NEGOTIATION_NOTE_FACT_TYPE, time: 1, data: null },
      { type: SHEAR_NEGOTIATION_REPLY_FACT_TYPE, time: 2, data: { marker: 'weird' } },
    ])
    expect(ledger.notes).toBe(0)
    expect(ledger.replies).toBe(1)
    expect(ledger.noReply).toBe(1)
  })
})

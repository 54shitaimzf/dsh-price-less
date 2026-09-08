/**
 * P20a H7 计量端口单测（docs/implement/archive/P20-pressure-and-fuse.md §5；docs/10 §1 H7）。
 * 区间启发式体量（影子价同源）+ wire 锚定计量（measure().totalTokens）；服务缺失/异常 = undefined。
 */
import { describe, expect, it } from 'vitest'
import { createMeterPort } from '../src/platform/meter.ts'

const session = { id: 's' } as never

describe('P20a 计量端口', () => {
  it('服务缺失 → 端口 undefined（调用侧 fail-lazy）', () => {
    expect(createMeterPort({} as never)).toBeUndefined()
  })

  it('heuristicTokensInRange：区间求和；区间内无节点 = undefined', () => {
    const port = createMeterPort({
      tokenMeter: { measure: () => ({ nodes: [{ seq: 1, heuristicTokens: 5 }, { seq: 2, heuristicTokens: 7 }, { seq: 5, heuristicTokens: 9 }] }) },
    } as never)!
    expect(port.heuristicTokensInRange(session, 1, 2)).toBe(12)
    expect(port.heuristicTokensInRange(session, 3, 4)).toBeUndefined()
  })

  it('wireTokens：measure().totalTokens；非法值/异常 = undefined', () => {
    const ok = createMeterPort({ tokenMeter: { measure: () => ({ totalTokens: 42, nodes: [] }) } } as never)!
    expect(ok.wireTokens(session)).toBe(42)
    const bad = createMeterPort({ tokenMeter: { measure: () => ({ totalTokens: Number.NaN, nodes: [] }) } } as never)!
    expect(bad.wireTokens(session)).toBeUndefined()
    const boom = createMeterPort({ tokenMeter: { measure: () => { throw new Error('x') } } } as never)!
    expect(boom.wireTokens(session)).toBeUndefined()
    expect(boom.heuristicTokensInRange(session, 0, 1)).toBeUndefined()
  })
})

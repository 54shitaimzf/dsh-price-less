/**
 * core/meter token 估算单测（docs/04 §5 标定；对齐 harness token-meter/estimate.ts 结构模型）。
 * 覆盖：两桶密度 / 真机标定锚点 / 密度注入与回退 / token→字符反解 / 块与角色价 / 标定比。
 */
import { describe, expect, it } from 'vitest'
import {
  BLOCK_OVERHEAD,
  DEFAULT_TOKEN_DENSITY,
  ROLE_OVERHEAD,
  calibrationRatio,
  classifyChars,
  estimateBlockTokens,
  estimateContentTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  flatDensity,
  tokensToChars,
  type EstimateBlock,
} from '../src/core/meter/index.ts'

describe('两桶密度：默认标定与分桶', () => {
  it('默认密度 = CJK 1.5 / 其余 2.9（2026-09-09 真机标定）', () => {
    expect(DEFAULT_TOKEN_DENSITY).toEqual({ cjk: 1.5, other: 2.9 })
  })
  it('分桶：CJK 记 cjk、其余记 other；code point 计数', () => {
    expect(classifyChars('')).toEqual({ chars: 0, cjk: 0, other: 0 })
    expect(classifyChars('ab')).toEqual({ chars: 2, cjk: 0, other: 2 })
    expect(classifyChars('中文')).toEqual({ chars: 2, cjk: 2, other: 0 })
    expect(classifyChars('a中')).toEqual({ chars: 2, cjk: 1, other: 1 })
    // 全角标点 / 假名 / 谚文 均入 CJK 桶
    expect(classifyChars('，。あ한').cjk).toBe(4)
  })
  it('空文本 = 0；非空至少 1', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
  })
  it('两桶分别折算：中文与英文不再共用一个常数', () => {
    // 2 个中文字 = ceil(2/1.5) = 2；4 个 ASCII = ceil(4/2.9) = 2
    expect(estimateTokens('中文')).toBe(2)
    expect(estimateTokens('abcd')).toBe(2)
    // 混合：ceil(2/1.5 + 4/2.9) = ceil(1.334 + 1.379) = 3
    expect(estimateTokens('中文abcd')).toBe(3)
  })
  it('真机标定锚点：20,101 CJK + 116,376 其余 → 53,531（实测真实 53,532，误差 0.002%）', () => {
    const text = `${'中'.repeat(20101)}${'x'.repeat(116376)}`
    expect(estimateTokens(text)).toBe(53531)
  })
  it('密度注入：flatDensity 等价旧 charsPerToken 标量', () => {
    expect(flatDensity(1)).toEqual({ cjk: 1, other: 1 })
    expect(estimateTokens('x'.repeat(30), flatDensity(3))).toBe(10)
    expect(estimateTokens('中'.repeat(3), flatDensity(3))).toBe(1)
  })
  it('非法密度回退默认（cjk/other ≤ 0 或非有限值）', () => {
    expect(estimateTokens('abcd', { cjk: 0, other: 0 })).toBe(2)
    expect(estimateTokens('abcd', { cjk: Number.NaN, other: -1 })).toBe(2)
    expect(flatDensity(0)).toEqual({ cjk: DEFAULT_TOKEN_DENSITY.other, other: DEFAULT_TOKEN_DENSITY.other })
  })
})

describe('token → 字符反解（尾截断取字符数）', () => {
  it('局部线性反解；零 token / 空文本 = 0', () => {
    expect(tokensToChars('', 10)).toBe(0)
    expect(tokensToChars('abcdef', 0)).toBe(0)
    expect(tokensToChars('abcdef', -1)).toBe(0)
    // 6 字符估 3 token → 2 token 对应 4 字符
    expect(tokensToChars('abcdef', 2, flatDensity(2))).toBe(4)
  })
  it('反解结果不超过原文长度', () => {
    expect(tokensToChars('abc', 1000)).toBe(3)
  })
})

describe('块与角色价（对齐 DSH estimateContent/estimateMessage）', () => {
  it('text / reasoning = 文本价 + BLOCK_OVERHEAD', () => {
    const density = flatDensity(1)
    expect(estimateBlockTokens({ type: 'text', text: 'abcd' }, density)).toBe(4 + BLOCK_OVERHEAD)
    expect(estimateBlockTokens({ type: 'reasoning', text: 'abcd' }, density)).toBe(4 + BLOCK_OVERHEAD)
    expect(estimateBlockTokens({ type: 'text', text: '' }, density)).toBe(BLOCK_OVERHEAD)
  })
  it('tool-call = name + arguments + BLOCK_OVERHEAD', () => {
    const density = flatDensity(1)
    expect(estimateBlockTokens({ type: 'tool-call', name: 'read', arguments: 'abc' }, density)).toBe(4 + 3 + BLOCK_OVERHEAD)
  })
  it('tool-result 递归计内容价 + BLOCK_OVERHEAD', () => {
    const density = flatDensity(1)
    const block: EstimateBlock = { type: 'tool-result', content: [{ type: 'text', text: 'ab' }] }
    expect(estimateBlockTokens(block, density)).toBe(2 + BLOCK_OVERHEAD + BLOCK_OVERHEAD)
  })
  it('未知块 = 结构性 JSON 价（保守）', () => {
    const density = flatDensity(1)
    const block: EstimateBlock = { type: 'image' }
    expect(estimateBlockTokens(block, density)).toBe(BLOCK_OVERHEAD + estimateTokens(JSON.stringify(block), density))
  })
  it('内容 / 消息 / 消息列表逐层累加', () => {
    const density = flatDensity(1)
    const content: EstimateBlock[] = [{ type: 'text', text: 'ab' }, { type: 'text', text: 'cd' }]
    expect(estimateContentTokens(content, density)).toBe(2 * (2 + BLOCK_OVERHEAD))
    expect(estimateMessageTokens({ content }, density)).toBe(estimateContentTokens(content, density) + ROLE_OVERHEAD)
    expect(estimateMessagesTokens([{ text: 'abcd' }, { text: 'ef' }], density)).toBe(4 + ROLE_OVERHEAD + 2 + ROLE_OVERHEAD)
  })
  it('空内容 = 0（消息仍有角色开销）', () => {
    expect(estimateContentTokens([], flatDensity(1))).toBe(0)
    expect(estimateMessageTokens({ content: [] }, flatDensity(1))).toBe(ROLE_OVERHEAD)
  })
})

describe('标定比（F8b 对账口径）', () => {
  it('actual / estimated；任一侧 ≤ 0 = null', () => {
    expect(calibrationRatio(100, 70)).toBeCloseTo(0.7, 10)
    expect(calibrationRatio(0, 10)).toBeNull()
    expect(calibrationRatio(10, 0)).toBeNull()
    expect(calibrationRatio(-1, 10)).toBeNull()
  })
})

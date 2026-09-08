/**
 * P14a 星标纯逻辑/桥测试（docs/implement/archive/P14a-star-button-ui.md §3.6；P14d 删 diff 后收敛）。
 * 零 React、零 host import：只验证门控镜像、mock 预览、裁决摘要与桥契约。
 */
import { describe, expect, it } from 'vitest'
import { createMockStarBridge } from '../client/star/star-bridge.ts'
import { isTrivialPrompt, parseMockPreview, verdictSummary } from '../client/star/star-model.ts'

describe('star trivial prompt', () => {
  it('去噪后不足 4 字为极短（与 host TRIVIAL_MESSAGE_MAX_CHARS 同口径）', () => {
    expect(isTrivialPrompt('好')).toBe(true)
    expect(isTrivialPrompt('继续')).toBe(true)
    expect(isTrivialPrompt('继续做完')).toBe(false)
    expect(isTrivialPrompt('   ')).toBe(true)
  })
})

describe('star mock preview', () => {
  it('确定性预览数据：previewId、产物、权威段、token 估算', () => {
    const data = parseMockPreview('第一行\n第二行')
    expect(data.previewId).toBe('mock-preview-1')
    expect(data.product).toContain('P14a 预览占位')
    expect(data.missingAuthority).toHaveLength(2)
    expect(data.ctxTokens).toBeGreaterThan(0)
    expect(data.historyCount).toBe(0)
    expect(data.droppedLines).toBe(0)
  })

  it('空草稿：无权威段，无历史素材', () => {
    const data = parseMockPreview('')
    expect(data.product).toBeNull()
    expect(data.missingAuthority).toEqual([])
    expect(data.historyCount).toBe(0)
  })
})

describe('star verdict summary', () => {
  it('计数摘要：空、单类、多类', () => {
    expect(verdictSummary([])).toBe('（无裁决）')
    expect(verdictSummary([
      { kind: 'class', summary: 'a' }, { kind: 'class', summary: 'b' }, { kind: 'shear', summary: 'c' },
    ])).toBe('裁决 3（class 2 · shear 1）')
  })
})

describe('star mock bridge', () => {
  it('preview 返回 ok 且 apply 返回 ok（确定性、无副作用）', async () => {
    const bridge = createMockStarBridge()
    const preview = await bridge.preview('s1', 'hello\nworld')
    expect(preview.ok).toBe(true)
    if (preview.ok) {
      expect(preview.data.previewId).toBe('mock-preview-1')
      expect(preview.data.originalPrompt).toBe('hello\nworld')
    }
    const applied = await bridge.apply('s1', { previewId: 'mock-preview-1', editedProduct: 'edited' })
    expect(applied.ok).toBe(true)
  })
})

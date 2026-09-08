/**
 * P14a 星标纯逻辑/桥测试（docs/implement/P14a-star-button-ui.md §3.6）。
 * 零 React、零 host import：只验证 diff、mock 预览、汇总与桥契约。
 */
import { describe, expect, it } from 'vitest'
import { createMockStarBridge } from '../client/star/star-bridge.ts'
import { clampPreviewText, diffLines, parseMockPreview, summaryOfVerdicts } from '../client/star/star-model.ts'

describe('star diff', () => {
  it('纯新增/纯删除/相同/空输入', () => {
    expect(diffLines('', 'a\nb')).toEqual([{ type: 'add', text: 'a' }, { type: 'add', text: 'b' }])
    expect(diffLines('a\nb', '')).toEqual([{ type: 'del', text: 'a' }, { type: 'del', text: 'b' }])
    expect(diffLines('a\nb', 'a\nb')).toEqual([{ type: 'same', text: 'a' }, { type: 'same', text: 'b' }])
    expect(diffLines('', '')).toEqual([])
  })

  it('混合同步：删除旧行、新增新行', () => {
    const out = diffLines('one\ntwo\nthree', 'one\nthree\nfour')
    expect(out).toEqual([
      { type: 'same', text: 'one' },
      { type: 'del', text: 'two' },
      { type: 'same', text: 'three' },
      { type: 'add', text: 'four' },
    ])
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

describe('star text helpers', () => {
  it('clampPreviewText 保留超长头尾', () => {
    const text = 'a'.repeat(5000)
    const out = clampPreviewText(text, 100)
    expect(out.length).toBeLessThan(text.length)
    expect(out).toContain('…[preview truncated]…')
    expect(out.startsWith('a')).toBe(true)
    expect(out.endsWith('a')).toBe(true)
  })

  it('summaryOfVerdicts 空与多行', () => {
    expect(summaryOfVerdicts([])).toBe('（无裁决）')
    expect(summaryOfVerdicts([{ kind: 'KEEP', summary: '保留' }, { kind: 'ASPECT', summary: '完成标准' }]))
      .toBe('KEEP: 保留；ASPECT: 完成标准')
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

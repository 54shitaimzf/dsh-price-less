/**
 * F10 路径与产物契约单测（docs/04 §2）：root 归一化 / 相对化 / 单元清单 /
 * 产物内零文件路径 + 热尾指向档案。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ASSEMBLE_POLICY,
  assembleArchive,
  normalizeRoot,
  relativePath,
  renderUnitList,
  type AssemblePolicy,
  type AssembleUnit,
} from '../src/core/assemble/index.ts'
import { foldFileChains } from '../src/core/assemble/chain.ts'
import { flatDensity } from '../src/core/meter/index.ts'

const ROOT = 'D:/proj'
const policy = (over: Partial<AssemblePolicy> = {}): AssemblePolicy => ({
  ...DEFAULT_ASSEMBLE_POLICY,
  density: flatDensity(1),
  hotTailTokens: 1000,
  pointerOverheadTokens: 0,
  minTruncatedChars: 5,
  ...over,
})

const unit = (id: string, seqStart: number, text: string, extra: Partial<AssembleUnit> = {}): AssembleUnit => ({
  id, kind: 'tool-pair', seqStart, seqEnd: seqStart + 1, text, tokens: text.length, ...extra,
})

describe('路径：归一化 / 相对化', () => {
  it('normalizeRoot：反斜杠归一 + 去尾斜杠；空/非串 = undefined', () => {
    expect(normalizeRoot('D:\\proj\\')).toBe('D:/proj')
    expect(normalizeRoot('D:/proj')).toBe('D:/proj')
    expect(normalizeRoot('  ')).toBeUndefined()
    expect(normalizeRoot(42)).toBeUndefined()
  })

  it('relativePath：root 下去前缀；不在 root 下原样（不猜）', () => {
    expect(relativePath('D:\\proj\\src\\a.ts', ROOT)).toBe('src/a.ts')
    expect(relativePath('D:/proj/src/a.ts', ROOT)).toBe('src/a.ts')
    expect(relativePath('D:/other/b.ts', ROOT)).toBe('D:/other/b.ts')
    expect(relativePath('D:/proj', ROOT)).toBe('.')
    expect(relativePath('src/a.ts', undefined)).toBe('src/a.ts')
  })
})

describe('F10 产物：零文件路径 + 热尾指向档案', () => {
  it('渲染不含文件路径 / 短 ID 表；热尾头指向档案 vN；档案正文仅总分', () => {
    const units = [
      unit('a', 1, 'A1', { path: 'D:/proj/src/a.ts', version: 2 }),
      unit('b', 5, 'B1', { path: 'D:/proj/src/b.ts', version: 1 }),
    ]
    const chains = foldFileChains([
      { seq: 1, path: 'D:/proj/src/a.ts', kind: 'write', content: 'l1\nl2' },
      { seq: 5, path: 'D:/proj/src/b.ts', kind: 'write', content: 'b1' },
    ])
    const outcome = assembleArchive({
      units,
      chains,
      root: ROOT,
      rootKind: 'session',
      digest: { gist: '改边界装配', steps: [{ type: 'impl', text: '落 F10 契约' }] },
      hotTail: [
        { unitId: 'a', coord: { path: 'D:/proj/src/a.ts', version: 1, lineRange: { start: 1, end: 2 } } },
        { unitId: 'b', coord: { path: 'D:/proj/src/b.ts', version: 1 } },
      ],
      resolve: { a: 'l1\nl2', b: 'b1' },
      policy: policy(),
    })
    if (!outcome.ok) throw new Error('expected ok')
    const text = outcome.result.rendered
    expect(text).toContain('【热尾｜档案 v1】')
    expect(text).toContain('▸1 l1\nl2')
    expect(text).not.toContain('[文件]')
    expect(text).not.toContain('src/a.ts')
    expect(text).not.toContain('【路径】')
    expect(outcome.result.digestText).toBe('【总述】改边界装配\n【实现】落 F10 契约')
    expect(outcome.result.hotTail.archiveRef).toBe('v1')
    expect(outcome.result.root).toBe(ROOT)
    expect(outcome.result.rootKind).toBe('session')
  })

  it('renderUnitList 按 root 相对化（省输入 token）', () => {
    const units = [unit('c1', 1, 'x', { path: 'D:/proj/src/a.ts', version: 3 })]
    expect(renderUnitList(units)).toBe('[c1] D:/proj/src/a.ts@v3 ~1t')
    expect(renderUnitList(units, ROOT)).toBe('[c1] src/a.ts@v3 ~1t')
  })
})

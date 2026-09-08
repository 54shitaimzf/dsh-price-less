/**
 * F9e 路径压缩单测（docs/04 §2/§6）：root 归一化 / 相对化 / 短 ID 表 / 指针与单元清单。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ASSEMBLE_POLICY,
  assembleArchive,
  buildPathTable,
  normalizeRoot,
  pathRef,
  relativePath,
  renderPathTable,
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

describe('F9e 路径：归一化 / 相对化 / 短 ID 表', () => {
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

  it('buildPathTable：同路径 ≥2 次才入表（首现序 §n）', () => {
    const table = buildPathTable(['D:/proj/a.ts', 'D:/proj/b.ts', 'D:/proj/a.ts'], ROOT)
    expect(table.entries).toEqual([{ id: '§1', path: 'a.ts' }])
    expect(pathRef('D:/proj/a.ts', ROOT, table)).toBe('§1')
    expect(pathRef('D:/proj/b.ts', ROOT, table)).toBe('b.ts')
    expect(renderPathTable(table)).toBe('【路径】\n§1 = a.ts')
    expect(renderPathTable({ entries: [], index: new Map() })).toBe('')
  })
})

describe('F9e 路径：产物渲染（相对化 + 短 ID 表）', () => {
  it('指针相对化 + 重复路径入表；pathBytesSaved 入账', () => {
    const units = [
      unit('a', 1, 'A1', { path: 'D:/proj/src/a.ts', version: 2 }),
      unit('b', 5, 'B1', { path: 'D:/proj/src/b.ts', version: 1 }),
      unit('c', 9, 'C1', { path: 'D:/proj/src/a.ts', version: 2 }),
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
      hotTail: [
        { unitId: 'a', coord: { path: 'D:/proj/src/a.ts', version: 1, lineRange: { start: 1, end: 2 } } },
        { unitId: 'b', coord: { path: 'D:/proj/src/b.ts', version: 1 } },
        { unitId: 'c', coord: { path: 'D:/proj/src/a.ts', version: 1 } },
      ],
      resolve: { a: 'l1\nl2', b: 'b1', c: 'l1\nl2' },
      policy: policy(),
    })
    if (!outcome.ok) throw new Error('expected ok')
    const text = outcome.result.rendered
    expect(text).toContain('【路径】\n§1 = src/a.ts')
    expect(text).toContain('▸1 [文件] §1@v1:1-2')
    expect(text).toContain('▸2 [文件] src/b.ts@v1')
    expect(text).toContain('▸3 [文件] §1@v1')
    expect(outcome.result.pathTableEntries).toBe(1)
    expect(outcome.result.pathBytesSaved).toBeGreaterThan(0)
    expect(outcome.result.root).toBe(ROOT)
    expect(outcome.result.rootKind).toBe('session')
  })

  it('renderUnitList 按 root 相对化（省输入 token）', () => {
    const units = [unit('c1', 1, 'x', { path: 'D:/proj/src/a.ts', version: 3 })]
    expect(renderUnitList(units)).toBe('[c1] D:/proj/src/a.ts@v3 ~1t')
    expect(renderUnitList(units, ROOT)).toBe('[c1] src/a.ts@v3 ~1t')
  })
})

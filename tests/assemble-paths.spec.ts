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

describe('F10/v4 产物：总分零路径 + 热尾按需定位标注', () => {
  it('总分零路径；热尾条目按需带定位标注；档案正文仅总分', () => {
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
    // v4：内容不自证位置（'l1'/'b1' 无搜索键）→ 渲染相对路径定位标注。
    expect(text).toContain('▸1 [src/a.ts@v1:1-2] l1\nl2')
    expect(text).toContain('▸2 [src/b.ts@v1] b1')
    expect(text).not.toContain('[文件]')
    expect(text).not.toContain('【路径】')
    // 总分仍零路径（定位只进热尾条目）。
    expect(outcome.result.digestText).toBe('【总述】改边界装配\n【实现】落 F10 契约')
    expect(outcome.result.digestText).not.toContain('src/')
    expect(outcome.result.hotTail.located).toBe(2)
    expect(outcome.result.hotTail.unlocated).toBe(0)
    expect(outcome.result.hotTail.archiveRef).toBe('v1')
    expect(outcome.result.root).toBe(ROOT)
    expect(outcome.result.rootKind).toBe('session')
  })

  it('内容自带搜索键 → 不渲染定位标注（省 token）', () => {
    const units = [unit('a', 1, 'A1', { path: 'D:/proj/src/a.ts', version: 1 })]
    const chains = foldFileChains([{ seq: 1, path: 'D:/proj/src/a.ts', kind: 'write', content: 'x' }])
    const outcome = assembleArchive({
      units,
      chains,
      root: ROOT,
      hotTail: [{ unitId: 'a', coord: { path: 'D:/proj/src/a.ts', version: 1 } }],
      resolve: { a: 'export function pressureRatio() { return 0.35 }' },
      policy: policy(),
    })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.rendered).toContain('▸1 export function pressureRatio()')
    expect(outcome.result.rendered).not.toContain('src/a.ts')
    expect(outcome.result.hotTail.located).toBe(0)
    expect(outcome.result.hotTail.unlocated).toBe(0)
  })

  it('无坐标（历史 span）→ 无从标注，计入 unlocated', () => {
    const units = [unit('a', 1, 'plain text')]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'a' }], policy: policy() })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.rendered).toContain('▸1 plain text')
    expect(outcome.result.hotTail.located).toBe(0)
    expect(outcome.result.hotTail.unlocated).toBe(1)
  })

  it('U13.2：locator 开销按**幸存条目**结算——超帽先撤标注、不丢内容（旧实现按候选数白扣 → 内容被丢弃）', () => {
    const text = '必'.repeat(30)
    const units = [unit('a', 1, text, { path: 'D:/proj/src/a.ts', version: 1 })]
    const chains = foldFileChains([{ seq: 1, path: 'D:/proj/src/a.ts', kind: 'write', content: text }])
    const hotTail = [{ unitId: 'a', coord: { path: 'D:/proj/src/a.ts', version: 1 } }]
    const request = { units, chains, root: ROOT, hotTail, resolve: { a: text } } as const
    // 预算 50：条目本体 20 + 标注 40 = 60 > 50 → 撤标注保内容
    // （旧实现把 40 从预算里预扣 → 只剩 10 quota → 条目整个丢弃：为了一个标注丢掉内容，方向错误）
    const tight = assembleArchive({ ...request, policy: policy({ hotTailTokens: 50, pointerOverheadTokens: 40, minTruncatedChars: 5 }) })
    if (!tight.ok) throw new Error('expected ok')
    expect(tight.result.hotTail.entries).toHaveLength(1)
    expect(tight.result.hotTail.entries[0]!.text).toBe(text)
    expect(tight.result.hotTail.entries[0]!.locator).toBeUndefined()
    expect(tight.result.hotTail.located).toBe(0)
    expect(tight.result.hotTail.quotaDrops).toBe(0)
    // 预算够（120 ≥ 20 + 40）→ 标注保留
    const roomy = assembleArchive({ ...request, policy: policy({ hotTailTokens: 120, pointerOverheadTokens: 40, minTruncatedChars: 5 }) })
    if (!roomy.ok) throw new Error('expected ok')
    expect(roomy.result.hotTail.entries[0]!.locator ?? '').toContain('a.ts')
    expect(roomy.result.hotTail.located).toBe(1)
    const span = assembleArchive({ units, hotTail: [{ unitId: 'a' }], policy: policy({ hotTailTokens: 50, pointerOverheadTokens: 40, minTruncatedChars: 5 }) })
    if (!span.ok) throw new Error('expected ok')
    expect(span.result.hotTail.entries).toHaveLength(1)
    expect(span.result.hotTail.unlocated).toBe(1)
  })

  it('renderUnitList 按 root 相对化（省输入 token）', () => {
    const units = [unit('c1', 1, 'x', { path: 'D:/proj/src/a.ts', version: 3 })]
    expect(renderUnitList(units)).toBe('[c1] D:/proj/src/a.ts@v3 ~1t')
    expect(renderUnitList(units, ROOT)).toBe('[c1] src/a.ts@v3 ~1t')
  })
})

/**
 * P17a 坐标层单测（docs/implement/archive/P17-boundary-assembler.md §5；docs/04 §2 通道 A）。
 * 纯核 fixture：版本补丁链 fold + vN 重映射（恒等 / 逐版行偏移 / 出界裁剪 / 删除丢弃 / 链断）。
 */
import { describe, expect, it } from 'vitest'
import { foldFileChains, lastLineCount, remapFileCoord, type FileOp } from '../src/core/assemble/index.ts'

const write = (seq: number, content: string, path = 'a.ts'): FileOp => ({ seq, path, kind: 'write', content })
const edit = (seq: number, oldString: string, newString: string, path = 'a.ts', replaceAll = false): FileOp => ({
  seq, path, kind: 'edit', oldString, newString, ...(replaceAll ? { replaceAll: true } : {}),
})
const read = (seq: number, offset: number, lines: string[], totalLines: number, path = 'a.ts'): FileOp => ({
  seq, path, kind: 'read', offset, lines, totalLines,
})

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `l${i + 1}`).join('\n')

describe('P17a 坐标层：版本链 fold', () => {
  it('write 全文 = 该版全文，行数已知', () => {
    const chains = foldFileChains([write(1, 'a\nb\nc')])
    const chain = chains.get('a.ts')!
    expect(chain.versions.length).toBe(1)
    expect(chain.versions[0]!.version).toBe(1)
    expect(chain.versions[0]!.lineCount).toBe(3)
    expect(lastLineCount(chain)).toBe(3)
    expect(chain.broken).toBe(false)
  })

  it('read 全覆盖窗口 = 已知全文；部分窗口只知行数', () => {
    const full = foldFileChains([read(1, 1, ['a', 'b'], 2)]).get('a.ts')!
    expect(full.versions[0]!.content).toEqual(['a', 'b'])
    const partial = foldFileChains([read(1, 1, ['a'], 9)]).get('a.ts')!
    expect(partial.versions[0]!.content).toBeUndefined()
    expect(partial.versions[0]!.lineCount).toBe(9)
  })

  it('edit 在已知全文里定位 → hunk（坐标 = 被替换版本行号）', () => {
    const chains = foldFileChains([write(1, 'a\nb\nc\nd'), edit(2, 'c', 'c1\nc2')])
    const chain = chains.get('a.ts')!
    expect(chain.versions[1]!.hunks).toEqual([{ startLine: 3, endLine: 3, newLineCount: 2 }])
    expect(chain.versions[1]!.lineCount).toBe(5)
    expect(chain.versions[1]!.content).toEqual(['a', 'b', 'c1', 'c2', 'd'])
  })

  it('edit 在部分读窗口里定位（无全文）→ 绝对行号 hunk + 行数位移推算', () => {
    const chains = foldFileChains([read(1, 5, ['e', 'f', 'g'], 12), edit(2, 'f', 'f1\nf2')])
    const chain = chains.get('a.ts')!
    expect(chain.versions[1]!.hunks).toEqual([{ startLine: 6, endLine: 6, newLineCount: 2 }])
    expect(chain.versions[1]!.lineCount).toBe(13)
  })

  it('replace_all 多 hunk（逐处，不做并集）', () => {
    const chains = foldFileChains([write(1, 'x\ny\nx'), edit(2, 'x', 'xx', 'a.ts', true)])
    const hunks = chains.get('a.ts')!.versions[1]!.hunks!
    expect(hunks).toEqual([
      { startLine: 1, endLine: 1, newLineCount: 1 },
      { startLine: 3, endLine: 3, newLineCount: 1 },
    ])
  })

  it('定位失败（oldString 不在已知内容）→ 链断，不猜位置', () => {
    const chain = foldFileChains([write(1, 'a\nb'), edit(2, 'zzz', 'q')]).get('a.ts')!
    expect(chain.broken).toBe(true)
    expect(chain.versions[1]!.hunks).toBeUndefined()
  })

  it('外部改写（read 行数/内容与已知全文不符）→ 该转换位置不可知', () => {
    const chain = foldFileChains([write(1, 'a\nb\nc'), read(2, 1, ['a', 'b', 'c', 'd'], 4)]).get('a.ts')!
    expect(chain.versions[1]!.hunks).toBeUndefined()
    expect(chain.broken).toBe(true)
  })
})

describe('P17a 坐标层：vN 重映射', () => {
  it('文件未改 = 恒等变换零成本', () => {
    const chain = foldFileChains([write(1, lines(10))]).get('a.ts')!
    expect(remapFileCoord(chain, { path: 'a.ts', version: 1, lineRange: { start: 4, end: 6 } }, 10))
      .toEqual({ ok: true, lineRange: { start: 4, end: 6 }, clipped: false })
  })

  it('单次 edit 后行号按净行差平移', () => {
    const chain = foldFileChains([write(1, lines(10)), edit(2, 'l3', 'l3a\nl3b')]).get('a.ts')!
    expect(remapFileCoord(chain, { path: 'a.ts', version: 1, lineRange: { start: 5, end: 6 } }, 11))
      .toEqual({ ok: true, lineRange: { start: 6, end: 7 }, clipped: false })
  })

  it('多次 edit 累积平移', () => {
    const chain = foldFileChains([
      write(1, lines(10)),
      edit(2, 'l2', 'l2a\nl2b'),
      edit(3, 'l8', 'l8a\nl8b\nl8c'),
    ]).get('a.ts')!
    // v1 的 9..10 行在两次增行之后 → +4
    expect(remapFileCoord(chain, { path: 'a.ts', version: 1, lineRange: { start: 9, end: 10 } }, 13))
      .toEqual({ ok: true, lineRange: { start: 12, end: 13 }, clipped: false })
  })

  it('区间与替换区相交 → 机械扩到替换后跨度', () => {
    const chain = foldFileChains([write(1, lines(5)), edit(2, 'l3', 'l3a\nl3b')]).get('a.ts')!
    expect(remapFileCoord(chain, { path: 'a.ts', version: 1, lineRange: { start: 3, end: 3 } }, 6))
      .toEqual({ ok: true, lineRange: { start: 3, end: 4 }, clipped: true })
  })

  it('write 全文替换 → 旧坐标位置不可平移（chain-break）；新版本坐标恒等', () => {
    const chain = foldFileChains([write(1, 'a\nb'), write(2, 'x\ny\nz')]).get('a.ts')!
    expect(remapFileCoord(chain, { path: 'a.ts', version: 1, lineRange: { start: 1, end: 1 } }, 3))
      .toEqual({ ok: false, reason: 'chain-break' })
    expect(remapFileCoord(chain, { path: 'a.ts', version: 2, lineRange: { start: 1, end: 2 } }, 3))
      .toEqual({ ok: true, lineRange: { start: 1, end: 2 }, clipped: false })
  })

  it('未知版本 / 空链 / 链断', () => {
    const chain = foldFileChains([write(1, 'a')]).get('a.ts')!
    expect(remapFileCoord(chain, { path: 'a.ts', version: 9 })).toEqual({ ok: false, reason: 'unknown-version' })
    expect(remapFileCoord(undefined, { path: 'a.ts', version: 1 })).toEqual({ ok: false, reason: 'empty' })
    const broken = foldFileChains([write(1, 'a'), edit(2, 'zzz', 'q')]).get('a.ts')!
    expect(remapFileCoord(broken, { path: 'a.ts', version: 1, lineRange: { start: 1, end: 1 } }))
      .toEqual({ ok: false, reason: 'chain-break' })
  })

  it('出界裁剪 / 整段越界丢弃 / 文件不存在丢弃', () => {
    const chain = foldFileChains([write(1, lines(10))]).get('a.ts')!
    expect(remapFileCoord(chain, { path: 'a.ts', version: 1, lineRange: { start: 8, end: 12 } }, 10))
      .toEqual({ ok: true, lineRange: { start: 8, end: 10 }, clipped: true })
    expect(remapFileCoord(chain, { path: 'a.ts', version: 1, lineRange: { start: 11, end: 12 } }, 10))
      .toEqual({ ok: false, reason: 'deleted' })
    expect(remapFileCoord(chain, { path: 'a.ts', version: 1 }, null)).toEqual({ ok: false, reason: 'deleted' })
  })

  it('省略 lineRange = 整文件（已知末版行数 / 盘上行数）', () => {
    const chain = foldFileChains([write(1, lines(7))]).get('a.ts')!
    expect(remapFileCoord(chain, { path: 'a.ts', version: 1 }, 7))
      .toEqual({ ok: true, lineRange: { start: 1, end: 7 }, clipped: false })
    expect(remapFileCoord(chain, { path: 'a.ts', version: 1 }))
      .toEqual({ ok: true, lineRange: { start: 1, end: 7 }, clipped: false })
  })

  it('输入未 mutate + 双跑相等（确定性）', () => {
    const ops: FileOp[] = [write(1, lines(5)), edit(2, 'l2', 'l2a'), read(3, 1, ['l1'], 6)]
    const snapshot = JSON.stringify(ops)
    const a = foldFileChains(ops)
    const b = foldFileChains(ops)
    expect(JSON.stringify(ops)).toBe(snapshot)
    expect(JSON.stringify([...a])).toBe(JSON.stringify([...b]))
  })
})

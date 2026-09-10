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

  it('U3：部分读窗口内 replace_all ≥2 处且行数变化 → 窗口不错乱（降序应用；后续编辑仍可正确定位）', () => {
    // 真实文件 20 行，窗口只见 1–6 行（两处 Xb 均在窗内）；审查复现：升序应用会让第二处
    // hunk 在已平移数组上按旧坐标切割 → 窗口残留旧文本 + 后续版本链行号失真（盘上取错行）。
    const chains = foldFileChains([
      read(1, 1, ['a', 'Xb', 'd', 'e', 'Xb', 'f'], 20),
      edit(2, 'Xb', 'Z\nZ2', 'a.ts', true),
    ])
    const chain = chains.get('a.ts')!
    expect(chain.broken).toBe(false)
    expect(chain.versions[1]!.hunks).toEqual([
      { startLine: 2, endLine: 2, newLineCount: 2 },
      { startLine: 5, endLine: 5, newLineCount: 2 },
    ])
    expect(chain.versions[1]!.lineCount).toBe(22)
    // 窗口内容钉死：修复后窗口 = a,Z,Z2,d,e,Z,Z2,f —— 跨第一处替换尾部的后续编辑必须定位成功
    const after = foldFileChains([
      read(1, 1, ['a', 'Xb', 'd', 'e', 'Xb', 'f'], 20),
      edit(2, 'Xb', 'Z\nZ2', 'a.ts', true),
      edit(3, 'Z2\nd', 'W', 'a.ts'),
    ]).get('a.ts')!
    expect(after.broken).toBe(false)
    expect(after.versions[2]!.hunks).toEqual([{ startLine: 3, endLine: 4, newLineCount: 1 }])
    expect(after.versions[2]!.lineCount).toBe(21)
  })

  it('U3：窗前 hunk 只平移窗口绝对位置，不改窗内局部坐标（多窗口 replace_all）', () => {
    // 窗口 A（1–2 行）与窗口 B（4–6 行）；replace_all 同时命中 A 内（行 2）与 B 内（行 5），
    // A 处替换扩行后 B 的窗内局部坐标必须仍按 B 原 offset 计（旧行为会错位 B 的应用位置）。
    const after = foldFileChains([
      read(1, 1, ['a', 'Xb'], 9),
      read(2, 4, ['w', 'Xb', 'f'], 9),
      edit(3, 'Xb', 'Z\nZ2', 'a.ts', true),
      edit(4, 'Z2\nf', 'W', 'a.ts'),
    ]).get('a.ts')!
    expect(after.broken).toBe(false)
    expect(after.versions[3]!.hunks).toEqual([{ startLine: 7, endLine: 8, newLineCount: 1 }])
    expect(after.versions[3]!.lineCount).toBe(10)
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

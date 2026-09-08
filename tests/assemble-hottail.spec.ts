/**
 * P17a 事实层与热尾单测（docs/implement/archive/P17-boundary-assembler.md §5；docs/04 §2 预算三环）。
 * 贪心停机 / 单单元尾截断 / 地板填充 / 位置兜底 / 装配序 / digest schema / 确定性。
 */
import { describe, expect, it } from 'vitest'
import { foldFileChains, type FileOp } from '../src/core/assemble/chain.ts'
import {
  DEFAULT_ASSEMBLE_POLICY,
  HOT_TAIL_TRUNCATION_MARKER,
  assembleArchive,
  foldAssembleInputs,
  gateHotTailDecls,
  renderArchive,
  renderDigest,
  renderUnitList,
  validateDigest,
  type AssemblePolicy,
  type AssembleUnit,
  type HotTailDecl,
  type LedgerSessionEvent,
} from '../src/core/assemble/index.ts'

const policy = (over: Partial<AssemblePolicy> = {}): AssemblePolicy => ({
  ...DEFAULT_ASSEMBLE_POLICY,
  charsPerToken: 1,
  hotTailTokens: 100,
  minTruncatedChars: 5,
  ...over,
})

const unit = (id: string, seqStart: number, text: string, extra: Partial<AssembleUnit> = {}): AssembleUnit => ({
  id,
  kind: 'tool-pair',
  seqStart,
  seqEnd: seqStart + 1,
  text,
  tokens: text.length,
  ...extra,
})

describe('P17a 热尾：贪心停机与预算', () => {
  it('按申报序累加、到预算即停（可少不多）', () => {
    const units = [unit('a', 1, 'x'.repeat(6)), unit('b', 3, 'y'.repeat(6)), unit('c', 5, 'z'.repeat(6))]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'a' }, { unitId: 'b' }, { unitId: 'c' }], policy: policy({ hotTailTokens: 10 }) })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.hotTail.selections.map((s) => s.unitId)).toEqual(['a'])
    expect(outcome.result.hotTail.stopReason).toBe('budget')
    expect(outcome.result.hotTail.source).toBe('model')
    expect(outcome.result.hotTail.declaredUnits).toBe(3)
  })

  it('申报耗尽 = list-end（预算有余）', () => {
    const units = [unit('a', 1, 'x'.repeat(6)), unit('b', 3, 'y'.repeat(6))]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'a' }, { unitId: 'b' }], policy: policy({ hotTailTokens: 100 }) })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.selections.length).toBe(2)
    expect(outcome.result.hotTail.stopReason).toBe('list-end')
  })

  it('单单元超帽 → 尾截断保头 + 可见标记（总 token 不超预算）', () => {
    const units = [unit('big', 1, 'A'.repeat(100))]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'big' }], policy: policy({ hotTailTokens: 30 }) })
    if (!outcome.ok) throw new Error('expected ok')
    const selection = outcome.result.hotTail.selections[0]!
    expect(selection.truncated).toBe(true)
    expect(selection.text.endsWith(HOT_TAIL_TRUNCATION_MARKER)).toBe(true)
    expect(selection.text.startsWith('A')).toBe(true)
    expect(selection.tokens).toBeLessThanOrEqual(30)
    expect(outcome.result.hotTail.truncated).toBe(1)
  })

  it('tool 对永不拆分（命中即整单元取原文）', () => {
    const units = [unit('pair', 1, 'call+result 完整对')]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'pair' }], policy: policy() })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.selections[0]!.text).toBe('call+result 完整对')
  })
})

describe('P17a 热尾：地板填充与位置兜底', () => {
  it('run 类目未覆盖且预算有余 → 验证尾 + 错误行逐字补入', () => {
    const units = [
      unit('a', 1, 'X'.repeat(20)),
      unit('v', 5, 'run summary\n307 tests passed', { isVerification: true }),
      unit('e', 9, 'start\nError: boom\n[exit code: 1]', { isError: true }),
    ]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'a' }], policy: policy({ hotTailTokens: 200 }) })
    if (!outcome.ok) throw new Error('expected ok')
    const plan = outcome.result.hotTail
    expect(plan.floorFilled).toBe(true)
    expect(plan.selections.map((s) => [s.unitId, s.tier])).toEqual([['a', 'model'], ['v', 'floor'], ['e', 'floor']])
    expect(plan.selections[1]!.text).toBe('307 tests passed')
    expect(plan.selections[2]!.text).toBe('Error: boom\n[exit code: 1]')
  })

  it('run 类目已覆盖 → 不填地板', () => {
    const units = [unit('run', 1, 'build ok', { isRunResult: true }), unit('v', 5, 'ok\n5 tests passed')]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'run' }], policy: policy({ hotTailTokens: 200 }) })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.floorFilled).toBe(false)
    expect(outcome.result.hotTail.selections.length).toBe(1)
  })

  it('地板同单元 ID 去重（已选单元不再补）', () => {
    const units = [
      unit('v', 1, 'ok\n5 tests passed', { isVerification: true }),
      unit('e', 5, 'Error: boom', { isError: true }),
    ]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'v' }], policy: policy({ hotTailTokens: 200 }) })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.selections.map((s) => s.unitId)).toEqual(['v', 'e'])
    expect(outcome.result.hotTail.selections[0]!.tier).toBe('model')
  })

  it('预算不足不填地板', () => {
    const units = [unit('a', 1, 'X'.repeat(20)), unit('v', 5, '5 tests passed')]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'a' }], policy: policy({ hotTailTokens: 20 }) })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.floorFilled).toBe(false)
    expect(outcome.result.hotTail.selections.length).toBe(1)
  })

  it('申报缺失 → 位置兜底反向累加（source = positional-fallback）', () => {
    const units = [unit('a', 1, 'A'.repeat(6)), unit('b', 5, 'B'.repeat(6)), unit('c', 9, 'C'.repeat(6))]
    const outcome = assembleArchive({ units, policy: policy({ hotTailTokens: 12 }) })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.source).toBe('positional-fallback')
    expect(outcome.result.hotTail.selections.map((s) => s.unitId)).toEqual(['b', 'c'])
    expect(outcome.result.hotTail.selections.every((s) => s.tier === 'fallback')).toBe(true)
  })

  it('坐标全部无效 → 丢弃计数 + 位置兜底（不产生 fatal）', () => {
    const units = [unit('a', 1, 'A'.repeat(6)), unit('b', 5, 'B'.repeat(6))]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'ghost-1' }, { unitId: 'ghost-2' }], policy: policy() })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.dropped).toBe(2)
    expect(outcome.result.hotTail.source).toBe('positional-fallback')
    expect(outcome.result.hotTail.selections.map((s) => s.unitId)).toEqual(['a', 'b'])
  })

  it('装配序 = transcript 序（申报序只定取舍）', () => {
    const units = [unit('a', 1, 'A'.repeat(6)), unit('b', 5, 'B'.repeat(6))]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'b' }, { unitId: 'a' }], policy: policy() })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.selections.map((s) => s.unitId)).toEqual(['a', 'b'])
  })
})

describe('P17a 热尾：通道 A 取真', () => {
  const ops: FileOp[] = [{ seq: 1, path: 'a.ts', kind: 'write', content: 'l1\nl2\nl3\nl4\nl5' }]
  const chains = foldFileChains(ops)

  it('坐标有效 + 盘上取真 → source = file（token 按取真文本计）', () => {
    const units = [unit('u1', 1, 'ignored span text')]
    const outcome = assembleArchive({
      units,
      chains,
      hotTail: [{ unitId: 'u1', coord: { path: 'a.ts', version: 1, lineRange: { start: 2, end: 3 } } }],
      resolve: { u1: 'l2\nl3' },
      currentLineCounts: { 'a.ts': 5 },
      policy: policy(),
    })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.selections[0]!.source).toBe('file')
    expect(outcome.result.hotTail.selections[0]!.text).toBe('l2\nl3')
    expect(outcome.result.hotTail.selections[0]!.tokens).toBe(5)
  })

  it('取真缺失 / 文件已删除 → 丢弃计数（不 fatal）', () => {
    const units = [unit('u1', 1, 'span')]
    const missingResolve = assembleArchive({
      units, chains,
      hotTail: [{ unitId: 'u1', coord: { path: 'a.ts', version: 1, lineRange: { start: 1, end: 1 } } }],
      policy: policy(),
    })
    if (!missingResolve.ok) throw new Error('expected ok')
    expect(missingResolve.result.hotTail.dropped).toBe(1)
    const deleted = assembleArchive({
      units, chains,
      hotTail: [{ unitId: 'u1', coord: { path: 'a.ts', version: 1, lineRange: { start: 1, end: 1 } } }],
      resolve: { u1: 'l1' },
      currentLineCounts: { 'a.ts': null },
      policy: policy(),
    })
    if (!deleted.ok) throw new Error('expected ok')
    expect(deleted.result.hotTail.dropped).toBe(1)
  })
})

describe('P17a 事实层：digest schema 与渲染', () => {
  it('渲染序 = 结论先行 wrap→plan→impl→verify + 类型标签，坐标层随后', () => {
    const digest = {
      blocks: [
        { type: 'wrap' as const, text: '收尾' },
        { type: 'plan' as const, text: '计划' },
        { type: 'verify' as const, text: '验收' },
      ],
      coords: [{ path: 'a.ts', version: 3, lineRange: { start: 1, end: 2 } }, { path: 'b.ts', version: 1, symbol: 'fn' }],
    }
    expect(renderDigest(digest)).toBe('【结论】收尾\n\n【计划】计划\n\n【验证】验收\n\na.ts@v3:1-2\nb.ts@v1 fn')
  })

  it('schema 违例 = fatal（坏块型 / 坏坐标 / 坏版本）', () => {
    expect(validateDigest({ blocks: [{ type: 'bogus', text: 'x' }], coords: [] })).toBeUndefined()
    expect(validateDigest({ blocks: [], coords: [{ path: 'a.ts', version: 0 }] })).toBeUndefined()
    expect(validateDigest({ blocks: [], coords: [{ path: 'a.ts', version: 1, lineRange: { start: 3, end: 1 } }] })).toBeUndefined()
    expect(validateDigest({ blocks: [], coords: [] })).toEqual({ blocks: [], coords: [] })
  })

  it('digest schema 违例 → 装配 fatal；空输入 → no-units', () => {
    const bad = assembleArchive({ units: [unit('a', 1, 'x')], digest: { blocks: [{ type: 'bogus' as never, text: 'x' }], coords: [] } })
    expect(bad).toEqual({ ok: false, reason: 'digest-schema' })
    expect(assembleArchive({ units: [] })).toEqual({ ok: false, reason: 'no-units' })
  })

  it('rendered = 摘要 + 热尾（transcript 序）；digestBytes 按 utf8 计', () => {
    const units = [unit('a', 1, '材料')]
    const outcome = assembleArchive({
      units,
      digest: { blocks: [{ type: 'plan', text: '目标' }], coords: [] },
      hotTail: [{ unitId: 'a' }],
      policy: policy(),
    })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.rendered).toBe('【计划】目标\n\n材料')
    expect(renderArchive(outcome.result)).toBe(outcome.result.rendered)
    expect(outcome.result.digestBytes).toBe(new TextEncoder().encode('【计划】目标').length)
    expect(outcome.result.digestEntryCount).toBe(1)
  })

  it('同输入双跑 JSON 相等（字节稳定）', () => {
    const input = {
      units: [unit('a', 1, 'A'.repeat(9)), unit('b', 5, 'B'.repeat(9))],
      hotTail: [{ unitId: 'b' }, { unitId: 'a' }],
      policy: policy({ hotTailTokens: 12 }),
    }
    expect(JSON.stringify(assembleArchive(input))).toBe(JSON.stringify(assembleArchive(input)))
  })
})

describe('P17a 输入 fold：单元清单', () => {
  const events: LedgerSessionEvent[] = [
    { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'a.ts' }) } },
    {
      type: 'tool/result', seq: 2, time: 2,
      data: {
        message: { content: [{ toolCallId: 'c1', content: [{ type: 'text', text: '1: l1\n2: l2' }] }] },
        meta: { path: 'a.ts', offset: 1, lines: [{ number: 1, text: 'l1' }, { number: 2, text: 'l2' }], totalLines: 2 },
      },
    },
    { type: 'tool/call', seq: 3, time: 3, data: { callId: 'c2', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) } },
    { type: 'tool/result', seq: 4, time: 4, data: { message: { content: [{ toolCallId: 'c2', content: [{ type: 'text', text: '5 tests passed' }] }] } } },
  ]

  it('tool 对成单元 + read 窗口进链 + 版本挂单元', () => {
    const inputs = foldAssembleInputs(events)
    expect(inputs.units.length).toBe(2)
    expect(inputs.units[0]!.path).toBe('a.ts')
    expect(inputs.units[0]!.version).toBe(1)
    expect(inputs.units[1]!.isRunResult).toBe(true)
    expect(inputs.units[1]!.isVerification).toBe(true)
    expect(inputs.chains.get('a.ts')!.versions[0]!.content).toEqual(['l1', 'l2'])
  })

  it('单元清单逐行确定（供压缩器 prompt 枚举）', () => {
    const inputs = foldAssembleInputs(events)
    expect(renderUnitList(inputs.units)).toBe('[c1] read a.ts@v1 ~8t\n[c2] bash ~10t')
  })
})

describe('P17c 热尾：HT 软门与计数修复', () => {
  const lines = Array.from({ length: 10 }, (_, i) => 'l' + (i + 1)).join('\n')
  const chains = foldFileChains([
    { seq: 1, path: 'a.ts', kind: 'write', content: lines },
    { seq: 2, path: 'a.ts', kind: 'edit', oldString: 'l3', newString: 'l3a\nl3b' },
  ])

  it('gateHotTailDecls：保持申报序 + 剥离夹带字段 + 两类拒绝', () => {
    const gate = gateHotTailDecls(
      [
        { unitId: 'a', coord: { path: 'x.ts', version: 1, noise: 'drop-me' } },
        { unitId: 'ghost' },
        42,
      ],
      [unit('a', 1, 'x')],
    )
    expect(gate.accepted).toEqual([{ unitId: 'a', coord: { path: 'x.ts', version: 1 } }])
    expect(gate.rejected).toEqual([{ reason: 'unknown-unit', unitId: 'ghost' }, { reason: 'bad-decl' }])
  })

  it('软门：坏形状不抛错、只计数（其余申报照常装填）', () => {
    const bad = [
      null,
      { unitId: '' },
      { unitId: 'a', coord: null },
      { unitId: 'a', coord: { path: 'a.ts', version: 0 } },
      { unitId: 'a', coord: { path: 'a.ts', version: 1, lineRange: { start: 5, end: 2 } } },
      { unitId: 'a' },
      { unitId: 'ghost' },
    ] as unknown as readonly HotTailDecl[]
    const outcome = assembleArchive({ units: [unit('a', 1, 'A'.repeat(6))], hotTail: bad, policy: policy({ hotTailTokens: 100 }) })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.selections.map((selection) => selection.unitId)).toEqual(['a'])
    expect(outcome.result.hotTail.dropReasons.badDecl).toBe(5)
    expect(outcome.result.hotTail.dropReasons.unknownUnit).toBe(1)
    expect(outcome.result.hotTail.dropped).toBe(6)
    expect(outcome.result.hotTail.declaredUnits).toBe(7)
  })

  it('软门：全部拒绝 = 位置兜底（不产生 fatal）', () => {
    const outcome = assembleArchive({ units: [unit('a', 1, 'A'.repeat(6))], hotTail: [{ unitId: 'ghost' }], policy: policy({ hotTailTokens: 100 }) })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.source).toBe('positional-fallback')
    expect(outcome.result.hotTail.selections.map((selection) => selection.unitId)).toEqual(['a'])
  })

  it('clipped：重映射出界裁剪计数（P17a 恒 0 缺陷修复）', () => {
    const outcome = assembleArchive({
      units: [unit('u', 1, 'ignored')],
      chains,
      hotTail: [{ unitId: 'u', coord: { path: 'a.ts', version: 1, lineRange: { start: 10, end: 12 } } }],
      resolve: { u: 'sliced' },
      currentLineCounts: { 'a.ts': 11 },
      policy: policy({ hotTailTokens: 100 }),
    })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.clipped).toBe(1)
    expect(outcome.result.hotTail.selections[0]!.clipped).toBe(true)
    expect(outcome.result.hotTail.selections[0]!.text).toBe('sliced')
  })

  it('dropReasons：未知版本 = remap 计数（坐标全无效 → 兜底）', () => {
    const outcome = assembleArchive({
      units: [unit('u', 1, 'A'.repeat(6))],
      chains,
      hotTail: [{ unitId: 'u', coord: { path: 'a.ts', version: 9, lineRange: { start: 1, end: 2 } } }],
      resolve: { u: 'x' },
      currentLineCounts: { 'a.ts': 11 },
      policy: policy({ hotTailTokens: 100 }),
    })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.dropReasons.remap).toBe(1)
    expect(outcome.result.hotTail.source).toBe('positional-fallback')
  })

  it('位置兜底 token 按 policy.charsPerToken 现算（不混用 fold 期默认 cpt）', () => {
    const outcome = assembleArchive({ units: [unit('a', 1, 'A'.repeat(10))], policy: policy({ charsPerToken: 2, hotTailTokens: 100 }) })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.selections[0]!.tokens).toBe(5)
  })
})


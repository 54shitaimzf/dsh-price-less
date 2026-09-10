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
  normalizeDigest,
  renderUnitList,
  type AssemblePolicy,
  type AssembleUnit,
  type HotTailDecl,
  type LedgerSessionEvent,
} from '../src/core/assemble/index.ts'
import { flatDensity } from '../src/core/meter/index.ts'

const policy = (over: Partial<AssemblePolicy> = {}): AssemblePolicy => ({
  ...DEFAULT_ASSEMBLE_POLICY,
  density: flatDensity(1),
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
  it('Zipf 分配：重要者多分（w_i = 1/i），全部申报都入选', () => {
    const units = [unit('a', 1, 'A'.repeat(300)), unit('b', 3, 'B'.repeat(300)), unit('c', 5, 'C'.repeat(300))]
    const outcome = assembleArchive({
      units,
      hotTail: [{ unitId: 'a' }, { unitId: 'b' }, { unitId: 'c' }],
      policy: policy({ hotTailTokens: 400, pointerOverheadTokens: 0, minTruncatedChars: 5 }),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const entries = outcome.result.hotTail.entries
    expect(entries.map((s) => s.unitId)).toEqual(['a', 'b', 'c'])
    expect(entries[0]!.tokens).toBeGreaterThan(entries[1]!.tokens)
    expect(entries[1]!.tokens).toBeGreaterThan(entries[2]!.tokens)
    expect(outcome.result.hotTail.source).toBe('model')
    expect(outcome.result.hotTail.declaredUnits).toBe(3)
    expect(outcome.result.hotTail.tokens).toBeLessThanOrEqual(400)
  })

  it('申报耗尽 = list-end（预算有余）', () => {
    const units = [unit('a', 1, 'x'.repeat(6)), unit('b', 3, 'y'.repeat(6))]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'a' }, { unitId: 'b' }], policy: policy({ hotTailTokens: 100 }) })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.entries.length).toBe(2)
    expect(outcome.result.hotTail.stopReason).toBe('list-end')
  })

  it('单单元超帽 → 尾截断保头 + 可见标记（总 token 不超预算）', () => {
    const units = [unit('big', 1, 'A'.repeat(100))]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'big' }], policy: policy({ hotTailTokens: 30, pointerOverheadTokens: 0 }) })
    if (!outcome.ok) throw new Error('expected ok')
    const selection = outcome.result.hotTail.entries[0]!
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
    expect(outcome.result.hotTail.entries[0]!.text).toBe('call+result 完整对')
  })
})

describe('P17a 热尾：地板填充与位置兜底', () => {
  it('run 类目未覆盖且预算有余 → 验证尾逐字补入（错误行地板退役：F10）', () => {
    const units = [
      unit('a', 1, 'X'.repeat(20)),
      unit('v', 5, 'run summary\n307 tests passed', { isVerification: true }),
      unit('e', 9, 'start\nError: boom\n[exit code: 1]', { isError: true }),
    ]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'a' }], policy: policy({ hotTailTokens: 200 }) })
    if (!outcome.ok) throw new Error('expected ok')
    const plan = outcome.result.hotTail
    expect(plan.floorFilled).toBe(true)
    expect(plan.entries.map((s) => [s.unitId, s.tier])).toEqual([['a', 'model'], ['v', 'floor']])
    expect(plan.entries[1]!.text).toBe('307 tests passed')
  })

  it('run 类目已覆盖 → 不填地板', () => {
    const units = [unit('run', 1, 'build ok', { isRunResult: true }), unit('v', 5, 'ok\n5 tests passed')]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'run' }], policy: policy({ hotTailTokens: 200 }) })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.floorFilled).toBe(false)
    expect(outcome.result.hotTail.entries.length).toBe(1)
  })

  it('地板同单元 ID 去重（已选单元不再补）', () => {
    const units = [
      unit('v', 1, 'ok\n5 tests passed', { isVerification: true }),
      unit('v2', 5, 'build ok', { isVerification: true }),
    ]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'v' }], policy: policy({ hotTailTokens: 200 }) })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.entries.map((s) => s.unitId)).toEqual(['v', 'v2'])
    expect(outcome.result.hotTail.entries[0]!.tier).toBe('model')
  })

  it('错误单元不进热尾：申报丢弃（error 归因）+ 地板不补 + 兜底跳过', () => {
    const units = [unit('e', 1, 'start\nError: boom\n[exit code: 1]', { isError: true })]
    const declared = assembleArchive({ units, hotTail: [{ unitId: 'e' }], policy: policy({ hotTailTokens: 200 }) })
    if (!declared.ok) throw new Error('expected ok')
    expect(declared.result.hotTail.entries).toHaveLength(0)
    expect(declared.result.hotTail.dropReasons.error).toBe(1)
    const fallback = assembleArchive({ units, policy: policy({ hotTailTokens: 200 }) })
    if (!fallback.ok) throw new Error('expected ok')
    expect(fallback.result.hotTail.entries).toHaveLength(0)
  })

  it('预算不足不填地板', () => {
    // v4：span 条目不吃定位预留，预算必须真的不够（10 < 20）才丢弃。
    const units = [unit('a', 1, 'X'.repeat(20)), unit('v', 5, '5 tests passed')]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'a' }], policy: policy({ hotTailTokens: 10 }) })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.floorFilled).toBe(false)
    expect(outcome.result.hotTail.entries.length).toBe(0)
    expect(outcome.result.hotTail.quotaDrops).toBe(1)
  })

  it('申报缺失 → 位置兜底反向累加（source = positional-fallback）', () => {
    const units = [unit('a', 1, 'A'.repeat(6)), unit('b', 5, 'B'.repeat(6)), unit('c', 9, 'C'.repeat(6))]
    const outcome = assembleArchive({ units, policy: policy({ hotTailTokens: 12 }) })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.source).toBe('positional-fallback')
    // F9：兜底按反向 transcript 序 push，条目序 = 装配序（不再按 seqStart 重排）。
    expect(outcome.result.hotTail.entries.map((s) => s.unitId)).toEqual(['c', 'b'])
    expect(outcome.result.hotTail.entries.every((s) => s.tier === 'fallback')).toBe(true)
  })

  it('坐标全部无效 → 丢弃计数 + 位置兜底（不产生 fatal）', () => {
    const units = [unit('a', 1, 'A'.repeat(6)), unit('b', 5, 'B'.repeat(6))]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'ghost-1' }, { unitId: 'ghost-2' }], policy: policy() })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.dropped).toBe(2)
    expect(outcome.result.hotTail.source).toBe('positional-fallback')
    expect(outcome.result.hotTail.entries.map((s) => s.unitId)).toEqual(['b', 'a'])
  })

  it('装配序 = 申报序（F10：▸n = 数组下标 + 1）', () => {
    const units = [unit('a', 1, 'A'.repeat(6)), unit('b', 5, 'B'.repeat(6))]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'b' }, { unitId: 'a' }], policy: policy() })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.entries.map((s) => s.unitId)).toEqual(['b', 'a'])
    expect(outcome.result.hotTail.entries.map((s) => s.rank)).toEqual([1, 2])
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
    expect(outcome.result.hotTail.entries[0]!.source).toBe('file')
    expect(outcome.result.hotTail.entries[0]!.text).toBe('l2\nl3')
    expect(outcome.result.hotTail.entries[0]!.tokens).toBe(5)
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

describe('F9 事实层：摘要 schema 与渲染', () => {
  it('渲染 = 【总述】+ 分步（零指针）+ 【热尾｜档案 vN】（F10）', () => {
    const units = [unit('a', 1, '材料A'), unit('b', 5, '材料B')]
    const outcome = assembleArchive({
      units,
      digest: {
        gist: '总目标与方向',
        steps: [{ type: 'plan', text: '先做一' }, { type: 'verify', text: '再验二' }],
      },
      hotTail: [{ unitId: 'a' }, { unitId: 'b' }],
      policy: policy(),
    })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.rendered).toBe(
      '【总述】总目标与方向\n【计划】先做一\n【验证】再验二\n\n【热尾｜档案 v1】\n▸1 材料A\n▸2 材料B',
    )
    expect(outcome.result.digestText).toBe('【总述】总目标与方向\n【计划】先做一\n【验证】再验二')
    expect(outcome.result.hotTail.archiveRef).toBe('v1')
    expect(outcome.result.digestPlan.stepCount).toBe(2)
    expect(outcome.result.digestPlan.bytes).toBe(
      new TextEncoder().encode('【总述】总目标与方向\n【计划】先做一\n【验证】再验二').length,
    )
  })

  it('机械归一化：坏形状一律修复（未知 type→note / refs 机械剥离 / 缺 gist 接受）', () => {
    const n = normalizeDigest({
      gist: 42,
      steps: [
        { type: 'bogus', text: 'x' },
        { type: 'plan', text: 'ok', refs: [0, 1, '2', 2, 1.5, 'x'] },
        { text: '   ' },
        'not-an-object',
      ],
    })
    expect(n.digest.gist).toBe('')
    expect(n.digest.steps).toEqual([
      { type: 'note', text: 'x' },
      { type: 'plan', text: 'ok' },
    ])
    expect(n.stepDrops).toBe(2)
  })

  it('摘要硬帽：超限从最后一条分步起整条丢弃', () => {
    const outcome = assembleArchive({
      units: [unit('a', 1, '材料')],
      digest: {
        gist: 'g',
        steps: [
          { type: 'plan', text: 'A'.repeat(60) },
          { type: 'plan', text: 'B'.repeat(60) },
        ],
      },
      hotTail: [{ unitId: 'a' }],
      policy: policy({ digestMaxTokens: 10, density: flatDensity(1) }),
    })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.digestPlan.stepCount).toBe(0)
    expect(outcome.result.digestText).toBe('【总述】g')
  })

  it('摘要事实泄漏只记账不拒单（factLeaks）', () => {
    const outcome = assembleArchive({
      units: [unit('a', 1, '材料')],
      digest: { gist: '改 src/domains/compaction.ts', steps: [] },
      hotTail: [{ unitId: 'a' }],
      policy: policy(),
    })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.digestPlan.factLeaks).toBeGreaterThan(0)
  })

  it('空输入 → no-units；非对象摘要 = 空摘要（不 fatal）', () => {
    expect(assembleArchive({ units: [] })).toEqual({ ok: false, reason: 'no-units' })
    const ok = assembleArchive({ units: [unit('a', 1, 'x')], digest: 'nonsense' as never, policy: policy() })
    expect(ok.ok).toBe(true)
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
    // 两桶密度（其余 2.9 字符/token）：'1: l1\n2: l2'(11) → 4；'5 tests passed'(14) → 5
    expect(renderUnitList(inputs.units)).toBe('[c1] read a.ts@v1 ~4t\n[c2] bash ~5t')
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
    expect(outcome.result.hotTail.entries.map((selection) => selection.unitId)).toEqual(['a'])
    expect(outcome.result.hotTail.dropReasons.badDecl).toBe(5)
    expect(outcome.result.hotTail.dropReasons.unknownUnit).toBe(1)
    expect(outcome.result.hotTail.dropped).toBe(6)
    expect(outcome.result.hotTail.declaredUnits).toBe(7)
  })

  it('软门：全部拒绝 = 位置兜底（不产生 fatal）', () => {
    const outcome = assembleArchive({ units: [unit('a', 1, 'A'.repeat(6))], hotTail: [{ unitId: 'ghost' }], policy: policy({ hotTailTokens: 100 }) })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.source).toBe('positional-fallback')
    expect(outcome.result.hotTail.entries.map((selection) => selection.unitId)).toEqual(['a'])
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
    expect(outcome.result.hotTail.entries[0]!.clipped).toBe(true)
    expect(outcome.result.hotTail.entries[0]!.text).toBe('sliced')
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

  it('位置兜底 token 按 policy.density 现算（不混用 fold 期默认密度）', () => {
    const outcome = assembleArchive({ units: [unit('a', 1, 'A'.repeat(10))], policy: policy({ density: flatDensity(2), hotTailTokens: 100 }) })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.entries[0]!.tokens).toBe(5)
  })
})

describe('F9c 热尾：事实载体与预算（份额帽 / 仅指针 / 去重 / 消息单元）', () => {
  it('份额帽：热尾 ≤ maxShare × 区间 − 摘要（防缩水校验打回）', () => {
    const units = [unit('a', 1, 'A'.repeat(1000))]
    const outcome = assembleArchive({
      units,
      hotTail: [{ unitId: 'a' }],
      regionTokens: 1000,
      policy: policy({ hotTailTokens: 10000, pointerOverheadTokens: 0, minTruncatedChars: 5 }),
    })
    if (!outcome.ok) throw new Error('expected ok')
    // maxShare 0.4 × 1000 = 400（摘要估算 = 0）；minShare 0.05 × 1000 = 50。
    expect(outcome.result.hotTail.budgetTokens).toBe(400)
    expect(outcome.result.hotTail.tokens).toBeLessThanOrEqual(400)
  })

  it('U11.1：摘要估算按截断后文本——超长总述/分步不会把份额帽压到 0.05 下限', () => {
    const REGION = 100_000
    const maxShareCap = Math.ceil(REGION * 0.4)
    const minShareFloor = Math.ceil(REGION * 0.05)
    const units = [unit('a', 1, 'A'.repeat(1000))]
    // 摘要超长（远超 gistMaxChars 80 / stepMaxChars 120 / digestMaxTokens 1000）
    const longDigest = {
      gist: 'G'.repeat(4000),
      steps: Array.from({ length: 30 }, (_, i) => ({ type: 'plan' as const, text: `${i}:${'S'.repeat(4000)}` })),
    }
    const outcome = assembleArchive({
      units,
      digest: longDigest,
      hotTail: [{ unitId: 'a' }],
      regionTokens: REGION,
      policy: policy({ hotTailTokens: 1_000_000, pointerOverheadTokens: 0, minTruncatedChars: 5 }),
    })
    if (!outcome.ok) throw new Error('expected ok')
    // 不变量：份额帽 = maxShare×区间 − **截断后**摘要头体量（digestPlan.tokens 就是截断后体量）。
    // 旧实现拿未截断原文估（≈3 万 token）→ 预算被砍到 1 万上下；两者必须相等才算"同一渲染函数"。
    expect(outcome.result.hotTail.budgetTokens).toBe(maxShareCap - outcome.result.digestPlan.tokens)
    // 且确实没落到 minShare 地板
    expect(outcome.result.hotTail.budgetTokens).toBeGreaterThan(maxShareCap - 5_000)
    expect(outcome.result.hotTail.budgetTokens).toBeGreaterThan(minShareFloor)
  })

  it('U13.1：截断条目重估后收口 ≤ 配额（旧实现只切不算 → 越帽 → 缩水校验把整单打回）', () => {
    // 混合密度长文本 + 极小预算：按配额反推的 chars 在两桶密度下不保证 estimate ≤ quota
    const mixed = `${'x'.repeat(600)}${'必'.repeat(400)}`
    const units = [unit('a', 1, mixed)]
    const outcome = assembleArchive({
      units,
      hotTail: [{ unitId: 'a' }],
      policy: policy({ hotTailTokens: 60, pointerOverheadTokens: 40, minTruncatedChars: 5 }),
    })
    if (!outcome.ok) throw new Error('expected ok')
    const hot = outcome.result.hotTail
    // 核心不变量：总用量（含幸存 locator 开销）绝不越过预算
    const located = hot.entries.filter((entry) => entry.locator !== undefined).length
    expect(hot.tokens + located * 40).toBeLessThanOrEqual(hot.budgetTokens)
    for (const entry of hot.entries) expect(entry.tokens).toBeLessThanOrEqual(hot.budgetTokens)
  })

  it('配额不足 → 丢弃（F10：无内容 = 无定位价值；quotaDrops 计数）', () => {
    const units = [unit('a', 1, 'A'.repeat(100))]
    const outcome = assembleArchive({
      units,
      hotTail: [{ unitId: 'a' }],
      policy: policy({ hotTailTokens: 10, pointerOverheadTokens: 0, minTruncatedChars: 20 }),
    })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.entries).toHaveLength(0)
    expect(outcome.result.hotTail.quotaDrops).toBe(1)
  })

  it('重复 unitId 只留首次（dup 归因）', () => {
    const units = [unit('a', 1, 'AAA')]
    const outcome = assembleArchive({ units, hotTail: [{ unitId: 'a' }, { unitId: 'a' }], policy: policy() })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.entries).toHaveLength(1)
    expect(outcome.result.hotTail.dropReasons.dup).toBe(1)
  })

  it('fact 子串校验：命中即并入内容；未命中丢弃并计数（防自造事实）', () => {
    const units = [unit('a', 1, 'line1\ncmd --flag=1\nline3')]
    const hit = assembleArchive({ units, hotTail: [{ unitId: 'a', fact: 'cmd --flag=1' }], policy: policy() })
    if (!hit.ok) throw new Error('expected ok')
    expect(hit.result.hotTail.entries[0]!.text).toContain('cmd --flag=1')
    const miss = assembleArchive({ units, hotTail: [{ unitId: 'a', fact: 'not-in-unit' }], policy: policy() })
    if (!miss.ok) throw new Error('expected ok')
    expect(miss.result.hotTail.dropReasons.factReject).toBe(1)
    expect(miss.result.hotTail.entries[0]!.text).not.toContain('not-in-unit')
  })

  it('fact 兜底：盘上取真缺失但摘抄命中原文 → 仅摘抄条目（事实不丢）', () => {
    const chains = foldFileChains([{ seq: 1, path: 'a.ts', kind: 'write', content: 'l1\nl2' }])
    const units = [unit('u', 1, '原文 l1')]
    const outcome = assembleArchive({
      units, chains,
      hotTail: [{ unitId: 'u', coord: { path: 'a.ts', version: 1, lineRange: { start: 1, end: 1 } }, fact: '原文 l1' }],
      policy: policy(),
    })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.hotTail.entries[0]!.source).toBe('fact')
    expect(outcome.result.hotTail.entries[0]!.text).toBe('原文 l1')
    expect(outcome.result.hotTail.dropped).toBe(0)
  })

  it('user/assistant 消息成单元（kind=message；插件检查点排除）', () => {
    const events: LedgerSessionEvent[] = [
      { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '约束：不得改 X' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 1, time: 2, data: { message: { content: [{ type: 'text', text: '结论 A' }, { type: 'tool-call', toolCallId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' }] } } },
      { type: 'user/message', seq: 2, time: 3, data: { content: [{ type: 'text', text: 'C1' }], source: { kind: 'plugin', plugin: 'compact' } } },
    ]
    const inputs = foldAssembleInputs(events)
    expect(inputs.units.map((u) => [u.id, u.kind, u.text])).toEqual([
      ['seq-0', 'message', '约束：不得改 X'],
      ['seq-1', 'message', '结论 A\n[tool-call] bash {"command":"npm test"}'],
    ])
  })
})



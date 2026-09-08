/**
 * P17c 档案形态与硬帽单测（docs/implement/archive/P17-boundary-assembler.md §5/§8；docs/04 §6 + §3 机制 A）。
 * 15K 硬帽整条截断 / 两形态（单块 / [C…][D]）/ append-only（stub 不可重压）/ priorChain 续传 / 确定性。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ASSEMBLE_POLICY,
  archiveChainAppendOnly,
  archiveChainMonotone,
  archiveChainShape,
  assembleArchive,
  truncateArchiveArea,
  type ArchiveEntry,
  type AssemblePolicy,
  type AssembleUnit,
} from '../src/core/assemble/index.ts'
import { flatDensity } from '../src/core/meter/index.ts'

const entry = (kind: 'checkpoint' | 'boundary', text: string, taskId = 't1'): ArchiveEntry => ({ taskId, kind, text })
const policy = (over: Partial<AssemblePolicy> = {}): AssemblePolicy => ({
  ...DEFAULT_ASSEMBLE_POLICY,
  density: flatDensity(1),
  archiveTokens: 20,
  ...over,
})
const unit = (id: string, seqStart: number, text: string): AssembleUnit => ({
  id,
  kind: 'tool-pair',
  seqStart,
  seqEnd: seqStart + 1,
  text,
  tokens: text.length,
})

describe('P17c 档案：策略初值', () => {
  it('档案区硬帽 = 10K 绝对设计值（F9；与热尾 10K 分列）', () => {
    expect(DEFAULT_ASSEMBLE_POLICY.archiveTokens).toBe(10000)
    expect(DEFAULT_ASSEMBLE_POLICY.hotTailTokens).toBe(10000)
  })
})

describe('P17c 档案：追加式链两形态（04 §3 机制 A）', () => {
  it('empty / prefix / single / chain 四态可辨', () => {
    expect(archiveChainShape([]).shape).toBe('empty')
    expect(archiveChainShape([entry('checkpoint', 'c1')]).shape).toBe('prefix')
    expect(archiveChainShape([entry('checkpoint', 'c1'), entry('checkpoint', 'c2')]).shape).toBe('prefix')
    expect(archiveChainShape([entry('boundary', 'd')]).shape).toBe('single')
    expect(archiveChainShape([entry('checkpoint', 'c1'), entry('boundary', 'd')]).shape).toBe('chain')
  })

  it('D 在 C 前 = order 违例；坏条目 / 跨 task = shape 违例', () => {
    expect(archiveChainShape([entry('boundary', 'd'), entry('checkpoint', 'c')])).toEqual({ shape: 'invalid', reason: 'order' })
    expect(archiveChainShape([{ taskId: 't1', kind: 'bogus', text: 'x' }])).toEqual({ shape: 'invalid', reason: 'shape' })
    expect(archiveChainShape([{ taskId: '', kind: 'boundary', text: 'x' }])).toEqual({ shape: 'invalid', reason: 'shape' })
    expect(archiveChainShape([entry('checkpoint', 'c', 't1'), entry('boundary', 'd', 't2')])).toEqual({ shape: 'invalid', reason: 'shape' })
    expect(archiveChainShape(undefined)).toEqual({ shape: 'invalid', reason: 'shape' })
  })

  it('append-only：前缀逐条字节恒等（旧块不可改写）', () => {
    const c1 = entry('checkpoint', 'c1')
    const c2 = entry('checkpoint', 'c2')
    const d = entry('boundary', 'd')
    expect(archiveChainAppendOnly([c1], [c1, d])).toBe(true)
    expect(archiveChainAppendOnly([c1, c2], [c1, c2, d])).toBe(true)
    expect(archiveChainAppendOnly([c1], [entry('checkpoint', 'c1-rewritten')])).toBe(false)
    expect(archiveChainAppendOnly([c1, c2], [c1])).toBe(false)
  })

  it('F9d 单调追加守卫：允许最老整条截断 + 尾部追加；改写幸存条目 = 违规', () => {
    const c1 = entry('checkpoint', 'c1')
    const c2 = entry('checkpoint', 'c2')
    const d = entry('boundary', 'd')
    expect(archiveChainMonotone([], [c1])).toBe(true)
    expect(archiveChainMonotone([c1], [c1, d])).toBe(true)
    // 最老整条被截断：next = prev 的后缀 + 追加。
    expect(archiveChainMonotone([c1, c2], [c2, d])).toBe(true)
    // 全部最老被截断（无幸存条目）：合法。
    expect(archiveChainMonotone([c1, c2], [d])).toBe(true)
    // 改写幸存条目 = 违规（形状 = 幸存后缀 + 恰好一条新条目；改写使后缀错位）。
    expect(archiveChainMonotone([c1, c2], [c1, entry('checkpoint', 'c2-rewritten'), d])).toBe(false)
    expect(archiveChainMonotone([c1, c2], [entry('checkpoint', 'c1-rewritten'), c2])).toBe(false)
    // 一次追加只能多一条：next 比 prev 多 2 条且不截断 = 违规。
    expect(archiveChainMonotone([c1], [c1, d, entry('boundary', 'd2')])).toBe(false)
  })
})

describe('P17c 档案：15K 硬帽机械截断（04 §6）', () => {
  it('入限 = no-op（一条不动）', () => {
    const area = [entry('boundary', 'x'.repeat(6)), entry('boundary', 'y'.repeat(6))]
    const result = truncateArchiveArea(area, policy({ archiveTokens: 20 }))
    expect(result.kept.length).toBe(2)
    expect(result.truncated).toEqual({ count: 0, tokens: 0 })
    expect(result.keptTokens).toBe(12)
    expect(result.overCap).toBe(false)
  })

  it('超限 = 从最老起整条截断至入限（保连续后缀，不跳洞）', () => {
    const area = [entry('boundary', 'a'.repeat(10)), entry('boundary', 'b'.repeat(10)), entry('boundary', 'c'.repeat(10))]
    const result = truncateArchiveArea(area, policy({ archiveTokens: 20 }))
    expect(result.kept.map((item) => item.text)).toEqual(['b'.repeat(10), 'c'.repeat(10)])
    expect(result.truncated).toEqual({ count: 1, tokens: 10 })
    expect(result.keptTokens).toBe(20)
    expect(result.overCap).toBe(false)
  })

  it('恰好等于硬帽 = 全部保留（≤ 口径）', () => {
    const area = [entry('boundary', 'a'.repeat(10)), entry('boundary', 'b'.repeat(10))]
    const result = truncateArchiveArea(area, policy({ archiveTokens: 20 }))
    expect(result.kept.length).toBe(2)
    expect(result.truncated.count).toBe(0)
  })

  it('最新单条自身超帽 = 保最新一条 + overCap（不空档，失败方向 = 保留）', () => {
    const area = [entry('boundary', 'a'.repeat(5)), entry('boundary', 'b'.repeat(30))]
    const result = truncateArchiveArea(area, policy({ archiveTokens: 20 }))
    expect(result.kept.map((item) => item.text)).toEqual(['b'.repeat(30)])
    expect(result.truncated).toEqual({ count: 1, tokens: 5 })
    expect(result.overCap).toBe(true)
  })

  it('确定性：同输入双跑相等 + 输入不 mutate', () => {
    const area = [entry('boundary', 'a'.repeat(10)), entry('boundary', 'b'.repeat(10)), entry('boundary', 'c'.repeat(10))]
    const snapshot = JSON.stringify(area)
    expect(JSON.stringify(truncateArchiveArea(area, policy()))).toBe(JSON.stringify(truncateArchiveArea(area, policy())))
    expect(JSON.stringify(area)).toBe(snapshot)
  })
})

describe('P17c 装配：priorChain 续传 + 追加（04 §3 机制 A）', () => {
  const base = { units: [unit('a', 1, 'A'.repeat(4))], hotTail: [{ unitId: 'a' }], policy: policy({ hotTailTokens: 100 }) }

  it('无 priorChain = 单块形态（single）', () => {
    const outcome = assembleArchive(base)
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.archiveForm).toEqual({ form: 'single', checkpointCount: 0 })
    expect(outcome.result.rendered).toBe('【热尾】\n▸1 [历史] 会话 1-2\n' + 'A'.repeat(4))
  })

  it('priorChain = [C…] → 续传旧块 + 追加新块（chain）', () => {
    const outcome = assembleArchive({ ...base, priorChain: [entry('checkpoint', 'C1'), entry('checkpoint', 'C2')] })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.archiveForm).toEqual({ form: 'chain', checkpointCount: 2 })
    expect(outcome.result.rendered).toBe('C1\n\nC2\n\n【热尾】\n▸1 [历史] 会话 1-2\n' + 'A'.repeat(4))
  })

  it('priorChain 非 empty|prefix（已闭合链 / D 在 C 前）= schema fatal', () => {
    expect(assembleArchive({ ...base, priorChain: [entry('boundary', 'D')] }).reason).toBe('digest-schema')
    expect(assembleArchive({ ...base, priorChain: [entry('checkpoint', 'C1'), entry('boundary', 'D')] }).reason).toBe('digest-schema')
    expect(assembleArchive({ ...base, priorChain: [entry('boundary', 'D'), entry('checkpoint', 'C')] }).reason).toBe('digest-schema')
  })

  it('priorChain + digest + 热尾的渲染序 = 旧块 → 摘要 → 热尾（字节稳定）', () => {
    const outcome = assembleArchive({
      ...base,
      priorChain: [entry('checkpoint', 'C1')],
      digest: { gist: '结论', steps: [] },
    })
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.result.rendered).toBe('C1\n\n【总述】结论\n\n【热尾】\n▸1 [历史] 会话 1-2\n' + 'A'.repeat(4))
    expect(outcome.result.digestPlan.bytes).toBe(Buffer.byteLength('【总述】结论', 'utf8'))
  })
})

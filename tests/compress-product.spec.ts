/**
 * P18 产物解析与 schema 校验单测（docs/implement/archive/P18-compress-call.md §5；docs/04 §2/§3）。
 * 围栏剥离 / 平衡抽取 / 三环 fatal 口径 / HT 软门降级 / 缝两校验 / 永不抛错。
 */
import { describe, expect, it } from 'vitest'
import {
  extractJsonObject,
  parseCompressProduct,
  stripProductFences,
  validateCheckpoint,
  validateCutPoint,
  type AssembleUnit,
} from '../src/core/compress/index.ts'

const unit = (id: string, extra: Partial<AssembleUnit> = {}): AssembleUnit => ({
  id,
  kind: 'tool-pair',
  seqStart: 1,
  seqEnd: 2,
  text: `text-${id}`,
  tokens: 10,
  ...extra,
})

const boundaryJson = JSON.stringify({
  gist: '目标与方向',
  steps: [
    { type: 'plan', text: '先做一', refs: [1] },
    { type: 'impl', text: '再做二' },
  ],
  hotTail: [{ unitId: 'a', coord: { path: 'src/a.ts', version: 2, lineRange: { start: 1, end: 3 } } }],
})

describe('P18 产物：机械抽取', () => {
  it('围栏剥离与平衡抽取（字符串内括号不计数）', () => {
    expect(stripProductFences('\n\`\`\`json\n{"a":1}\n\`\`\`\n')).toBe('{"a":1}')
    expect(stripProductFences('{"a":1}')).toBe('{"a":1}')
    expect(extractJsonObject('前言 {"s":"} not end","n":{"x":1}} 后记')).toBe('{"s":"} not end","n":{"x":1}}')
    expect(extractJsonObject('no braces')).toBeUndefined()
    expect(extractJsonObject('{"unclosed":1')).toBeUndefined()
  })
})

describe('P18/F9 产物：边界模式（宽松修复 > 拒单）', () => {
  it('合法产物 → ok（gist/steps/refs + 热尾申报）', () => {
    const result = parseCompressProduct(boundaryJson, 'boundary', [unit('a')])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.product.mode).toBe('boundary')
    if (result.product.mode !== 'boundary') return
    expect(result.product.digest.gist).toBe('目标与方向')
    expect(result.product.digest.steps).toEqual([
      { type: 'plan', text: '先做一', refs: [1] },
      { type: 'impl', text: '再做二', refs: [] },
    ])
    expect(result.product.hotTail).toEqual([
      { unitId: 'a', coord: { path: 'src/a.ts', version: 2, lineRange: { start: 1, end: 3 } } },
    ])
    expect(result.dropped).toEqual({ badDecl: 0, unknownUnit: 0, remap: 0, fetch: 0, dup: 0, factReject: 0 })
  })

  it('围栏 + 前后噪声仍可解析（格式噪声不杀死一次有效压缩）', () => {
    const raw = `以下是产物：\n\`\`\`json\n${boundaryJson}\n\`\`\`\n（完）`
    expect(parseCompressProduct(raw, 'boundary', [unit('a')]).ok).toBe(true)
  })

  it('非 JSON = parse fatal（唯一硬失败）；摘要坏形状一律机械修复', () => {
    expect(parseCompressProduct('这不是 JSON', 'boundary', [])).toEqual({ ok: false, reason: 'parse' })
    // 旧 schema / 坏类型 / 缺字段：全部归一为空摘要，不再 fatal。
    for (const raw of [
      '{"digest":{"blocks":"x","coords":[]}}',
      '{"digest":{"blocks":[],"coords":[{"path":"a","version":0}]}}',
      '{"digest":{"blocks":[{"type":"other","text":"x"}],"coords":[]}}',
      '{"gist":1,"steps":"x"}',
      '{}',
    ]) {
      const result = parseCompressProduct(raw, 'boundary', [])
      expect(result.ok).toBe(true)
      if (!result.ok || result.product.mode !== 'boundary') return
      expect(result.product.digest).toEqual({ gist: '', steps: [] })
    }
  })

  it('hotTail 缺失 / 非数组 = ok + 空申报（装配器回退位置法，不 fatal）', () => {
    for (const raw of [
      JSON.stringify({ gist: '结论', steps: [] }),
      '{"gist":"结论","steps":[],"hotTail":"x"}',
    ]) {
      const result = parseCompressProduct(raw, 'boundary', [])
      expect(result.ok).toBe(true)
      if (!result.ok || result.product.mode !== 'boundary') return
      expect(result.product.hotTail).toEqual([])
    }
  })

  it('坏热尾申报只降级计数（HT 软门：badDecl / unknownUnit），好申报保留', () => {
    const raw = JSON.stringify({
      gist: '结论',
      steps: [],
      hotTail: [{ unitId: 'a' }, { unitId: 'ghost' }, { unitId: 'b', coord: null }, { coord: { path: 'x', version: 1 } }, 'junk'],
    })
    const result = parseCompressProduct(raw, 'boundary', [unit('a'), unit('b')])
    expect(result.ok).toBe(true)
    if (!result.ok || result.product.mode !== 'boundary') return
    expect(result.product.hotTail).toEqual([{ unitId: 'a' }])
    expect(result.dropped.badDecl).toBe(3)
    expect(result.dropped.unknownUnit).toBe(1)
  })

  it('fact 字段透传（逐字摘抄；子串校验归装配器）', () => {
    const raw = JSON.stringify({ gist: 'g', steps: [], hotTail: [{ unitId: 'a', fact: 'verbatim' }] })
    const result = parseCompressProduct(raw, 'boundary', [unit('a')])
    expect(result.ok).toBe(true)
    if (!result.ok || result.product.mode !== 'boundary') return
    expect(result.product.hotTail).toEqual([{ unitId: 'a', fact: 'verbatim' }])
  })
})

describe('P18 产物：压力模式', () => {
  const pressureJson = JSON.stringify({
    checkpoint: { progress: 'p', currentState: 'c', nextStep: 'n', liveConstraints: ['约束'] },
    cutPoint: { unitId: 'a' },
  })

  it('合法产物 → ok（检查点 + 缝）', () => {
    const result = parseCompressProduct(pressureJson, 'pressure', [unit('a')])
    expect(result.ok).toBe(true)
    if (!result.ok || result.product.mode !== 'pressure') return
    expect(result.product.checkpoint.liveConstraints).toEqual(['约束'])
    expect(result.product.cutPoint).toEqual({ unitId: 'a' })
  })

  it('检查点字段缺失/类型错 = schema', () => {
    expect(validateCheckpoint({ progress: 'p', currentState: 'c', nextStep: 'n' })).toBeUndefined()
    expect(validateCheckpoint({ progress: 'p', currentState: 'c', nextStep: 'n', liveConstraints: [1] })).toBeUndefined()
    expect(validateCheckpoint(null)).toBeUndefined()
  })

  it('缝两校验：未知单元 / 空串 / 切开工具对 = schema（04 §3 机械校验仅两条）', () => {
    expect(validateCutPoint({ unitId: 'ghost' }, [unit('a')])).toEqual({ ok: false, reason: 'unknown-unit' })
    expect(validateCutPoint({ unitId: '' }, [unit('a')])).toEqual({ ok: false, reason: 'schema' })
    expect(validateCutPoint({ unitId: 'a' }, [unit('a')])).toEqual({ ok: true, cutPoint: { unitId: 'a' } })
    const pair = unit('p', { kind: 'tool-pair', seqStart: 1, seqEnd: 4 })
    const inside = unit('m', { kind: 'message', seqStart: 2, seqEnd: 2 })
    const outside = unit('m2', { kind: 'message', seqStart: 5, seqEnd: 5 })
    expect(validateCutPoint({ unitId: 'm' }, [pair, inside])).toEqual({ ok: false, reason: 'pair-split' })
    expect(validateCutPoint({ unitId: 'm2' }, [pair, outside]).ok).toBe(true)
    expect(parseCompressProduct(JSON.stringify({
      checkpoint: { progress: 'p', currentState: 'c', nextStep: 'n', liveConstraints: [] },
      cutPoint: { unitId: 'm' },
    }), 'pressure', [pair, inside])).toEqual({ ok: false, reason: 'schema' })
  })

  it('任何输入都不抛错（null / 数组 / 数字 / 超长噪声）', () => {
    for (const raw of ['', 'null', '[]', '42', '{'.repeat(5000), '\u0000\u0001']) {
      expect(() => parseCompressProduct(raw, 'boundary', [])).not.toThrow()
      expect(() => parseCompressProduct(raw, 'pressure', [])).not.toThrow()
    }
  })
})

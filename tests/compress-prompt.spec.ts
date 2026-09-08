/**
 * P18 两模式 prompt 组装单测（docs/implement/P18-compress-call.md §5；docs/04 §2/§3）。
 * 模板在前 / 清单在尾 / 零预算泄漏 / 续传面 / 上限计数 / 字节稳定。
 */
import { describe, expect, it } from 'vitest'
import {
  COMPRESS_BOUNDARY_HEAD,
  COMPRESS_POLICY_VERSION,
  COMPRESS_PRESSURE_HEAD,
  COMPRESS_PROMPT_VERSION,
  DEFAULT_COMPRESS_POLICY,
  compressUnitList,
  renderBoundaryPrompt,
  renderPressurePrompt,
  renderPriorChain,
  type ArchiveEntry,
  type AssembleUnit,
  type CompressPolicy,
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

const policy = (over: Partial<CompressPolicy> = {}): CompressPolicy => ({ ...DEFAULT_COMPRESS_POLICY, ...over })

const entry = (taskId: string, kind: ArchiveEntry['kind'], text: string): ArchiveEntry => ({ taskId, kind, text })

describe('P18 prompt：两模式组装', () => {
  it('静态模板在前、单元清单在尾（04 §2 输入尾部机械追加）', () => {
    const render = renderBoundaryPrompt({ regionText: 'RAW-REGION', units: [unit('a')] })
    expect(render.prompt.startsWith(COMPRESS_BOUNDARY_HEAD)).toBe(true)
    expect(render.prompt.trimEnd().endsWith('</单元清单>')).toBe(true)
    expect(render.prompt.indexOf('RAW-REGION')).toBeLessThan(render.prompt.lastIndexOf('<单元清单>'))
    expect(render.mode).toBe('boundary')
    expect(render.version).toBe(COMPRESS_PROMPT_VERSION)
  })

  it('两模式各自 schema 段落齐备', () => {
    const boundary = renderBoundaryPrompt({ regionText: 'r', units: [unit('a')] }).prompt
    for (const marker of ['"digest"', '"blocks"', 'plan|impl|verify|wrap', '"hotTail"', '禁止任何预算计算']) {
      expect(boundary).toContain(marker)
    }
    const pressure = renderPressurePrompt({ regionText: 'r', units: [unit('a')] }).prompt
    for (const marker of ['"checkpoint"', '"progress"', '"currentState"', '"nextStep"', '"liveConstraints"', '"cutPoint"', '不宣称最终事实']) {
      expect(pressure).toContain(marker)
    }
    expect(pressure.startsWith(COMPRESS_PRESSURE_HEAD)).toBe(true)
    expect(pressure).toContain('不申报热尾')
  })

  it('预算数字零泄漏（N2：模型可见面无任何预算常数）', () => {
    const prompt = [
      renderBoundaryPrompt({ regionText: 'r', units: [unit('a')] }).prompt,
      renderPressurePrompt({ regionText: 'r', units: [unit('a')] }).prompt,
    ].join('\n')
    for (const leak of ['10000', '15000', '100000', '0.4', '10K', '15K', 'retainTokens', 'thresholdTokens']) {
      expect(prompt).not.toContain(leak)
    }
  })

  it('机制 A 续传面：旧检查点原样列出 + 计数', () => {
    const chain = [entry('t1', 'checkpoint', 'C1'), entry('t1', 'checkpoint', 'C2')]
    const render = renderBoundaryPrompt({ regionText: 'REGION-TEXT', units: [unit('a')], priorChain: chain })
    expect(render.priorChainCount).toBe(2)
    expect(render.prompt).toContain('原样续传，禁止改写')
    expect(render.prompt).toContain('C1')
    expect(render.prompt).toContain('C2')
    expect(render.prompt.indexOf('C1')).toBeLessThan(render.prompt.indexOf('REGION-TEXT'))
  })

  it('清单上限：超限保留最近单元 + 计数（0 = 不限 = 正典行为）', () => {
    const units = [unit('a'), unit('b'), unit('c')]
    const unlimited = compressUnitList(units)
    expect(unlimited.listed).toBe(3)
    expect(unlimited.omitted).toBe(0)
    expect(unlimited.text).toContain('[a]')
    const capped = compressUnitList(units, policy({ maxUnitListEntries: 2 }))
    expect(capped.listed).toBe(2)
    expect(capped.omitted).toBe(1)
    expect(capped.text).not.toContain('[a]')
    expect(capped.text).toContain('[b]')
    expect(capped.text).toContain('[c]')
  })

  it('regionTokens 按注入 cpt 机械计量；空区域/空清单不抛错', () => {
    const render = renderBoundaryPrompt({ regionText: 'x'.repeat(30), units: [], policy: policy({ charsPerToken: 1 }) })
    expect(render.regionTokens).toBe(30)
    expect(render.unitCount).toBe(0)
    expect(render.listedUnits).toBe(0)
    expect(render.prompt).not.toContain('</单元清单>')
    expect(renderBoundaryPrompt({ regionText: '', units: [] }).prompt.length).toBeGreaterThan(0)
  })

  it('同输入同字节（双跑逐字节一致）', () => {
    const input = { regionText: 'raw\nwork', units: [unit('a'), unit('b')], priorChain: [entry('t', 'boundary', 'D')] }
    expect(renderBoundaryPrompt(input).prompt).toBe(renderBoundaryPrompt(input).prompt)
    expect(renderPressurePrompt(input).prompt).toBe(renderPressurePrompt(input).prompt)
    expect(renderPriorChain([])).toBe('')
    expect(COMPRESS_POLICY_VERSION).toBe(1)
  })
})

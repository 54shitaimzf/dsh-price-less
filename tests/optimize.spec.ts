/**
 * P11 星标断面纯核测试（docs/implement/P11-optimize.md §3.2）。
 * 九组用例：门控/输入栈与预算/render 布局与确定性/候选 span/双通道解析/行级容错/
 * 引用守卫/权威段逐字保留/度量 fold。全部纯函数与 fake 数据，零 cordis 运行时 import。
 */
import { describe, expect, it } from 'vitest'
import type { DossierBody, DossierMessage } from '../src/core/dossier.ts'
import { renderStablePrefix, type ProjectFrameBody, type SkillCatalogSnapshot } from '../src/core/prefix.ts'
import {
  OPTIMIZE_GATE_DEFAULTS,
  OPTIMIZE_PROMPT_HEAD,
  OPTIMIZE_PROMPT_OUTPUT,
  assembleOptimizeInput,
  checkAuthoritySpans,
  clampOptimizePrompt,
  extractAuthorityCandidates,
  foldOptimizeLedger,
  parseOptimizeOutput,
  renderOptimizePrompt,
  validateSkillName,
  type AuthorityCandidate,
  type OptimizeRecord,
} from '../src/core/optimize.ts'

const msg = (seq: number, text: string): DossierMessage => ({ seq, time: seq, text })
const body = (messages: DossierMessage[]): DossierBody => ({ taskId: 'task-1', messages, annotations: {} })
const catalog: SkillCatalogSnapshot = { complete: true, skills: [{ name: 'build-fix', description: 'Build fix' }] }
const frame: ProjectFrameBody = { goal: 'Build parser', aspects: ['parsing'], skillCatalog: catalog }
const input = (overrides: Partial<Parameters<typeof renderOptimizePrompt>[0]> = {}) => ({
  projectFrame: frame,
  dossier: body([msg(1, 'build a parser'), msg(2, 'keep the cache path')]),
  prompt: 'do it',
  catalog,
  ...overrides,
})

describe('optimize gate', () => {
  it('门控阈值冻结；短卷宗只出空产品，足量卷宗正常出产品段', () => {
    expect(OPTIMIZE_GATE_DEFAULTS).toEqual({ minMessages: 2, minTextLength: 10 })
    const short = renderOptimizePrompt(input({ dossier: body([msg(1, 'hi')]) }))
    expect(short.short).toBe(true)
    expect(short.prompt).toContain('[PRODUCT]\n(空)')
    // 短卷宗也必须保持“严格两段”单一输出契约，不得出现重复的 [PRODUCT]/[VERDICTS] 分界。
    expect(short.prompt.match(/\[PRODUCT\]/g)).toHaveLength(1)
    expect(short.prompt.match(/\[VERDICTS\]/g)).toHaveLength(1)
    expect(short.prompt).not.toContain('[PRODUCT]\n(空)\n\n[VERDICTS]\n输出格式')
    const long = renderOptimizePrompt(input())
    expect(long.short).toBe(false)
    expect(long.prompt).toContain('[PRODUCT]\n\n[VERDICTS]')
    expect(long.prompt.match(/\[PRODUCT\]/g)).toHaveLength(1)
    expect(long.prompt.match(/\[VERDICTS\]/g)).toHaveLength(1)
  })
})

describe('optimize assemble', () => {
  it('输入栈：prefix 与 P8 一致、prompt 截断、超预算丢最旧卷宗且入参不可变', () => {
    const dossier = body(Array.from({ length: 100 }, (_, i) => msg(i + 1, `message ${i + 1} ` + 'x'.repeat(1000))))
    const before = JSON.stringify(dossier)
    const prompt = 'y'.repeat(5000)
    const a = assembleOptimizeInput({ projectFrame: frame, dossier, prompt, catalog })
    expect(a.prefixText).toBe(renderStablePrefix(frame))
    expect(a.promptText.startsWith('y'.repeat(3000))).toBe(true)
    expect(a.promptText.endsWith('y'.repeat(1000))).toBe(true)
    expect(a.truncatedDossierCount).toBeGreaterThan(0)
    expect(a.dossierMessages.length).toBeLessThan(dossier.messages.length)
    expect(a.dossierMessages).not.toBe(dossier.messages)
    expect(JSON.stringify(dossier)).toBe(before)
    expect(clampOptimizePrompt('short')).toBe('short')
  })
})

describe('optimize render', () => {
  it('布局与确定性：模板在前、各段齐全、连续三次逐字节一致', () => {
    const result = renderOptimizePrompt(input())
    expect(result.prompt.startsWith(OPTIMIZE_PROMPT_HEAD)).toBe(true)
    for (const section of ['[稳定前缀]', '[卷宗]', '[当前 prompt]', '[候选权威段]', '[技能目录]']) {
      expect(result.prompt).toContain(section)
    }
    expect(result.prompt).toContain(OPTIMIZE_PROMPT_OUTPUT)
    expect(result.prompt).toContain('build a parser')
    expect(result.prompt).toContain('build-fix')
    const one = JSON.stringify(result)
    expect(JSON.stringify(renderOptimizePrompt(input()))).toBe(one)
    expect(JSON.stringify(renderOptimizePrompt(input()))).toBe(one)
  })
})

describe('optimize candidates', () => {
  it('候选提取：非空行、编号从 1、40 上限、空返回空', () => {
    expect(extractAuthorityCandidates('  a \n\n b \n c ')).toEqual([
      { index: 1, text: 'a' }, { index: 2, text: 'b' }, { index: 3, text: 'c' },
    ])
    const many = Array.from({ length: 45 }, (_, i) => `line${i + 1}`).join('\n')
    expect(extractAuthorityCandidates(many)).toHaveLength(40)
    expect(extractAuthorityCandidates('')).toEqual([])
  })
})

describe('optimize parse', () => {
  it('双通道：全部行文法解析到对应集合', () => {
    const dossier = body([msg(1, 'a'), msg(2, 'b'), msg(3, 'c')])
    const candidates: AuthorityCandidate[] = [{ index: 1, text: 'keep me' }]
    const raw = `[PRODUCT]
Optimized prompt

[VERDICTS]
CLASS 1 action
CLASS 2 pureQ
BOUNDARY 3
SHEAR 1..2 已吸收：some note
SKILL build-fix
KEEP 1
ASPECT testing
FILE report.pdf
KEYWORD cache`
    const r = parseOptimizeOutput(raw, dossier, catalog, candidates)
    expect(r.product).toBe('Optimized prompt')
    expect(r.verdicts).toHaveLength(9)
    expect(r.skillNames).toEqual(['build-fix'])
    expect(r.shearItems).toEqual([{ startSeq: 1, endSeq: 2, note: 'some note' }])
    expect(r.backfillVerdicts).toEqual({ 1: 'action', 2: 'pureQ' })
    expect(r.judgeTable).toEqual({ aspects: ['testing'], fileSignatures: ['report.pdf'], keywords: ['cache'] })
    expect(r.keptSpanIndexes).toEqual([1])
    expect(r.droppedLines).toBe(0)
  })

  it('行级容错：坏行只丢该行，好行与产品存活；缺分界 product 为 null', () => {
    const dossier = body([msg(1, 'a'), msg(2, 'b'), msg(3, 'c')])
    const raw = `[PRODUCT]
Good product

[VERDICTS]
CLASS 1 action
CLASS 9 bogus
CLASS 2 verifyQ
BOUNDARY 99
SHEAR 3..1 已吸收：bad
SHEAR 1..2 已吸收：ok
SKILL ghost
SKILL build-fix
KEEP 9
KEEP 1
RANDOM nope`
    const r = parseOptimizeOutput(raw, dossier, catalog, [{ index: 1, text: 'keep' }])
    expect(r.product).toBe('Good product')
    expect(r.droppedLines).toBe(6)
    expect(r.backfillVerdicts).toEqual({ 1: 'action', 2: 'verifyQ' })
    expect(r.skillNames).toEqual(['build-fix'])
    expect(r.shearItems).toEqual([{ startSeq: 1, endSeq: 2, note: 'ok' }])
    expect(r.keptSpanIndexes).toEqual([1])
    const missing = parseOptimizeOutput('[PRODUCT]\nno verdicts', dossier, catalog)
    expect(missing.product).toBeNull()
    expect(missing.verdicts).toEqual([])
  })
})

describe('optimize skill guard', () => {
  it('引用守卫：精确命中、目录缺失/不完整全拒', () => {
    expect(validateSkillName('build-fix', catalog)).toBe(true)
    expect(validateSkillName('ghost', catalog)).toBe(false)
    expect(validateSkillName('build-fix', undefined)).toBe(false)
    expect(validateSkillName('build-fix', { ...catalog, complete: false })).toBe(false)
    const r = parseOptimizeOutput('[PRODUCT]\np\n[VERDICTS]\nSKILL build-fix\nSKILL ghost', body([msg(1, 'a'), msg(2, 'b')]), catalog)
    expect(r.skillNames).toEqual(['build-fix'])
    expect(r.droppedLines).toBe(1)
  })
})

describe('optimize authority', () => {
  it('权威段逐字保留：缺失报告、包含不报、非法/重复只去重', () => {
    const candidates: AuthorityCandidate[] = [{ index: 1, text: 'keep me' }, { index: 2, text: 'also' }]
    expect(checkAuthoritySpans('keep me and also', candidates, [1, 2])).toEqual({ missing: [], kept: [1, 2] })
    expect(checkAuthoritySpans('nope', candidates, [1])).toEqual({ missing: [candidates[0]], kept: [1] })
    expect(checkAuthoritySpans('x', candidates, [99])).toEqual({ missing: [], kept: [] })
    expect(checkAuthoritySpans('keep me', candidates, [1, 1])).toEqual({ missing: [], kept: [1] })
  })
})

describe('optimize fold', () => {
  it('度量 fold：手算聚合、空记录零值、字节稳定', () => {
    const records: OptimizeRecord[] = [
      { time: 1, short: false, ctxTokens: 10, llmUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5, reasoningTokens: 6 }, backfillCount: 2, backfillConflicts: 1, shearPairs: 3, shearTokens: 30 },
      { time: 2, short: true, ctxTokens: 20, llmUsage: { inputTokens: 10, outputTokens: 20 }, backfillCount: 1, backfillConflicts: 0, shearPairs: 4, shearTokens: 40 },
      { time: 3, short: false, ctxTokens: 30, backfillCount: 0, backfillConflicts: 2, shearPairs: 1, shearTokens: 10 },
    ]
    const led = foldOptimizeLedger(records)
    expect(led.optimizeCount).toBe(3)
    expect(led.optimizePromptTokens).toEqual({ inputTokens: 11, outputTokens: 22, totalTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5, reasoningTokens: 6 })
    expect(led.verdictBackfill).toEqual({ count: 3, conflicts: 3 })
    expect(led.shearAtStar).toEqual({ pairs: 8, tokens: 80 })
    expect(foldOptimizeLedger([])).toEqual({ optimizeCount: 0, optimizePromptTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, verdictBackfill: { count: 0, conflicts: 0 }, shearAtStar: { pairs: 0, tokens: 0 } })
    const one = JSON.stringify(led)
    expect(JSON.stringify(foldOptimizeLedger(records))).toBe(one)
    expect(JSON.stringify(foldOptimizeLedger(records))).toBe(one)
  })
})

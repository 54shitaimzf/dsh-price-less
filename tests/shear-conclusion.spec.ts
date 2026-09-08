/**
 * N2 结论契约单测（docs/implement/N2-conclusion-contract.md §7）：
 * 模板字节稳定 / 标记解析容错 / 三件套缺件 / 事实抽取四类 / 保真校验 / 一步到位 judge。
 */
import { describe, expect, it } from 'vitest'
import {
  KEY_FACT_LIMIT,
  SHEAR_CONCLUSION_TEMPLATE,
  SHEAR_CONCLUSION_VERSION,
  extractKeyFacts,
  judgeConclusion,
  negotiationNote,
  parseConclusion,
  verifyConclusion,
} from '../src/core/shear/conclusion.ts'

describe('N2 模板（§4）', () => {
  it('版本 = 2；negotiationNote 逐字节等于模板常量（字节稳定）', () => {
    expect(SHEAR_CONCLUSION_VERSION).toBe(2)
    expect(negotiationNote()).toBe(SHEAR_CONCLUSION_TEMPLATE)
    expect(negotiationNote()).toBe(negotiationNote())
    expect(Buffer.byteLength(SHEAR_CONCLUSION_TEMPLATE, 'utf8')).toBe(Buffer.byteLength(negotiationNote(), 'utf8'))
  })

  it('模板含两个标记与三件套提示，且零动态拼接', () => {
    expect(SHEAR_CONCLUSION_TEMPLATE).toContain('CUT-OK:')
    expect(SHEAR_CONCLUSION_TEMPLATE).toContain('CUT-HOLD:')
    for (const word of ['结论', '事实', '重取']) expect(SHEAR_CONCLUSION_TEMPLATE).toContain(word)
  })
})

describe('N2 解析（§5）', () => {
  const okLine = 'CUT-OK: 结论 门禁通过｜事实 gate 552 tests; src/a.ts｜重取 重跑 npm run gate'

  it('三件套齐全 → marker ok / complete true', () => {
    const p = parseConclusion('先答任务。\n' + okLine)
    expect(p.marker).toBe('ok')
    expect(p.complete).toBe(true)
    expect(p.conclusion).toContain('门禁通过')
    expect(p.facts).toEqual(['gate 552 tests', 'src/a.ts'])
    expect(p.handle).toContain('npm run gate')
    expect(p.raw).toBe(okLine)
  })

  it('容错：ASCII | / 全角冒号 / 前导 -* / 多余空白', () => {
    const p = parseConclusion('  - CUT-OK：结论 X|事实 y；z|重取 w  ')
    expect(p.marker).toBe('ok')
    expect(p.conclusion).toBe('X')
    expect(p.facts).toEqual(['y', 'z'])
    expect(p.handle).toBe('w')
    expect(p.complete).toBe(true)
  })

  it('只认最后一条非空行：标记不在末行 → none', () => {
    expect(parseConclusion(okLine + '\n还有一句普通回答')).toMatchObject({ marker: 'none', complete: false })
  })

  it('缺件：无重取 / 无事实 → complete false', () => {
    expect(parseConclusion('CUT-OK: 结论 X｜事实 y')).toMatchObject({ marker: 'ok', complete: false })
    expect(parseConclusion('CUT-OK: 结论 X｜重取 w')).toMatchObject({ marker: 'ok', complete: false })
  })

  it('CUT-HOLD → marker hold + reason；无标记 / 空回复 → none', () => {
    expect(parseConclusion('CUT-HOLD: 还需要原文里的报错行')).toMatchObject({ marker: 'hold', reason: '还需要原文里的报错行', complete: false })
    expect(parseConclusion('CUT-HOLD:')).toMatchObject({ marker: 'hold', complete: false })
    expect(parseConclusion('普通回复')).toMatchObject({ marker: 'none', complete: false })
    expect(parseConclusion('')).toMatchObject({ marker: 'none', complete: false })
  })

  it('容错：无标签时按位置取（结论 / 事实 / 重取）', () => {
    const p = parseConclusion('CUT-OK: 一句话结论｜a；b｜再跑一次')
    expect(p.conclusion).toBe('一句话结论')
    expect(p.facts).toEqual(['a', 'b'])
    expect(p.handle).toBe('再跑一次')
    expect(p.complete).toBe(true)
  })
})

describe('N2 事实抽取（§6）', () => {
  it('四类各命中：带单位数值 / 版本 / 校验值引号 / 路径', () => {
    const facts = extractKeyFacts('see src/core/shear/classify.ts at v0.1.3, 552 tests, "PASS", 12.5s')
    expect(facts).toContain('src/core/shear/classify.ts')
    expect(facts).toContain('v0.1.3')
    expect(facts).toContain('552 tests')
    expect(facts).toContain('PASS')
    expect(facts).toContain('12.5s')
  })

  it('短字符串字面量不进事实（探针实测噪声）', () => {
    expect(extractKeyFacts('{"name": "dsh-price-less", "ok": true}')).toEqual([])
  })

  it('去重保序 + 类上限（number 6 / version 2 / quoted 2 / path 4）+ 总上限 12', () => {
    expect(extractKeyFacts('a.ts a.ts a.ts')).toEqual(['a.ts'])
    const paths = extractKeyFacts(Array.from({ length: 20 }, (_, i) => `f${i}.ts`).join(' '))
    expect(paths).toHaveLength(4)
    const mixed = extractKeyFacts('1 tests 2 tests 3 tests 4 tests 5 tests 6 tests 7 tests 8 tests v1.2.3 v2.3.4 v3.4.5 "AAAA" "BBBB" "CCCC" a.ts b.ts c.ts d.ts e.ts')
    expect(mixed).toHaveLength(KEY_FACT_LIMIT)
  })
})

describe('N2 保真校验（§6）', () => {
  const original = 'gate 通过：src/a.ts 修改，552 tests，用时 12.5s'
  it('事实全在（结论/事实/重取任一处）→ ok', () => {
    const p = parseConclusion('CUT-OK: 结论 gate 绿｜事实 src/a.ts; 552 tests; 12.5s｜重取 重跑 npm run gate')
    expect(verifyConclusion(original, p)).toEqual({ ok: true, missing: [] })
  })

  it('缺一条 → ok false + missing 列表', () => {
    const p = parseConclusion('CUT-OK: 结论 gate 绿｜事实 src/a.ts; 12.5s｜重取 重跑 npm run gate')
    const v = verifyConclusion(original, p)
    expect(v.ok).toBe(false)
    expect(v.missing).toContain('552 tests')
  })

  it('hold / none 一律不通过（失败默认保留）', () => {
    expect(verifyConclusion(original, parseConclusion('CUT-HOLD: x')).ok).toBe(false)
    expect(verifyConclusion(original, parseConclusion('无标记')).ok).toBe(false)
  })

  it('judgeConclusion 一步到位返回解析 + 校验', () => {
    const r = judgeConclusion(original, 'CUT-OK: 结论 done｜事实 src/a.ts; 552 tests; 12.5s｜重取 npm run gate')
    expect(r.parsed.marker).toBe('ok')
    expect(r.verify.ok).toBe(true)
  })
})

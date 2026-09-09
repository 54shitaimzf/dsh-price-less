/**
 * v4 可定位性判定单测（docs/04 §2 预算三环 / §6 路径面）：自证位置的类别、
 * 普通词与中文散文的判负、确定性。
 */
import { describe, expect, it } from 'vitest'
import { scanLocatable } from '../src/core/assemble/index.ts'

describe('v4 scanLocatable：内容能否自证位置', () => {
  it('路径 / 引号 / 数字 / 版本 / 可辨识标识符 → 自证位置', () => {
    expect(scanLocatable('docs/04-compactor.md §2').hits).toContain('path')
    expect(scanLocatable('"逐字保留"').hits).toContain('quote')
    expect(scanLocatable('阈值 10000').hits).toContain('number')
    expect(scanLocatable('v0.8.6').hits).toContain('version')
    expect(scanLocatable('pressureRatio').hits).toContain('ident')
    expect(scanLocatable('ENTRY_MIN_BYTES').hits).toContain('ident')
    expect(scanLocatable('readFileSync').hits).toContain('ident')
    expect(scanLocatable('C:\\proj\\a.ts').locatable).toBe(true)
  })

  it('普通英文词 / 中文散文 / 空串 → 不自证位置（需要定位标注）', () => {
    expect(scanLocatable('return the function result').locatable).toBe(false)
    expect(scanLocatable('必须保留用户原话').locatable).toBe(false)
    expect(scanLocatable('').locatable).toBe(false)
  })

  it('确定性：同输入同输出（含类别序）', () => {
    const text = 'fooBar 12345 docs/a.ts'
    expect(JSON.stringify(scanLocatable(text))).toBe(JSON.stringify(scanLocatable(text)))
    expect(scanLocatable(text).hits[0]).toBe('path')
  })
})

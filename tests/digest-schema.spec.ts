/**
 * per-task 摘要 schema 单测：校验 / 空摘要 / 渲染字节稳定 / 字节数。
 */
import { describe, expect, it } from 'vitest'
import {
  DIGEST_SCHEMA_VERSION,
  isValidDigest,
  emptyDigest,
  digestToMarkdown,
  digestByteLength,
  type TaskDigest,
} from '../src/task/digest-schema.js'

function sample(overrides: Partial<TaskDigest> = {}): TaskDigest {
  return {
    taskId: 'task-1',
    schemaVersion: DIGEST_SCHEMA_VERSION,
    taskAnchor: 'fix the parser bug',
    purpose: 'Fix parser crash on empty input (verbatim: "ignore empty files")',
    decisions: ['use buffered reader'],
    artifacts: [{ file: 'src/parser.ts', symbols: ['parse'], lineRange: [10, 40], note: 'crash site' }],
    touchedFiles: ['src/parser.ts'],
    pending: ['src/parser.ts: add regression test'],
    triedRejected: ['regex split -> rejected (loses positions)'],
    verbatimSpans: ['ignore empty files'],
    createdAtMs: 0,
    ...overrides,
  }
}

describe('isValidDigest', () => {
  it('合法 digest → true', () => {
    expect(isValidDigest(sample())).toBe(true)
  })

  it('taskId 缺失 → false', () => {
    expect(isValidDigest({ ...sample(), taskId: undefined })).toBe(false)
  })

  it('schemaVersion 不符 → false', () => {
    expect(isValidDigest({ ...sample(), schemaVersion: 999 })).toBe(false)
  })

  it('artifacts 未按 schema → false', () => {
    expect(isValidDigest({ ...sample(), artifacts: [{ file: 'x', symbols: [], lineRange: null, note: '' }] })).toBe(true)
    expect(isValidDigest({ ...sample(), artifacts: [{ file: 'x', symbols: 'no', lineRange: null, note: '' }] })).toBe(false)
  })

  it('非对象 / 数组 → false', () => {
    expect(isValidDigest(null)).toBe(false)
    expect(isValidDigest([])).toBe(false)
  })
})

describe('emptyDigest', () => {
  it('最小合法 digest（字段空）', () => {
    const d = emptyDigest('task-9', 'anchor', 123)
    expect(isValidDigest(d)).toBe(true)
    expect(d.taskId).toBe('task-9')
    expect(d.taskAnchor).toBe('anchor')
    expect(d.createdAtMs).toBe(123)
    expect(d.pending).toEqual([])
  })
})

describe('digestToMarkdown / 字节稳定', () => {
  it('任务锚与关键字段逐字保留', () => {
    const md = digestToMarkdown(sample())
    expect(md).toContain('## Task task-1')
    expect(md).toContain('ignore empty files')
    expect(md).toContain('src/parser.ts')
    expect(md).toContain('regex split -> rejected (loses positions)')
  })

  it('同 digest 同字节（缓存命中的物理基础）', () => {
    const d = sample()
    expect(digestToMarkdown(d)).toBe(digestToMarkdown(d))
    expect(digestToMarkdown(sample())).toBe(digestToMarkdown(sample()))
  })

  it('digestByteLength > 0，且不同内容不同长度', () => {
    expect(digestByteLength(sample())).toBeGreaterThan(0)
    expect(digestByteLength(sample())).not.toBe(digestByteLength(sample({ purpose: '' })))
  })
})

/**
 * 摘要器单测（无 harness，纯函数）：fence 剥离 / JSON digest 解析 / 缓存命中结果构造。
 */
import { describe, expect, it } from 'vitest'
import {
  stripFences,
  parseDigestJson,
  cachedDigestResult,
  DIGEST_INSTRUCTION,
} from '../src/task/summarizer.js'
import { DIGEST_SCHEMA_VERSION, digestToMarkdown, emptyDigest } from '../src/task/digest-schema.js'

describe('stripFences', () => {
  it('去掉 markdown 代码围栏', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })
  it('无围栏原样返回', () => {
    expect(stripFences('{"a":1}')).toBe('{"a":1}')
  })
})

describe('parseDigestJson', () => {
  it('解析合法 JSON digest，补齐 taskId/anchor/version/createdAtMs', () => {
    const json = JSON.stringify({
      purpose: 'fix parser',
      decisions: ['use buffered'],
      artifacts: [{ file: 'src/parser.ts', symbols: ['parse'], lineRange: [10, 40], note: 'crash' }],
      touchedFiles: ['src/parser.ts'],
      pending: ['src/parser.ts: add test'],
      triedRejected: ['regex split -> rejected'],
      verbatimSpans: ['ignore empty files'],
    })
    const d = parseDigestJson(json, 'task-1', 'fix the parser', DIGEST_SCHEMA_VERSION, 42)
    expect(d).not.toBeNull()
    expect(d!.taskId).toBe('task-1')
    expect(d!.taskAnchor).toBe('fix the parser')
    expect(d!.schemaVersion).toBe(DIGEST_SCHEMA_VERSION)
    expect(d!.createdAtMs).toBe(42)
    expect(d!.artifacts[0]).toEqual({ file: 'src/parser.ts', symbols: ['parse'], lineRange: [10, 40], note: 'crash' })
  })

  it('非法 JSON → null', () => {
    expect(parseDigestJson('not json', 't', 'a')).toBeNull()
  })
  it('非对象 → null', () => {
    expect(parseDigestJson('123', 't', 'a')).toBeNull()
    expect(parseDigestJson('[]', 't', 'a')).toBeNull()
  })
  it('artifacts 字段容错：malformed symbols 被规整为 []，文件坐标仍保留', () => {
    const json = JSON.stringify({ purpose: 'x', artifacts: [{ file: 'a', symbols: 'no', lineRange: null, note: '' }] })
    const d = parseDigestJson(json, 't', 'a')
    expect(d).not.toBeNull() // 不规范条目应被规整而非整体失败（不丢文件坐标）
    expect(d!.artifacts).toEqual([{ file: 'a', symbols: [], lineRange: null, note: '' }])
  })
})

describe('cachedDigestResult', () => {
  it('summary 为 digestToMarkdown 文本块，llmStreamCall=false（命中缓存不走 LLM）', () => {
    const digest = emptyDigest('task-1', 'anchor', 1)
    digest.purpose = 'do x'
    const r = cachedDigestResult(digest)
    expect(r.llmStreamCall).toBe(false)
    expect(r.provider).toBe('')
    expect(r.summary[0]).toEqual({ type: 'text', text: digestToMarkdown(digest) })
  })
})

describe('DIGEST_INSTRUCTION', () => {
  it('指令含 schema 字段与"重发现拦截器"规则', () => {
    expect(DIGEST_INSTRUCTION).toContain('artifacts')
    expect(DIGEST_INSTRUCTION).toContain('touchedFiles')
    expect(DIGEST_INSTRUCTION).toContain('triedRejected')
    expect(DIGEST_INSTRUCTION).toContain('prevent a downstream tool call')
  })
})

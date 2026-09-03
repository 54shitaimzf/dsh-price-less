/**
 * 压缩摘要缓存单测：内容寻址键 + LRU + 命中/失效 + 统计。
 */
import { describe, expect, it } from 'vitest'
import { DigestCache, spanContentHash, type HashFn } from '../src/task/digest-cache.js'
import { DIGEST_SCHEMA_VERSION, emptyDigest } from '../src/task/digest-schema.js'

const hash: HashFn = (t) => `h:${t}`

describe('spanContentHash', () => {
  it('同内容 → 同哈希', () => {
    expect(spanContentHash('abc', hash)).toBe(spanContentHash('abc', hash))
  })
  it('不同内容 → 不同哈希', () => {
    expect(spanContentHash('abc', hash)).not.toBe(spanContentHash('abd', hash))
  })
})

describe('DigestCache', () => {
  it('未命中返回 null', () => {
    const c = new DigestCache(10)
    expect(c.get('sha', 'task-1')).toBeNull()
  })

  it('set → get 命中返回同一引用（字节稳定）', () => {
    const c = new DigestCache(10)
    const d = emptyDigest('task-1', 'a', 1)
    c.set('sha', 'task-1', d)
    expect(c.get('sha', 'task-1')).toBe(d)
  })

  it('键含 spanHash 与 taskId（不同 task 不同键）', () => {
    const c = new DigestCache(10)
    c.set('sha', 'task-a', emptyDigest('a', 'x', 1))
    expect(c.get('sha', 'task-b')).toBeNull()
  })

  it('LRU：容量满逐最旧（get 提升为新近）', () => {
    const c = new DigestCache(2)
    c.set('h1', 't1', emptyDigest('a', '', 1))
    c.set('h2', 't2', emptyDigest('b', '', 2))
    c.get('h1', 't1') // 提升 h1 为最近
    c.set('h3', 't3', emptyDigest('c', '', 3)) // 逐最旧 h2
    expect(c.get('h1', 't1')).not.toBeNull()
    expect(c.get('h2', 't2')).toBeNull()
    expect(c.get('h3', 't3')).not.toBeNull()
  })

  it('invalidate(spanHash) 清除全部分身', () => {
    const c = new DigestCache(10)
    c.set('sha', 't1', emptyDigest('a', '', 1))
    c.set('sha', 't2', emptyDigest('b', '', 2))
    c.invalidate('sha')
    expect(c.get('sha', 't1')).toBeNull()
    expect(c.get('sha', 't2')).toBeNull()
  })

  it('stats 命中率', () => {
    const c = new DigestCache(10)
    c.set('s', 't', emptyDigest('a', '', 1))
    c.get('s', 't')
    c.get('s', 'missing')
    const s = c.stats()
    expect(s.hits).toBe(1)
    expect(s.misses).toBe(1)
    expect(s.hitRate).toBe(0.5)
  })
})

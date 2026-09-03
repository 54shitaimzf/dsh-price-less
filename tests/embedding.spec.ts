/**
 * embedding 端口接口空壳单测：余弦相似度（纯函数）+ EmbeddingPort 契约形状。
 * v0.2.0-s6：语义票 provider/artifact 已移除，仅剩纯函数与端口类型可测。
 */
import { describe, expect, it } from 'vitest'
import { cosineSimilarity, type EmbeddingPort } from '../src/task/embedding.js'

describe('cosineSimilarity', () => {
  it('同向量 = 1', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1)
  })
  it('正交 = 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10)
  })
  it('反向 = -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1)
  })
  it('长度不等/零向量 → 0（防御）', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

describe('EmbeddingPort 契约（映射检索留门）', () => {
  it('端口接口最小形状：embed(text|text[]) → 向量数组', async () => {
    const port: EmbeddingPort = {
      async embed(input) {
        const list = Array.isArray(input) ? input : [input]
        return list.map(() => [1, 0])
      },
    }
    const out = await port.embed(['a', 'b'])
    expect(out).toHaveLength(2)
  })
})

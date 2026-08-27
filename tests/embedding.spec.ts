/**
 * 语义票模块单测：余弦/提供方/artifact 存储/系统注入过滤（纯 node，无 Ollama 依赖）。
 */
import { describe, expect, it } from 'vitest'
import {
  OllamaVoteProvider,
  VoteArtifactStore,
  cosineSimilarity,
  createVoteProvider,
  hashText,
  isSystemInjectedUserText,
  type EmbeddingPort,
} from '../src/task/embedding.js'

/** 内存 embedding 端口（测试用）。 */
class FakePort implements EmbeddingPort {
  constructor(private readonly vectors: Record<string, number[]>) {}

  async embed(input: string | string[]): Promise<number[][]> {
    const list = Array.isArray(input) ? input : [input]
    return list.map(text => this.vectors[text] ?? [])
  }
}

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

describe('OllamaVoteProvider', () => {
  it('score = 两文本向量余弦（缓存：同文本只调一次 port）', async () => {
    let calls = 0
    const port: EmbeddingPort = {
      async embed(input) {
        calls += 1
        const map: Record<string, number[]> = {
          'a': [1, 0],
          'b': [0.6, 0.8],
        }
        const list = Array.isArray(input) ? input : [input]
        const out: number[][] = []
        for (const text of list) out.push(map[text] ?? [0, 0])
        return out
      },
    }
    const provider = new OllamaVoteProvider(port)
    const score = await provider.score('a', 'b')
    expect(score).toBeCloseTo(0.6, 10)
    expect(calls).toBe(2)
    // 再次同文本：命中缓存（embed 不再被调用）。
    await provider.score('a', 'b')
    expect(calls).toBe(2)
  })

  it('port 抛错 → null（fail-lazy，不抛）', async () => {
    const port: EmbeddingPort = {
      async embed() { throw new Error('server down') },
    }
    const provider = new OllamaVoteProvider(port)
    await expect(provider.score('x', 'y')).resolves.toBeNull()
  })
})

describe('VoteArtifactStore', () => {
  const mem = new Map<string, string>()
  const pathImpl = {
    async mkdir() {},
    async write(p: string, content: string) { mem.set(p, content) },
    async read(p: string) {
      const value = mem.get(p)
      if (value === undefined) throw new Error('ENOENT')
      return value
    },
    async list(p: string) {
      const prefix = `${p}/`
      return [...mem.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
    },
    async exists(p: string) { return mem.has(p) || [...mem.keys()].some(k => k.startsWith(`${p}/`)) },
    join(...parts: string[]) { return parts.join('/') },
  }

  it('save → loadAll 往返；同 seq 二次 save 不覆盖（幂等）', async () => {
    const store = new VoteArtifactStore('/root', pathImpl)
    await store.save('s1', 42, 18, '锚文本A', 0.37, 'qwen3-embedding:0.6b')
    await store.save('s1', 42, 18, '锚文本B', 0.99, 'qwen3-embedding:0.6b')
    const loaded = await store.loadAll('s1')
    expect(loaded.get(42)).toBe(0.37)
    expect(loaded.size).toBe(1)
    // 锚 hash 记录为首写判据
    const raw = JSON.parse(mem.get('/root/s1/votes/42.json')!) as { anchorHash: string }
    expect(raw.anchorHash).toBe(hashText('锚文本A'))
  })

  it('损坏票跳过（不影响其他票）', async () => {
    mem.set('/root/s2/votes/7.json', '{not json')
    const store = new VoteArtifactStore('/root', pathImpl)
    const loaded = await store.loadAll('s2')
    expect(loaded.size).toBe(0)
  })
})

describe('createVoteProvider + 系统注入过滤', () => {
  it("tier 'off' → null（机械降级）", () => {
    expect(createVoteProvider('off', 'http://x', 'm')).toBeNull()
  })
  it("tier 'local' → Ollama provider 实例", () => {
    expect(createVoteProvider('local', 'http://localhost:11434', 'qwen3-embedding:0.6b')).toBeInstanceOf(OllamaVoteProvider)
  })
  it('系统注入用户消息被识别（不参与投票）', () => {
    expect(isSystemInjectedUserText('This is an automatically generated checkpoint condensing an earlier span')).toBe(true)
    expect(isSystemInjectedUserText('<system-reminder>\nThe available skill catalog changed')).toBe(true)
    expect(isSystemInjectedUserText('background job pwsh-1 finished')).toBe(true)
    expect(isSystemInjectedUserText('Router: classify this task (build or fix)')).toBe(true)
    expect(isSystemInjectedUserText('现在R12执行完毕，我在观看执行过程')).toBe(false)
  })
})

/**
 * P19a 档案区存储面单测（docs/implement/P19-boundary-path.md §5；docs/04 §6 / docs/09 §2）。
 * 覆盖：追加 + 硬帽整条截断 / 防御解析 / 内容寻址键（确定性 + 输入敏感）/ 缓存命中与淘汰 / 续传链过滤。
 */
import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_CACHE_LIMIT,
  ARCHIVE_STORE_VERSION,
  appendArchiveEntry,
  compressSpanHash,
  emptyArchiveStore,
  lookupCachedProduct,
  priorChainFor,
  putCachedProduct,
  readArchiveStore,
  type ArchiveStoreBody,
  type CompressCacheEntry,
} from '../src/core/compress/index.ts'
import { DEFAULT_ASSEMBLE_POLICY } from '../src/core/assemble/index.ts'
import type { BoundaryProduct } from '../src/core/compress/index.ts'

const policy = { ...DEFAULT_ASSEMBLE_POLICY, archiveTokens: 30 }
const product: BoundaryProduct = { mode: 'boundary', digest: { blocks: [{ type: 'plan', text: '目标' }], coords: [] }, hotTail: [] }
const cacheEntry = (key: string, at = 1): CompressCacheEntry => ({ key, at, layer: 'boundary', product })

const entry = (taskId: string, kind: 'checkpoint' | 'boundary', text: string, sessionId = 's1') => ({ taskId, kind, text, sessionId, layer: 'boundary' as const, at: 1 })

describe('P19a 档案区：追加与硬帽', () => {
  it('追加只增不改；超帽从最老整条截断（不条内截断）', () => {
    let body = emptyArchiveStore('w')
    const first = appendArchiveEntry(body, entry('task-1', 'boundary', 'a'.repeat(30)), policy)
    body = first.body
    expect(first.truncation).toEqual({ count: 0, tokens: 0 })
    const second = appendArchiveEntry(body, entry('task-2', 'boundary', 'b'.repeat(30)), policy)
    expect(second.truncation.count).toBe(1)
    expect(second.body.entries.map((e) => e.taskId)).toEqual(['task-2'])
    expect(second.body.entries[0]!.text).toBe('b'.repeat(30))
  })

  it('续传链只取同 task 的 checkpoint 条目', () => {
    let body = emptyArchiveStore('w')
    body = appendArchiveEntry(body, entry('task-1', 'checkpoint', 'C1'), policy).body
    body = appendArchiveEntry(body, entry('task-1', 'boundary', 'D1'), policy).body
    body = appendArchiveEntry(body, entry('task-2', 'checkpoint', 'C2'), policy).body
    expect(priorChainFor(body, 'task-1', 's1').map((e) => e.text)).toEqual(['C1'])
    expect(priorChainFor(body, 'task-1', 's2')).toEqual([])
    expect(priorChainFor(body, 'task-9')).toEqual([])
  })
})

describe('P19a 档案区：防御解析', () => {
  it('坏形状 / 版本不符 / workspace 不符 → 空档案', () => {
    expect(readArchiveStore(null, 'w')).toEqual(emptyArchiveStore('w'))
    expect(readArchiveStore({ schemaVersion: 99, workspace: 'w', entries: [], cache: {} }, 'w')).toEqual(emptyArchiveStore('w'))
    expect(readArchiveStore({ schemaVersion: ARCHIVE_STORE_VERSION, workspace: 'other', entries: [], cache: {} }, 'w')).toEqual(emptyArchiveStore('w'))
  })

  it('坏条目与坏缓存条目逐条丢弃，好条目保留', () => {
    const body = readArchiveStore({
      schemaVersion: ARCHIVE_STORE_VERSION,
      workspace: 'w',
      entries: [entry('task-1', 'boundary', 'ok'), { taskId: '', kind: 'boundary', text: 'x' }, { taskId: 't', kind: 'nope', text: 'x' }, null],
      cache: { k1: cacheEntry('k1'), k2: { ...cacheEntry('k2'), layer: 'nope' }, k3: cacheEntry('other') },
    }, 'w')
    expect(body.entries).toHaveLength(1)
    expect(Object.keys(body.cache)).toEqual(['k1'])
  })
})

describe('P19a 内容寻址缓存', () => {
  const base = { promptVersion: 1, policyVersion: 1, layer: 'boundary' as const, regionText: 'R', unitIds: ['c1', 'c2'], priorChainTexts: [] }

  it('键确定性：同输入同键；任一输入变化换键', () => {
    const key = compressSpanHash(base)
    expect(compressSpanHash({ ...base })).toBe(key)
    expect(compressSpanHash({ ...base, regionText: 'R2' })).not.toBe(key)
    expect(compressSpanHash({ ...base, unitIds: ['c2', 'c1'] })).not.toBe(key)
    expect(compressSpanHash({ ...base, priorChainTexts: ['C1'] })).not.toBe(key)
    expect(compressSpanHash({ ...base, promptVersion: 2 })).not.toBe(key)
    expect(compressSpanHash({ ...base, layer: 'pressure' })).not.toBe(key)
    expect(key).toMatch(/^[0-9a-f]{16}$/)
  })

  it('命中 = 取回产物；写入按插入序淘汰超限条目', () => {
    let body: ArchiveStoreBody = emptyArchiveStore('w')
    body = putCachedProduct(body, cacheEntry('k1'))
    expect(lookupCachedProduct(body, 'k1')?.product).toEqual(product)
    for (let i = 0; i < ARCHIVE_CACHE_LIMIT + 3; i++) body = putCachedProduct(body, cacheEntry(`x${i}`))
    expect(Object.keys(body.cache)).toHaveLength(ARCHIVE_CACHE_LIMIT)
    expect(lookupCachedProduct(body, 'k1')).toBeUndefined()
    expect(lookupCachedProduct(body, `x${ARCHIVE_CACHE_LIMIT + 2}`)).toBeDefined()
  })
})

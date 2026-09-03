/**
 * 压缩摘要缓存（L0 纯算法）：按 span 内容哈希做内容寻址，命中即跳过一次 LLM 摘要调用，
 * 从而**降低压缩调用成本**（compressionCallCount 下降、缓存命中率上升）。
 *
 * 键 = `spanHash`（span 内容哈希，跨会话/复压通用）+ `taskId`（会话内去重）。
 * 失效 = span 内容哈希变化（视为新内容 → 重算，不写旧）。LRU 上限容量。
 *
 * 模块: task 摘要缓存
 * 平面: L0（纯内存 LRU + 哈希键；无外部 IO）
 * 回退链步数: 2（代码分支——缓存命中/淘汰为确定性规则）
 * 审查清单: 无 LLM 调用；同键同字节（命中返回同一 digest 引用，字节稳定）；
 *           容量满 → 逐最旧（LRU）；线程安全由进程内单例 + 调用方互斥保证；
 *           可无 harness 单测。
 * 度量: compressionCallCount / compressionCacheHitRate（docs/07）
 */

import type { TaskDigest } from './digest-schema.ts'

/** 哈希函数（默认 sha256；测试可注入确定性 hash）。 */
export type HashFn = (text: string) => string

import { createHash } from 'node:crypto'

/** sha256 摘要（默认哈希；16-进制）。 */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 由 span 内容字符串计算内容哈希（内容 = 被压 span 的派生消息文本拼接，调用方构建）。 */
export function spanContentHash(content: string, hashFn: HashFn = sha256): string {
  return hashFn(content)
}

interface CacheEntry {
  digest: TaskDigest
  createdAtMs: number
  spanHash: string
}

/** 有界 LRU 摘要缓存。 */
export class DigestCache {
  private readonly map = new Map<string, CacheEntry>()
  private hits = 0
  private misses = 0

  constructor(private readonly capacity: number) {}

  /** 缓存键：spanHash（内容寻址）+ taskId（会话内去重）。 */
  key(spanHash: string, taskId: string): string {
    return `${spanHash}::${taskId}`
  }

  /** 命中返回缓存的 digest（引用，字节稳定）；未命中返回 null。 */
  get(spanHash: string, taskId: string): TaskDigest | null {
    const k = this.key(spanHash, taskId)
    const entry = this.map.get(k)
    if (entry === undefined) {
      this.misses += 1
      return null
    }
    this.hits += 1
    // LRU：触达移到最后（Map 迭代序 = 插入序）。
    this.map.delete(k)
    this.map.set(k, entry)
    return entry.digest
  }

  /** 写入缓存（内容变化 → 调用方先算新 spanHash，写新的，旧键自然淘汰）。 */
  set(spanHash: string, taskId: string, digest: TaskDigest): void {
    const k = this.key(spanHash, taskId)
    this.map.delete(k)
    this.map.set(k, { digest, createdAtMs: digest.createdAtMs, spanHash })
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  /** 显式失效（内容哈希变化 / stale）。 */
  invalidate(spanHash: string): void {
    for (const [k, entry] of this.map) {
      if (entry.spanHash === spanHash) this.map.delete(k)
    }
  }

  /** 命中断言（跨会话/复压复用；docs/07 cacheHitRate）。 */
  stats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.hits + this.misses
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.map.size,
      hitRate: total === 0 ? 0 : this.hits / total,
    }
  }
}

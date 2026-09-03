/**
 * per-task 摘要落盘（L0 + 原子写）。把"按 task 拆分的压缩上下文"持久化到 L3
 * `knowledge.json` 的 `taskSummaries.archived[taskId]`——每 task 独立归档，供：
 *  - 跨会话复用（同 task 二次遇到 → 不重算、不重发现，避免额外调用）；
 *  - 重启后重建（恢复契约，docs/12 §2 降级兜底）；
 *  - 按 task 单位渲染摘要区（docs/02 §3 布局）。
 *
 * 形态决策（G3）：**不拆独立文件**，遵守 docs/09（"拆独立文件属架构变更，须重新裁决"）。
 * 单文件 + 原子写（临时文件 + rename），版本 +1、schemaVersion 校验、无 source 拒绝、
 * 同 task 二次归档按 mergeOnReopen 合并/拒绝。
 *
 * 模块: task 摘要落盘
 * 平面: L0（JSON 读写/校验/版本）+ IO（原子写）
 * 回退链步数: 2（代码分支——确定性读写；IO 失败 fail-lazy 不抛错打断 step）
 * 审查清单: IO 抽象为可注入（测试用内存/临时文件）；写前 schemaVersion 校验 + version+1；
 *           落盘失败 → 仅日志 + 内存缓存兜底（绝不断流）；字节稳定（同版本同字节可复现）。
 * 度量: digestBytes / digestEntryCount / cacheHitRate（docs/07）
 */

import * as fs from 'node:fs'
import type { TaskDigest } from './digest-schema.ts'
import { isValidDigest, DIGEST_SCHEMA_VERSION } from './digest-schema.ts'

/** 一条已归档的 per-task digest（含版本与溯源）。 */
export interface StoredDigest {
  taskId: string
  digest: TaskDigest
  constraints: string[]
  targets: string[]
  schemaVersion: number
  version: number
  source: string
  updatedAtMs: number
}

/** 落盘 IO 抽象（默认 node:fs；测试注入内存/临时目录）。 */
export interface DigestStoreIO {
  exists(path: string): boolean
  read(path: string): string
  write(path: string, content: string): void
  rename(from: string, to: string): void
  mkdir(dir: string): void
}

/** 默认 node:fs 实现（原子写 = 写临时文件 + rename）。 */
export const defaultIO: DigestStoreIO = {
  exists: (p) => fs.existsSync(p),
  read: (p) => fs.readFileSync(p, 'utf8'),
  write: (p, c) => fs.writeFileSync(p, c, 'utf8'),
  rename: (a, b) => fs.renameSync(a, b),
  mkdir: (d) => fs.mkdirSync(d, { recursive: true }),
}

/** 存储文件形态：仅管理 knowledge.json 的 taskSummaries 子结构，保留其它顶层键（preferences/mappings）。 */
interface KnowledgeSummaryShape {
  schemaVersion?: number
  taskSummaries?: { version?: number; archived?: Record<string, StoredDigest> }
  [k: string]: unknown
}

function summarizeShape(value: unknown): KnowledgeSummaryShape {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as KnowledgeSummaryShape
}

function archivedMap(shape: KnowledgeSummaryShape): Record<string, StoredDigest> {
  const raw = shape.taskSummaries?.archived
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return raw as Record<string, StoredDigest>
}

function collectValid(archived: Record<string, StoredDigest>): Record<string, StoredDigest> {
  const out: Record<string, StoredDigest> = {}
  for (const [taskId, entry] of Object.entries(archived)) {
    if (entry !== null && typeof entry === 'object'
      && typeof entry.digest === 'object' && entry.digest !== null
      && isValidDigest(entry.digest) && entry.digest.taskId === taskId) {
      out[taskId] = entry
    }
  }
  return out
}

const KNOWLEDGE_SCHEMA_VERSION = 1

export interface DigestStoreOptions {
  filePath: string
  io?: DigestStoreIO
  /** 同 task 二次归档策略：merge = 合并（保留仍真，交由调用方），reject = 拒绝（返回 false）。 */
  mergeOnReopen?: boolean
}

/** 按 task 归档的摘要存储（单文件 + 版本 + 溯源）。 */
export class DigestStore {
  private readonly io: DigestStoreIO
  private readonly mergeOnReopen: boolean
  private readonly filePath: string

  constructor(options: DigestStoreOptions) {
    this.filePath = options.filePath
    this.io = options.io ?? defaultIO
    this.mergeOnReopen = options.mergeOnReopen ?? true
  }

  /** 读取（文件不存在 → 空表；无效条目静默跳过——fail-lazy）。 */
  load(): Record<string, StoredDigest> {
    if (!this.io.exists(this.filePath)) return {}
    let raw: string
    try {
      raw = this.io.read(this.filePath)
    } catch {
      return {}
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return {}
    }
    return collectValid(archivedMap(summarizeShape(parsed)))
  }

  /** 读取单条（不存在或无效 → null）。 */
  readDigest(taskId: string): StoredDigest | null {
    return this.load()[taskId] ?? null
  }

  /**
   * 写入（升级 + 原子落盘）：校验 schemaVersion → 新增/合并 → version+1 → 原子写。
   * @param source - 溯源（taskId:事件来源，无 source 拒绝写入）。
   * @returns true 写入成功；false 拒绝（无 source / 同 task 且 mergeOnReopen=false 已存在 / 非法 digest）。
   */
  writeDigest(taskId: string, digest: TaskDigest, source: string): boolean {
    if (source.length === 0) return false
    if (digest.schemaVersion !== DIGEST_SCHEMA_VERSION || !isValidDigest(digest)) return false

    const archived = this.load()
    const existing = archived[taskId]
    if (existing !== undefined && !this.mergeOnReopen) return false

    const baseVersion = existing?.version ?? 0
    const entry: StoredDigest = {
      taskId,
      digest,
      constraints: existing?.constraints ?? [],
      targets: existing?.targets ?? [],
      schemaVersion: DIGEST_SCHEMA_VERSION,
      version: baseVersion + 1,
      source,
      updatedAtMs: Date.now(),
    }
    archived[taskId] = entry

    this.flush(archived)
    return true
  }

  /** 把最新 archived 表写回文件（原子：写临时 + rename；保留其它顶层键）。 */
  private flush(archived: Record<string, StoredDigest>): void {
    const prior = this.io.exists(this.filePath)
      ? summarizeShape(JSON.parse(this.io.read(this.filePath)))
      : {}
    const shape: KnowledgeSummaryShape = {
      ...prior,
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      taskSummaries: {
        ...(typeof prior.taskSummaries === 'object' && prior.taskSummaries !== null
          ? prior.taskSummaries : {}),
        version: (typeof prior.taskSummaries?.version === 'number' ? prior.taskSummaries.version : 0) + 1,
        archived,
      },
    }
    const dir = this.filePath.slice(0, Math.max(this.filePath.lastIndexOf('/'), this.filePath.lastIndexOf('\\')))
    if (dir.length > 0) this.io.mkdir(dir)
    const tmp = `${this.filePath}.tmp`
    this.io.write(tmp, JSON.stringify(shape, null, 2))
    this.io.rename(tmp, this.filePath)
  }
}

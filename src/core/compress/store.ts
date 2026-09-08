/**
 * 档案区实体纯核（docs/04 §6 档案区：只追加 + 15K 硬帽 + 内容寻址复用；docs/09 §2 边界档案 vN；P19a）。
 * 纯函数：档案条目追加（含硬帽机械截断）+ 内容寻址缓存（span 哈希命中 = 零调用复用）+ 防御解析。
 * 键含 workspace（09 §1 项目级实体隔离）；条目字节一经写出不可变（机制 A：只追加、绝不重写）。
 *
 * 模块: core 压缩调用纯核（档案区存储面）
 * 平面: L0（确定性机械增删；零模型、零 IO）
 * 回退链步数: 2（坏形状 → 空档案；缓存条目坏形状 → 丢弃）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D13）；不读盘、不写事实、不改史。
 * 度量: truncation 由调用侧落 assemble-run / compress-run 事实（07 压缩族同源）。
 */
import { truncateArchiveArea } from '../assemble/archive.ts'
import { DEFAULT_ASSEMBLE_POLICY, type ArchiveEntry, type ArchiveTruncation, type AssembleLayer, type AssemblePolicy, type HotTailDropCounts } from '../assemble/types.ts'
import type { CompressMode, CompressProduct } from './types.ts'

/** 档案区实体结构版本（schemaVersion；结构变化必须升版本）。 */
export const ARCHIVE_STORE_VERSION = 1

/** 内容寻址缓存条目上限（插入序淘汰；跨会话复用的小容量缓存）。 */
export const ARCHIVE_CACHE_LIMIT = 32

/** 档案条目（ArchiveEntry + 会话/层归因；追加式链只比较 taskId/kind/text，额外字段不参与字节判定）。 */
export interface ArchiveRecord extends ArchiveEntry {
  readonly sessionId?: string
  readonly layer?: AssembleLayer
  readonly at?: number
  /** 压力检查点：缝（下一折叠的起点；机制 A 续传定位）。 */
  readonly cutPointSeq?: number
  /** 压力检查点：本次替换区间末端（下一折叠的替换起点 = 其后的首个表面节点）。 */
  readonly rangeEndSeq?: number
}

/** 内容寻址缓存条目：键 = span 哈希，值 = 已解析产物（复用 = 零调用）。 */
export interface CompressCacheEntry {
  readonly key: string
  readonly at: number
  readonly layer: CompressMode
  readonly product: CompressProduct
  readonly dropped?: HotTailDropCounts
}

/** 档案区实体体（一个 workspace 一条）。 */
export interface ArchiveStoreBody {
  readonly schemaVersion: number
  readonly workspace: string
  readonly entries: readonly ArchiveRecord[]
  readonly cache: Readonly<Record<string, CompressCacheEntry>>
}

export function emptyArchiveStore(workspace: string): ArchiveStoreBody {
  return { schemaVersion: ARCHIVE_STORE_VERSION, workspace, entries: [], cache: {} }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function isArchiveRecord(value: unknown): value is ArchiveRecord {
  const item = recordOf(value)
  if (item === undefined) return false
  if (typeof item.taskId !== 'string' || item.taskId === '') return false
  if (item.kind !== 'checkpoint' && item.kind !== 'boundary') return false
  return typeof item.text === 'string'
}

function isDropCounts(value: unknown): value is HotTailDropCounts {
  const item = recordOf(value)
  if (item === undefined) return false
  return (['badDecl', 'unknownUnit', 'remap', 'fetch'] as const).every((key) => typeof item[key] === 'number')
}

function isCacheEntry(value: unknown): value is CompressCacheEntry {
  const item = recordOf(value)
  if (item === undefined) return false
  if (typeof item.key !== 'string' || item.key === '') return false
  if (typeof item.at !== 'number' || !Number.isFinite(item.at)) return false
  if (item.layer !== 'boundary' && item.layer !== 'pressure') return false
  const product = recordOf(item.product)
  if (product === undefined) return false
  if (product.mode !== 'boundary' && product.mode !== 'pressure') return false
  if (item.dropped !== undefined && !isDropCounts(item.dropped)) return false
  return true
}

/** 防御解析：坏形状 / 版本不符 / workspace 不符 → 空档案（失败方向 = 保留原文）。 */
export function readArchiveStore(value: unknown, workspace: string): ArchiveStoreBody {
  const root = recordOf(value)
  if (root === undefined) return emptyArchiveStore(workspace)
  if (root.schemaVersion !== ARCHIVE_STORE_VERSION || root.workspace !== workspace) return emptyArchiveStore(workspace)
  const entries = Array.isArray(root.entries) ? root.entries.filter(isArchiveRecord) : []
  const cache: Record<string, CompressCacheEntry> = {}
  const rawCache = recordOf(root.cache)
  if (rawCache !== undefined) {
    for (const [key, entry] of Object.entries(rawCache)) {
      if (!isCacheEntry(entry) || entry.key !== key) continue
      cache[key] = entry
    }
  }
  return { schemaVersion: ARCHIVE_STORE_VERSION, workspace, entries, cache }
}

export interface ArchiveAppendResult {
  readonly body: ArchiveStoreBody
  /** 硬帽截断计数（04 §6；入 assemble-run / compress-run 事实）。 */
  readonly truncation: ArchiveTruncation
  readonly kept: number
}

/** 追加一条档案（只追加；超帽从最老整条机械截断，不合并、不重压）。 */
export function appendArchiveEntry(
  body: ArchiveStoreBody,
  entry: ArchiveRecord,
  policy: AssemblePolicy = DEFAULT_ASSEMBLE_POLICY,
): ArchiveAppendResult {
  const area = truncateArchiveArea([...body.entries, entry], policy)
  return {
    body: { ...body, entries: area.kept },
    truncation: area.truncated,
    kept: area.kept.length,
  }
}

/** 同 task 的检查点链（机制 A 续传面：C… 条目，transcript 序）。 */
export function priorChainFor(body: ArchiveStoreBody, taskId: string, sessionId?: string): ArchiveRecord[] {
  return body.entries.filter((entry) => entry.taskId === taskId
    && entry.kind === 'checkpoint'
    && (sessionId === undefined || entry.sessionId === undefined || entry.sessionId === sessionId))
}

function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 无歧义喂入：长度前缀 + 分隔符（防拼接歧义；region 字节逐字参与）。 */
function feed(state: { a: number; b: number }, piece: string): void {
  state.a = fnv1a32(`${piece.length}:`, state.a)
  state.b = fnv1a32(`${piece.length}:`, state.b)
  state.a = fnv1a32(piece, state.a)
  state.b = fnv1a32(piece, state.b)
}

export interface CompressSpanKeyInput {
  readonly promptVersion: number
  readonly policyVersion: number
  readonly layer: CompressMode
  readonly regionText: string
  readonly unitIds: readonly string[]
  readonly priorChainTexts: readonly string[]
  /** 装配/压缩策略指纹（热尾预算、档案帽、估计器；缺省 = 版本号已覆盖）。 */
  readonly policyKey?: string
}

/**
 * 内容寻址键（04 §6「span 哈希命中即复用」）：同键 = 同产物，可零调用复用。
 * 覆盖 prompt/policy 版本 + 层 + 区域字节 + 单元 ID 序 + 续传链字节（产物的一切输入）。
 */
export function compressSpanHash(input: CompressSpanKeyInput): string {
  const state = { a: 0x811c9dc5, b: 0x9e3779b9 }
  feed(state, String(input.promptVersion))
  feed(state, String(input.policyVersion))
  feed(state, input.layer)
  feed(state, input.regionText)
  feed(state, input.unitIds.join('\u0000'))
  feed(state, input.priorChainTexts.join('\u0000'))
  feed(state, input.policyKey ?? '')
  const a = state.a.toString(16).padStart(8, '0')
  const b = state.b.toString(16).padStart(8, '0')
  return `${a}${b}`
}

export function lookupCachedProduct(body: ArchiveStoreBody, key: string): CompressCacheEntry | undefined {
  return body.cache[key]
}

/** 写入缓存条目（插入序淘汰；同键覆盖 = 同字节，幂等）。 */
export function putCachedProduct(
  body: ArchiveStoreBody,
  entry: CompressCacheEntry,
  limit: number = ARCHIVE_CACHE_LIMIT,
): ArchiveStoreBody {
  const cache: Record<string, CompressCacheEntry> = { ...body.cache, [entry.key]: entry }
  const keys = Object.keys(cache)
  if (limit > 0 && keys.length > limit) {
    for (const key of keys.slice(0, keys.length - limit)) delete cache[key]
  }
  return { ...body, cache }
}

/**
 * 档案形态与硬帽（docs/04 §6 档案区 10K 硬帽〔F9〕/ §3 机制 A 追加式链两形态；P17c）。
 * 纯函数：超限从**最老**档案条目起整条机械截断至入限（不合并、不重压、不条内截断）；
 * 链形态只认 `[]` / `[C…]` / `[D]` / `[C…][D]`；append-only = 前缀逐条字节恒等（旧块不可改写）。
 *
 * 模块: core 边界装配纯核（档案形态 + 硬帽）
 * 平面: L0（确定性机械截断；零模型、零 IO）
 * 回退链步数: 2（超帽 → 整条截断；单条自身超帽 → 保最新一条 + overCap 标记，不空档）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D12）；不读盘、不写事实、不改史。
 * 度量: ArchiveTruncation{count,tokens} 由调用方（P19 档案区）落 assemble-run 事实。
 */
import { estimateTokens } from '../ledger/fold.ts'
import { DEFAULT_ASSEMBLE_POLICY, type ArchiveEntry, type ArchiveTruncation, type AssemblePolicy } from './types.ts'

export type ArchiveChainShape = 'empty' | 'prefix' | 'single' | 'chain'
export type ArchiveShapeCheck =
  | { readonly shape: ArchiveChainShape }
  | { readonly shape: 'invalid'; readonly reason: 'order' | 'shape' }

function isEntry(value: unknown): value is ArchiveEntry {
  const entry = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  if (entry === undefined) return false
  if (typeof entry.taskId !== 'string' || entry.taskId === '') return false
  if (entry.kind !== 'checkpoint' && entry.kind !== 'boundary') return false
  return typeof entry.text === 'string'
}

/** 链形态（04 §3 机制 A）：条目同 task、C… 在前、D 至多一条且在末位；其余 = invalid。 */
export function archiveChainShape(entries: unknown): ArchiveShapeCheck {
  if (!Array.isArray(entries)) return { shape: 'invalid', reason: 'shape' }
  if (entries.length === 0) return { shape: 'empty' }
  for (const entry of entries) if (!isEntry(entry)) return { shape: 'invalid', reason: 'shape' }
  const list = entries as readonly ArchiveEntry[]
  const taskId = (list[0] as ArchiveEntry).taskId
  for (const entry of list) if (entry.taskId !== taskId) return { shape: 'invalid', reason: 'shape' }
  const last = list[list.length - 1] as ArchiveEntry
  for (let i = 0; i < list.length - 1; i++) {
    if ((list[i] as ArchiveEntry).kind !== 'checkpoint') return { shape: 'invalid', reason: 'order' }
  }
  if (last.kind === 'boundary') return { shape: list.length === 1 ? 'single' : 'chain' }
  return { shape: 'prefix' }
}

/**
 * append-only（stub 不可重压律）：next 以 prev 为前缀，逐条 task/kind/text 字节恒等。
 * **测试/校验面**（verify-p17/p21b 与缓存不变量用例）；运行时守卫 = `archiveChainMonotone`
 * （F9d 起在 `writeStore` 生效，允许最老整条截断，本函数不允许截断故不能直接用）。
 */
export function archiveChainAppendOnly(prev: readonly ArchiveEntry[], next: readonly ArchiveEntry[]): boolean {
  if (next.length < prev.length) return false
  for (let i = 0; i < prev.length; i++) {
    const before = prev[i] as ArchiveEntry
    const after = next[i] as ArchiveEntry
    if (before.taskId !== after.taskId || before.kind !== after.kind || before.text !== after.text) return false
  }
  return true
}

/**
 * 单调追加守卫（F9d 运行时）：next 必须是 prev 的**后缀 + 追加**——允许最老整条截断
 * （front truncation），但幸存条目必须逐条字节恒等且保持相对序（append-only 律的运行时形式）。
 * 违规 = 拒写（失败方向 = 保留旧档案）。
 */
export function archiveChainMonotone(prev: readonly ArchiveEntry[], next: readonly ArchiveEntry[]): boolean {
  if (next.length === 0) return prev.length === 0
  // appendArchiveEntry 的构造性形状：next = prev.slice(k) ++ [新条目]（0 ≤ k ≤ prev.length）。
  const survivors = next.slice(0, next.length - 1)
  if (survivors.length > prev.length) return false
  const start = prev.length - survivors.length
  for (let i = 0; i < survivors.length; i++) {
    const before = prev[start + i] as ArchiveEntry
    const after = survivors[i] as ArchiveEntry
    if (before.taskId !== after.taskId || before.kind !== after.kind || before.text !== after.text) return false
  }
  return true
}

export interface ArchiveAreaResult {
  readonly kept: readonly ArchiveEntry[]
  readonly truncated: ArchiveTruncation
  readonly keptTokens: number
  /** 最新单条自身超帽（保最新 + 标记，见工单 N9）。 */
  readonly overCap: boolean
}

/** 档案区硬帽：保留满足总量 ≤ archiveTokens 的**后缀**（从最老起整条截断，不跳洞）。 */
export function truncateArchiveArea(
  entries: readonly ArchiveEntry[],
  policy: AssemblePolicy = DEFAULT_ASSEMBLE_POLICY,
): ArchiveAreaResult {
  const list = entries.slice()
  const tokens = list.map((entry) => estimateTokens(entry.text, policy.density))
  let total = tokens.reduce((sum, value) => sum + value, 0)
  if (total <= policy.archiveTokens) return { kept: list, truncated: { count: 0, tokens: 0 }, keptTokens: total, overCap: false }
  let cut = 0
  while (cut < list.length - 1 && total > policy.archiveTokens) {
    total -= tokens[cut] as number
    cut++
  }
  const truncatedTokens = tokens.slice(0, cut).reduce((sum, value) => sum + value, 0)
  return {
    kept: list.slice(cut),
    truncated: { count: cut, tokens: truncatedTokens },
    keptTokens: total,
    overCap: total > policy.archiveTokens,
  }
}

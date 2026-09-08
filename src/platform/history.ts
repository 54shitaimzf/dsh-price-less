/**
 * H4/H5 改史端口（docs/10 §1 H4/H5；docs/11 §2 history.ts 行；docs/04 §1 共享事务原语）。
 *
 * 唯一改史通道：一切历史变更经 `session.append` + `surfaceOp.replace` + 完整
 * `sourceEventSeqs` 表达；本模块是 `.append(` 的改史归口（S2）。此外提供 H5
 * `compaction/start … end` 标记对、`compaction/prune` 影子计价和配对平衡守卫。
 *
 * 模块: platform 改史端口（唯一 harness 触点层）
 * 平面: L0（确定性规则：表面定位 + 协议封装；无模型、无机制逻辑）
 * 回退链步数: 1（失败抛错——调用方决定重试/保留；历史变更绝不静默）
 * 审查清单: 不 import core；不改日志；sourceEventSeqs 由当前表面机械补全；
 *           配对平衡 = 可注入守卫（默认 harness dsh-compaction 实现）；
 *           事务扫描基于会话日志（重启后仍可从日志发现未闭合事务）。
 * 度量: 本模块无 07 字段；剪切/压缩域经返回值入账。
 */

import type { Session, SessionEvent, SessionEventMap, SessionSeq, SurfaceEventType } from '@deepseek-ai/dsh-session'
import { CompactionId, toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { boundContextSummary, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

export type HistoryErrorCode =
  | 'INVALID_RANGE'
  | 'ASSISTANT_SOURCE_SEQS'
  | 'COMPACTION_ACTIVE'
  | 'NO_ACTIVE_COMPACTION'
  | 'COMPACTION_ID_MISMATCH'
  | 'COMPACTION_TURN_MISMATCH'

export class HistoryError extends Error {
  constructor(
    readonly code: HistoryErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'HistoryError'
  }
}

export interface SurfaceRange {
  start: SessionSeq
  end: SessionSeq
}

export interface ReplaceSurfaceRequest<T extends SurfaceEventType = SurfaceEventType> {
  type: T
  data: SessionEventMap[T]
  range: SurfaceRange
  /** 额外引用源（被遮蔽节点由本端口自动补全；assistant/message 禁止携带）。 */
  sourceEventSeqs?: SessionSeq[]
}

export interface HistoryReplaceResult<T extends SurfaceEventType> {
  event: SessionEvent<T>
  /** 本次实际被遮蔽的表面节点（surface 序），即 sourceEventSeqs 的被遮蔽子集。 */
  shadowedSeqs: SessionSeq[]
}

export interface PairBalanceChecker {
  before(session: Session, seq: SessionSeq): boolean
  after(session: Session, seq: SessionSeq): boolean
}

/** 默认配对平衡守卫 = harness dsh-compaction 官方实现（docs/04 §1）。 */
export const nativePairBalanceChecker: PairBalanceChecker = {
  before: (session, seq) => toolPairingBalancedBefore(session, seq),
  after: (session, seq) => toolPairingBalancedAfter(session, seq),
}


/**
 * 插件来源的结论替换节点（P16 对话剪切；官方 compaction checkpoint 同构）。
 * 内容 = 中立叙述体结论；来源 = plugin + form:'notice'（折叠成一行摘要，主模型只见结论本身）。
 * @param text 模型可见的结论正文。
 * @param summary UI 折叠行的一行摘要（自动钳制到 CONTEXT_SUMMARY_MAX_CHARS）。
 */
export function buildNoticeUserMessage(text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'context-economy', form: 'notice', summary: boundContextSummary(summary) },
  })
}

export interface CompactionBegin {
  compactionId: string
  turn: number | null
}

export interface CompactionEnd {
  compactionId: string
  turn: number | null
  error?: string
}

export interface ActiveCompaction {
  compactionId: ReturnType<typeof CompactionId>
  turn: number | null
  startSeq: SessionSeq
}

export interface HistoryPort {
  replaceSurface<T extends SurfaceEventType>(request: ReplaceSurfaceRequest<T>): HistoryReplaceResult<T>
  beginCompaction(init: CompactionBegin): SessionEvent<'compaction/start'>
  endCompaction(init: CompactionEnd): SessionEvent<'compaction/end'>
  recordPrune(input: SurfaceRange & { shadowedTokenCount: number }): SessionEvent<'compaction/prune'>
  assertNoActiveCompaction(): void
  findActiveCompaction(): ActiveCompaction | undefined
  balanceRange(range: SurfaceRange): SurfaceRange | null
  pairBalancedBefore(seq: SessionSeq): boolean
  pairBalancedAfter(seq: SessionSeq): boolean
}

function findSpan(session: Session, range: SurfaceRange): { startIdx: number; endIdx: number; shadowedSeqs: SessionSeq[] } {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(range.start)
  const endIdx = nodes.indexOf(range.end)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    throw new HistoryError('INVALID_RANGE', `INVALID_RANGE: invalid surface replace range ${String(range.start)}..${String(range.end)}`)
  }
  return { startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) }
}

function mergeSourceSeqs(extra: readonly SessionSeq[] | undefined, shadowed: readonly SessionSeq[]): SessionSeq[] {
  const set = new Set<number>(shadowed.map(Number))
  for (const seq of extra ?? []) set.add(Number(seq))
  return [...set].sort((a, b) => a - b).map((n) => n as SessionSeq)
}

function scanActiveCompaction(session: Session): ActiveCompaction | undefined {
  let open: ActiveCompaction | undefined
  for (const event of session.snapshotEvents()) {
    if (event.type === 'compaction/start') {
      open = {
        compactionId: event.data.compactionId,
        turn: event.data.turn,
        startSeq: event.seq,
      }
    } else if (event.type === 'compaction/end') {
      if (open !== undefined && String(open.compactionId) === String(event.data.compactionId)) open = undefined
    }
  }
  return open
}

function activeOrThrow(session: Session): ActiveCompaction {
  const active = scanActiveCompaction(session)
  if (active === undefined) throw new HistoryError('NO_ACTIVE_COMPACTION', 'NO_ACTIVE_COMPACTION: no active compaction transaction to close')
  return active
}

export function createHistoryPort(
  session: Session,
  options: { balanceChecker?: PairBalanceChecker } = {},
): HistoryPort {
  const balanceChecker = options.balanceChecker ?? nativePairBalanceChecker

  const replaceSurface = <T extends SurfaceEventType>(request: ReplaceSurfaceRequest<T>): HistoryReplaceResult<T> => {
    const span = findSpan(session, request.range)
    if (request.type === 'assistant/message' && request.sourceEventSeqs !== undefined) {
      throw new HistoryError('ASSISTANT_SOURCE_SEQS', 'ASSISTANT_SOURCE_SEQS: assistant/message replacement cannot carry sourceEventSeqs')
    }
    const appendSurface = session.append.bind(session) as unknown as <U extends SurfaceEventType>(
      type: U,
      data: SessionEventMap[U],
      opts: { surfaceOp: { op: 'replace'; start: SessionSeq; end: SessionSeq }; sourceEventSeqs?: SessionSeq[] },
    ) => SessionEvent<U>
    const sourceEventSeqs = request.type === 'assistant/message'
      ? undefined
      : mergeSourceSeqs(request.sourceEventSeqs, span.shadowedSeqs)
    const event = appendSurface(request.type, request.data, {
      surfaceOp: { op: 'replace', start: request.range.start, end: request.range.end },
      ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
    })
    return { event, shadowedSeqs: span.shadowedSeqs }
  }

  const assertNoActiveCompaction = (): void => {
    const active = scanActiveCompaction(session)
    if (active !== undefined) {
      throw new HistoryError('COMPACTION_ACTIVE', `COMPACTION_ACTIVE: compaction ${String(active.compactionId)} already active (start seq ${String(active.startSeq)})`)
    }
  }

  const beginCompaction = (init: CompactionBegin): SessionEvent<'compaction/start'> => {
    assertNoActiveCompaction()
    return session.append('compaction/start', { compactionId: CompactionId(init.compactionId), turn: init.turn })
  }

  const endCompaction = (init: CompactionEnd): SessionEvent<'compaction/end'> => {
    const active = activeOrThrow(session)
    if (String(active.compactionId) !== init.compactionId) {
      throw new HistoryError('COMPACTION_ID_MISMATCH', `COMPACTION_ID_MISMATCH: cannot close ${init.compactionId}: active transaction is ${String(active.compactionId)}`)
    }
    if (active.turn !== init.turn) {
      throw new HistoryError('COMPACTION_TURN_MISMATCH', `COMPACTION_TURN_MISMATCH: cannot close ${init.compactionId}: turn ${String(init.turn)} != active ${String(active.turn)}`)
    }
    return session.append('compaction/end', {
      compactionId: CompactionId(init.compactionId),
      turn: init.turn,
      ...(init.error === undefined ? {} : { error: init.error }),
    })
  }

  const recordPrune = (input: SurfaceRange & { shadowedTokenCount: number }): SessionEvent<'compaction/prune'> => {
    const span = findSpan(session, input)
    return session.append('compaction/prune', {
      shadowedRange: { start: input.start, end: input.end },
      shadowedSeqs: span.shadowedSeqs,
      shadowedTokenCount: input.shadowedTokenCount,
    })
  }

  const balanceRange = (range: SurfaceRange): SurfaceRange | null => {
    const nodes = session.surface.nodes
    const startIdx = nodes.indexOf(range.start)
    const endIdx = nodes.indexOf(range.end)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return null
    let s = startIdx
    let e = endIdx
    while (s <= e && !balanceChecker.before(session, nodes[s]!)) s++
    while (e >= s && !balanceChecker.after(session, nodes[e]!)) e--
    if (s > e) return null
    return { start: nodes[s]!, end: nodes[e]! }
  }

  return {
    replaceSurface,
    beginCompaction,
    endCompaction,
    recordPrune,
    assertNoActiveCompaction,
    findActiveCompaction: () => scanActiveCompaction(session),
    balanceRange,
    pairBalancedBefore: (seq) => balanceChecker.before(session, seq),
    pairBalancedAfter: (seq) => balanceChecker.after(session, seq),
  }
}

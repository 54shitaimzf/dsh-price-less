/**
 * P15b 工具剪切调度域（docs/03 §2/§2.1/§2.2；docs/10 §1 H4/H6；docs/11 §2 domains/shear.ts 行）。
 * 两相接线：同步相 = 工具结果落账前挂点（T-entry 整形 / T-note 贴注）；异步相 = pump 事件
 * （重折 foldToolShear → 门槛 → H4 surfaceOp replace + 影子计价 → 事实发射）。
 * 失败语义：协商不成不动刀、写未成功不剪、老读件不剪、抛错遏制 + 零重试（失败默认保留）。
 *
 * 模块: domains 剪切调度（core 纯核 + platform 端口编排）
 * 平面: L0/L1（机械时机 + 纯核判据；零模型参与）
 * 回退链步数: 3（纯核自带策略 → 类别启发式 → 保留；执行侧九道门槛任一不过即保留）
 * 审查清单: 改史只经 platform/history（S2）；工具事件只经 platform/tools（D8）；事实只经 logger.emitCeFact
 *           （S3/D3）；无 timer（S5）；配置关闭 = 零行为；不读盘、不调模型。
 * 度量: context-economy/shear-applied|shear-decision|shear-error（fold 见 core/shear/ledger.ts）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_SHEAR_POLICY,
  SHEAR_NOTE_TEMPLATE,
  SHEAR_POLICY_VERSION,
  buildLoopStub,
  buildSupersededStub,
  foldToolShear,
  ledgerEventText,
  noteEligible,
  shapeEntryContent,
  toolCategory,
  utf8ByteLength,
  type ShearEvent,
  type ShearOp,
  type ShearPolicy,
  type ShearToolCall,
} from '../core/shear/index.ts'
import { estimateTokens, extractTextFromToolResult } from '../core/ledger/fold.ts'
import { createHistoryPort, type HistoryPort } from '../platform/history.ts'
import { emitCeFact } from '../platform/logger.ts'
import { createShearToolPort, type ToolResultView } from '../platform/tools.ts'
import type { CeDomainEvents, CeLogger, EventPump } from '../platform/events.ts'
import type { Config } from '../config.ts'
import {
  SHEAR_APPLIED_FACT_TYPE,
  SHEAR_DECISION_FACT_TYPE,
  SHEAR_ERROR_FACT_TYPE,
  compactFact,
  type ShearAppliedFactData,
  type ShearAppliedTier,
  type ShearDecisionFactData,
  type ShearErrorFactData,
} from './shear-facts.ts'

/** 会话内参与重折的原始事件上限（超出丢最老；只影响超老读件的 T0 检出，失败方向 = 保留）。 */
export const SESSION_EVENT_LIMIT = 4000
/** T0/T0-R 执行门槛：被超越读件必须仍在最后 N 个表面节点内（[03 §1] 断裂成本公式）。 */
export const TAIL_NODE_WINDOW = 8
/** 落账前决策的待结算上限（结果事件到达即结算；未到达的最老条目丢弃）。 */
export const PENDING_LIMIT = 1000

export interface ShearDomainDeps {
  pump: EventPump
  getConfig: () => Config
  logger: CeLogger
  now?: () => number
  policy?: ShearPolicy
}

export interface ShearDomainStats {
  sessions: number
  entryShaped: number
  notesAttached: number
  cuts: number
  holds: number
  errors: number
}

export interface ShearDomain {
  dispose(): void
  stats(): ShearDomainStats
}

interface PendingEntry {
  readonly kind: 'entry' | 'note'
  readonly view: ToolResultView
  readonly beforeTokens: number
  readonly afterTokens: number
  readonly noteBytes: number
}

interface SessionState {
  readonly session: Session
  readonly history: HistoryPort
  readonly events: ShearEvent[]
  readonly seqs: Set<number>
  readonly consumed: Set<string>
  readonly holdsSeen: Set<string>
  readonly entryShaped: Set<string>
  readonly nameByCallId: Map<string, string>
  readonly resultSeqByCallId: Map<string, SessionSeq>
  readonly resultTextByCallId: Map<string, string>
  readonly resultErrorByCallId: Map<string, boolean>
}

function callIdOfResultData(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const root = data as { message?: { content?: unknown }; content?: unknown }
  const message = typeof root.message === 'object' && root.message !== null ? root.message : root
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content) || content.length === 0) return undefined
  const block = content[0] as { toolCallId?: unknown } | null
  return block !== null && typeof block?.toolCallId === 'string' ? block.toolCallId : undefined
}

function eventTextOf(event: SessionEvent): string {
  const data = (event.data ?? {}) as Record<string, unknown>
  if (event.type === 'tool/result') return extractTextFromToolResult(data)
  const message = (data.message ?? data) as { content?: unknown } | undefined
  const content = message?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
      const part = (block as { text?: unknown }).text
      if (typeof part === 'string') text += part
    }
  }
  return text
}

function isReplacement(event: SessionEvent): boolean {
  const op = (event as { surfaceOp?: unknown }).surfaceOp
  return typeof op === 'object' && op !== null
}

function opKeyOf(op: ShearOp): string {
  if (op.kind === 't0r-repair') return `T0-R|${op.readCallId}|${op.version}`
  return `${op.kind}|${op.callId}`
}

function opTierOf(op: ShearOp): ShearAppliedTier {
  switch (op.kind) {
    case 'shape-entry': return 'T-entry'
    case 'stub-replace': return 'T-loop'
    case 'note-cut': return 'T-note'
    case 't0-supersede': return 'T0'
    case 't0r-repair': return 'T0-R'
  }
}

function opTargetCallId(op: ShearOp): string {
  return op.kind === 't0r-repair' ? op.readCallId : op.callId
}

function replacementTextOf(op: ShearOp): string {
  switch (op.kind) {
    case 'stub-replace': return op.stub
    case 'note-cut': return buildLoopStub(op.conclusion)
    case 't0-supersede': return buildSupersededStub(op.path)
    case 't0r-repair': return op.envelope
    default: return ''
  }
}

export function mountShearDomain(ctx: Pick<Context, 'on'>, deps: ShearDomainDeps): ShearDomain {
  const { pump, getConfig, logger, now = Date.now } = deps
  const policy = deps.policy ?? DEFAULT_SHEAR_POLICY
  const states = new WeakMap<Session, SessionState>()
  const pending = new Map<string, PendingEntry>()
  const counts = { sessions: 0, entryShaped: 0, notesAttached: 0, cuts: 0, holds: 0, errors: 0 }
  let disposed = false

  const enabled = (): boolean => getConfig().shear?.enabled !== false

  const rememberPending = (callId: string, entry: PendingEntry): void => {
    pending.set(callId, entry)
    if (pending.size > PENDING_LIMIT) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) pending.delete(oldest)
    }
  }

  const callOf = (view: ToolResultView): ShearToolCall => ({ seq: 0, time: 0, callId: view.callId, name: view.name, argsText: '' })

  const shapeEntry = (view: ToolResultView): string | undefined => {
    if (disposed || !enabled()) return undefined
    const shaped = shapeEntryContent(callOf(view), view.resultText)
    if (shaped === undefined) return undefined
    const beforeTokens = estimateTokens(view.resultText)
    const afterTokens = estimateTokens(shaped)
    if (afterTokens >= beforeTokens) return undefined
    rememberPending(view.callId, { kind: 'entry', view, beforeTokens, afterTokens, noteBytes: 0 })
    return shaped
  }

  const attachNote = (view: ToolResultView): string | undefined => {
    if (disposed || !enabled()) return undefined
    if (!noteEligible(callOf(view), view.resultText, policy)) return undefined
    rememberPending(view.callId, { kind: 'note', view, beforeTokens: 0, afterTokens: 0, noteBytes: utf8ByteLength(SHEAR_NOTE_TEMPLATE) })
    return SHEAR_NOTE_TEMPLATE
  }

  const port = createShearToolPort(ctx, { shapeEntry, attachNote }, logger)

  const emitError = (session: Session, opKey: string, tier: string | undefined, code: string, message: string): void => {
    const data: ShearErrorFactData = compactFact({ at: now(), opKey, ...(tier === undefined ? {} : { tier }), code, message })
    emitCeFact(session, SHEAR_ERROR_FACT_TYPE, data, logger)
    counts.errors++
  }

  const pushEvent = (state: SessionState, event: ShearEvent): void => {
    state.events.push(event)
    if (state.events.length > SESSION_EVENT_LIMIT) state.events.shift()
  }

  const ingest = (state: SessionState, event: SessionEvent): boolean => {
    if (isReplacement(event) || state.seqs.has(event.seq)) return false
    const data = (event.data ?? {}) as Record<string, unknown>
    if (event.type === 'tool/call') {
      const callId = String(data.callId ?? '')
      const name = String(data.name ?? '')
      state.seqs.add(event.seq)
      if (callId !== '') state.nameByCallId.set(callId, name)
      pushEvent(state, { kind: 'tool-call', call: { seq: event.seq, time: event.time, callId, name, argsText: String(data.arguments ?? '') } })
      return true
    }
    if (event.type === 'tool/result') {
      const callId = callIdOfResultData(data)
      const text = extractTextFromToolResult(data)
      state.seqs.add(event.seq)
      pushEvent(state, { kind: 'tool-result', result: { seq: event.seq, time: event.time, callId: callId ?? '', text } })
      if (callId !== undefined) {
        state.resultSeqByCallId.set(callId, event.seq)
        state.resultTextByCallId.set(callId, text)
        state.resultErrorByCallId.set(callId, data.error !== undefined && data.error !== null)
      }
      return true
    }
    if (event.type === 'assistant/message') {
      state.seqs.add(event.seq)
      pushEvent(state, { kind: 'assistant-message', seq: event.seq, time: event.time, text: eventTextOf(event) })
      return true
    }
    return false
  }

  const stateOf = (session: Session): SessionState => {
    const existing = states.get(session)
    if (existing !== undefined) return existing
    const state: SessionState = {
      session,
      history: createHistoryPort(session),
      events: [],
      seqs: new Set(),
      consumed: new Set(),
      holdsSeen: new Set(),
      entryShaped: new Set(),
      nameByCallId: new Map(),
      resultSeqByCallId: new Map(),
      resultTextByCallId: new Map(),
      resultErrorByCallId: new Map(),
    }
    states.set(session, state)
    counts.sessions++
    // 回填基线：重启/首次见到会话时折一遍历史，op 全部记为已消费（不执行、不发事实）——
    // 剪点必须贴近尾部，历史中部不回剪（docs/03 §1）。
    const snapshot = (session as unknown as { snapshotEvents?: () => readonly SessionEvent[] }).snapshotEvents?.() ?? []
    for (const event of snapshot) ingest(state, event)
    const plan = foldToolShear(state.events, policy, { entryShaped: state.entryShaped })
    for (const op of plan.ops) state.consumed.add(opKeyOf(op))
    for (const decision of plan.decisions) if (decision.decision === 'hold') state.holdsSeen.add(`${decision.tier}|${decision.callId ?? ''}`)
    return state
  }

  const settlePending = (session: Session, event: SessionEvent): void => {
    if (event.type !== 'tool/result') return
    const callId = callIdOfResultData(event.data)
    if (callId === undefined) return
    const entry = pending.get(callId)
    if (entry === undefined) return
    pending.delete(callId)
    if (entry.kind === 'entry') {
      const data: ShearAppliedFactData = compactFact({
        policyVersion: SHEAR_POLICY_VERSION,
        tier: 'T-entry',
        kind: 'shape-entry',
        callId,
        resultSeq: event.seq,
        at: now(),
        category: toolCategory(entry.view.name),
        beforeTokens: entry.beforeTokens,
        afterTokens: entry.afterTokens,
        savedTokens: entry.beforeTokens - entry.afterTokens,
        breakTokens: 0,
        tailNodes: 0,
      })
      emitCeFact(session, SHEAR_APPLIED_FACT_TYPE, data, logger)
      stateOf(session).entryShaped.add(callId)
      counts.entryShaped++
      return
    }
    const decision: ShearDecisionFactData = compactFact({
      policyVersion: SHEAR_POLICY_VERSION,
      tier: 'T-note',
      decision: 'note-attached',
      reason: 'note-eligible',
      callId,
      at: now(),
      noteBytes: entry.noteBytes,
    })
    emitCeFact(session, SHEAR_DECISION_FACT_TYPE, decision, logger)
    counts.notesAttached++
  }

  const executeOp = (state: SessionState, op: ShearOp, targetCallId: string, resultSeq: SessionSeq, text: string): void => {
    const target = state.session.eventAt(resultSeq)
    if (target === undefined || target.type !== 'tool/result') {
      emitError(state.session, opKeyOf(op), opTierOf(op), 'CE_SHEAR_NO_TARGET', 'target result event unavailable')
      return
    }
    const beforeTokens = estimateTokens(state.resultTextByCallId.get(targetCallId) ?? '')
    const afterTokens = estimateTokens(text)
    if (op.kind !== 't0r-repair' && afterTokens >= beforeTokens) return
    const message = target.data.message
    const block = message.content[0]
    if (block === undefined) {
      emitError(state.session, opKeyOf(op), opTierOf(op), 'CE_SHEAR_NO_BLOCK', 'tool result has no content block')
      return
    }
    const replacement = {
      ...target.data,
      message: { ...message, content: [{ ...block, content: [{ type: 'text', text }] }] as [typeof block] },
    }
    state.history.recordPrune({ start: resultSeq, end: resultSeq, shadowedTokenCount: beforeTokens })
    const landed = state.history.replaceSurface({
      type: 'tool/result',
      data: replacement,
      range: { start: resultSeq, end: resultSeq },
      sourceEventSeqs: [resultSeq],
    })
    const nodes = state.session.surface.nodes
    const index = nodes.indexOf(landed.event.seq)
    let breakTokens = 0
    let tailNodes = 0
    if (index >= 0) {
      for (const seq of nodes.slice(index + 1)) {
        const event = state.session.eventAt(seq)
        if (event === undefined) continue
        tailNodes++
        breakTokens += estimateTokens(ledgerEventText(event as never))
      }
    }
    const data: ShearAppliedFactData = compactFact({
      policyVersion: SHEAR_POLICY_VERSION,
      tier: opTierOf(op),
      kind: op.kind,
      callId: targetCallId,
      resultSeq,
      at: now(),
      ...(op.kind === 't0r-repair' || op.kind === 't0-supersede' ? { path: op.path } : {}),
      ...(op.kind === 't0r-repair'
        ? {
            version: op.version,
            segments: op.segments.length,
            windowLines: op.windowLines,
            repairCoverage: op.windowLines === 0 ? 0 : op.segments.reduce((total, segment) => total + segment.lines.length, 0) / op.windowLines,
          }
        : {}),
      category: toolCategory(state.nameByCallId.get(targetCallId) ?? ''),
      beforeTokens,
      afterTokens,
      savedTokens: beforeTokens - afterTokens,
      breakTokens,
      tailNodes,
    })
    emitCeFact(state.session, SHEAR_APPLIED_FACT_TYPE, data, logger)
    counts.cuts++
  }

  const processOps = (state: SessionState): void => {
    const plan = foldToolShear(state.events, policy, { entryShaped: state.entryShaped })
    for (const decision of plan.decisions) {
      if (decision.decision !== 'hold') continue
      const key = `${decision.tier}|${decision.callId ?? ''}`
      if (state.holdsSeen.has(key)) continue
      state.holdsSeen.add(key)
      const data: ShearDecisionFactData = compactFact({
        policyVersion: SHEAR_POLICY_VERSION,
        tier: decision.tier as ShearAppliedTier,
        decision: 'hold',
        reason: decision.reason,
        ...(decision.callId === undefined ? {} : { callId: decision.callId }),
        at: now(),
      })
      emitCeFact(state.session, SHEAR_DECISION_FACT_TYPE, data, logger)
      counts.holds++
    }
    for (const op of plan.ops) {
      const key = opKeyOf(op)
      if (state.consumed.has(key)) continue
      if (op.kind === 'shape-entry') { state.consumed.add(key); continue }
      const targetCallId = opTargetCallId(op)
      const resultSeq = state.resultSeqByCallId.get(targetCallId)
      if (resultSeq === undefined) { state.consumed.add(key); continue }
      const nodes = state.session.surface.nodes
      const index = nodes.indexOf(resultSeq)
      if (index < 0) {
        state.consumed.add(key)
        emitError(state.session, key, opTierOf(op), 'CE_SHEAR_NOT_ON_SURFACE', `result seq ${resultSeq} is not a current surface node`)
        continue
      }
      if (op.kind === 't0-supersede' || op.kind === 't0r-repair') {
        const writeError = state.resultErrorByCallId.get(op.writeCallId)
        if (writeError === undefined) continue
        if (writeError) { state.consumed.add(key); continue }
        if (nodes.length - 1 - index >= TAIL_NODE_WINDOW) { state.consumed.add(key); continue }
      }
      state.consumed.add(key)
      try {
        executeOp(state, op, targetCallId, resultSeq, replacementTextOf(op))
      } catch (e) {
        emitError(state.session, key, opTierOf(op), 'CE_SHEAR_OP_FAILED', e instanceof Error ? e.message : String(e))
      }
    }
  }

  const onMetrics = ({ session, event }: CeDomainEvents['metrics/session-event']): void => {
    if (disposed || !enabled()) return
    if (session.header.origin === 'subagent') return
    const state = stateOf(session)
    settlePending(session, event)
    if (!ingest(state, event)) return
    processOps(state)
  }

  const onUserMessage = (payload: CeDomainEvents['input/user-message']): void => {
    if (disposed || !enabled()) return
    const { session } = payload
    if (session.header.origin === 'subagent') return
    const state = stateOf(session)
    if (state.seqs.has(payload.seq)) return
    state.seqs.add(payload.seq)
    pushEvent(state, { kind: 'user-message', seq: payload.seq, time: payload.time, text: payload.text })
    processOps(state)
  }

  const offMetrics = pump.on('metrics/session-event', onMetrics)
  const offUser = pump.on('input/user-message', onUserMessage)

  return {
    dispose() {
      if (disposed) return
      disposed = true
      offMetrics()
      offUser()
      port.dispose()
    },
    stats() { return { ...counts } },
  }
}

/**
 * P17b 边界装配域（docs/04 §2 双通道取真 / §1 共享事务原语；docs/10 §1 H4/H5/H15；docs/11 §2）。
 * 编排：事件摄取（表面 fold → 单元/文件操作）→ 范围过滤 → 版本链 fold → 通道 A 经
 * platform/files 盘上取真 / 通道 B 用单元原文 → core/assemble 装配 → assemble-run 事实。
 * 本域**不触发**压缩、不落档案（触发/档案 vN/卷宗清空归 P19）；事务执行器供 P19 复用。
 * 失败语义：fs 缺失 = 通道 A 丢弃计数 + 兜底照常；装配 fatal 只来自 digest schema（零重试）。
 *
 * 模块: domains 装配编排（core 纯核 + platform 端口）
 * 平面: L0（机械装配；零模型）
 * 回退链步数: 2（坐标丢弃 → 位置兜底；fs 缺失 = 通道 A 全降级）
 * 审查清单: 改史只经 platform/history（S2）；fs 只经 platform/files（D11）；事实只经 logger.emitCeFact
 *           （S3/D3）；无 timer（S5）；不读盘、不调模型。
 * 度量: context-economy/assemble-run（fold 见 core/assemble/ledger.ts）。
 */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_ASSEMBLE_POLICY,
  assembleArchive,
  foldAssembleInputs,
  gateHotTailDecls,
  txnOrderValid,
  remapFileCoord,
  type ArchiveEntry,
  type ArchiveTruncation,
  type AssembleLayer,
  type AssembleOutcome,
  type AssemblePolicy,
  type AssembleUnit,
  type HotTailDecl,
  type TaskDigest,
  type TxnPlan,
} from '../core/assemble/index.ts'
import { foldFileChains } from '../core/assemble/chain.ts'
import { foldSurfaceNodes } from '../core/ledger/surface.ts'
import { compactFact } from '../core/ledger/facts.ts'
import type { LedgerSessionEvent } from '../core/ledger/types.ts'
import { emitCeFact } from '../platform/logger.ts'
import type { HistoryPort } from '../platform/history.ts'
import type { FilesPort } from '../platform/files.ts'
import { readSessionEvents, type CeDomainEvents, type CeLogger, type EventPump } from '../platform/events.ts'
import { ASSEMBLE_RUN_FACT_TYPE, type AssembleRunFactData } from './assemble-facts.ts'

/** 会话内参与装配重折的原始事件上限（超出丢最老；只影响超老材料的单元清单，失败方向 = 保留）。 */
export const ASSEMBLE_EVENT_LIMIT = 4000

export interface AssembleDomainDeps {
  pump: EventPump
  logger: CeLogger
  /** 盘上取真端口（H15）；缺省 / 返回 undefined = 通道 A 降级。 */
  getFiles?: () => FilesPort | undefined
  now?: () => number
  policy?: AssemblePolicy
}

export interface AssembleRequest {
  readonly session: Session
  readonly taskId: string
  /** 闭合段范围（会话序，1-based 含端点）。 */
  readonly range: { readonly startSeq: number; readonly endSeq: number }
  readonly layer?: AssembleLayer
  readonly digest?: TaskDigest
  readonly hotTail?: readonly HotTailDecl[]
  /** 已存在的压力检查点链（04 §3 机制 A 续传；P17c）。 */
  readonly priorChain?: readonly ArchiveEntry[]
  /** 被压区间体量（估算 token；热尾份额帽分母；F9c 由压缩域传入）。 */
  readonly regionTokens?: number
  /** 渲染根（会话工作区；F9e）。 */
  readonly root?: string
  readonly rootKind?: 'session' | 'cwd' | 'none'
  /** 档案区硬帽截断结果（生产者 = P19 档案区；P17c 只透传入账）。 */
  readonly archiveTruncate?: ArchiveTruncation
}

export interface AssembleDomainStats {
  sessions: number
  assemblies: number
  failures: number
  degraded: number
}

export interface AssembleDomain {
  dispose(): void
  stats(): AssembleDomainStats
  /** 闭合段内单元清单（压缩器 prompt 枚举面；P18 消费）。U1：传 `domain`（实际遮蔽集）时按其过滤，seq 区间仅作缺省近似。 */
  unitList(session: Session, range: { startSeq: number; endSeq: number }, domain?: ReadonlySet<number>): AssembleUnit[]
  /** 装配一条边界档案计划（纯内存 + 盘上取真；注入与档案 vN 归 P19）。 */
  assemble(request: AssembleRequest): Promise<AssembleOutcome>
}

export interface TxnRunResult {
  readonly ok: boolean
  readonly code?: string
  readonly message?: string
  readonly steps: number
}

/**
 * 共享事务原语执行器（docs/04 §1）：assertNoActiveCompaction → open → 业务 op → close。
 * 业务 op 失败也**闭合事务**（带 error，绝不半开标记）；标记对与配对平衡守卫锁在 platform/history（D7）。
 */
export function runCompactionTxn(
  history: HistoryPort,
  plan: TxnPlan,
  apply: (history: HistoryPort) => void,
): TxnRunResult {
  if (!txnOrderValid(plan.steps)) return { ok: false, code: 'TXN_ORDER', message: 'invalid transaction step order', steps: 0 }
  try {
    history.assertNoActiveCompaction()
  } catch (e) {
    return { ok: false, code: 'TXN_ACTIVE', message: e instanceof Error ? e.message : String(e), steps: 0 }
  }
  history.beginCompaction({ compactionId: plan.txnId, turn: plan.turn })
  let steps = 1
  try {
    apply(history)
    steps++
    history.endCompaction({ compactionId: plan.txnId, turn: plan.turn })
    steps++
    return { ok: true, steps }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    try {
      history.endCompaction({ compactionId: plan.txnId, turn: plan.turn, error: message })
      steps++
    } catch {
      // 收尾失败 = 遏制（事务仍可从日志发现未闭合；调用方记 error 事实）。
    }
    return { ok: false, code: 'TXN_BODY', message, steps }
  }
}

interface AssembleSessionState {
  readonly session: Session
  readonly events: LedgerSessionEvent[]
  readonly seqs: Set<number>
}

export function mountAssembleDomain(deps: AssembleDomainDeps): AssembleDomain {
  const { pump, logger, now = Date.now } = deps
  const policy = deps.policy ?? DEFAULT_ASSEMBLE_POLICY
  const states = new WeakMap<Session, AssembleSessionState>()
  const counts: AssembleDomainStats = { sessions: 0, assemblies: 0, failures: 0, degraded: 0 }
  let disposed = false

  const ingest = (state: AssembleSessionState, event: SessionEvent): void => {
    if (state.seqs.has(event.seq)) return
    state.seqs.add(event.seq)
    state.events.push({
      type: event.type,
      seq: event.seq,
      time: event.time,
      data: event.data,
      surfaceOp: (event as unknown as { surfaceOp?: unknown }).surfaceOp,
    })
    if (state.events.length > ASSEMBLE_EVENT_LIMIT) state.events.shift()
  }

  const stateOf = (session: Session): AssembleSessionState => {
    const existing = states.get(session)
    if (existing !== undefined) return existing
    const state: AssembleSessionState = { session, events: [], seqs: new Set() }
    states.set(session, state)
    counts.sessions++
    const snapshot = readSessionEvents(session)
    for (const event of snapshot) ingest(state, event)
    return state
  }

  /** 当前表面可见事件（被 replace 遮蔽的 tool/result 不再入清单；tool/call 始终保留以保配对）。 */
  const visibleEvents = (state: AssembleSessionState): LedgerSessionEvent[] => {
    const surface = new Set(foldSurfaceNodes(state.events))
    return state.events.filter((event) => event.type === 'tool/call' || surface.has(event.seq))
  }

  const unitsIn = (session: Session, range: { startSeq: number; endSeq: number }, domain?: ReadonlySet<number>): AssembleUnit[] => {
    const state = stateOf(session)
    const units = foldAssembleInputs(visibleEvents(state)).units
    // U1：单元归域以 seqEnd（表面节点）为准——tool/call 是日志事件不在遮蔽集里，但其结果节点在。
    if (domain !== undefined) return units.filter((unit) => domain.has(unit.seqEnd))
    return units.filter((unit) => unit.seqStart >= range.startSeq && unit.seqEnd <= range.endSeq)
  }

  const assemble = async (request: AssembleRequest): Promise<AssembleOutcome> => {
    if (disposed) return { ok: false, reason: 'no-units' }
    const state = stateOf(request.session)
    const inputs = foldAssembleInputs(visibleEvents(state))
    const { startSeq, endSeq } = request.range
    const units = inputs.units.filter((unit) => unit.seqStart >= startSeq && unit.seqEnd <= endSeq)
    const ops = inputs.ops.filter((op) => op.seq >= startSeq && op.seq <= endSeq)
    const chains = foldFileChains(ops)

    const decls = request.hotTail ?? []
    // HT 软门（P17c）：坏形状在触盘前被挡下（coord 形状由 gate 保证，remap 前置守卫）。
    const gated = gateHotTailDecls(decls, units)
    const resolve: Record<string, string> = {}
    const currentLineCounts: Record<string, number | null> = {}
    const files = deps.getFiles?.()
    let fetchCapped = 0
    if (files === undefined) {
      if (gated.accepted.some((decl) => decl.coord !== undefined)) counts.degraded++
    } else {
      const windows = new Map<string, Awaited<ReturnType<FilesPort['readLines']>>>()
      let fetches = 0
      for (const [index, decl] of gated.accepted.entries()) {
        const coord = decl.coord
        if (coord === undefined) continue
        if (fetches >= policy.maxFetchUnits) {
          // F9f：申报洪泛时静默截断改明账（不再无计数）。
          fetchCapped = gated.accepted.slice(index).filter((item) => item.coord !== undefined).length
          break
        }
        if (!windows.has(coord.path)) {
          windows.set(coord.path, await files.readLines(coord.path))
          fetches++
        }
        const window = windows.get(coord.path) ?? null
        currentLineCounts[coord.path] = window === null ? null : window.totalLines
        if (window === null) continue
        const remap = remapFileCoord(chains.get(coord.path), coord, window.totalLines)
        if (!remap.ok) continue
        resolve[decl.unitId] = window.lines.slice(remap.lineRange.start - 1, remap.lineRange.end).join('\n')
      }
    }

    const outcome = assembleArchive({
      units,
      chains,
      ...(request.digest === undefined ? {} : { digest: request.digest }),
      ...(request.priorChain === undefined ? {} : { priorChain: request.priorChain }),
      ...(request.regionTokens === undefined ? {} : { regionTokens: request.regionTokens }),
      ...(request.root === undefined ? {} : { root: request.root }),
      ...(request.rootKind === undefined ? {} : { rootKind: request.rootKind }),
      hotTail: decls,
      resolve,
      currentLineCounts,
      ...(request.layer === undefined ? {} : { layer: request.layer }),
      policy,
    })
    if (!outcome.ok) {
      counts.failures++
      return outcome
    }
    counts.assemblies++
    const result = outcome.result
    const data: AssembleRunFactData = compactFact({
      at: now(),
      layer: result.layer,
      digestBytes: result.digestPlan.bytes,
      digestEntryCount: result.digestPlan.stepCount,
      digestTokens: result.digestPlan.tokens,
      gistBytes: result.digestPlan.gistBytes,
      stepCount: result.digestPlan.stepCount,
      stepTokens: result.digestPlan.stepTokens,
      factLeaks: result.digestPlan.factLeaks,
      quotaDrops: result.hotTail.quotaDrops,
      factRejects: result.hotTail.dropReasons.factReject ?? 0,
      dupDrops: result.hotTail.dropReasons.dup ?? 0,
      errorDrops: result.hotTail.dropReasons.error ?? 0,
      hotTailPointers: result.hotTail.entries.length,
      fetchCapped,
      archiveForm: result.archiveForm.form,
      ...(result.rootKind === undefined ? {} : { rootKind: result.rootKind }),
      hotTailTokens: result.hotTail.tokens,
      hotTailDeclaredUnits: result.hotTail.declaredUnits,
      hotTailStopReason: result.hotTail.stopReason,
      hotTailSource: result.hotTail.source,
      hotTailFloorFilled: result.hotTail.floorFilled,
      hotTailLocated: result.hotTail.located,
      hotTailUnlocated: result.hotTail.unlocated,
      unitCount: result.unitCount,
      dropped: result.hotTail.dropped,
      dropReasons: result.hotTail.dropReasons,
      clipped: result.hotTail.clipped,
      truncated: result.hotTail.truncated,
      ...(request.archiveTruncate === undefined
        ? {}
        : {
            archiveTruncateCount: request.archiveTruncate.count,
            archiveTruncateTokens: request.archiveTruncate.tokens,
            ...(request.archiveTruncate.overCap === undefined ? {} : { archiveOverCap: request.archiveTruncate.overCap }),
          }),
    })
    emitCeFact(request.session, ASSEMBLE_RUN_FACT_TYPE, data, logger)
    return outcome
  }

  const off = pump.on('metrics/session-event', (payload: CeDomainEvents['metrics/session-event']) => {
    if (disposed) return
    try {
      ingest(stateOf(payload.session), payload.event)
    } catch (e) {
      logger.warn('context-economy: assemble ingest error contained', e instanceof Error ? e.message : String(e))
    }
  })

  return {
    dispose() {
      disposed = true
      off()
    },
    stats: () => ({ ...counts }),
    unitList: (session, range, domain) => unitsIn(session, range, domain),
    assemble,
  }
}

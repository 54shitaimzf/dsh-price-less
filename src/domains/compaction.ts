/**
 * P19b 边界路径编排（docs/04 §2 时序 A + §1 缩水校验 + §6 档案区；docs/10 §3 时序 A；
 * docs/09 §2 边界档案 vN；docs/11 §2 domains/compaction.ts 行）。
 *
 * 一次边界压缩（全部失败路径 = 不落刀 + 如实记账）：
 *   H2 闭合发现 → 区间落表面（配对平衡）→ 单元清单 + 区间转写 → 内容寻址复用（命中 = 零调用）
 *   → 边界 prompt → H12 单次调用 → P18 产物校验 → P17 装配 → 缩水校验（重试 1）
 *   → 档案 vN 落盘（CAS；落盘成功才落刀）→ H4/H5 事务（prune 影子价 + 官方 checkpoint 提交）
 *   → compress-run 事实 + T-boundary 搭车补账。
 *
 * 模块: domains 压缩域编排（core 纯核 + platform 端口）
 * 平面: L0/L2（机械装配 + 单次语义调用；模型只产坐标与排序）
 * 回退链步数: 3（缓存复用 → 缩水重试 1 → 保留原文；服务缺失 = 全路径 fail-lazy）
 * 审查清单: 改史只经 platform/history（S2/D7）；llm 只经 platform/llm（D6）；H2 只经 platform/agent-step（D14）；
 *           计量只经 platform/meter（D15）；事实只经 logger.emitCeFact（S3/D3）；无 timer（S5）。
 * 度量: context-economy/compress-run（fold 见 core/compress/ledger.ts；07 压缩族）。
 */
import type { Session } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { FACT_TYPE_PREFIX, compactFact, factsFromSessionEvents } from '../core/ledger/facts.ts'
import { estimateTokens, extractTextFromToolResult } from '../core/ledger/fold.ts'
import type { LedgerFact, LedgerSessionEvent } from '../core/ledger/types.ts'
import { foldSegmentState, type TaskSegment } from '../core/units.ts'
import { workspaceOf } from './workspace.ts'
import { DEFAULT_ASSEMBLE_POLICY, archiveChainMonotone, ceTxnId, foldAssembleInputs, isPluginSourceEvent, planTxn, type AssemblePolicy, type HotTailDropCounts } from '../core/assemble/index.ts'
import {
  COMPRESS_PROMPT_VERSION,
  COMPRESS_POLICY_VERSION,
  DEFAULT_COMPRESS_POLICY,
  PRESSURE_EMERGENCY_LIMIT,
  PRESSURE_RETRY_BUDGET,
  appendArchiveEntry,
  compressSpanHash,
  composePressureArchive,
  emptyArchiveStore,
  fuseArmed,
  fuseFloorTokens,
  isPressureMaterial,
  lookupCachedProduct,
  parseCompressProduct,
  planTailConsumption,
  pressureBreakerTripped,
  pressureChainDepth,
  pressureThreshold,
  priorChainFor,
  putCachedProduct,
  readArchiveStore,
  renderBoundaryPrompt,
  renderCheckpoint,
  renderFoldMaterialTranscript,
  renderPressurePrompt,
  foldMaterialTokens,
  renderDomainTranscript,
  renderRegionTranscript,
  type ArchiveStoreBody,
  type BoundaryProduct,
  type CompressCheckpoint,
  type CompressPolicy,
  type PressureProduct,
} from '../core/compress/index.ts'
import {
  SHEAR_APPLIED_FACT_TYPE,
  SHEAR_DECISION_FACT_TYPE,
  SHEAR_POLICY_VERSION,
  type ShearAppliedFactData,
  type ShearDecisionFactData,
} from '../core/shear/index.ts'
import { toolCategory } from '../core/shear/tool.ts'
import { calibrationRatio } from '../core/meter/estimate.ts'
import { emitCeFact } from '../platform/logger.ts'
import { createHistoryPort } from '../platform/history.ts'
import { CE_CONTEXT_OVERFLOW_CODE, CE_LLM_TIMEOUT_MS, resolveContextWindow, resolveReasoningEffort, streamCeLlm, type CeGenerateOptions, type CeLlmUsage } from '../platform/llm.ts'
import { readSessionEvents, readSessionModel, type CeLogger, type EventPump } from '../platform/events.ts'
import type { ContextEconomyStorage } from '../platform/storage.ts'
import type { MeterPort } from '../platform/meter.ts'
// U17：产物/结局的形状与 host 面合同归 platform（服务缝唯一构造点）——域只管产出与消费。
import type { CompactionOutcome, CompactionProduct } from '../platform/compaction-port.ts'
import { compressionInvariantOk, reasoningEffortSetting, type Config as ConfigShape } from '../config.ts'
import { resolveJudgeModel } from './input.ts'
import { runCompactionTxn, type AssembleDomain } from './assemble.ts'
import { COMPRESS_RUN_FACT_TYPE, HARD_TRUNCATE_FACT_TYPE, PRESSURE_FIRED_FACT_TYPE, type CompressRunFactData, type PressureFireFactData } from './compaction-facts.ts'

const ZERO_DROPS: HotTailDropCounts = { badDecl: 0, unknownUnit: 0, remap: 0, fetch: 0, dup: 0, factReject: 0 }

/** F8b 标定对账（只观察、不改行为）：估算 promptTokens vs 真实 input+cacheRead，偏离 ±25% 即 warn。 */
function warnTokenDrift(estimated: number | undefined, usage: CeLlmUsage | undefined, logger: CeLogger): void {
  const actual = (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0)
  const ratio = calibrationRatio(estimated ?? 0, actual)
  if (ratio === null || (ratio >= 0.75 && ratio <= 1.25)) return
  logger.warn(`context-economy: token estimate drift (estimated ${estimated}, actual ${actual}, ratio ${ratio.toFixed(2)})`)
}

/** U17：产物/结局的形状归 `platform/compaction-port.ts`；此处转出，域侧消费方与测试沿用本模块名。 */
export type { CompactionOutcome, CompactionProduct } from '../platform/compaction-port.ts'

export interface CompactionDomainDeps {
  storage: ContextEconomyStorage
  getConfig: () => ConfigShape
  logger: CeLogger
  /** 装配域（单元清单 + 共享事务执行器）。 */
  assemble: AssembleDomain
  /** 计量端口（影子价同源）；缺省 = 本地估算并在事实里标注。 */
  getMeter?: () => MeterPort | undefined
  /** 辅助调用上下文（H12）；缺省 = 压缩不可用（fail-lazy）。 */
  getLlm?: () => Pick<Context, 'llm'> | undefined
  workspace?: string
  now?: () => number
  /**
   * HC3 事实回灌面（docs/12 §3）。**降级态下必需**：通道缺失时 `emitFact` 只写 KV 镜像、
   * 不 append 会话，事实进不了 `readSessionEvents`——不订阅本面则 `foldSegmentState`
   * 看不到任何 `judge-verdict`，边界压缩静默全灭（2026-09-11 真机复盘）。
   */
  pump?: Pick<EventPump, 'on'>
}

/**
 * 内部捕获槽：`compactSegment` 有十余条早退路径（全部走 `skip(...)`），
 * 让它们各自返回结果会改动十几处 return；改为在 `skip` 与成功点各写一次捕获槽。
 */
interface CompactCapture {
  result?: CompactionProduct
  reason?: string
}

export interface CompactionDomainStats {
  preSteps: number
  triggers: number
  compactions: number
  cacheHits: number
  skips: number
  rangeSkips: number
  errors: number
}

export interface CompactionDomain {
  dispose(): void
  stats(): CompactionDomainStats
  /** H2 步准入回调体：一次尝试至多压一个闭合 task（挂点收口见 platform/agent-step.ts）。 */
  onPreStep(payload: { session: Session; turn: number; step?: number }): Promise<void>
  /**
   * A/F2（2026-09-11 真机复盘）：pre-step 载荷已判 `new-task` → 在 `next()` 之前压**当前开放段**。
   * 见 `runBoundaryBeforeStep`（与 `onPreStep` 的分工：后者只压"已被判词标记闭合"的段）。
   */
  onBoundaryBeforeStep(payload: { session: Session; turn: number }): Promise<void>
  /** H3 溢出接管（P20b）：'retry' = 本轮重试；'pass' = 委派上游。 */
  onRequestError(payload: { session: Session; turn: number; step: number; failureCode: string }): Promise<'retry' | 'pass'>
  /**
   * U17：显式空闲压缩（取代原生 `/compact` 的后端入口）。压**最早**尚未归档的闭合段；
   * 无此段则压当前开放段。事务 `turn: null`（轮间独立括号）——平台侧必须以
   * `agent.runMaintenance` 保证此刻无开轮，否则撞 harness 属主守卫（`validateOwner`）。
   */
  compactNow(payload: { session: Session }): Promise<CompactionOutcome>
}

/**
 * U14（2026-09-11 真机复盘）：原 `COMPACTION_EVENT_LIMIT = 4000` 的"丢最老"事件窗已**删除**。
 *
 * 该窗把 `ledgerEventsOf` 的返回截成末 4000 条，而 `ledgerEventsOf` 同时是**事实源**与
 * **首条用户消息锚**的来源，于是：
 * ① 界定 task 段的 `judge-verdict` 事实（边界压缩的全部触发依据）在长会话里永远落在窗外，
 *    `foldSegmentState` 恒只见 1 段 → `runBoundary` 在 `segments.length < 2` 处永久空转。
 *    实测三例：4130 事件会话（窗内首条 user seq = 152、判词 anchor = 19）、32913 事件会话
 *    （窗内 28935、判词 21198/21255）均为零次尝试；唯一成功的一次是 347 事件的短会话。
 * ② `firstUserSeq` 取到的是**窗内**首条用户消息而非会话首条，段状态机基准随之漂移。
 *
 * `readSessionEvents` 本就返回全量快照，切片只省下游 CPU 却切断正确性——故整段移除。
 * 边界段的原文渲染天然由区间（startSeq/endSeq）限定，不因此放大开销。
 */

/** 回灌事实的每会话缓冲上限（防御性；降级态一个进程内的判词/剪切事实量级远低于此）。 */
export const REPLAYED_FACT_LIMIT = 20000

/** 档案区实体键（workspace 隔离；docs/09 §1）。 */
export function boundaryArchiveKey(workspace: string): string {
  return `boundary_archive:${workspace}`
}

/** 会话工作区根（F9e：相对路径基准；缺省 = 进程 cwd，不猜）。 */
function sessionRootOf(session: Session): { root: string; rootKind: 'session' | 'cwd' } {
  const header = (session as unknown as { header?: { cwd?: unknown } }).header
  if (typeof header?.cwd === 'string' && header.cwd.trim() !== '') {
    return { root: header.cwd.replaceAll('\\', '/').replace(/\/+$/, ''), rootKind: 'session' }
  }
  return { root: process.cwd().replaceAll('\\', '/'), rootKind: 'cwd' }
}

function sessionIdOf(session: Session): string {
  const s = session as unknown as { header?: { id?: unknown }; id?: unknown }
  const header = s.header?.id
  return typeof header === 'string' ? header : String(s.id ?? 'session')
}

function ledgerEventsOf(session: Session): LedgerSessionEvent[] {
  const snapshot = readSessionEvents(session) as readonly unknown[]
  const out: LedgerSessionEvent[] = []
  for (const raw of snapshot) {
    const event = raw as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown; surfaceOp?: unknown }
    if (typeof event.type !== 'string' || typeof event.seq !== 'number') continue
    out.push({
      type: event.type,
      seq: event.seq,
      time: typeof event.time === 'number' ? event.time : 0,
      data: event.data,
      ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
    })
  }
  return out
}

function firstUserSeq(events: readonly LedgerSessionEvent[]): number {
  for (const event of events) if (event.type === 'user/message' && event.surfaceOp === 'append') return event.seq
  return events[0]?.seq ?? 0
}

/**
 * U9：**统一重试预算**（旧名 SCHEMA_RETRY_BUDGET = 1，只覆盖 parse/schema）。
 * 可重试的临时失败 = parse / schema / skipped(shrink|storage|txn-*)：
 * ① 一次坏输出不该把 task 永久封禁；② 一次瞬时落盘/事务失败（含孤儿事务自愈后的那次）同理。
 * 预算 2 仍防"每步重复计费"（一次 task 最多 3 次真正尝试）。
 */
export const RETRY_BUDGET = 2

/** 可重试的临时失败判据（U9.2；压力路径事实 `layer !== 'boundary'` 先行排除）。 */
export function isTransientCompressFailure(data: Partial<CompressRunFactData>): boolean {
  if (data.outcome === 'parse' || data.outcome === 'schema') return true
  if (data.outcome !== 'skipped') return false
  const reason = data.reason ?? ''
  return reason === 'shrink' || reason === 'storage' || reason.startsWith('txn-')
}

/**
 * 已尝试过的 task 段（事实键，重放可判）：除 llm-unavailable / 有界重试内的临时失败外不再尝试。
 * U9：键 = `${scopedTaskId}:${segmentStartSeq ?? ''}`；**无该字段的旧事实保守沿用旧键**
 * `${scopedTaskId}`（一次性影响：升级前的历史事实仍按"该 task 已归档"判，不重复计费）。
 */
function attemptedTaskIds(facts: readonly LedgerFact[], retryBudget = RETRY_BUDGET): Set<string> {
  const attempted = new Set<string>()
  const transient = new Map<string, number>()
  for (const fact of facts) {
    if (fact.type !== COMPRESS_RUN_FACT_TYPE) continue
    const data = (fact.data ?? {}) as Partial<CompressRunFactData>
    if (typeof data.taskId !== 'string' || data.taskId === '') continue
    // 只有边界路径的尝试才算"该 task 已归档"；压力路径的 compress-run 不阻止 task 闭合归档。
    if (data.layer !== 'boundary') continue
    // 非封禁原因（U9 + U11.8）：llm-unavailable = 瞬态；range-empty = 区间/表面结构条件。
    // U11.8 新发的 range-empty 只是**可观测**事实，绝不能因此把该段永久封禁——
    // 旧实现这几处根本不发事实、每步照试；加了事实却顺带改了封禁语义就是引入新缺陷。
    if (data.outcome === 'skipped' && (data.reason === 'llm-unavailable' || data.reason === 'range-empty')) continue
    const key = data.segmentStartSeq === undefined ? data.taskId : `${data.taskId}:${data.segmentStartSeq ?? ''}`
    if (isTransientCompressFailure(data)) {
      transient.set(key, (transient.get(key) ?? 0) + 1)
      continue
    }
    attempted.add(key)
  }
  for (const [key, count] of transient) if (count > retryBudget) attempted.add(key)
  return attempted
}

/** 区间内 hold 的老调用对（T-boundary 搭车会计面；坐标来自剪切事实 + 事件）。 */
function heldPairsInRange(
  events: readonly LedgerSessionEvent[],
  facts: readonly LedgerFact[],
  range: { startSeq: number; endSeq: number },
): Array<{ callId: string; resultSeq: number; name: string; text: string }> {
  const holdCallIds = new Set<string>()
  for (const fact of facts) {
    if (fact.type !== SHEAR_DECISION_FACT_TYPE) continue
    const data = (fact.data ?? {}) as Partial<ShearDecisionFactData>
    if (data.decision !== 'hold' || typeof data.callId !== 'string' || data.callId === '') continue
    holdCallIds.add(data.callId)
  }
  if (holdCallIds.size === 0) return []
  const nameByCallId = new Map<string, string>()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = (event.data ?? {}) as Record<string, unknown>
    if (typeof data.callId === 'string' && typeof data.name === 'string') nameByCallId.set(data.callId, data.name)
  }
  const out: Array<{ callId: string; resultSeq: number; name: string; text: string }> = []
  for (const event of events) {
    if (event.type !== 'tool/result' || event.seq < range.startSeq || event.seq > range.endSeq) continue
    const data = (event.data ?? {}) as Record<string, unknown>
    const message = (data.message ?? data) as { content?: unknown }
    const content = message.content
    const block = Array.isArray(content) && content.length > 0 ? (content[0] as { toolCallId?: unknown }) : undefined
    const callId = typeof block?.toolCallId === 'string' ? block.toolCallId : undefined
    if (callId === undefined || !holdCallIds.has(callId)) continue
    out.push({ callId, resultSeq: event.seq, name: nameByCallId.get(callId) ?? '', text: extractTextFromToolResult(event.data) })
  }
  return out
}

interface ProductAttempt {
  readonly product: BoundaryProduct
  readonly dropped: HotTailDropCounts
  readonly calls: number
  readonly cacheHit: boolean
  /** U8：本次实际使用的辅助调用路由（cacheHit 时为空串）；提交记账直接复用，不再二次解析。 */
  readonly provider: string
  readonly model: string
  readonly usage?: CeLlmUsage
  readonly rawOutput?: string
  readonly rendered: string
  /** F10：档案落盘正文（仅总分；热尾每次抛弃，不入档案）。 */
  readonly digestText: string
  readonly productTokens: number
  readonly truncation: { count: number; tokens: number }
  readonly entries: number
}

export function mountCompactionDomain(deps: CompactionDomainDeps): CompactionDomain {
  const { storage, getConfig, logger, now = Date.now } = deps
  /** F3：会话级工作区（header.cwd 优先；deps.workspace/进程 cwd 仅作回落）。 */
  const workspaceFor = (session: Session): string => workspaceOf(session, deps.workspace ?? process.cwd())
  const counts: CompactionDomainStats = { preSteps: 0, triggers: 0, compactions: 0, cacheHits: 0, skips: 0, rangeSkips: 0, errors: 0 }
  /** U11.8：range-skip 事实节流（同一段的区间定位失败每进程只记一次，防每步刷屏）。 */
  const rangeSkipNotified = new Set<string>()
  const busy = new WeakSet<Session>()
  /** 压力触发 turn 守卫（一个 turn 至多一次常规压力尝试；紧急折叠另有守卫）。 */
  const pressureTurn = new WeakMap<Session, number>()
  /** 紧急折叠守卫（同 (turn,step) 至多一次：地板以上自动折叠 / 溢出接管共用）。 */
  const emergencyGuard = new WeakMap<Session, string>()
  /** 保险丝自动折叠 turn 守卫（每轮至多一次；与压力 turn 守卫独立）。 */
  const fuseTurn = new WeakMap<Session, number>()
  let disposed = false

  /**
   * HC3 回灌事实缓冲（docs/12 §3）：降级态下 `emitFact` 只写 KV 镜像、不 append 会话，
   * 事实因此不在 `readSessionEvents` 里。本域订阅 pump 的 `facts/session-event` 把这些
   * 事实按会话收下来，与会话事件并集成事实源（见 `factsFor`）。
   *
   * 不回读 storage 的 `fact_mirror` 表：镜像行没有日志位（seq 缺失），跨源合成的 seq 与
   * HC3 回灌路径自增的 seq 无法对齐，dupe 判据会失效并双计。**已知边界**：进程重启后，
   * 上一个进程写入镜像的历史事实不在本缓冲里（那部分段状态需通道恢复后自然补齐）。
   */
  const replayedFacts = new WeakMap<Session, LedgerFact[]>()
  const offReplayedFacts = deps.pump?.on('facts/session-event', ({ session, event }) => {
    if (!event.type.startsWith(FACT_TYPE_PREFIX)) return
    const list = replayedFacts.get(session) ?? []
    list.push({
      type: event.type,
      seq: event.seq,
      time: event.time,
      data: event.data,
    })
    if (list.length > REPLAYED_FACT_LIMIT) list.splice(0, list.length - REPLAYED_FACT_LIMIT)
    replayedFacts.set(session, list)
  })

  /**
   * 事实源并集（docs/12 §3「会话 ignorable 事件 ∨ KV 镜像」的域侧落点）。
   *
   * 通道可用 → 回灌面收到的与会话事件同源同序（firehose 把 `context-economy/*` 也送进
   * `facts/session-event`，events.ts），按 `(type, seq, data)` 去重后**不双计**；
   * 通道缺失 → 事实只在回灌缓冲里，不并集则段状态机与判词彻底失明。
   * 合并后按 `seq ?? time` 升序，使回灌事实（seq 锚在日志尾）稳定落在会话事实之后。
   */
  const factsFor = (session: Session, events: readonly LedgerSessionEvent[]): LedgerFact[] => {
    const fromEvents = factsFromSessionEvents([...events])
    const replayed = replayedFacts.get(session)
    if (replayed === undefined || replayed.length === 0) return fromEvents
    const seen = new Set(fromEvents.map((fact) => `${fact.type}|${fact.seq}|${JSON.stringify(fact.data)}`))
    const merged = [...fromEvents]
    for (const fact of replayed) {
      const key = `${fact.type}|${fact.seq}|${JSON.stringify(fact.data)}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(fact)
    }
    merged.sort((a, b) => (a.seq ?? a.time) - (b.seq ?? b.time))
    return merged
  }

  const policiesOf = (config: ConfigShape): { assemble: AssemblePolicy; compress: CompressPolicy } => ({
    assemble: {
      ...DEFAULT_ASSEMBLE_POLICY,
      hotTailTokens: config.compression.retainTokens,
      archiveTokens: config.compression.archiveCapTokens,
    },
    compress: { ...DEFAULT_COMPRESS_POLICY },
  })

  /**
   * 档案实体写入（CAS 冲突重读重试 1；纯 mutate 在新体上重放）。
   * F9d：写入前做**单调追加守卫**（允许最老整条截断，幸存条目必须逐条字节恒等）——
   * 违规 = 拒写（失败方向 = 保留旧档案）。
   */
  const writeStore = async (
    mutate: (body: ArchiveStoreBody) => { body: ArchiveStoreBody; entries: number; overCap: boolean },
    baseVersion: number | undefined,
    taskId: string,
    workspace: string,
    storeKey: string,
  ): Promise<{ entries: number; overCap: boolean } | undefined> => {
    const source = { taskId, eventType: 'boundary-archive', evidence: { workspace } }
    const apply = (
      base: unknown,
    ): { body: ArchiveStoreBody; entries: number; overCap: boolean } | undefined => {
      const before = readArchiveStore(base, workspace)
      const result = mutate(before)
      if (!archiveChainMonotone(before.entries, result.body.entries)) {
        logger.warn('context-economy: archive write rejected (append-only violation; old archive preserved)')
        return undefined
      }
      return result
    }
    try {
      const result = apply(storage.getEntity('boundary_archive', storeKey)?.body)
      if (result === undefined) return undefined
      await storage.putEntity('boundary_archive', storeKey, result.body, source, { baseVersion: baseVersion ?? 0 })
      return { entries: result.entries, overCap: result.overCap }
    } catch {
      const current = storage.getEntity('boundary_archive', storeKey)
      if (current === undefined || current.version === baseVersion) return undefined
      try {
        const result = apply(current.body)
        if (result === undefined) return undefined
        await storage.putEntity('boundary_archive', storeKey, result.body, source, { baseVersion: current.version })
        return { entries: result.entries, overCap: result.overCap }
      } catch {
        return undefined
      }
    }
  }

  /**
   * U6：档案补偿——事务失败时把档案回退到写前状态（防幽灵 checkpoint/boundary 条目毒化
   * 下一轮折叠定位、缩水分母与断路器深度）。"先档案后落刀"的写序不变（失败默认保留）；
   * 补偿失败只降级 warn（等价旧行为），不外溢。
   */
  const compensateArchive = async (
    storeKey: string,
    workspace: string,
    scopedTaskId: string,
    prior: { version: number } | undefined,
  ): Promise<void> => {
    try {
      const current = storage.getEntity('boundary_archive', storeKey)
      if (current === undefined) return
      if (prior !== undefined) {
        await storage.rollbackEntity('boundary_archive', storeKey, prior.version)
      } else {
        // 首建即失败：无版本可回 → 体复位为空档案（版本前进；内容等价于从未写过）
        await storage.putEntity(
          'boundary_archive', storeKey, emptyArchiveStore(workspace),
          { taskId: scopedTaskId, eventType: 'archive-compensate', evidence: {} },
          { baseVersion: current.version },
        )
      }
    } catch (e) {
      logger.warn('context-economy: archive compensate failed (degraded, fail-lazy)', e instanceof Error ? e.message : String(e))
    }
  }

  const compactSegment = async (
    session: Session,
    /** 事务属主轮；`null` = 轮间独立事务（U17 空闲手动压缩用，平台侧由 runMaintenance 保证无开轮）。 */
    turn: number | null,
    events: readonly LedgerSessionEvent[],
    facts: readonly LedgerFact[],
    segment: TaskSegment,
    nextStartSeq: number,
    capture?: CompactCapture,
  ): Promise<void> => {
    const config = getConfig()
    const sid = sessionIdOf(session)
    const workspace = workspaceFor(session)
    const storeKey = boundaryArchiveKey(workspace)
    const { root, rootKind } = sessionRootOf(session)
    const scopedTaskId = `${sid}:${segment.taskId}`
    const { assemble: assemblePolicy, compress: compressPolicy } = policiesOf(config)
    const base = {
      at: now(), layer: 'boundary' as const,
      promptVersion: COMPRESS_PROMPT_VERSION, policyVersion: COMPRESS_POLICY_VERSION,
      taskId: scopedTaskId, segmentStartSeq: segment.startSeq ?? null,
    }
    const skip = (reason: string, extra: Partial<CompressRunFactData> = {}): void => {
      counts.skips++
      if (capture !== undefined) capture.reason = reason
      emitCeFact(session, COMPRESS_RUN_FACT_TYPE, compactFact({ ...base, outcome: 'skipped' as const, reason, ...extra }), logger)
    }
    /**
     * U11.8：区间定位失败（旧实现**零事实**——`rangeSkips` 只在内存计数里，回放不可见）。
     * 每段每进程只记一次（节流；`rangeSkips` 仍如实累计）。
     */
    const rangeSkip = (): void => {
      counts.rangeSkips++
      const key = `${scopedTaskId}:${segment.startSeq ?? ''}`
      if (rangeSkipNotified.has(key)) return
      rangeSkipNotified.add(key)
      skip('range-empty')
    }

    // ① 区间落表面（权威表面 = harness session.surface.nodes；尾必须排除下一段起点 = 新 task 首条消息）。
    // F9a：范围端点必须取自权威表面——从原始事件自折在事件窗被截断时会复活已遮蔽节点，
    // 选到非表面端点 → replace 抛 INVALID_RANGE（真机 2026-09-09）。
    // U1（P0 修复）：端点候选排除 plugin 源节点（checkpoint/notice 的 seq 是追加时新高、位置却落在
    // 被替换 span 原位——seq 谓词会被这种"seq 高、位置早"的产物节点骗到起点，使位置 span 罩住
    // seq 区间外的真实消息：新 task 首条用户消息被静默遮蔽却未进产物）；转写/单元的定义域
    // 改为 findSpan 实际遮蔽集（shadowedSeqs），"进产物 ⇔ 被遮蔽"严格等价。
    const history = createHistoryPort(session)
    const surface = history.surfaceNodes()
    const eventBySeq = new Map<number, LedgerSessionEvent>(events.map((event) => [event.seq, event] as const))
    const isRealNode = (seq: number): boolean => {
      const event = eventBySeq.get(Number(seq))
      return event === undefined || !isPluginSourceEvent(event.data)
    }
    const start = surface.find((seq) => isRealNode(Number(seq)) && seq >= (segment.startSeq ?? 0) && seq < nextStartSeq)
    const end = start === undefined ? undefined : [...surface].reverse().find((seq) => isRealNode(Number(seq)) && seq >= start && seq < nextStartSeq)
    if (start === undefined || end === undefined) { rangeSkip(); return }
    const balanced = history.balanceRange({ start: start as never, end: end as never })
    if (balanced === null) { rangeSkip(); return }
    const shadowedSeqs = history.spanShadowedSeqs(balanced)
    if (shadowedSeqs === null || shadowedSeqs.length === 0) { rangeSkip(); return }
    const range = { startSeq: Number(balanced.start), endSeq: Number(balanced.end) }
    const domain = new Set<number>(shadowedSeqs.map(Number))
    const regionText = renderDomainTranscript(events, domain)
    if (regionText === '') { rangeSkip(); return }
    const units = deps.assemble.unitList(session, range, domain)

    // ② 档案体 + 续传链（机制 A）+ 内容寻址键。
    const existing = storage.getEntity('boundary_archive', storeKey)
    const storeBody = readArchiveStore(existing?.body, workspace)
    const priorChain = priorChainFor(storeBody, scopedTaskId, sid)
    if (!planTailConsumption({ priorChain, layer: 'boundary' }).ok) { skip('chain-invalid'); return }
    const policyKey = `${assemblePolicy.hotTailTokens}/${assemblePolicy.archiveTokens}/${compressPolicy.density.cjk},${compressPolicy.density.other}/${root}`
    const key = compressSpanHash({
      promptVersion: COMPRESS_PROMPT_VERSION, policyVersion: COMPRESS_POLICY_VERSION, layer: 'boundary',
      regionText, unitIds: units.map((unit) => unit.id), priorChainTexts: priorChain.map((entry) => entry.text), policyKey,
    })
    const cached = lookupCachedProduct(storeBody, key)
    const shadowedTokens = estimateTokens(regionText, compressPolicy.density)

    // ③ 产物获取：缓存复用（零调用）或单次调用 + 解析；每次装配后做缩水校验。
    const llm = deps.getLlm?.()
    let calls = 0
    let usage: CeLlmUsage | undefined
    let renderedPromptTokens: number | undefined
    const attemptProduct = async (useCache: boolean): Promise<ProductAttempt | undefined> => {
      let product: BoundaryProduct
      let dropped: HotTailDropCounts = ZERO_DROPS
      let cacheHit = false
      let rawOutput: string | undefined
      let provider = ''
      let model = ''
      if (useCache && cached !== undefined && cached.product.mode === 'boundary') {
        product = cached.product
        dropped = cached.dropped ?? ZERO_DROPS
        cacheHit = true
      } else {
        if (llm === undefined) { skip('llm-unavailable', { calls }); return undefined }
        const rendered = renderBoundaryPrompt({ regionText, units, priorChain, policy: compressPolicy, root })
        renderedPromptTokens = estimateTokens(rendered.prompt, compressPolicy.density)
        const route = resolveJudgeModel(config, readSessionModel(session))
        // U8：无路由（未配置 + 会话尚无 request/header）→ 复用 llm-unavailable（瞬态：第二条消息起即有会话模型）。
        if (route === undefined) { skip('llm-unavailable', { calls }); return undefined }
        provider = route.provider
        model = route.model
        const desired = reasoningEffortSetting(config)
        const sentEffort = desired === undefined ? undefined : await resolveReasoningEffort(llm, provider, model, desired, logger)
        const options: CeGenerateOptions = {
          provider, model,
          messages: [{ role: 'user', content: [{ type: 'text', text: rendered.prompt }], source: { kind: 'user' }, id: 'compress' }] as never,
          purpose: 'context-economy-compaction',
          temperature: 0,
          ...(sentEffort === undefined ? {} : { reasoningEffort: sentEffort }),
        }
        let llmText = ''
        let failure: { code?: string; message: string } | undefined
        for await (const chunk of streamCeLlm(llm, options, { onUsage: (receipt) => { usage = receipt.usage }, logger, timeoutMs: CE_LLM_TIMEOUT_MS.compaction })) {
          if (chunk.type === 'text-delta') llmText += chunk.text
          if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') {
            const reason = chunk.reason as { kind: 'error'; failure?: { code?: string; message?: string } }
            failure = { code: reason.failure?.code, message: reason.failure?.message ?? 'non-stop finish' }
            break
          }
        }
        if (failure !== undefined) {
          const unavailable = failure.code === 'CE_LLM_UNAVAILABLE'
          skip(unavailable ? 'llm-unavailable' : 'llm-error', { calls: unavailable ? calls : calls + 1, ...(usage === undefined ? {} : { llmUsage: usage }) })
          return undefined
        }
        calls++
        warnTokenDrift(renderedPromptTokens, usage, logger)
        const parsed = parseCompressProduct(llmText, 'boundary', units)
        if (!parsed.ok) {
          emitCeFact(session, COMPRESS_RUN_FACT_TYPE, compactFact({ ...base, outcome: parsed.reason, calls, ...(usage === undefined ? {} : { llmUsage: usage }) }), logger)
          return undefined
        }
        product = parsed.product as BoundaryProduct
        dropped = parsed.dropped
        rawOutput = llmText
      }
      const outcome = await deps.assemble.assemble({
        session, taskId: scopedTaskId, range, layer: 'boundary',
        digest: product.digest, hotTail: product.hotTail, priorChain,
        regionTokens: shadowedTokens, root, rootKind,
      })
      if (!outcome.ok) {
        emitCeFact(session, COMPRESS_RUN_FACT_TYPE, compactFact({
          ...base, outcome: outcome.reason === 'no-units' ? 'skipped' : 'schema',
          ...(outcome.reason === 'no-units' ? { reason: 'no-units' } : {}),
          calls, cacheHit,
        }), logger)
        if (outcome.reason === 'no-units') counts.skips++
        return undefined
      }
      const append = appendArchiveEntry(
        storeBody,
        { taskId: scopedTaskId, kind: 'boundary', text: outcome.result.digestText, sessionId: sid, layer: 'boundary', at: now() },
        assemblePolicy,
      )
      return {
        product, dropped, calls, cacheHit, provider, model,
        rendered: outcome.result.rendered, digestText: outcome.result.digestText,
        productTokens: estimateTokens(outcome.result.rendered, compressPolicy.density),
        truncation: append.truncation, entries: append.kept,
        ...(usage === undefined ? {} : { usage }),
        ...(rawOutput === undefined ? {} : { rawOutput }),
      }
    }

    let chosen: ProductAttempt | undefined
    let attempts = 0
    for (let attempt = 0; attempt <= 1 && chosen === undefined; attempt++) {
      attempts++
      const candidate = await attemptProduct(attempt === 0)
      if (candidate === undefined) return
      if (candidate.productTokens < shadowedTokens) chosen = candidate
    }
    const retry = Math.max(0, attempts - 1)
    if (chosen === undefined) {
      skip('shrink', { calls, retry, shadowedTokens, ...(usage === undefined ? {} : { llmUsage: usage }) })
      return
    }
    if (chosen.cacheHit) counts.cacheHits++

    // ④ 档案 vN 落盘（落盘成功才落刀；09 §6「LLM 产物未落盘不被引用」）。
    const written = await writeStore((body) => {
      const appended = appendArchiveEntry(
        body,
        { taskId: scopedTaskId, kind: 'boundary', text: chosen!.digestText, sessionId: sid, layer: 'boundary', at: now(), root },
        assemblePolicy,
      )
      return {
        body: chosen!.cacheHit
          ? appended.body
          : putCachedProduct(appended.body, { key, at: now(), layer: 'boundary', product: chosen!.product, dropped: chosen!.dropped }),
        entries: appended.kept,
        overCap: appended.overCap,
      }
    }, existing?.version, scopedTaskId, workspace, storeKey)
    if (written === undefined) {
      skip('storage', { calls: chosen.calls, retry, shadowedTokens, productTokens: chosen.productTokens, cacheHit: chosen.cacheHit, ...(chosen.usage === undefined ? {} : { llmUsage: chosen.usage }) })
      return
    }

    // ⑤ 事务：open → prune（影子价）→ summary+checkpoint 替换 → close。
    const shadowPrice = deps.getMeter?.()?.heuristicTokensInRange(session, range.startSeq, range.endSeq) ?? shadowedTokens
    const plan = planTxn({
      txnId: ceTxnId('boundary', segment.taskId, range.startSeq, range.endSeq),
      layer: 'boundary', taskId: scopedTaskId, range: { start: range.startSeq, end: range.endSeq },
      shadowedTokenCount: shadowPrice, replaceKind: 'digest', turn,
    })
    // U17：捕获提交结果（薄 provider 需回传官方 CompactionResult 的 summarySeq / shadowedSeqs）。
    let committed: { summaryEvent: { seq: number }; landed: { shadowedSeqs: readonly number[] } } | undefined
    const txn = runCompactionTxn(history, plan, (h) => {
      h.recordPrune({ start: range.startSeq as never, end: range.endSeq as never, shadowedTokenCount: shadowPrice })
      committed = h.commitCheckpoint({
        compactionId: plan.txnId,
        text: chosen!.rendered,
        summary: chosen!.rendered,
        range: { start: range.startSeq as never, end: range.endSeq as never },
        shadowedTokenCount: shadowPrice,
        provider: chosen!.cacheHit ? '' : chosen!.provider,
        model: chosen!.cacheHit ? '' : chosen!.model,
        ...(chosen!.usage === undefined ? {} : { usage: chosen!.usage }),
        ...(chosen!.rawOutput === undefined ? {} : { rawOutput: chosen!.rawOutput }),
      })
    })
    if (!txn.ok) {
      // U6：档案补偿——事务未落刀，档案必须回退到写前状态（防幽灵 boundary 条目）
      await compensateArchive(storeKey, workspace, scopedTaskId, existing)
      skip(`txn-${txn.code ?? 'fail'}`, { calls: chosen.calls, retry, shadowedTokens, productTokens: chosen.productTokens, cacheHit: chosen.cacheHit, ...(chosen.usage === undefined ? {} : { llmUsage: chosen.usage }) })
      return
    }
    counts.compactions++

    // U17：成功落刀 → 回填捕获槽（取代路线：本域要能作为 `ctx.compaction` 的实现作答）。
    if (capture !== undefined && committed !== undefined) {
      capture.result = {
        compactionId: plan.txnId,
        startSeq: txn.markers?.startSeq ?? 0,
        summarySeq: Number(committed.summaryEvent.seq),
        endSeq: txn.markers?.endSeq ?? 0,
        summaryText: chosen!.rendered,
        shadowedRange: { start: range.startSeq, end: range.endSeq },
        shadowedSeqs: (committed.landed.shadowedSeqs as readonly number[]).map(Number),
        shadowedTokenCount: shadowPrice,
      }
    }

    // ⑥ T-boundary 搭车补账（会计；折叠由大 replace 构造性完成）。
    const held = heldPairsInRange(events, facts, range)
    for (const pair of held) {
      const beforeTokens = estimateTokens(pair.text, compressPolicy.density)
      const data: ShearAppliedFactData = compactFact({
        policyVersion: SHEAR_POLICY_VERSION, tier: 'T-boundary', kind: 't-boundary',
        callId: pair.callId, resultSeq: pair.resultSeq, at: now(), category: toolCategory(pair.name),
        beforeTokens, afterTokens: 0, savedTokens: beforeTokens, breakTokens: 0, tailNodes: 0,
      })
      emitCeFact(session, SHEAR_APPLIED_FACT_TYPE, data, logger)
    }

    emitCeFact(session, COMPRESS_RUN_FACT_TYPE, compactFact({
      ...base, outcome: 'ok', calls: chosen.calls, cacheHit: chosen.cacheHit, retry,
      regionTokens: shadowedTokens,
      ...(renderedPromptTokens === undefined ? {} : { promptTokens: renderedPromptTokens }),
      productBytes: new TextEncoder().encode(chosen.rendered).length,
      shadowedTokens, productTokens: chosen.productTokens,
      droppedHotTail: chosen.dropped.badDecl + chosen.dropped.unknownUnit,
      // U15：归因拆分——合并数看不出"为什么退化为位置兜底"（assemble-run 只看得到过滤后的空数组）。
      droppedHotTailBadDecl: chosen.dropped.badDecl,
      droppedHotTailUnknownUnit: chosen.dropped.unknownUnit,
      carried: priorChain.length, archiveEntries: written.entries,
      archiveTruncateCount: chosen.truncation.count, archiveTruncateTokens: chosen.truncation.tokens,
      archiveOverCap: written.overCap,
      shearFolded: held.length, dossierRetired: true,
      ...(chosen.usage === undefined ? {} : { llmUsage: chosen.usage }),
    }), logger)
  }

  /** 边界路径（时序 A）：闭合段发现 → 单次调用 → 档案 vN → 事务替换。 */
  const runBoundary = async (
    session: Session,
    turn: number,
    events: readonly LedgerSessionEvent[],
    facts: readonly LedgerFact[],
  ): Promise<void> => {
    const segments = foldSegmentState([...facts], { sessionFirstSeq: firstUserSeq(events) }).segments
    if (segments.length < 2) return
    const sid = sessionIdOf(session)
    const attempted = attemptedTaskIds(facts)
    const index = segments.findIndex((segment, i) =>
      segment.closed && i < segments.length - 1
      && !attempted.has(`${sid}:${segment.taskId}`)                    // 旧事实键（保守）
      && !attempted.has(`${sid}:${segment.taskId}:${segment.startSeq ?? ''}`))
    if (index < 0) return
    const nextStartSeq = segments[index + 1]?.startSeq
    if (typeof nextStartSeq !== 'number') return
    counts.triggers++
    await compactSegment(session, turn, events, facts, segments[index] as TaskSegment, nextStartSeq)
  }

  /**
   * A/F2（2026-09-11 真机复盘）：pre-step 已判 `new-task` → 在 `next()` 之前压**当前开放段**到表面尾。
   *
   * 与 `runBoundary` 的差别：此段**尚未**被 `judge-verdict` 标记闭合——判词要等该消息落进会话才有 seq
   * （harness 在**步准入回调**返回之后才 `append('user/message')`）。故直接取 `segments.at(-1)`，
   * 并把区间右端开成表面尾（`nextStartSeq` 取 MAX_SAFE_INTEGER，只被 L481/L482 的 `seq < nextStartSeq`
   * 消费）：此刻新消息尚未提交，**表面尾就是边界**。
   *
   * 防重：本次照常发 `compress-run`（带 `taskId` + `segmentStartSeq`），后续 pre-step 由
   * `attemptedTaskIds` 拦下；判词落盘后 `runBoundary` 也会看到同一段，但已被 `attempted` 排除。
   */
  const runBoundaryBeforeStep = async (session: Session, turn: number): Promise<void> => {
    const events = ledgerEventsOf(session)
    const facts = factsFor(session, events)
    const first = firstUserSeq(events)
    if (typeof first !== 'number') return
    const segments = foldSegmentState([...facts], { sessionFirstSeq: first }).segments
    const open = segments.at(-1)
    if (open === undefined || typeof open.startSeq !== 'number') return
    const sid = sessionIdOf(session)
    const attempted = attemptedTaskIds(facts)
    if (attempted.has(`${sid}:${open.taskId}`) || attempted.has(`${sid}:${open.taskId}:${open.startSeq}`)) return
    counts.triggers++
    await compactSegment(session, turn, events, facts, open, Number.MAX_SAFE_INTEGER)
  }

  interface PressureAttempt {
    readonly product: PressureProduct
    readonly checkpointText: string
    readonly rendered: string
    readonly cutSeq: number
    readonly foldedTokens: number
    readonly retainedTokens: number
    readonly productTokens: number
    readonly calls: number
    readonly cacheHit: boolean
    readonly provider: string
    readonly model: string
    readonly usage?: CeLlmUsage
    readonly rawOutput?: string
  }

  interface PressureFoldResult {
    readonly landed: boolean
    /** 是否真正进入折叠尝试（保险丝据此避免同一轮重复折叠）。 */
    readonly attempted: boolean
  }

  /**
   * 压力折叠（P20a；docs/04 §3）：选缝 → 检查点 + 保留区逐字 → 缩水校验（重试 2）→
   * 档案 checkpoint 条目 → 事务替换。emergency = 保险丝/溢出接管（P20b；跳过 turn 守卫，
   * 并可越过断路器——保险丝是最后板凳，但仍有硬上限 PRESSURE_EMERGENCY_LIMIT）。
   * 返回 { landed, attempted }。
   */
  const pressureFold = async (
    session: Session,
    turn: number,
    events: readonly LedgerSessionEvent[],
    facts: readonly LedgerFact[],
    opts: {
      wireTokens: number
      thresholdTokens: number
      emergency: boolean
      contextWindow?: number
      pressureRatio?: number
    },
  ): Promise<PressureFoldResult> => {
    const config = getConfig()
    const sid = sessionIdOf(session)
    const workspace = workspaceFor(session)
    const storeKey = boundaryArchiveKey(workspace)
    const { root } = sessionRootOf(session)
    const stop = (attempted: boolean): PressureFoldResult => ({ landed: false, attempted })
    const base = {
      at: now(), wireTokens: opts.wireTokens, thresholdTokens: opts.thresholdTokens, emergency: opts.emergency,
      contextWindow: opts.contextWindow, pressureRatio: opts.pressureRatio,
    }
    const fire = (outcome: PressureFireFactData['outcome'], extra: Partial<PressureFireFactData> = {}): void => {
      emitCeFact(session, PRESSURE_FIRED_FACT_TYPE, compactFact({ ...base, outcome, chainDepth: 0, ...extra }), logger)
    }
    const segments = foldSegmentState([...facts], { sessionFirstSeq: firstUserSeq(events) }).segments
    const segment = segments.at(-1)
    if (segment === undefined || segment.closed) { fire('skip', { reason: 'no-task' }); return stop(false) }
    const scopedTaskId = `${sid}:${segment.taskId}`
    /** U9：压力路径 `compress-run` 的公共头（含段锚；与边界路径同字段）。 */
    const runBase = {
      at: now(), layer: 'pressure' as const, promptVersion: COMPRESS_PROMPT_VERSION,
      policyVersion: COMPRESS_POLICY_VERSION, taskId: scopedTaskId, segmentStartSeq: segment.startSeq ?? null,
    }
    const existing = storage.getEntity('boundary_archive', storeKey)
    const storeBody = readArchiveStore(existing?.body, workspace)
    const priorChain = priorChainFor(storeBody, scopedTaskId, sid)
    const depth = pressureChainDepth(priorChain)
    // 常规压力受断路器约束；紧急折叠（保险丝/溢出接管）可越过，但有独立硬上限。
    if (!opts.emergency && pressureBreakerTripped(depth)) { fire('breaker', { chainDepth: depth }); return stop(false) }
    if (opts.emergency && depth >= PRESSURE_EMERGENCY_LIMIT) { fire('breaker', { chainDepth: depth, reason: 'emergency-cap' }); return stop(false) }
    if (!planTailConsumption({ priorChain, layer: 'pressure' }).ok) { fire('skip', { reason: 'chain-invalid', chainDepth: depth }); return stop(false) }

    // 权威表面 + 配对平衡守卫（F9a）：端点必须同时是当前表面节点且不切工具对，
    // 否则 replace 抛 INVALID_RANGE（真机 2026-09-09 压力路径整单 skipped 的根因）。
    const history = createHistoryPort(session)
    const surface = history.surfaceNodes()
    const taskEndSeq = surface.at(-1)
    if (taskEndSeq === undefined) { fire('skip', { reason: 'range', chainDepth: depth }); return stop(false) }
    const prev = priorChain.at(-1)
    const segmentStart = segment.startSeq ?? firstUserSeq(events)
    const foldStartSeq = prev?.cutPointSeq ?? segmentStart
    const rawStart = prev?.rangeEndSeq === undefined
      ? surface.find((seq) => seq >= segmentStart)
      : surface.find((seq) => seq > (prev.rangeEndSeq as number))
    if (rawStart === undefined) { fire('skip', { reason: 'range', chainDepth: depth }); return stop(false) }
    const balanced = history.balanceRange({ start: rawStart as never, end: taskEndSeq as never })
    if (balanced === null) { fire('skip', { reason: 'range', chainDepth: depth }); return stop(false) }
    const replaceStart = Number(balanced.start)
    const replaceEnd = Number(balanced.end)
    const visibleSeqs = new Set<number>(surface.map((seq) => Number(seq)))

    // 单元清单与折叠区同源（模型只从清单抄 unitId 选缝；被遮蔽原文在此重新可见 = 机制 B）。
    const material = events.filter(isPressureMaterial)
    const units = foldAssembleInputs(material).units
      .filter((unit) => unit.seqStart >= foldStartSeq && unit.seqEnd <= replaceEnd)
    if (units.length === 0) { fire('skip', { reason: 'no-units', chainDepth: depth }); return stop(false) }

    const { assemble: assemblePolicy, compress: compressPolicy } = policiesOf(config)
    const candidateText = renderFoldMaterialTranscript(events, { startSeq: foldStartSeq, endSeq: replaceEnd })
    const policyKey = `${assemblePolicy.hotTailTokens}/${assemblePolicy.archiveTokens}/${compressPolicy.density.cjk},${compressPolicy.density.other}/${root}`
    const key = compressSpanHash({
      promptVersion: COMPRESS_PROMPT_VERSION, policyVersion: COMPRESS_POLICY_VERSION, layer: 'pressure',
      regionText: candidateText, unitIds: units.map((unit) => unit.id),
      priorChainTexts: priorChain.map((entry) => entry.text), policyKey,
    })
    const cached = lookupCachedProduct(storeBody, key)
    const llm = deps.getLlm?.()
    let calls = 0
    let usage: CeLlmUsage | undefined
    let renderedPromptTokens: number | undefined

    const attemptProduct = async (useCache: boolean): Promise<PressureAttempt | undefined> => {
      let product: PressureProduct
      let cacheHit = false
      let rawOutput: string | undefined
      let provider = ''
      let model = ''
      if (useCache && cached !== undefined && cached.product.mode === 'pressure') {
        product = cached.product
        cacheHit = true
      } else {
        if (llm === undefined) { fire('skip', { reason: 'llm-unavailable', chainDepth: depth }); return undefined }
        const renderedPrompt = renderPressurePrompt({ regionText: candidateText, units, priorChain, policy: compressPolicy, root })
        renderedPromptTokens = estimateTokens(renderedPrompt.prompt, compressPolicy.density)
        const route = resolveJudgeModel(config, readSessionModel(session))
        // U8：无路由（未配置 + 会话尚无 request/header）→ 复用 llm-unavailable（瞬态）。
        if (route === undefined) { fire('skip', { reason: 'llm-unavailable', chainDepth: depth }); return undefined }
        provider = route.provider
        model = route.model
        const desired = reasoningEffortSetting(config)
        const sentEffort = desired === undefined ? undefined : await resolveReasoningEffort(llm, provider, model, desired, logger)
        const options: CeGenerateOptions = {
          provider, model,
          messages: [{ role: 'user', content: [{ type: 'text', text: renderedPrompt.prompt }], source: { kind: 'user' }, id: 'compress' }] as never,
          purpose: 'context-economy-compaction',
          temperature: 0,
          ...(sentEffort === undefined ? {} : { reasoningEffort: sentEffort }),
        }
        let llmText = ''
        let failure: { code?: string; message: string } | undefined
        for await (const chunk of streamCeLlm(llm, options, { onUsage: (receipt) => { usage = receipt.usage }, logger, timeoutMs: CE_LLM_TIMEOUT_MS.compaction })) {
          if (chunk.type === 'text-delta') llmText += chunk.text
          if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') {
            const reason = chunk.reason as { kind: 'error'; failure?: { code?: string; message?: string } }
            failure = { code: reason.failure?.code, message: reason.failure?.message ?? 'non-stop finish' }
            break
          }
        }
        if (failure !== undefined) {
          const unavailable = failure.code === 'CE_LLM_UNAVAILABLE'
          fire('skip', { reason: unavailable ? 'llm-unavailable' : 'llm-error', chainDepth: depth, cutPointSeq: undefined })
          emitCeFact(session, COMPRESS_RUN_FACT_TYPE, compactFact({
            ...runBase, outcome: 'skipped' as const, reason: unavailable ? 'llm-unavailable' : 'llm-error',
            calls: unavailable ? calls : calls + 1, emergency: opts.emergency,
            ...(usage === undefined ? {} : { llmUsage: usage }),
          }), logger)
          return undefined
        }
        calls++
        warnTokenDrift(renderedPromptTokens, usage, logger)
        const parsed = parseCompressProduct(llmText, 'pressure', units)
        if (!parsed.ok) {
          // U14：parse/schema 是压力路径**已经真正开火**（调用已发生、费用已产生）的结果，
          // 旧实现只发 compress-run 而不发 pressure-fired → 账本上"决定开火"的那半条记录消失，
          // 回放只见一次孤立的失败调用（2026-09-11 真机：一次 schema 失败烧掉 718K input tokens
          // 却在 `pressure-fired` 计数里完全不可见）。与 shrink/cutpoint/range/no-units 各路径对齐。
          fire('skip', { reason: parsed.reason, chainDepth: depth })
          emitCeFact(session, COMPRESS_RUN_FACT_TYPE, compactFact({
            ...runBase, outcome: parsed.reason, calls, emergency: opts.emergency,
            ...(usage === undefined ? {} : { llmUsage: usage }),
          }), logger)
          return undefined
        }
        product = parsed.product as PressureProduct
        rawOutput = llmText
      }
      const cutUnit = units.find((unit) => unit.id === product.cutPoint.unitId)
      if (cutUnit === undefined) { fire('skip', { reason: 'cutpoint', chainDepth: depth }); return undefined }
      const cutSeq = cutUnit.seqStart
      // 缝必须落在替换区间内：否则保留区会把区间外的原文重复带进产物（或区间内原文被截断丢失）。
      if (cutSeq < replaceStart || cutSeq > replaceEnd) { fire('skip', { reason: 'cutpoint', chainDepth: depth }); return undefined }
      const retainedText = renderRegionTranscript(events, { startSeq: cutSeq, endSeq: replaceEnd }, visibleSeqs)
      const checkpointText = renderCheckpoint(product.checkpoint)
      const rendered = composePressureArchive({ priorChain, checkpointText, retainedText })
      return {
        product, checkpointText, rendered, cutSeq,
        foldedTokens: foldMaterialTokens(events, { startSeq: foldStartSeq, endSeq: cutSeq - 1 }, compressPolicy),
        retainedTokens: estimateTokens(retainedText, compressPolicy.density),
        productTokens: estimateTokens(`${checkpointText}\n\n${retainedText}`, compressPolicy.density),
        calls, cacheHit, provider, model,
        ...(usage === undefined ? {} : { usage }),
        ...(rawOutput === undefined ? {} : { rawOutput }),
      }
    }

    let chosen: PressureAttempt | undefined
    let lastFolded = 0
    let lastRetained = 0
    let attempts = 0
    for (let attempt = 0; attempt <= PRESSURE_RETRY_BUDGET && chosen === undefined; attempt++) {
      attempts++
      const candidate = await attemptProduct(attempt === 0)
      if (candidate === undefined) return stop(true)
      lastFolded = candidate.foldedTokens
      lastRetained = candidate.retainedTokens
      // 缩水校验（04 §1，replace 前置）：产物（检查点 + 保留区）< 被压区间（折叠材料）。
      if (candidate.productTokens < candidate.foldedTokens) chosen = candidate
    }
    const retry = Math.max(0, attempts - 1)
    if (chosen === undefined) {
      fire('skip', { reason: 'shrink', chainDepth: depth, foldedTokens: lastFolded, retainedTokens: lastRetained })
      emitCeFact(session, COMPRESS_RUN_FACT_TYPE, compactFact({
        ...runBase, outcome: 'skipped' as const, reason: 'shrink', calls, retry,
        foldedTokens: lastFolded, retainedTokens: lastRetained, emergency: opts.emergency,
        ...(usage === undefined ? {} : { llmUsage: usage }),
      }), logger)
      return stop(true)
    }
    if (chosen.cacheHit) counts.cacheHits++

    // 档案 vN：只存检查点文本 C（续传面）；cutPointSeq/rangeEndSeq 供下一次折叠定位（机制 A/B）。
    const written = await writeStore((body) => {
      const appended = appendArchiveEntry(body, {
        taskId: scopedTaskId, kind: 'checkpoint', text: chosen!.checkpointText, sessionId: sid,
        layer: 'pressure', at: now(), cutPointSeq: chosen!.cutSeq, rangeEndSeq: replaceEnd, root,
      }, assemblePolicy)
      return {
        body: chosen!.cacheHit
          ? appended.body
          : putCachedProduct(appended.body, { key, at: now(), layer: 'pressure', product: chosen!.product }),
        entries: appended.kept,
        overCap: appended.overCap,
      }
    }, existing?.version, scopedTaskId, workspace, storeKey)
    if (written === undefined) {
      fire('skip', { reason: 'storage', chainDepth: depth, foldedTokens: chosen.foldedTokens, retainedTokens: chosen.retainedTokens, cutPointSeq: chosen.cutSeq })
      emitCeFact(session, COMPRESS_RUN_FACT_TYPE, compactFact({
        ...runBase, outcome: 'skipped' as const, reason: 'storage', calls: chosen.calls, retry,
        cacheHit: chosen.cacheHit, foldedTokens: chosen.foldedTokens, retainedTokens: chosen.retainedTokens,
        cutPointSeq: chosen.cutSeq, emergency: opts.emergency,
        ...(chosen.usage === undefined ? {} : { llmUsage: chosen.usage }),
      }), logger)
      return stop(true)
    }

    // 事务：open → prune（影子价）→ summary + checkpoint 替换 → close。
    const shadowPrice = deps.getMeter?.()?.heuristicTokensInRange(session, replaceStart, replaceEnd)
      ?? estimateTokens(renderRegionTranscript(events, { startSeq: replaceStart, endSeq: replaceEnd }, visibleSeqs), compressPolicy.density)
    const plan = planTxn({
      txnId: ceTxnId('pressure', segment.taskId, replaceStart, replaceEnd),
      layer: 'pressure', taskId: scopedTaskId, range: { start: replaceStart, end: replaceEnd },
      shadowedTokenCount: shadowPrice, replaceKind: 'checkpoint', turn,
    })
    const txn = runCompactionTxn(history, plan, (h) => {
      h.recordPrune({ start: replaceStart as never, end: replaceEnd as never, shadowedTokenCount: shadowPrice })
      h.commitCheckpoint({
        compactionId: plan.txnId,
        text: chosen!.rendered,
        summary: chosen!.checkpointText,
        range: { start: replaceStart as never, end: replaceEnd as never },
        shadowedTokenCount: shadowPrice,
        provider: chosen!.cacheHit ? '' : chosen!.provider,
        model: chosen!.cacheHit ? '' : chosen!.model,
        ...(chosen!.usage === undefined ? {} : { usage: chosen!.usage }),
        ...(chosen!.rawOutput === undefined ? {} : { rawOutput: chosen!.rawOutput }),
      })
    })
    if (!txn.ok) {
      // U6：档案补偿——事务未落刀，档案必须回退到写前状态（防幽灵 checkpoint 毒化续传链定位）
      await compensateArchive(storeKey, workspace, scopedTaskId, existing)
      fire('skip', { reason: `txn-${txn.code ?? 'fail'}`, chainDepth: depth, foldedTokens: chosen.foldedTokens, retainedTokens: chosen.retainedTokens, cutPointSeq: chosen.cutSeq })
      emitCeFact(session, COMPRESS_RUN_FACT_TYPE, compactFact({
        ...runBase, outcome: 'skipped' as const, reason: 'txn', calls: chosen.calls, retry,
        cacheHit: chosen.cacheHit, foldedTokens: chosen.foldedTokens, retainedTokens: chosen.retainedTokens,
        cutPointSeq: chosen.cutSeq, emergency: opts.emergency,
        ...(chosen.usage === undefined ? {} : { llmUsage: chosen.usage }),
      }), logger)
      return stop(true)
    }
    counts.compactions++
    fire('fired', { chainDepth: depth, foldedTokens: chosen.foldedTokens, retainedTokens: chosen.retainedTokens, cutPointSeq: chosen.cutSeq })
    emitCeFact(session, COMPRESS_RUN_FACT_TYPE, compactFact({
      ...runBase, outcome: 'ok' as const, calls: chosen.calls, cacheHit: chosen.cacheHit, retry,
      regionTokens: chosen.foldedTokens,
      ...(renderedPromptTokens === undefined ? {} : { promptTokens: renderedPromptTokens }),
      productBytes: new TextEncoder().encode(chosen.rendered).length,
      shadowedTokens: chosen.foldedTokens, productTokens: chosen.productTokens,
      foldedTokens: chosen.foldedTokens, retainedTokens: chosen.retainedTokens, cutPointSeq: chosen.cutSeq,
      carried: priorChain.length, archiveEntries: written.entries,
      archiveOverCap: written.overCap, emergency: opts.emergency,
      ...(chosen.usage === undefined ? {} : { llmUsage: chosen.usage }),
    }), logger)
    return { landed: true, attempted: true }
  }

  /**
   * 主模型窗口探针（P20c）：窗口必须取**主会话路由**（readSessionModel），
   * 不是辅助调用（判别/压缩）路由；无 llm / 无 request/header / 适配器未声明 = undefined（不猜）。
   */
  const resolvePressureWindow = async (session: Session): Promise<number | undefined> => {
    const llm = deps.getLlm?.()
    if (llm === undefined) return undefined
    const model = readSessionModel(session)
    if (model === undefined) return undefined
    return await resolveContextWindow(llm, model.provider, model.model, logger)
  }

  /**
   * 压力触发（时序 C 上半）：wire 锚定计量 ≥ 阀门（比例 × 主模型窗口）；一个 turn 至多尝试一次。
   * 返回 true = 本轮真正进入折叠尝试（保险丝据此避免同轮重复折叠）。
   */
  const runPressure = async (
    session: Session,
    turn: number,
    events: readonly LedgerSessionEvent[],
    facts: readonly LedgerFact[],
    contextWindow?: number,
  ): Promise<boolean> => {
    const config = getConfig()
    const wireTokens = deps.getMeter?.()?.wireTokens(session)
    if (wireTokens === undefined) return false
    const thresholdTokens = pressureThreshold({
      contextWindow,
      domainTokens: config.compression.domainTokens,
      thresholdTokens: config.compression.thresholdTokens,
      pressureRatio: config.compression.pressureRatio,
    })
    if (thresholdTokens === undefined || wireTokens < thresholdTokens) return false
    if (pressureTurn.get(session) === turn) return false
    pressureTurn.set(session, turn)
    const result = await pressureFold(session, turn, events, facts, {
      wireTokens, thresholdTokens, emergency: false,
      pressureRatio: config.compression.pressureRatio,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    })
    return result.attempted
  }

  /**
   * 保险丝（时序 C 下半，P20b/P20c）：地板以上自动紧急折叠；低于地板严格 no-op（零事实零行为）。
   * 压力路径本轮已真正尝试过折叠则跳过（避免同轮重复折叠）；否则紧急折叠可越过断路器。
   */
  const runFuse = async (
    session: Session,
    turn: number,
    step: number,
    events: readonly LedgerSessionEvent[],
    facts: readonly LedgerFact[],
    contextWindow: number | undefined,
    pressureAttempted: boolean,
  ): Promise<void> => {
    if (pressureAttempted) return
    if (fuseTurn.get(session) === turn) return
    const wireTokens = deps.getMeter?.()?.wireTokens(session)
    if (wireTokens === undefined) return
    const floorTokens = fuseFloorTokens(contextWindow)
    if (floorTokens === undefined || !fuseArmed({ wireTokens, contextWindow })) return
    // U11.7：键分前缀——保险丝（fuse）与溢出接管（err）是两条独立通道，同一 (turn,step) 下
    // 旧实现共用一个键，先到者会把另一条挤掉（保险丝挤掉同拍溢出接管 = 该轮不再重试）。
    const guardKey = `fuse:${turn}:${step}`
    if (emergencyGuard.get(session) === guardKey) return
    emergencyGuard.set(session, guardKey)
    fuseTurn.set(session, turn)
    const result = await pressureFold(session, turn, events, facts, { wireTokens, thresholdTokens: floorTokens, emergency: true })
    emitCeFact(session, HARD_TRUNCATE_FACT_TYPE, compactFact({
      at: now(), wireTokens, floorTokens, outcome: 'fuse-fold' as const, landed: result.landed,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    }), logger)
  }

  /**
   * H3 溢出接管（P20b）：仅 CONTEXT_WINDOW_EXCEEDED 且本轮未接管过时紧急压力折叠；
   * 落刀 = 请求重试，未落刀 = 原始错误交还上游（失败方向 = 用户数据安全侧）。
   */
  const onRequestError = async (payload: {
    session: Session
    turn: number
    step: number
    failureCode: string
  }): Promise<'retry' | 'pass'> => {
    if (disposed) return 'pass'
    const config = getConfig()
    if (config.compression?.pressure === false) return 'pass'
    if (payload.failureCode !== CE_CONTEXT_OVERFLOW_CODE) return 'pass'
    const guardKey = `err:${payload.turn}:${payload.step}`
    if (emergencyGuard.get(payload.session) === guardKey) return 'pass'
    emergencyGuard.set(payload.session, guardKey)
    if (busy.has(payload.session)) return 'pass'
    busy.add(payload.session)
    try {
      const events = ledgerEventsOf(payload.session)
      const facts = factsFor(payload.session, events)
      const wireTokens = deps.getMeter?.()?.wireTokens(payload.session) ?? 0
      const thresholdTokens = pressureThreshold({
        domainTokens: config.compression.domainTokens,
        thresholdTokens: config.compression.thresholdTokens,
        pressureRatio: config.compression.pressureRatio,
      }) ?? 0
      const result = await pressureFold(payload.session, payload.turn, events, facts, { wireTokens, thresholdTokens, emergency: true })
      emitCeFact(payload.session, HARD_TRUNCATE_FACT_TYPE, compactFact({
        at: now(), wireTokens, floorTokens: thresholdTokens,
        outcome: result.landed ? 'overflow-retry' as const : 'overflow-declined' as const, landed: result.landed,
      }), logger)
      return result.landed ? 'retry' : 'pass'
    } catch (e) {
      counts.errors++
      logger.warn('context-economy: overflow takeover failed (fail-lazy, original error preserved)', e instanceof Error ? e.message : String(e))
      return 'pass'
    } finally {
      busy.delete(payload.session)
    }
  }

  /**
   * U17：显式空闲压缩（取代原生 `/compact` 的后端入口）。
   *
   * 选段：**最早**尚未被 `attemptedTaskIds` 归档的闭合段优先（"压更老的历史" = 原生语义）；
   * 无此段则退回当前开放段（区间右端 = 表面尾）。两条都走 `compactSegment`，与压力路径
   * **共用** `planTxn`/`runCompactionTxn` 事务原语、装配器、档案 vN 与缩水校验——即"用我们
   * 自己的压缩取代原生"，而不是另起一套。一次调用至多落一刀（与 `onPreStep` 同口径），
   * 免得一条命令把整会话刮空。
   */
  const compactNow = async (session: Session): Promise<CompactionOutcome> => {
    if (disposed) return { ok: false, reason: 'disposed' }
    const events = ledgerEventsOf(session)
    const facts = factsFor(session, events)
    const first = firstUserSeq(events)
    if (typeof first !== 'number') return { ok: false, reason: 'no-session' }
    const segments = foldSegmentState([...facts], { sessionFirstSeq: first }).segments
    if (segments.length === 0) return { ok: false, reason: 'no-task' }
    const sid = sessionIdOf(session)
    const attempted = attemptedTaskIds(facts)
    const keys = (segment: TaskSegment): string[] => [
      `${sid}:${segment.taskId}`,
      `${sid}:${segment.taskId}:${segment.startSeq ?? ''}`,
    ]
    const isAttempted = (segment: TaskSegment): boolean => keys(segment).some((k) => attempted.has(k))
    const closed = segments.findIndex((segment, i) => segment.closed && i < segments.length - 1 && !isAttempted(segment))
    const capture: CompactCapture = {}
    if (closed >= 0) {
      const nextStartSeq = segments[closed + 1]?.startSeq
      if (typeof nextStartSeq !== 'number') return { ok: false, reason: 'no-next-boundary' }
      counts.triggers++
      await compactSegment(session, null, events, facts, segments[closed] as TaskSegment, nextStartSeq, capture)
    } else {
      const open = segments.at(-1)
      if (open === undefined || typeof open.startSeq !== 'number') return { ok: false, reason: 'no-task' }
      if (isAttempted(open)) return { ok: false, reason: 'already-compacted' }
      counts.triggers++
      await compactSegment(session, null, events, facts, open, Number.MAX_SAFE_INTEGER, capture)
    }
    return capture.result === undefined
      ? { ok: false, reason: capture.reason ?? 'no-result' }
      : { ok: true, result: capture.result }
  }

  const onPreStep = async (payload: { session: Session; turn: number; step?: number }): Promise<void> => {
    if (disposed) return
    const { session, turn } = payload
    counts.preSteps++
    const config = getConfig()
    if (!compressionInvariantOk(config.compression)) return
    if (busy.has(session)) return
    busy.add(session)
    try {
      const events = ledgerEventsOf(session)
      const facts = factsFor(session, events)
      if (config.compression?.boundary !== false) await runBoundary(session, turn, events, facts)
      if (config.compression?.pressure !== false) {
        // P20c：每步只探一次主模型窗口，压力阀门与保险丝地板共用同一值。
        const contextWindow = await resolvePressureWindow(session)
        const pressureAttempted = await runPressure(session, turn, events, facts, contextWindow)
        await runFuse(session, turn, payload.step ?? 0, events, facts, contextWindow, pressureAttempted)
      }
    } catch (e) {
      counts.errors++
      logger.warn('context-economy: compaction failed (fail-lazy, original history preserved)', e instanceof Error ? e.message : String(e))
    } finally {
      busy.delete(session)
    }
  }

  return {
    dispose() { disposed = true; offReplayedFacts?.() },
    stats: () => ({ ...counts }),
    onPreStep,
    onBoundaryBeforeStep: (payload) => runBoundaryBeforeStep(payload.session, payload.turn),
    compactNow: (payload) => compactNow(payload.session),
    onRequestError,
  }
}

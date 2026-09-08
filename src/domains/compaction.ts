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
import { compactFact, factsFromSessionEvents } from '../core/ledger/facts.ts'
import { estimateTokens, extractTextFromToolResult } from '../core/ledger/fold.ts'
import { foldSurfaceNodes } from '../core/ledger/surface.ts'
import type { LedgerFact, LedgerSessionEvent } from '../core/ledger/types.ts'
import { foldSegmentState, type TaskSegment } from '../core/units.ts'
import { DEFAULT_ASSEMBLE_POLICY, foldAssembleInputs, planTxn, type AssemblePolicy, type HotTailDropCounts } from '../core/assemble/index.ts'
import {
  COMPRESS_PROMPT_VERSION,
  COMPRESS_POLICY_VERSION,
  DEFAULT_COMPRESS_POLICY,
  PRESSURE_EMERGENCY_LIMIT,
  PRESSURE_RETRY_BUDGET,
  appendArchiveEntry,
  compressSpanHash,
  composePressureArchive,
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
import { CE_CONTEXT_OVERFLOW_CODE, resolveContextWindow, resolveReasoningEffort, streamCeLlm, type CeGenerateOptions, type CeLlmUsage } from '../platform/llm.ts'
import { readSessionModel, type CeLogger } from '../platform/events.ts'
import type { ContextEconomyStorage } from '../platform/storage.ts'
import type { MeterPort } from '../platform/meter.ts'
import { compressionInvariantOk, reasoningEffortSetting, type Config as ConfigShape } from '../config.ts'
import { resolveJudgeModel } from './input.ts'
import { runCompactionTxn, type AssembleDomain } from './assemble.ts'
import { COMPRESS_RUN_FACT_TYPE, HARD_TRUNCATE_FACT_TYPE, PRESSURE_FIRED_FACT_TYPE, type CompressRunFactData, type PressureFireFactData } from './compaction-facts.ts'

const ZERO_DROPS: HotTailDropCounts = { badDecl: 0, unknownUnit: 0, remap: 0, fetch: 0 }

/** F8b 标定对账（只观察、不改行为）：估算 promptTokens vs 真实 input+cacheRead，偏离 ±25% 即 warn。 */
function warnTokenDrift(estimated: number | undefined, usage: CeLlmUsage | undefined, logger: CeLogger): void {
  const actual = (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0)
  const ratio = calibrationRatio(estimated ?? 0, actual)
  if (ratio === null || (ratio >= 0.75 && ratio <= 1.25)) return
  logger.warn(`context-economy: token estimate drift (estimated ${estimated}, actual ${actual}, ratio ${ratio.toFixed(2)})`)
}

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
  /** H3 溢出接管（P20b）：'retry' = 本轮重试；'pass' = 委派上游。 */
  onRequestError(payload: { session: Session; turn: number; step: number; failureCode: string }): Promise<'retry' | 'pass'>
}

/** 会话内参与段状态 fold 的原始事件上限（超出丢最老；只影响超老段的发现）。 */
export const COMPACTION_EVENT_LIMIT = 4000

/** 档案区实体键（workspace 隔离；docs/09 §1）。 */
export function boundaryArchiveKey(workspace: string): string {
  return `boundary_archive:${workspace}`
}

function sessionIdOf(session: Session): string {
  const s = session as unknown as { header?: { id?: unknown }; id?: unknown }
  const header = s.header?.id
  return typeof header === 'string' ? header : String(s.id ?? 'session')
}

function ledgerEventsOf(session: Session): LedgerSessionEvent[] {
  const snapshot = (session as unknown as { snapshotEvents?: () => readonly unknown[] }).snapshotEvents?.() ?? []
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
  return out.slice(-COMPACTION_EVENT_LIMIT)
}

function firstUserSeq(events: readonly LedgerSessionEvent[]): number {
  for (const event of events) if (event.type === 'user/message' && event.surfaceOp === 'append') return event.seq
  return events[0]?.seq ?? 0
}

/** 已尝试过的 task（事实键，重放可判）：除 llm-unavailable 外一律不再尝试（防每步重复计费）。 */
function attemptedTaskIds(facts: readonly LedgerFact[]): Set<string> {
  const attempted = new Set<string>()
  for (const fact of facts) {
    if (fact.type !== COMPRESS_RUN_FACT_TYPE) continue
    const data = (fact.data ?? {}) as Partial<CompressRunFactData>
    if (typeof data.taskId !== 'string' || data.taskId === '') continue
    // 只有边界路径的尝试才算"该 task 已归档"；压力路径的 compress-run 不阻止 task 闭合归档。
    if (data.layer !== 'boundary') continue
    if (data.outcome === 'skipped' && data.reason === 'llm-unavailable') continue
    attempted.add(data.taskId)
  }
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
  readonly usage?: CeLlmUsage
  readonly rawOutput?: string
  readonly rendered: string
  readonly productTokens: number
  readonly truncation: { count: number; tokens: number }
  readonly entries: number
}

export function mountCompactionDomain(deps: CompactionDomainDeps): CompactionDomain {
  const { storage, getConfig, logger, now = Date.now } = deps
  const workspace = deps.workspace ?? process.cwd().replaceAll('\\', '/')
  const storeKey = boundaryArchiveKey(workspace)
  const counts: CompactionDomainStats = { preSteps: 0, triggers: 0, compactions: 0, cacheHits: 0, skips: 0, rangeSkips: 0, errors: 0 }
  const busy = new WeakSet<Session>()
  /** 压力触发 turn 守卫（一个 turn 至多一次常规压力尝试；紧急折叠另有守卫）。 */
  const pressureTurn = new WeakMap<Session, number>()
  /** 紧急折叠守卫（同 (turn,step) 至多一次：地板以上自动折叠 / 溢出接管共用）。 */
  const emergencyGuard = new WeakMap<Session, string>()
  /** 保险丝自动折叠 turn 守卫（每轮至多一次；与压力 turn 守卫独立）。 */
  const fuseTurn = new WeakMap<Session, number>()
  let disposed = false

  const policiesOf = (config: ConfigShape): { assemble: AssemblePolicy; compress: CompressPolicy } => ({
    assemble: {
      ...DEFAULT_ASSEMBLE_POLICY,
      hotTailTokens: config.compression.retainTokens,
      archiveTokens: config.compression.archiveCapTokens,
    },
    compress: { ...DEFAULT_COMPRESS_POLICY },
  })

  /** 档案实体写入（CAS 冲突重读重试 1；纯 mutate 在新体上重放）。 */
  const writeStore = async (
    mutate: (body: ArchiveStoreBody) => { body: ArchiveStoreBody; entries: number },
    baseVersion: number | undefined,
    taskId: string,
  ): Promise<number | undefined> => {
    const source = { taskId, eventType: 'boundary-archive', evidence: { workspace } }
    try {
      const result = mutate(readArchiveStore(storage.getEntity('boundary_archive', storeKey)?.body, workspace))
      await storage.putEntity('boundary_archive', storeKey, result.body, source, { baseVersion: baseVersion ?? 0 })
      return result.entries
    } catch {
      const current = storage.getEntity('boundary_archive', storeKey)
      if (current === undefined || current.version === baseVersion) return undefined
      try {
        const result = mutate(readArchiveStore(current.body, workspace))
        await storage.putEntity('boundary_archive', storeKey, result.body, source, { baseVersion: current.version })
        return result.entries
      } catch {
        return undefined
      }
    }
  }

  const compactSegment = async (
    session: Session,
    turn: number,
    events: readonly LedgerSessionEvent[],
    facts: readonly LedgerFact[],
    segment: TaskSegment,
    nextStartSeq: number,
  ): Promise<void> => {
    const config = getConfig()
    const sid = sessionIdOf(session)
    const scopedTaskId = `${sid}:${segment.taskId}`
    const { assemble: assemblePolicy, compress: compressPolicy } = policiesOf(config)
    const base = {
      at: now(), layer: 'boundary' as const,
      promptVersion: COMPRESS_PROMPT_VERSION, policyVersion: COMPRESS_POLICY_VERSION,
      taskId: scopedTaskId,
    }
    const skip = (reason: string, extra: Partial<CompressRunFactData> = {}): void => {
      counts.skips++
      emitCeFact(session, COMPRESS_RUN_FACT_TYPE, compactFact({ ...base, outcome: 'skipped' as const, reason, ...extra }), logger)
    }

    // ① 区间落表面（尾必须排除下一段起点 = 新 task 首条消息 = 权威段）。
    const surface = foldSurfaceNodes(events)
    // 起点必须同时落在本段区间内：压缩产物节点（checkpoint，seq 高但语义属更早区间）不得被当起点，
    // 否则"多闭合段积压"（如恢复后 / 曾关开关）场景会取到新节点 → 区间反空 → 每步 rangeSkip 卡死。
    const start = surface.find((seq) => seq >= (segment.startSeq ?? 0) && seq < nextStartSeq)
    const end = start === undefined ? undefined : [...surface].reverse().find((seq) => seq >= start && seq < nextStartSeq)
    if (start === undefined || end === undefined) { counts.rangeSkips++; return }
    const history = createHistoryPort(session)
    const balanced = history.balanceRange({ start: start as never, end: end as never })
    if (balanced === null) { counts.rangeSkips++; return }
    const range = { startSeq: Number(balanced.start), endSeq: Number(balanced.end) }
    const regionText = renderRegionTranscript(events, range)
    if (regionText === '') { counts.rangeSkips++; return }
    const units = deps.assemble.unitList(session, range)

    // ② 档案体 + 续传链（机制 A）+ 内容寻址键。
    const existing = storage.getEntity('boundary_archive', storeKey)
    const storeBody = readArchiveStore(existing?.body, workspace)
    const priorChain = priorChainFor(storeBody, scopedTaskId, sid)
    if (!planTailConsumption({ priorChain, layer: 'boundary' }).ok) { skip('chain-invalid'); return }
    const policyKey = `${assemblePolicy.hotTailTokens}/${assemblePolicy.archiveTokens}/${compressPolicy.density.cjk},${compressPolicy.density.other}`
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
        const rendered = renderBoundaryPrompt({ regionText, units, priorChain, policy: compressPolicy })
        renderedPromptTokens = estimateTokens(rendered.prompt, compressPolicy.density)
        const route = resolveJudgeModel(config, readSessionModel(session))
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
        for await (const chunk of streamCeLlm(llm, options, { onUsage: (receipt) => { usage = receipt.usage }, logger })) {
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
        { taskId: scopedTaskId, kind: 'boundary', text: outcome.result.rendered, sessionId: sid, layer: 'boundary', at: now() },
        assemblePolicy,
      )
      return {
        product, dropped, calls, cacheHit, rendered: outcome.result.rendered,
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
    const entries = await writeStore((body) => {
      const appended = appendArchiveEntry(
        body,
        { taskId: scopedTaskId, kind: 'boundary', text: chosen!.rendered, sessionId: sid, layer: 'boundary', at: now() },
        assemblePolicy,
      )
      return {
        body: chosen!.cacheHit
          ? appended.body
          : putCachedProduct(appended.body, { key, at: now(), layer: 'boundary', product: chosen!.product, dropped: chosen!.dropped }),
        entries: appended.kept,
      }
    }, existing?.version, scopedTaskId)
    if (entries === undefined) {
      skip('storage', { calls: chosen.calls, retry, shadowedTokens, productTokens: chosen.productTokens, cacheHit: chosen.cacheHit, ...(chosen.usage === undefined ? {} : { llmUsage: chosen.usage }) })
      return
    }

    // ⑤ 事务：open → prune（影子价）→ summary+checkpoint 替换 → close。
    const shadowPrice = deps.getMeter?.()?.heuristicTokensInRange(session, range.startSeq, range.endSeq) ?? shadowedTokens
    const plan = planTxn({
      txnId: `ce-compact-boundary-${segment.taskId}-${range.startSeq}-${range.endSeq}`,
      layer: 'boundary', taskId: scopedTaskId, range: { start: range.startSeq, end: range.endSeq },
      shadowedTokenCount: shadowPrice, replaceKind: 'digest', turn,
    })
    const txn = runCompactionTxn(history, plan, (h) => {
      h.recordPrune({ start: range.startSeq as never, end: range.endSeq as never, shadowedTokenCount: shadowPrice })
      h.commitCheckpoint({
        compactionId: plan.txnId,
        text: chosen!.rendered,
        summary: chosen!.rendered,
        range: { start: range.startSeq as never, end: range.endSeq as never },
        shadowedTokenCount: shadowPrice,
        provider: chosen!.cacheHit ? '' : resolveJudgeModel(config, readSessionModel(session)).provider,
        model: chosen!.cacheHit ? '' : resolveJudgeModel(config, readSessionModel(session)).model,
        ...(chosen!.usage === undefined ? {} : { usage: chosen!.usage }),
        ...(chosen!.rawOutput === undefined ? {} : { rawOutput: chosen!.rawOutput }),
      })
    })
    if (!txn.ok) {
      skip(`txn-${txn.code ?? 'fail'}`, { calls: chosen.calls, retry, shadowedTokens, productTokens: chosen.productTokens, cacheHit: chosen.cacheHit, ...(chosen.usage === undefined ? {} : { llmUsage: chosen.usage }) })
      return
    }
    counts.compactions++

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
      carried: priorChain.length, archiveEntries: entries,
      archiveTruncateCount: chosen.truncation.count, archiveTruncateTokens: chosen.truncation.tokens,
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
    const index = segments.findIndex((segment, i) => segment.closed && i < segments.length - 1 && !attempted.has(`${sid}:${segment.taskId}`))
    if (index < 0) return
    const nextStartSeq = segments[index + 1]?.startSeq
    if (typeof nextStartSeq !== 'number') return
    counts.triggers++
    await compactSegment(session, turn, events, facts, segments[index] as TaskSegment, nextStartSeq)
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
    const existing = storage.getEntity('boundary_archive', storeKey)
    const storeBody = readArchiveStore(existing?.body, workspace)
    const priorChain = priorChainFor(storeBody, scopedTaskId, sid)
    const depth = pressureChainDepth(priorChain)
    // 常规压力受断路器约束；紧急折叠（保险丝/溢出接管）可越过，但有独立硬上限。
    if (!opts.emergency && pressureBreakerTripped(depth)) { fire('breaker', { chainDepth: depth }); return stop(false) }
    if (opts.emergency && depth >= PRESSURE_EMERGENCY_LIMIT) { fire('breaker', { chainDepth: depth, reason: 'emergency-cap' }); return stop(false) }
    if (!planTailConsumption({ priorChain, layer: 'pressure' }).ok) { fire('skip', { reason: 'chain-invalid', chainDepth: depth }); return stop(false) }

    const surface = foldSurfaceNodes(events)
    const taskEndSeq = surface.at(-1)
    if (taskEndSeq === undefined) { fire('skip', { reason: 'range', chainDepth: depth }); return stop(false) }
    const prev = priorChain.at(-1)
    const segmentStart = segment.startSeq ?? firstUserSeq(events)
    const foldStartSeq = prev?.cutPointSeq ?? segmentStart
    const replaceStart = prev?.rangeEndSeq === undefined
      ? surface.find((seq) => seq >= segmentStart)
      : surface.find((seq) => seq > (prev.rangeEndSeq as number))
    if (replaceStart === undefined) { fire('skip', { reason: 'range', chainDepth: depth }); return stop(false) }

    // 单元清单与折叠区同源（模型只从清单抄 unitId 选缝；被遮蔽原文在此重新可见 = 机制 B）。
    const material = events.filter(isPressureMaterial)
    const units = foldAssembleInputs(material).units
      .filter((unit) => unit.seqStart >= foldStartSeq && unit.seqEnd <= taskEndSeq)
    if (units.length === 0) { fire('skip', { reason: 'no-units', chainDepth: depth }); return stop(false) }

    const { assemble: assemblePolicy, compress: compressPolicy } = policiesOf(config)
    const candidateText = renderFoldMaterialTranscript(events, { startSeq: foldStartSeq, endSeq: taskEndSeq })
    const policyKey = `${assemblePolicy.hotTailTokens}/${assemblePolicy.archiveTokens}/${compressPolicy.density.cjk},${compressPolicy.density.other}`
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
        const renderedPrompt = renderPressurePrompt({ regionText: candidateText, units, priorChain, policy: compressPolicy })
        renderedPromptTokens = estimateTokens(renderedPrompt.prompt, compressPolicy.density)
        const route = resolveJudgeModel(config, readSessionModel(session))
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
        for await (const chunk of streamCeLlm(llm, options, { onUsage: (receipt) => { usage = receipt.usage }, logger })) {
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
            at: now(), layer: 'pressure' as const, promptVersion: COMPRESS_PROMPT_VERSION, policyVersion: COMPRESS_POLICY_VERSION,
            taskId: scopedTaskId, outcome: 'skipped' as const, reason: unavailable ? 'llm-unavailable' : 'llm-error',
            calls: unavailable ? calls : calls + 1, emergency: opts.emergency,
            ...(usage === undefined ? {} : { llmUsage: usage }),
          }), logger)
          return undefined
        }
        calls++
        warnTokenDrift(renderedPromptTokens, usage, logger)
        const parsed = parseCompressProduct(llmText, 'pressure', units)
        if (!parsed.ok) {
          emitCeFact(session, COMPRESS_RUN_FACT_TYPE, compactFact({
            at: now(), layer: 'pressure' as const, promptVersion: COMPRESS_PROMPT_VERSION, policyVersion: COMPRESS_POLICY_VERSION,
            taskId: scopedTaskId, outcome: parsed.reason, calls, emergency: opts.emergency,
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
      const foldText = renderFoldMaterialTranscript(events, { startSeq: foldStartSeq, endSeq: cutSeq - 1 })
      const retainedText = renderRegionTranscript(events, { startSeq: cutSeq, endSeq: taskEndSeq })
      const checkpointText = renderCheckpoint(product.checkpoint)
      const rendered = composePressureArchive({ priorChain, checkpointText, retainedText })
      return {
        product, checkpointText, rendered, cutSeq,
        foldedTokens: estimateTokens(foldText, compressPolicy.density),
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
        at: now(), layer: 'pressure' as const, promptVersion: COMPRESS_PROMPT_VERSION, policyVersion: COMPRESS_POLICY_VERSION,
        taskId: scopedTaskId, outcome: 'skipped' as const, reason: 'shrink', calls, retry,
        foldedTokens: lastFolded, retainedTokens: lastRetained, emergency: opts.emergency,
        ...(usage === undefined ? {} : { llmUsage: usage }),
      }), logger)
      return stop(true)
    }
    if (chosen.cacheHit) counts.cacheHits++

    // 档案 vN：只存检查点文本 C（续传面）；cutPointSeq/rangeEndSeq 供下一次折叠定位（机制 A/B）。
    const entries = await writeStore((body) => {
      const appended = appendArchiveEntry(body, {
        taskId: scopedTaskId, kind: 'checkpoint', text: chosen!.checkpointText, sessionId: sid,
        layer: 'pressure', at: now(), cutPointSeq: chosen!.cutSeq, rangeEndSeq: taskEndSeq,
      }, assemblePolicy)
      return {
        body: chosen!.cacheHit
          ? appended.body
          : putCachedProduct(appended.body, { key, at: now(), layer: 'pressure', product: chosen!.product }),
        entries: appended.kept,
      }
    }, existing?.version, scopedTaskId)
    if (entries === undefined) {
      fire('skip', { reason: 'storage', chainDepth: depth, foldedTokens: chosen.foldedTokens, retainedTokens: chosen.retainedTokens, cutPointSeq: chosen.cutSeq })
      emitCeFact(session, COMPRESS_RUN_FACT_TYPE, compactFact({
        at: now(), layer: 'pressure' as const, promptVersion: COMPRESS_PROMPT_VERSION, policyVersion: COMPRESS_POLICY_VERSION,
        taskId: scopedTaskId, outcome: 'skipped' as const, reason: 'storage', calls: chosen.calls, retry,
        cacheHit: chosen.cacheHit, foldedTokens: chosen.foldedTokens, retainedTokens: chosen.retainedTokens,
        cutPointSeq: chosen.cutSeq, emergency: opts.emergency,
        ...(chosen.usage === undefined ? {} : { llmUsage: chosen.usage }),
      }), logger)
      return stop(true)
    }

    // 事务：open → prune（影子价）→ summary + checkpoint 替换 → close。
    const history = createHistoryPort(session)
    const shadowPrice = deps.getMeter?.()?.heuristicTokensInRange(session, replaceStart, taskEndSeq)
      ?? estimateTokens(renderRegionTranscript(events, { startSeq: replaceStart, endSeq: taskEndSeq }), compressPolicy.density)
    const plan = planTxn({
      txnId: `ce-compact-pressure-${segment.taskId}-${replaceStart}-${taskEndSeq}`,
      layer: 'pressure', taskId: scopedTaskId, range: { start: replaceStart, end: taskEndSeq },
      shadowedTokenCount: shadowPrice, replaceKind: 'checkpoint', turn,
    })
    const txn = runCompactionTxn(history, plan, (h) => {
      h.recordPrune({ start: replaceStart as never, end: taskEndSeq as never, shadowedTokenCount: shadowPrice })
      h.commitCheckpoint({
        compactionId: plan.txnId,
        text: chosen!.rendered,
        summary: chosen!.checkpointText,
        range: { start: replaceStart as never, end: taskEndSeq as never },
        shadowedTokenCount: shadowPrice,
        provider: chosen!.cacheHit ? '' : chosen!.provider,
        model: chosen!.cacheHit ? '' : chosen!.model,
        ...(chosen!.usage === undefined ? {} : { usage: chosen!.usage }),
        ...(chosen!.rawOutput === undefined ? {} : { rawOutput: chosen!.rawOutput }),
      })
    })
    if (!txn.ok) {
      fire('skip', { reason: `txn-${txn.code ?? 'fail'}`, chainDepth: depth, foldedTokens: chosen.foldedTokens, retainedTokens: chosen.retainedTokens, cutPointSeq: chosen.cutSeq })
      emitCeFact(session, COMPRESS_RUN_FACT_TYPE, compactFact({
        at: now(), layer: 'pressure' as const, promptVersion: COMPRESS_PROMPT_VERSION, policyVersion: COMPRESS_POLICY_VERSION,
        taskId: scopedTaskId, outcome: 'skipped' as const, reason: 'txn', calls: chosen.calls, retry,
        cacheHit: chosen.cacheHit, foldedTokens: chosen.foldedTokens, retainedTokens: chosen.retainedTokens,
        cutPointSeq: chosen.cutSeq, emergency: opts.emergency,
        ...(chosen.usage === undefined ? {} : { llmUsage: chosen.usage }),
      }), logger)
      return stop(true)
    }
    counts.compactions++
    fire('fired', { chainDepth: depth, foldedTokens: chosen.foldedTokens, retainedTokens: chosen.retainedTokens, cutPointSeq: chosen.cutSeq })
    emitCeFact(session, COMPRESS_RUN_FACT_TYPE, compactFact({
      at: now(), layer: 'pressure' as const, promptVersion: COMPRESS_PROMPT_VERSION, policyVersion: COMPRESS_POLICY_VERSION,
      taskId: scopedTaskId, outcome: 'ok' as const, calls: chosen.calls, cacheHit: chosen.cacheHit, retry,
      regionTokens: chosen.foldedTokens,
      ...(renderedPromptTokens === undefined ? {} : { promptTokens: renderedPromptTokens }),
      productBytes: new TextEncoder().encode(chosen.rendered).length,
      shadowedTokens: chosen.foldedTokens, productTokens: chosen.productTokens,
      foldedTokens: chosen.foldedTokens, retainedTokens: chosen.retainedTokens, cutPointSeq: chosen.cutSeq,
      carried: priorChain.length, archiveEntries: entries, emergency: opts.emergency,
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
    const guardKey = `${turn}:${step}`
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
    const guardKey = `${payload.turn}:${payload.step}`
    if (emergencyGuard.get(payload.session) === guardKey) return 'pass'
    emergencyGuard.set(payload.session, guardKey)
    if (busy.has(payload.session)) return 'pass'
    busy.add(payload.session)
    try {
      const events = ledgerEventsOf(payload.session)
      const facts = factsFromSessionEvents(events)
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
      const facts = factsFromSessionEvents(events)
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
    dispose() { disposed = true },
    stats: () => ({ ...counts }),
    onPreStep,
    onRequestError,
  }
}

/**
 * P12 自动断面服务（docs/02 §3 / docs/11 §2 domains/input.ts）。
 * 订阅 pump 的 input/user-message 与 facts/session-event，按
 * T0→L1（重复投递护栏）→对表（保守）→LLM→fail-lazy 决策链逐消息处理；卷宗追加、判别事实发射、
 * 按会话分桶/去重。domains 允许 import core + platform；本文件不直接调用会话追加。
 * P14c：L0 延续词表已删除（实测 0.6% 命中，见 docs/implement/archive/P14c §1）；对表改为打分制。
 */
import {
  FAIL_LAZY_JUDGE_DECISION,
  foldJudgeLedger,
  freezeJudgeConfig,
  judgeL1CacheKey,
  matchJudgeTable,
  parseJudgeLlmOutput,
  renderJudgePrompt,
  toJudgeVerdictFactData,
  type JudgeDecision,
  type JudgeRecord,
  type JudgeTable,
  type JudgeTableShadow,
} from '../core/judge.ts'
import { foldSegmentState } from '../core/units.ts'
import { appendDossierMessage, annotateDossier, createDossier, dossierStorageKey, sessionScopedTaskId, type DossierBody, type DossierClass } from '../core/dossier.ts'
import type { LedgerFact } from '../core/ledger/types.ts'
import { parseT0Command } from '../core/t0.ts'
import { workspaceOf } from './workspace.ts'
import { resolveReasoningEffort, streamCeLlm, type CeGenerateOptions } from '../platform/llm.ts'
import { emitCeFact } from '../platform/logger.ts'
import { readSessionModel, type EventPump, type CeDomainEvents, type CeLogger } from '../platform/events.ts'
import type { ContextEconomyStorage } from '../platform/storage.ts'
import { reasoningEffortSetting, type Config as ConfigShape } from '../config.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  JUDGE_ERROR_FACT_TYPE,
  JUDGE_RECORDED_FACT_TYPE,
  JUDGE_VERDICT_FACT_TYPE,
  judgeRecordToFactData,
  type JudgeErrorFactData,
} from './judge-facts.ts'

// 默认判别模型 = 当前主对话模型（2026-09-08 定；可在设置卡覆盖，缺省时优先跟随会话当前模型）。
const DEFAULT_MODEL = { provider: 'deepseek-official', model: 'deepseek-v4.1-flash-expires-on-0910' }
const FACT_BUCKET_LIMIT = 2000
const DEFAULT_CACHE_LIMIT = 1024

export interface AutoDiscriminatorDeps {
  pump: EventPump
  storage: ContextEconomyStorage
  getConfig: () => ConfigShape
  logger: CeLogger
  workspace?: string
  now?: () => number
  cacheLimit?: number
}

/** 边界判词等待上限（F2 阻塞式边界压缩，2026-09-09 用户裁定 60s；超时 fail-lazy）。 */
export const BOUNDARY_JUDGE_WAIT_MS = 60_000

export interface AutoDiscriminator {
  dispose(): void
  stats(): { queued: number; processed: number; facts: number; records: JudgeRecord[]; ledger: ReturnType<typeof foldJudgeLedger> }
  /**
   * 等待 `newestSeq` 这条用户消息的判词落地（有界）。settled = 判词已产出 / 本会话无在飞工作；
   * timeout = 超时（调用侧 fail-lazy 放行，退回"下一 pre-step 再压"）。F2：边界压缩阻塞屏障。
   */
  settle(session: Session, newestSeq: number, timeoutMs: number): Promise<'settled' | 'timeout'>
}

export function resolveJudgeModel(
  config: ConfigShape,
  sessionModel?: { provider: string; model: string },
): { provider: string; model: string } {
  const provider = config.discriminator?.provider?.trim()
  const model = config.discriminator?.model?.trim()
  if (provider && model) return { provider, model }
  if (sessionModel !== undefined) return sessionModel
  return { ...DEFAULT_MODEL }
}

export function readJudgeTable(storage: ContextEconomyStorage, workspace: string): JudgeTable | undefined {
  const key = `optimize_artifact:latest:${workspace}`
  const record = storage.getEntity('optimize_artifact', key)
  const body = record?.body as { judgeTable?: unknown } | undefined
  const table = body?.judgeTable
  if (typeof table !== 'object' || table === null) return undefined
  const t = table as Record<string, unknown>
  if (typeof t.version !== 'number' || t.version < 1) return undefined
  if (!Array.isArray(t.aspects) || !t.aspects.every((x) => typeof x === 'string')) return undefined
  if (!Array.isArray(t.fileSignatures) || !t.fileSignatures.every((x) => typeof x === 'string')) return undefined
  if (!Array.isArray(t.keywords) || !t.keywords.every((x) => typeof x === 'string')) return undefined
  return { version: t.version, aspects: t.aspects as string[], fileSignatures: t.fileSignatures as string[], keywords: t.keywords as string[] }
}

function sidOf(session: Session): string {
  const s = session as unknown as { header?: { id?: unknown }; id?: unknown }
  const header = s.header?.id
  return typeof header === 'string' ? header : String(s.id ?? 'session')
}

export function mountAutoDiscriminator(ctx: Pick<Context, 'llm'>, deps: AutoDiscriminatorDeps): AutoDiscriminator {
  const { pump, storage, getConfig, logger, workspace = process.cwd().replaceAll('\\', '/'), now = Date.now, cacheLimit = DEFAULT_CACHE_LIMIT } = deps
  const factsBySession = new Map<string, LedgerFact[]>()
  const factKeys = new Map<string, Set<string>>()
  const firstSeqBySession = new Map<string, number>()
  const l1Cache = new Map<string, { decision: JudgeDecision; class: DossierClass; tableShadow?: JudgeTableShadow }>()
  const records: JudgeRecord[] = []
  const queue: CeDomainEvents['input/user-message'][] = []
  /** 每会话在飞判词计数（settle 屏障；含排队 + 处理中）。 */
  const pendingBySession = new Map<string, { count: number; waiters: Array<() => void> }>()
  /** 每会话已落地判词的最大用户消息 seq（settle 快速返回判据）。 */
  const lastDoneSeqBySession = new Map<string, number>()
  let disposed = false
  let processing = false
  let processed = 0

  const recordFact = (sid: string, fact: LedgerFact): void => {
    const key = `${fact.type}|${fact.seq ?? ''}|${fact.time}|${JSON.stringify(fact.data)}`
    let keys = factKeys.get(sid)
    if (!keys) factKeys.set(sid, (keys = new Set()))
    if (keys.has(key)) return
    keys.add(key)
    let bucket = factsBySession.get(sid)
    if (!bucket) factsBySession.set(sid, (bucket = []))
    bucket.push(fact)
    if (bucket.length > FACT_BUCKET_LIMIT) bucket.shift()
  }

  const emitRecorded = (session: Session, sid: string, record: JudgeRecord): void => {
    const data = judgeRecordToFactData(record)
    emitCeFact(session, JUDGE_RECORDED_FACT_TYPE, data, logger)
    recordFact(sid, { type: JUDGE_RECORDED_FACT_TYPE, seq: record.seq, time: record.time, data })
    records.push(record)
  }

  const emitError = (session: Session, sid: string, seq: number, time: number, error: { code: string; message: string }): void => {
    const data: JudgeErrorFactData = { seq, time, code: error.code, message: error.message }
    emitCeFact(session, JUDGE_ERROR_FACT_TYPE, data, logger)
    recordFact(sid, { type: JUDGE_ERROR_FACT_TYPE, seq, time, data })
  }

  const readDossier = (taskId: string): { body: DossierBody; version: number | undefined } => {
    const rec = storage.getEntity('dossier', dossierStorageKey(taskId))
    return rec ? { body: rec.body as DossierBody, version: rec.version } : { body: createDossier(taskId), version: undefined }
  }

  const writeDossier = async (taskId: string, body: DossierBody, baseVersion: number | undefined): Promise<boolean> => {
    const key = dossierStorageKey(taskId)
    const source = { taskId, eventType: 'dossier-append', evidence: { seq: body.messages.at(-1)?.seq } }
    try {
      await storage.putEntity('dossier', key, body, source, { baseVersion: baseVersion ?? 0 })
      return true
    } catch {
      const current = storage.getEntity('dossier', key)
      if (current === undefined || current.version === baseVersion) return false
      try {
        await storage.putEntity('dossier', key, body, source, { baseVersion: current.version })
        return true
      } catch {
        return false
      }
    }
  }

  const processOne = async (payload: CeDomainEvents['input/user-message']): Promise<void> => {
    if (getConfig().discriminator.auto !== true) return
    const session = payload.session
    const sid = sidOf(session)
    const { seq, time, text } = payload
    if (!firstSeqBySession.has(sid)) firstSeqBySession.set(sid, seq)
    const sessionFirstSeq = firstSeqBySession.get(sid) ?? seq
    const sessionFacts = factsBySession.get(sid) ?? []
    const segments = foldSegmentState(sessionFacts, { sessionFirstSeq })
    const localTaskId = segments.segments.at(-1)!.taskId
    const taskId = sessionScopedTaskId(sid, localTaskId)
    const { body, version } = readDossier(taskId)
    const message = { seq, time, text }
    const appended = appendDossierMessage(body, message)
    if (appended !== body) await writeDossier(taskId, appended, version)

    const t0 = parseT0Command(text)
    if (t0.boundary !== null) {
      emitRecorded(session, sid, { seq, time, trigger: 't0', decision: 'continue' })
      return
    }
    const { provider, model } = resolveJudgeModel(getConfig(), readSessionModel(session))
    const fingerprint = freezeJudgeConfig({ provider, model, auto: true })
    const cacheKey = judgeL1CacheKey({ sessionId: sid, seq, text, configFingerprint: fingerprint })
    // L1 = 重复投递护栏（P14c §1）：键含 seq，跨消息永不命中，只防同一消息被重复处理/计费。
    const cached = l1Cache.get(cacheKey)
    if (cached !== undefined) {
      emitRecorded(session, sid, {
        seq, time, trigger: 'l1-cache', decision: cached.decision, class: cached.class,
        ...(cached.tableShadow === undefined ? {} : { tableShadow: cached.tableShadow }),
      })
      return
    }

    // 对表 = 影子记账（P14c §2 修订）：**只算不拦**——命中照常走 LLM，只记录"机械本会怎么判"。
    // 唯一允许不调模型就下结论的是 T0（用户显式宣告）与 L1（重放同一条消息的既有裁决）；
    // 任何"用特征猜意图"的短路都会带来无声漏边界，故对表层不参与决策。
    // F3：优化产物表按会话工作区取键。
    const table = readJudgeTable(storage, workspaceOf(session, workspace))
    const tableMatch = matchJudgeTable(text, table)

    const rendered = renderJudgePrompt(appended, { seq, text })
    let llmText = ''
    let llmUsage: JudgeRecord['llmUsage']
    let latencyMs: number | undefined
    const started = now()
    // P14f：推理档来自设置（discriminator.reasoningEffort）；缺省 = 跟随模型默认（不覆盖）。
    // 关闭思考会明显影响边界判断，故不默认强制；用户显式选择才传，且只传模型声明支持的档。
    const desiredEffort = reasoningEffortSetting(getConfig())
    const sentEffort = desiredEffort === undefined
      ? undefined
      : await resolveReasoningEffort(ctx, provider, model, desiredEffort, logger)
    const options: CeGenerateOptions = {
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: rendered.prompt }], source: { kind: 'user' }, id: 'judge' }] as never,
      purpose: 'context-economy-judge',
      temperature: 0,
      ...(sentEffort === undefined ? {} : { reasoningEffort: sentEffort }),
    }
    for await (const chunk of streamCeLlm(ctx, options, {
      onUsage: (receipt) => { llmUsage = receipt.usage },
      logger,
    })) {
      if (chunk.type === 'text-delta') llmText += chunk.text
      if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') {
        throw new Error('context-economy: non-stop finish')
      }
    }
    latencyMs = now() - started
    const parsed = parseJudgeLlmOutput(llmText)
    if (parsed === null) throw new Error('context-economy: bad judge output')
    const record: JudgeRecord = {
      seq, time, trigger: 'llm', decision: parsed.decision, class: parsed.class,
      ctxTokens: rendered.ctxTokens, latencyMs,
    }
    if (llmUsage !== undefined) record.llmUsage = llmUsage
    if (desiredEffort !== undefined) record.requestedEffort = desiredEffort
    if (sentEffort !== undefined) record.sentEffort = sentEffort
    if (tableMatch.hit) record.tableShadow = { hit: true, score: tableMatch.score }
    l1Cache.set(cacheKey, {
      decision: parsed.decision, class: parsed.class,
      ...(record.tableShadow === undefined ? {} : { tableShadow: record.tableShadow }),
    })
    if (l1Cache.size > cacheLimit) l1Cache.delete(l1Cache.keys().next().value!)
    if (appended !== body && parsed.class !== undefined) {
      const annotated = annotateDossier(appended, seq, parsed.class, 'auto', time)
      if (annotated !== appended) await writeDossier(taskId, annotated, storage.getEntity('dossier', dossierStorageKey(taskId))?.version)
    }
    if (parsed.decision === 'new-task') {
      const data = toJudgeVerdictFactData(parsed.decision, seq)
      emitCeFact(session, JUDGE_VERDICT_FACT_TYPE, data, logger)
      recordFact(sid, { type: JUDGE_VERDICT_FACT_TYPE, seq, time, data })
    }
    emitRecorded(session, sid, record)
  }

  const trackEnqueue = (sid: string): void => {
    let entry = pendingBySession.get(sid)
    if (entry === undefined) pendingBySession.set(sid, (entry = { count: 0, waiters: [] }))
    entry.count++
  }
  const trackSettled = (sid: string, seq: number): void => {
    const done = lastDoneSeqBySession.get(sid)
    if (done === undefined || seq > done) lastDoneSeqBySession.set(sid, seq)
    const entry = pendingBySession.get(sid)
    if (entry === undefined) return
    entry.count--
    if (entry.count > 0) return
    pendingBySession.delete(sid)
    for (const wake of entry.waiters.splice(0)) wake()
  }
  /**
   * 边界压缩阻塞屏障（F2）：等到 `newestSeq` 的判词落地才放行 pre-step，
   * 使 task 闭合 → 压缩发生在**新任务第一条模型调用之前**。
   * 先让两个 microtask 通过——pump 用 `queueMicrotask` 派发，同一提交周期内到达的
   * 用户消息要等它入队后才可见（否则屏障空转）。
   */
  const settle = async (session: Session, newestSeq: number, timeoutMs: number): Promise<'settled' | 'timeout'> => {
    const sid = sidOf(session)
    await Promise.resolve()
    await Promise.resolve()
    if ((lastDoneSeqBySession.get(sid) ?? -1) >= newestSeq) return 'settled'
    const entry = pendingBySession.get(sid)
    if (entry === undefined || entry.count <= 0) return 'settled'
    return new Promise<'settled' | 'timeout'>((resolve) => {
      let done = false
      const timer = setTimeout(() => { if (done) return; done = true; resolve('timeout') }, Math.max(0, timeoutMs))
      entry.waiters.push(() => { if (done) return; done = true; clearTimeout(timer); resolve('settled') })
    })
  }

  const drain = async (): Promise<void> => {
    if (processing || disposed) return
    processing = true
    try {
      while (queue.length > 0 && !disposed) {
        const payload = queue.shift()!
        const sid = sidOf(payload.session)
        try {
          if (getConfig().discriminator.auto !== true) continue
          processed++
          try {
            await processOne(payload)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            const code = e instanceof Error && 'code' in e ? String((e as { code?: unknown }).code) : 'CE_JUDGE_FAIL'
            emitError(payload.session, sidOf(payload.session), payload.seq, payload.time, { code, message: msg })
            emitRecorded(payload.session, sidOf(payload.session), {
              seq: payload.seq, time: payload.time, trigger: 'error-fallback', decision: FAIL_LAZY_JUDGE_DECISION,
              error: { code, message: msg },
            })
          }
        } finally {
          trackSettled(sid, payload.seq)
        }
      }
    } finally {
      processing = false
    }
  }

  const offInput = pump.on('input/user-message', (payload) => {
    if (disposed) return
    trackEnqueue(sidOf(payload.session))
    queue.push(payload)
    void drain()
  })
  const offFacts = pump.on('facts/session-event', ({ session, event }) => {
    if (disposed || getConfig().discriminator.auto !== true) return
    recordFact(sidOf(session), { type: event.type, seq: event.seq, time: event.time, data: event.data })
  })

  return {
    dispose() {
      disposed = true
      queue.length = 0
      for (const entry of pendingBySession.values()) for (const wake of entry.waiters.splice(0)) wake()
      pendingBySession.clear()
      offInput()
      offFacts()
    },
    settle,
    stats() {
      let facts = 0
      for (const bucket of factsBySession.values()) facts += bucket.length
      return { queued: queue.length, processed, facts, records: [...records], ledger: foldJudgeLedger(records) }
    },
  }
}

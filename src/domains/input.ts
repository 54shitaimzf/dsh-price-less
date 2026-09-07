/**
 * P12 自动断面服务（docs/02 §3 / docs/11 §2 domains/input.ts）。
 * 订阅 pump 的 input/user-message 与 facts/session-event，按
 * T0→L0→L1→对表→LLM→fail-lazy 决策链逐消息处理；卷宗追加、判别事实发射、
 * 按会话分桶/去重。domains 允许 import core + platform；本文件不直接调用会话追加。
 */
import {
  FAIL_LAZY_JUDGE_DECISION,
  foldJudgeLedger,
  freezeJudgeConfig,
  judgeL1CacheKey,
  matchJudgeTable,
  matchL0Continue,
  parseJudgeLlmOutput,
  renderJudgePrompt,
  toJudgeVerdictFactData,
  type JudgeDecision,
  type JudgeRecord,
  type JudgeTable,
} from '../core/judge.ts'
import { foldSegmentState } from '../core/units.ts'
import { appendDossierMessage, annotateDossier, createDossier, dossierStorageKey, sessionScopedTaskId, type DossierBody, type DossierClass } from '../core/dossier.ts'
import type { LedgerFact } from '../core/ledger/types.ts'
import { parseT0Command } from '../core/t0.ts'
import { streamCeLlm, type CeGenerateOptions } from '../platform/llm.ts'
import { emitCeFact } from '../platform/logger.ts'
import type { EventPump, CeDomainEvents, CeLogger } from '../platform/events.ts'
import type { ContextEconomyStorage } from '../platform/storage.ts'
import type { Config as ConfigShape } from '../config.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  JUDGE_ERROR_FACT_TYPE,
  JUDGE_RECORDED_FACT_TYPE,
  JUDGE_VERDICT_FACT_TYPE,
  judgeRecordToFactData,
  type JudgeErrorFactData,
} from './judge-facts.ts'

const DEFAULT_MODEL = { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' }
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

export interface AutoDiscriminator {
  dispose(): void
  stats(): { queued: number; processed: number; facts: number; records: JudgeRecord[]; ledger: ReturnType<typeof foldJudgeLedger> }
}

export function resolveJudgeModel(config: ConfigShape): { provider: string; model: string } {
  const provider = config.discriminator?.provider?.trim()
  const model = config.discriminator?.model?.trim()
  if (provider && model) return { provider, model }
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
  const l1Cache = new Map<string, { decision: JudgeDecision; class: DossierClass }>()
  const records: JudgeRecord[] = []
  const queue: CeDomainEvents['input/user-message'][] = []
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
    if (matchL0Continue(text)) {
      emitRecorded(session, sid, { seq, time, trigger: 'l0-continue', decision: 'continue' })
      return
    }

    const { provider, model } = resolveJudgeModel(getConfig())
    const fingerprint = freezeJudgeConfig({ provider, model, auto: true })
    const cacheKey = judgeL1CacheKey({ sessionId: sid, seq, text, configFingerprint: fingerprint })
    const cached = l1Cache.get(cacheKey)
    if (cached !== undefined) {
      emitRecorded(session, sid, { seq, time, trigger: 'l1-cache', decision: cached.decision, class: cached.class })
      return
    }

    const table = readJudgeTable(storage, workspace)
    if (matchJudgeTable(text, table).hit) {
      emitRecorded(session, sid, { seq, time, trigger: 'table', decision: 'continue' })
      return
    }

    const rendered = renderJudgePrompt(appended, { seq, text })
    let llmText = ''
    let llmUsage: JudgeRecord['llmUsage']
    let latencyMs: number | undefined
    const started = now()
    const options: CeGenerateOptions = {
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: rendered.prompt }], source: { kind: 'user' }, id: 'judge' }] as never,
      purpose: 'context-economy-judge',
      temperature: 0,
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
    l1Cache.set(cacheKey, { decision: parsed.decision, class: parsed.class })
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

  const drain = async (): Promise<void> => {
    if (processing || disposed) return
    processing = true
    try {
      while (queue.length > 0 && !disposed) {
        const payload = queue.shift()!
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
      }
    } finally {
      processing = false
    }
  }

  const offInput = pump.on('input/user-message', (payload) => {
    if (disposed) return
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
      offInput()
      offFacts()
    },
    stats() {
      let facts = 0
      for (const bucket of factsBySession.values()) facts += bucket.length
      return { queued: queue.length, processed, facts, records: [...records], ledger: foldJudgeLedger(records) }
    },
  }
}

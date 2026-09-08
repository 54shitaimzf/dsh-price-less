/**
 * 星标断面 host 编排（P14b1；docs/02 §4 / docs/09 §2 / docs/10 §4 时序 B / docs/11 §2）。
 * 装配输入栈 → H12 断面 → 双通道解析 → 预览态 → 用户确认后回填 + 产物落盘 + 两相事实。
 * domains 允许 import core + platform；零 harness 运行时 import；fail-lazy（失败零写盘）。
 *
 * 模块: domains 星标断面服务（host 半边）
 * 平面: L1 编排（确定性规则 + 单次模型断面 + 机械闸）
 * 回退链步数: 2（卷宗太短 → 跳过产品层只回填裁决；任何失败 → 稳定错误码 + 零写盘）
 * 审查清单: 不改 P11 纯核；不执行剪切（P15b）；不写会话历史（只经 emitCeFact）；apply 顺序 = 卷宗 → 产物；用户编辑即终稿。
 * 度量: 两相 optimize-run（docs/07 §0.5 断面族）；foldOptimizeRunFacts 回放口径。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  checkAuthoritySpans, extractAuthorityCandidates, isTrivialOptimizePrompt, parseOptimizeOutput, renderOptimizePrompt,
  type OptimizeParseResult, type OptimizeVerdict,
} from '../core/optimize.ts'
import { backfillDossier, dossierStorageKey, isTrivialMessage, sessionScopedTaskId, type DossierBody } from '../core/dossier.ts'
import { projectFrameStorageKey, type ProjectFrameBody } from '../core/prefix.ts'
import { foldSegmentState } from '../core/units.ts'
import { factsFromSessionEvents } from '../core/ledger/facts.ts'
import type { LedgerFact, LedgerSessionEvent } from '../core/ledger/types.ts'
import { estimateTokens } from '../core/ledger/fold.ts'
import { streamCeLlm, type CeGenerateOptions, type CeLlmUsage } from '../platform/llm.ts'
import { emitCeFact } from '../platform/logger.ts'
import { listSkillCatalog } from '../platform/skills.ts'
import type { ContextEconomyStorage } from '../platform/storage.ts'
import { readSessionModel, readSessionUserMessages, type CeLogger } from '../platform/events.ts'
import { STAR_BRIDGE_CODES, STAR_PREVIEW_LIMIT, type StarBridgeOutcome } from '../platform/star-bridge.ts'
import type { Config as ConfigShape } from '../config.ts'
import { resolveJudgeModel } from './input.ts'
import { OPTIMIZE_RUN_FACT_TYPE, appliedRunFact, previewRunFact, type OptimizeRunFactData } from './optimize-facts.ts'

/** 行式裁决 UI 视图（与 client/star/star-types.ts 同构但独立声明——两侧不得互相 import）。 */
export interface StarVerdictView { readonly kind: string; readonly summary: string }
export interface StarMissingAuthority { readonly index: number; readonly text: string }
export interface StarPreviewDto {
  readonly previewId: string; readonly originalPrompt: string; readonly product: string | null
  readonly verdicts: readonly StarVerdictView[]; readonly missingAuthority: readonly StarMissingAuthority[]
  readonly droppedLines: number; readonly ctxTokens: number; readonly historyCount: number
}

export const STAR_VERDICT_SUMMARY_MAX_CHARS = 120

/** 八种 kind 的行文（长度钳制到 STAR_VERDICT_SUMMARY_MAX_CHARS）。 */
export function summarizeVerdict(verdict: OptimizeVerdict): StarVerdictView {
  let summary = ''
  switch (verdict.kind) {
    case 'class': summary = `消息 #${verdict.seq} 标注为 ${verdict.class}`; break
    case 'boundary': summary = `消息 #${verdict.seq} 为任务边界`; break
    case 'shear': summary = `剪切 #${verdict.startSeq}..#${verdict.endSeq}：${verdict.note}`; break
    case 'skill': summary = `引用技能 ${verdict.name}`; break
    case 'keep': summary = `保留权威段 #${verdict.spanIndex}`; break
    case 'aspect': summary = `方面：${verdict.text}`; break
    case 'file': summary = `文件签名：${verdict.signature}`; break
    case 'keyword': summary = `关键词：${verdict.keyword}`; break
  }
  const summary2 = summary.length > STAR_VERDICT_SUMMARY_MAX_CHARS ? `${summary.slice(0, STAR_VERDICT_SUMMARY_MAX_CHARS - 1)}…` : summary
  return { kind: verdict.kind, summary: summary2 }
}

export function buildPreviewDto(input: {
  previewId: string; originalPrompt: string; product: string | null; verdicts: readonly OptimizeVerdict[]
  missingAuthority: readonly StarMissingAuthority[]; droppedLines: number; ctxTokens: number; historyCount: number
}): StarPreviewDto {
  return {
    previewId: input.previewId, originalPrompt: input.originalPrompt, product: input.product,
    verdicts: input.verdicts.map(summarizeVerdict),
    missingAuthority: input.missingAuthority.map((item) => ({ index: item.index, text: item.text })),
    droppedLines: input.droppedLines, ctxTokens: input.ctxTokens, historyCount: input.historyCount,
  }
}

/** 优化产物形状（docs/09 §2；必须被 domains/input.ts:readJudgeTable 接受）。 */
export interface OptimizeArtifactBody {
  judgeTable: { version: number; aspects: string[]; fileSignatures: string[]; keywords: string[] }
  product: string | null; verdicts: StarVerdictView[]
  shear: Array<{ startSeq: number; endSeq: number; note: string }>; keptSpanIndexes: number[]
  taskId: string; sessionId: string; previewId: string; appliedAt: number
}

export function buildArtifactBody(input: {
  parsed: OptimizeParseResult; product: string | null; previewId: string; taskId: string; sessionId: string
  appliedAt: number; previousVersion?: number
}): OptimizeArtifactBody {
  const { parsed } = input
  return {
    judgeTable: {
      version: (input.previousVersion ?? 0) + 1, aspects: [...parsed.judgeTable.aspects],
      fileSignatures: [...parsed.judgeTable.fileSignatures], keywords: [...parsed.judgeTable.keywords],
    },
    product: input.product, verdicts: parsed.verdicts.map(summarizeVerdict),
    shear: parsed.shearItems.map((item) => ({ ...item })), keptSpanIndexes: [...parsed.keptSpanIndexes],
    taskId: input.taskId, sessionId: input.sessionId, previewId: input.previewId, appliedAt: input.appliedAt,
  }
}

export interface StarHostDeps {
  storage: ContextEconomyStorage; getConfig: () => ConfigShape; logger: CeLogger
  workspace?: string; now?: () => number
  skillsCtx?: Pick<Context, 'skills' | 'logger'>; llmCtx?: Pick<Context, 'llm'>
  resolveSession?: (id: string) => Session | undefined; emitFact?: (session: Session, type: string, data: unknown, logger?: CeLogger) => void
}

export interface StarHostStats {
  previews: number; applies: number; reapplies: number; pending: number
  llmFailures: number; parseFailures: number; storageFailures: number
}

export interface StarHost {
  preview(input: { sessionId: string; prompt: string }): Promise<StarBridgeOutcome<StarPreviewDto>>
  apply(input: { sessionId: string; previewId: string; editedProduct: string }): Promise<StarBridgeOutcome<{ text?: string }>>
  stats(): StarHostStats
  dispose(): void
}

interface PendingPreview { sessionId: string; session: Session; taskId: string; dossier: DossierBody; parsed: OptimizeParseResult; applied: boolean }

/** 会话 id 结构读取（与 commands/input 同口径；domains 不 import 运行期 harness）。 */
export function readSessionId(session: { header?: { id?: unknown }; id?: unknown }): string {
  const header = session.header?.id
  return typeof header === 'string' ? header : String(session.id ?? 'session')
}

function shearTokensOf(dossier: DossierBody, items: readonly { startSeq: number; endSeq: number }[]): number {
  let text = ''
  for (const item of items) for (const message of dossier.messages) {
    if (message.seq >= item.startSeq && message.seq <= item.endSeq) text += `${message.text}\n`
  }
  return estimateTokens(text)
}

/** 命令形态结果文本（/optimize-prompt = 预览，不写盘——P14b1 §0.5）。 */
export function renderPreviewCommandText(dto: StarPreviewDto): string {
  return [
    '断面预览（未写入任何状态）',
    dto.product === null ? '（模型未产出产品，仅回填裁决）' : dto.product,
    `裁决 ${dto.verdicts.length} 条 / 丢弃行 ${dto.droppedLines} / 输入栈 ${dto.ctxTokens} tokens / 历史消息 ${dto.historyCount} 条 / 缺失权威段 ${dto.missingAuthority.length} 条`,
    ...dto.verdicts.slice(0, 10).map((verdict) => `- ${verdict.kind}: ${verdict.summary}`),
  ].join('\n')
}

export function mountStarHost(deps: StarHostDeps): StarHost {
  const { storage, getConfig, logger, workspace = process.cwd().replaceAll('\\', '/'), now = Date.now } = deps
  const pending = new Map<string, PendingPreview>()
  const counters = { previews: 0, applies: 0, reapplies: 0, llmFailures: 0, parseFailures: 0, storageFailures: 0 }
  let seq = 0
  const emit = deps.emitFact ?? ((session: Session, type: string, data: unknown, log?: CeLogger) => emitCeFact(session, type as never, data as never, log))
  const emitRun = (session: Session, data: OptimizeRunFactData): void => { emit(session, OPTIMIZE_RUN_FACT_TYPE, data, logger) }
  const readFacts = (session: Session): LedgerFact[] => factsFromSessionEvents(((session as unknown as { snapshotEvents?: () => readonly LedgerSessionEvent[] }).snapshotEvents?.() ?? []) as LedgerSessionEvent[])

  const preview = async (input: { sessionId: string; prompt: string }): Promise<StarBridgeOutcome<StarPreviewDto>> => {
    const session = deps.resolveSession?.(input.sessionId)
    if (session === undefined) return { ok: false, code: STAR_BRIDGE_CODES.noSession, message: '会话不存在或未激活' }
    // P14c §3 唯一门控：本次提示词极短 → 零调用短路（不计数、不写盘、不发事实）。
    if (isTrivialOptimizePrompt(input.prompt)) {
      return {
        ok: false, code: STAR_BRIDGE_CODES.badRequest,
        message: '提示词过短（去标点后不足 4 字），没有可优化的内容',
      }
    }
    counters.previews++
    const at = now()
    const segment = foldSegmentState(readFacts(session)).segments.at(-1)!
    const taskId = sessionScopedTaskId(input.sessionId, segment.taskId)
    // P14c §4：task 内用户消息直接读会话事件（与 auto 开关无关，挂载/重启不丢历史）；
    // KV 卷宗只提供既有标注，不再充当消息来源。
    const dossierRecord = storage.getEntity('dossier', dossierStorageKey(taskId))
    const stored = dossierRecord?.body as DossierBody | undefined
    const messages = readSessionUserMessages(session)
      .filter((message) => (segment.startSeq === null || message.seq >= segment.startSeq) && !isTrivialMessage(message.text))
    const dossier: DossierBody = { taskId, messages, annotations: stored?.annotations ?? {} }
    const frameRecord = storage.getEntity('project_frame', projectFrameStorageKey(workspace))
    const catalog = deps.skillsCtx === undefined ? undefined : await listSkillCatalog(deps.skillsCtx)
    const rendered = renderOptimizePrompt({
      projectFrame: frameRecord?.body as ProjectFrameBody | undefined, dossier, prompt: input.prompt, catalog,
    })
    const previewId = `${input.sessionId}#${segment.taskId}#${dossierRecord?.version ?? 0}#${++seq}`
    const candidates = extractAuthorityCandidates(input.prompt)
    let parsed: OptimizeParseResult | undefined
    let usage: CeLlmUsage | undefined
    let latencyMs = 0
    let errorCode: string | undefined
    if (deps.llmCtx === undefined) errorCode = STAR_BRIDGE_CODES.llmFailed
    else {
      const { provider, model } = resolveJudgeModel(getConfig(), readSessionModel(session))
      const startedAt = now()
      const options: CeGenerateOptions = {
        provider, model, purpose: 'context-economy-optimize', temperature: 0,
        messages: [{ role: 'user', content: [{ type: 'text', text: rendered.prompt }], source: { kind: 'user' }, id: 'optimize' }] as never,
      }
      let raw = ''
      let stopped = false
      for await (const chunk of streamCeLlm(deps.llmCtx, options, { logger, onUsage: (receipt) => { usage = receipt.usage } })) {
        if (chunk.type === 'text-delta') raw += chunk.text
        if (chunk.type === 'finish') stopped = chunk.reason.kind === 'stop'
      }
      latencyMs = now() - startedAt
      if (!stopped) errorCode = STAR_BRIDGE_CODES.llmFailed
      else {
        parsed = parseOptimizeOutput(raw, dossier, catalog, candidates)
        if (parsed.product === null && parsed.verdicts.length === 0) errorCode = STAR_BRIDGE_CODES.parseFailed
      }
    }
    const product = parsed === undefined ? null : parsed.product
    const missingAuthority = checkAuthoritySpans(product ?? '', candidates, parsed?.keptSpanIndexes ?? [])
      .missing.map((candidate) => ({ index: candidate.index, text: candidate.text }))
    emitRun(session, previewRunFact({ previewId, taskId, sessionId: input.sessionId, at }, {
      // short 保留为账本字段，P14c 语义修订为「无历史素材」（= historyCount === 0）。
      short: rendered.historyCount === 0, historyCount: rendered.historyCount,
      ctxTokens: rendered.ctxTokens, productChars: product?.length ?? 0,
      verdictCount: parsed?.verdicts.length ?? 0, droppedLines: parsed?.droppedLines ?? 0,
      keptSpanCount: parsed?.keptSpanIndexes.length ?? 0, missingAuthorityCount: missingAuthority.length,
      shearPairs: parsed?.shearItems.length ?? 0, shearTokens: parsed === undefined ? 0 : shearTokensOf(dossier, parsed.shearItems),
      latencyMs, llmUsage: usage, errorCode,
    }))
    if (errorCode === STAR_BRIDGE_CODES.llmFailed) {
      counters.llmFailures++
      return { ok: false, code: errorCode, message: deps.llmCtx === undefined ? 'LLM 服务不可用' : '断面调用未正常结束' }
    }
    if (errorCode === STAR_BRIDGE_CODES.parseFailed) {
      counters.parseFailures++
      return { ok: false, code: errorCode, message: '断面输出无法解析（无产品且无裁决）' }
    }
    const dto = buildPreviewDto({
      previewId, originalPrompt: input.prompt, product, verdicts: parsed!.verdicts, missingAuthority,
      droppedLines: parsed!.droppedLines, ctxTokens: rendered.ctxTokens, historyCount: rendered.historyCount,
    })
    if (pending.size >= STAR_PREVIEW_LIMIT) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) pending.delete(oldest)
    }
    pending.set(previewId, { sessionId: input.sessionId, session, taskId, dossier, parsed: parsed!, applied: false })
    return { ok: true, value: dto }
  }

  const apply = async (input: {
    sessionId: string; previewId: string; editedProduct: string
  }): Promise<StarBridgeOutcome<{ text?: string }>> => {
    const item = pending.get(input.previewId)
    if (item === undefined || item.sessionId !== input.sessionId) {
      return { ok: false, code: STAR_BRIDGE_CODES.unknownPreview, message: '预览不存在或与当前会话不匹配' }
    }
    if (item.applied) {
      counters.reapplies++
      return { ok: true, value: { text: '已应用（重复提交，未重复写入）' } }
    }
    counters.applies++
    const at = now()
    const dossierKey = dossierStorageKey(item.taskId)
    const currentRecord = storage.getEntity('dossier', dossierKey)
    const current = currentRecord === undefined ? item.dossier : currentRecord.body as DossierBody
    const backfill = backfillDossier(current, { verdicts: item.parsed.backfillVerdicts, at })
    const backfillCount = Object.keys(item.parsed.backfillVerdicts).length
    try {
      await storage.putEntity('dossier', dossierKey, backfill.body, {
        taskId: item.taskId, eventType: 'optimize-backfill',
        evidence: { previewId: input.previewId, count: backfillCount, conflicts: backfill.conflicts },
      }, { baseVersion: currentRecord?.version ?? 0 })
    } catch (e) {
      counters.storageFailures++
      logger.warn('context-economy: optimize dossier backfill failed (contained, fail-lazy)', e instanceof Error ? e.message : String(e))
      return { ok: false, code: STAR_BRIDGE_CODES.storageFailed, message: '卷宗回填写入失败' }
    }
    const artifactKey = `optimize_artifact:latest:${workspace}`
    const previous = storage.getEntity('optimize_artifact', artifactKey)
    const body = buildArtifactBody({
      parsed: item.parsed, product: input.editedProduct, previewId: input.previewId, taskId: item.taskId,
      sessionId: item.sessionId, appliedAt: at,
      previousVersion: (previous?.body as { judgeTable?: { version?: number } } | undefined)?.judgeTable?.version,
    })
    try {
      await storage.putEntity('optimize_artifact', artifactKey, body, {
        taskId: item.taskId, eventType: 'optimize-artifact',
        evidence: { previewId: input.previewId, version: body.judgeTable.version },
      }, { baseVersion: previous?.version ?? 0 })
    } catch (e) {
      counters.storageFailures++
      logger.warn('context-economy: optimize artifact write failed (contained, fail-lazy)', e instanceof Error ? e.message : String(e))
      return { ok: false, code: STAR_BRIDGE_CODES.storageFailed, message: '优化产物写入失败' }
    }
    item.applied = true
    emitRun(item.session, appliedRunFact({ previewId: input.previewId, taskId: item.taskId, sessionId: item.sessionId, at }, {
      backfillCount, backfillConflicts: backfill.conflicts,
      shearPairs: item.parsed.shearItems.length, shearTokens: shearTokensOf(current, item.parsed.shearItems),
    }))
    return { ok: true, value: { text: `已应用（回填 ${backfillCount} 条，冲突 ${backfill.conflicts} 条）` } }
  }

  return { preview, apply, stats: () => ({ ...counters, pending: pending.size }), dispose: () => { pending.clear() } }
}

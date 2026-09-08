/**
 * 剪切账本 fold（docs/07 §0.5 剪切族；docs/03 §6；P15b 工具半边 + P16 对话半边）。
 * 纯函数：同输入同账；输入 = 原始事件序（append 语义）+ context-economy/shear-* 事实。
 * `shearDecision` 来自重跑 foldToolShear + foldRunShear（本会怎么判）；`cut*`/`tableRepair` 来自已发射事实（实际落刀）——分列不混算。
 * P16：`cutEvents.question` / `questionBacklogDepth` / `cutMisfireDetected` 由重折 run 状态机得出；`thinkingCutTokens` 显式 0（N5）。
 *
 * 模块: core 剪切账本 fold（零 harness/platform import）
 * 平面: L0（确定性重放；无模型、无 IO）
 * 回退链步数: 0（纯计算）
 * 审查清单: 不 import harness/platform（S1）；无时钟/随机（D10）；不写事实、不改史、不读盘。
 * 度量: 本文件即剪切族账本 fold（07 回放管道消费面）。
 */
import type { LedgerFact, LedgerSessionEvent } from '../ledger/types.ts'
import { estimateTokens, extractTextFromToolResult } from '../ledger/fold.ts'
import { foldSurfaceNodes } from '../ledger/surface.ts'
import { DEFAULT_SHEAR_POLICY, type ShearEvent, type ShearPolicy, type ShearToolCategory } from './types.ts'
import { foldToolShear, pathOfCall, toolCategory, type FoldToolShearOptions } from './tool.ts'
import { DEFAULT_RUN_POLICY, foldRunShear, RUN_CLASS_FACT_TYPE, type RunEvent, type RunPolicy } from './run.ts'
import { foldNegotiation, formatNegotiationLedger, type NegotiationLedger } from './negotiate.ts'

export const SHEAR_APPLIED_FACT_TYPE = 'context-economy/shear-applied' // ignorable
export const SHEAR_DECISION_FACT_TYPE = 'context-economy/shear-decision' // ignorable
export const SHEAR_ERROR_FACT_TYPE = 'context-economy/shear-error' // ignorable
/** 星标剪切清单事实（P16；星标 = 用户明确动作 = 吸收证明，清单来自断面行记录）。 */
export const SHEAR_RUN_PLAN_FACT_TYPE = 'context-economy/shear-run-plan' // ignorable

export type ShearAppliedKind = 'shape-entry' | 'stub-replace' | 'note-cut' | 't0-supersede' | 't0r-repair' | 'run-flush' | 't-boundary'
export type ShearAppliedTier = 'T-entry' | 'T-loop' | 'T-note' | 'T0' | 'T0-R' | 'run' | 'T-boundary'

/** 每次落刀一条（cut 相；失败不落此事实，落 shear-error）。 */
export interface ShearAppliedFactData {
  readonly policyVersion: number
  readonly tier: ShearAppliedTier
  readonly kind: ShearAppliedKind
  readonly callId: string
  readonly resultSeq: number
  readonly at: number
  readonly path?: string
  readonly version?: number
  readonly category: ShearToolCategory
  readonly beforeTokens: number
  readonly afterTokens: number
  readonly savedTokens: number
  readonly breakTokens: number
  readonly tailNodes: number
  readonly segments?: number
  readonly windowLines?: number
  readonly repairCoverage?: number
  // —— P16 对话半边（kind = 'run-flush' 时在位） ——
  readonly startSeq?: number
  readonly endSeq?: number
  readonly runPairs?: number
  readonly runClass?: string
  readonly conclusionTier?: string
}

/** 星标剪切清单载荷（P16；选坐标不造坐标：坐标与结论都来自断面行记录）。 */
export interface ShearRunPlanFactData {
  readonly at: number
  readonly source: 'star'
  readonly items: readonly { readonly startSeq: number; readonly endSeq: number; readonly note: string }[]
  /** 断面 CLASS 行回填的三分类（= 判别器手动断面产出，run 状态机的分类输入之一）。 */
  readonly classes?: readonly { readonly anchorSeq: number; readonly class: string }[]
}

/** hold / note-attached 相（keep 不发射，由重算 fold 得出）。 */
export interface ShearDecisionFactData {
  readonly policyVersion: number
  readonly tier: ShearAppliedTier
  readonly decision: 'hold' | 'note-attached'
  readonly reason: string
  readonly callId?: string
  /** 对话 run 半边（tier = 'run'）的裁决键：<startSeq>..<endSeq>。 */
  readonly runKey?: string
  readonly at: number
  readonly noteBytes?: number
}

/** 执行失败（零重试；op 键已消费）。 */
export interface ShearErrorFactData {
  readonly at: number
  readonly opKey: string
  readonly tier?: string
  readonly code: string
  readonly message: string
}

export interface ShearLedger {
  cutEvents: { question: number; tool: number }
  cutTokensSaved: number
  cutBreakCost: number
  cutMisfireDetected: number
  questionBacklogDepth: number
  toolPruneByClass: Record<ShearToolCategory, number>
  /** 挂出的注记数 = 历史 T-note 事实 + N3 协商注记事实（两代通道不重叠）。 */
  shearNoteAttached: number
  shearDecision: { cut: number; hold: number; keep: number }
  /** N3 协商族（docs/implement/N3-shadow-mode.md §4；fold 见 core/shear/negotiate.ts）。 */
  negotiation: NegotiationLedger
  thinkingCutTokens: number
  tableRepair: { count: number; tokens: number }
  repairCoverage: number
  rereadAfterRepair: number
  rerunAfterCut: number
}

function emptyLedger(): ShearLedger {
  return {
    cutEvents: { question: 0, tool: 0 },
    cutTokensSaved: 0,
    cutBreakCost: 0,
    cutMisfireDetected: 0,
    questionBacklogDepth: 0,
    toolPruneByClass: { read: 0, write: 0, search: 0, cmd: 0, other: 0 },
    shearNoteAttached: 0,
    shearDecision: { cut: 0, hold: 0, keep: 0 },
    negotiation: foldNegotiation([]),
    thinkingCutTokens: 0,
    tableRepair: { count: 0, tokens: 0 },
    repairCoverage: 0,
    rereadAfterRepair: 0,
    rerunAfterCut: 0,
  }
}

/** 表面 fold（通用回放工具，P17b 上移 core/ledger/surface.ts；此处 re-export 保持剪切面导出不变）。 */
export { foldSurfaceNodes } from '../ledger/surface.ts'

/** 事件模型可见文本（tool/result | assistant/message | user/message）。 */
export function ledgerEventText(event: LedgerSessionEvent): string {
  const data = event.data as Record<string, unknown> | undefined
  if (event.type === 'tool/result') return extractTextFromToolResult(data)
  const message = (data?.message ?? data) as { content?: unknown } | undefined
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

/** 剪点（节点）之后存活表面的 token 估算——一次性断裂重价（docs/03 §1 / docs/07 §3）。 */
export function surfaceTailTokens(events: readonly LedgerSessionEvent[], nodeSeq: number): number {
  const nodes = foldSurfaceNodes(events)
  const index = nodes.indexOf(nodeSeq)
  if (index < 0) return 0
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  let tokens = 0
  for (const seq of nodes.slice(index + 1)) {
    const event = bySeq.get(seq)
    if (event !== undefined) tokens += estimateTokens(ledgerEventText(event))
  }
  return tokens
}

function appliedFacts(facts: readonly LedgerFact[]): ShearAppliedFactData[] {
  const out: ShearAppliedFactData[] = []
  for (const fact of facts) {
    if (fact.type !== SHEAR_APPLIED_FACT_TYPE) continue
    if (typeof fact.data === 'object' && fact.data !== null) out.push(fact.data as ShearAppliedFactData)
  }
  return out
}

/**
 * 剪切族账本 fold：事实（实际落刀）+ 事件序（裁决分布与误伤信号重算）。
 * @param events 会话事件序（含 surfaceOp；replace 事件不参与纯核重折，只参与表面 fold）。
 * @param facts context-economy/shear-* 事实（会话 ignorable 事件或 KV 镜像，同口径）。
 * @param policy 工具策略阈值（默认 docs/03 §8 初值）。
 * @param runPolicy 对话 run 策略阈值（默认 docs/03 §8 初值）。
 */
export function foldShearLedger(
  events: readonly LedgerSessionEvent[],
  facts: readonly LedgerFact[],
  policy: ShearPolicy = DEFAULT_SHEAR_POLICY,
  runPolicy: RunPolicy = DEFAULT_RUN_POLICY,
): ShearLedger {
  const ledger = emptyLedger()
  const original = events.filter((event) => {
    const op = (event as { surfaceOp?: unknown }).surfaceOp
    return typeof op !== 'object' || op === null
  })
  const applied = appliedFacts(facts)
  const entryShaped = new Set(applied.filter((fact) => fact.kind === 'shape-entry').map((fact) => fact.callId))

  const shearEvents: ShearEvent[] = []
  for (const event of original) {
    const data = (event.data ?? {}) as Record<string, unknown>
    if (event.type === 'tool/call') {
      shearEvents.push({ kind: 'tool-call', call: { seq: event.seq, time: event.time, callId: String(data.callId ?? ''), name: String(data.name ?? ''), argsText: String(data.arguments ?? '') } })
    } else if (event.type === 'tool/result') {
      const block = ((data.message ?? data) as { content?: unknown }).content
      const first = Array.isArray(block) && block.length > 0 ? (block[0] as { toolCallId?: unknown }) : undefined
      shearEvents.push({ kind: 'tool-result', result: { seq: event.seq, time: event.time, callId: String(first?.toolCallId ?? ''), text: extractTextFromToolResult(data) } })
    } else if (event.type === 'assistant/message' || event.type === 'user/message') {
      shearEvents.push({ kind: event.type === 'assistant/message' ? 'assistant-message' : 'user-message', seq: event.seq, time: event.time, text: ledgerEventText(event) })
    }
  }

  const options: FoldToolShearOptions = { entryShaped }
  const plan = foldToolShear(shearEvents, policy, options)
  for (const decision of plan.decisions) ledger.shearDecision[decision.decision]++

  const callsById = new Map<string, { name: string; argsText: string; seq: number }>()
  const calls: Array<{ name: string; argsText: string; seq: number }> = []
  for (const event of shearEvents) {
    if (event.kind !== 'tool-call') continue
    callsById.set(event.call.callId, { name: event.call.name, argsText: event.call.argsText, seq: event.call.seq })
    calls.push({ name: event.call.name, argsText: event.call.argsText, seq: event.call.seq })
  }

  let repairLines = 0
  let windowLines = 0
  for (const fact of applied) {
    if (fact.kind === 'run-flush') {
      ledger.cutEvents.question++
      ledger.cutTokensSaved += fact.savedTokens
      ledger.cutBreakCost += fact.breakTokens
      continue
    }
    ledger.cutEvents.tool++
    ledger.cutTokensSaved += fact.savedTokens
    ledger.cutBreakCost += fact.breakTokens
    ledger.toolPruneByClass[fact.category] = (ledger.toolPruneByClass[fact.category] ?? 0) + 1
    if (fact.kind === 't0r-repair') {
      ledger.tableRepair.count++
      ledger.tableRepair.tokens += fact.savedTokens
      if (typeof fact.segments === 'number') repairLines += fact.segments
      if (typeof fact.windowLines === 'number') windowLines += fact.windowLines
      if (fact.path !== undefined) {
        for (const call of calls) {
          if (call.seq <= fact.resultSeq) continue
          if (call.name !== 'read') continue
          if (pathOfCall({ seq: call.seq, time: 0, callId: '', name: call.name, argsText: call.argsText }) === fact.path) { ledger.rereadAfterRepair++; break }
        }
      }
    }
    // rerunAfterCut = 命令类剪除后重跑同名同参（误伤信号）；read 类重读归 rereadAfterRepair，不重复计。
    const origin = fact.category === 'cmd' ? callsById.get(fact.callId) : undefined
    if (origin !== undefined) {
      const rerun = calls.some((call) => call.seq > fact.resultSeq && call.name === origin.name && call.argsText === origin.argsText)
      if (rerun) ledger.rerunAfterCut++
    }
  }
  ledger.repairCoverage = windowLines === 0 ? 0 : repairLines / windowLines

  for (const fact of facts) {
    if (fact.type !== SHEAR_DECISION_FACT_TYPE) continue
    const data = fact.data as ShearDecisionFactData
    if (data.decision === 'note-attached') ledger.shearNoteAttached++
  }
  // N3 协商族（只记账不剪的账本半边；注记数并入 shearNoteAttached 保持 07 口径连续）。
  ledger.negotiation = foldNegotiation(facts)
  ledger.shearNoteAttached += ledger.negotiation.notes

  // —— P16 对话半边：重折 run 状态机（分类读 judge-recorded 事实，清单读 shear-run-plan 事实） ——
  const runEvents: RunEvent[] = []
  for (const event of original) {
    if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
      const kind = event.type === 'user/message' ? 'user-message' : event.type === 'assistant/message' ? 'assistant-message' : 'tool-result'
      runEvents.push({ kind, seq: event.seq, time: event.time, text: ledgerEventText(event) })
    }
  }
  for (const fact of facts) {
    const data = (fact.data ?? {}) as Record<string, unknown>
    if (fact.type === RUN_CLASS_FACT_TYPE) {
      const anchorSeq = Number(data.seq)
      if (!Number.isInteger(anchorSeq) || anchorSeq < 0) continue
      const decision = data.decision === 'new-task' ? 'new-task' : 'continue'
      const klass = data.class
      runEvents.push({
        kind: 'verdict', seq: fact.seq ?? fact.time, time: fact.time, anchorSeq, decision,
        ...(klass === 'action' || klass === 'pureQ' || klass === 'verifyQ' ? { klass } : {}),
      })
    } else if (fact.type === SHEAR_RUN_PLAN_FACT_TYPE) {
      const items = Array.isArray(data.items) ? (data.items as { startSeq?: unknown; endSeq?: unknown; note?: unknown }[]) : []
      const parsedItems = items
        .filter((item) => Number.isInteger(item.startSeq) && Number.isInteger(item.endSeq) && typeof item.note === 'string')
        .map((item) => ({ startSeq: Number(item.startSeq), endSeq: Number(item.endSeq), note: String(item.note) }))
      const at = fact.seq ?? fact.time
      if (parsedItems.length > 0) runEvents.push({ kind: 'star-plan', seq: at, time: fact.time, items: parsedItems })
      const classes = Array.isArray(data.classes) ? (data.classes as { anchorSeq?: unknown; class?: unknown }[]) : []
      for (const entry of classes) {
        if (!Number.isInteger(entry.anchorSeq) || Number(entry.anchorSeq) < 0) continue
        if (entry.class !== 'action' && entry.class !== 'pureQ' && entry.class !== 'verifyQ') continue
        runEvents.push({
          kind: 'verdict', seq: at, time: fact.time, anchorSeq: Number(entry.anchorSeq),
          decision: 'continue', klass: entry.class,
        })
      }
    }
  }
  const runPlan = foldRunShear(runEvents, runPolicy)
  for (const record of runPlan.records) ledger.shearDecision[record.decision]++
  ledger.questionBacklogDepth = runPlan.backlogDepth
  const salientByRun = new Map<string, readonly string[]>()
  for (const record of runPlan.records) {
    if (record.decision === 'cut') salientByRun.set(`${record.startSeq}..${record.endSeq}`, record.salient)
  }
  const userTexts = runEvents.filter((event) => event.kind === 'user-message') as Extract<RunEvent, { kind: 'user-message' }>[]
  for (const fact of applied) {
    if (fact.kind !== 'run-flush' || fact.startSeq === undefined || fact.endSeq === undefined) continue
    const salient = salientByRun.get(`${fact.startSeq}..${fact.endSeq}`) ?? []
    if (salient.length === 0) continue
    // 误剪信号 = 剪后用户又提到被剪内容（重问/重读；指纹可检出，不静默）。
    const misfire = userTexts.some((user) => user.seq > (fact.endSeq as number) && salient.some((token) => user.text.toLowerCase().includes(token)))
    if (misfire) ledger.cutMisfireDetected++
  }
  return ledger
}

/** 07 §6 报表模板的剪切段（纯字符串，无时间戳）。 */
export function formatShearLedger(ledger: ShearLedger): string {
  const lines: string[] = ['剪切：']
  lines.push(`  cutEvents: question=${ledger.cutEvents.question} tool=${ledger.cutEvents.tool}`)
  lines.push(`  cutTokensSaved: ${ledger.cutTokensSaved}`)
  lines.push(`  cutBreakCost: ${ledger.cutBreakCost}`)
  lines.push(`  toolPruneByClass: read=${ledger.toolPruneByClass.read} write=${ledger.toolPruneByClass.write} search=${ledger.toolPruneByClass.search} cmd=${ledger.toolPruneByClass.cmd} other=${ledger.toolPruneByClass.other}`)
  lines.push(`  shearNoteAttached: ${ledger.shearNoteAttached}`)
  lines.push(`  shearDecision: cut=${ledger.shearDecision.cut} hold=${ledger.shearDecision.hold} keep=${ledger.shearDecision.keep}`)
  lines.push(`  tableRepair: count=${ledger.tableRepair.count} tokens=${ledger.tableRepair.tokens} coverage=${ledger.repairCoverage}`)
  lines.push(`  rereadAfterRepair: ${ledger.rereadAfterRepair} / rerunAfterCut: ${ledger.rerunAfterCut}`)
  lines.push(`  cutMisfireDetected: ${ledger.cutMisfireDetected} / questionBacklogDepth: ${ledger.questionBacklogDepth} / thinkingCutTokens: ${ledger.thinkingCutTokens}`)
  lines.push(formatNegotiationLedger(ledger.negotiation))
  return lines.join('\n')
}

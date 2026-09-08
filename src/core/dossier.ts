/**
 * 卷宗纯核（docs/02 §2 / docs/09 §2 / docs/11 §2 core/dossier.ts）。
 * 纯函数：task 内用户消息原文 append-only 累积 + 三分类标注 + 回填终审 + 边界清空。
 * core 零 harness/platform import；不抛错，防御性 no-op。
 */
import { estimateTokens } from './ledger/fold.ts'

export const DOSSIER_CLASSES = ['action', 'pureQ', 'verifyQ'] as const
export type DossierClass = (typeof DOSSIER_CLASSES)[number]
export type DossierAnnotationBy = 'auto' | 'backfill'

export interface DossierMessage {
  seq: number
  time: number
  text: string
}

export interface DossierAnnotation {
  class: DossierClass
  by: DossierAnnotationBy
  at: number
}

export interface DossierBody {
  taskId: string
  messages: DossierMessage[]
  annotations: Record<string, DossierAnnotation[]>
}

export interface DossierBackfill {
  verdicts: Partial<Record<number, DossierClass>>
  at: number
}

export interface DossierBackfillResult {
  body: DossierBody
  conflicts: number
}

export interface DossierGate {
  minMessages: number
  minTextLength: number
}

export interface DossierLedger {
  messageCount: number
  textLength: number
  ctxTokens: number
  annotationCounts: Record<DossierClass, number>
}

export function dossierStorageKey(taskId: string): string {
  return `dossier:${taskId}`
}

/** 会话级 taskId 作用域（docs/09 §2 / P9 工单 §2.4-5）：同一 workspace 多会话共用
 * storage domain 时，调用方须先经本函数把单会话 fold 的 `task-<n>` 限定到会话，
 * 再交给 `dossierStorageKey`，避免不同会话的 task-1/task-2 相互覆盖。 */
export function sessionScopedTaskId(sessionId: string, taskId: string): string {
  return `${sessionId}:${taskId}`
}

export function createDossier(taskId: string): DossierBody {
  return { taskId, messages: [], annotations: {} }
}

// —— 极短消息判据（P14c） ——
/** 去噪后短于该长度的消息视为「极短/无实质内容」，不进 task 用户消息上下文。 */
export const TRIVIAL_MESSAGE_MAX_CHARS = 4

const MESSAGE_NOISE_RE = /[\s\u3000！？。，、；：""''（）《》【】!?.,;:()\[\]{}~\-—_…]/gu

/** 去噪归一（空白/标点剥离 + 小写）：判据与展示共用，避免两处口径漂移。 */
export function normalizeMessageText(text: string): string {
  return text.replace(MESSAGE_NOISE_RE, '').toLowerCase()
}

/**
 * 极短/无实质内容消息（去噪后长度 < {@link TRIVIAL_MESSAGE_MAX_CHARS}）。
 * 用途仅限两处：① 不进 task 用户消息上下文（★ 组装与卷宗追加同口径）；
 * ② ★ 按钮禁用判据。**不参与任务边界判定**——边界是语义判断，交 LLM 主路径。
 */
export function isTrivialMessage(text: string): boolean {
  return normalizeMessageText(text).length < TRIVIAL_MESSAGE_MAX_CHARS
}

/**
 * 追加一条 task 内用户消息（append-only 全量；docs/09 §2）。
 * 极短消息过滤只作用于 ★ 的上下文组装（P14c §4），不改变卷宗追加口径。
 */
export function appendDossierMessage(body: DossierBody, message: DossierMessage): DossierBody {
  if (message.text === '') return body
  const last = body.messages.at(-1)
  if (last !== undefined && message.seq <= last.seq) return body
  return {
    ...body,
    messages: [...body.messages, message],
    annotations: { ...body.annotations },
  }
}

export function annotateDossier(
  body: DossierBody,
  seq: number,
  verdict: DossierClass,
  by: DossierAnnotationBy,
  at: number,
): DossierBody {
  if (!body.messages.some((m) => m.seq === seq)) return body
  const key = String(seq)
  const existing = body.annotations[key] ?? []
  if (existing.some((a) => a.class === verdict && a.by === by)) return body
  return {
    ...body,
    annotations: {
      ...body.annotations,
      [key]: [...existing, { class: verdict, by, at }],
    },
  }
}

export function backfillDossier(body: DossierBody, backfill: DossierBackfill): DossierBackfillResult {
  const messageSeqs = new Set(body.messages.map((m) => m.seq))
  const entries = Object.entries(backfill.verdicts).filter(
    ([seq]) => messageSeqs.has(Number(seq)),
  ) as Array<[string, DossierClass]>
  if (entries.length === 0) return { body, conflicts: 0 }

  let conflicts = 0
  const annotations = { ...body.annotations }
  for (const [seqKey, klass] of entries) {
    const seq = Number(seqKey)
    const existing = body.annotations[seqKey] ?? []
    let lastAuto: DossierAnnotation | undefined
    for (let i = existing.length - 1; i >= 0; i--) {
      if (existing[i]!.by === 'auto') {
        lastAuto = existing[i]
        break
      }
    }
    if (lastAuto !== undefined && lastAuto.class !== klass) conflicts++
    annotations[seqKey] = [{ class: klass, by: 'backfill', at: backfill.at }]
  }
  return {
    body: { ...body, annotations },
    conflicts,
  }
}

export function foldDossierLedger(body: DossierBody): DossierLedger {
  const annotationCounts: Record<DossierClass, number> = { action: 0, pureQ: 0, verifyQ: 0 }
  let textLength = 0
  for (const message of body.messages) {
    textLength += message.text.length
    const annotations = body.annotations[String(message.seq)]
    const last = annotations?.at(-1)
    if (last !== undefined) annotationCounts[last.class]++
  }
  const ctxTokens = estimateTokens(body.messages.map((m) => m.text).join('\n'))
  return {
    messageCount: body.messages.length,
    textLength,
    ctxTokens,
    annotationCounts,
  }
}

export function isDossierShort(body: DossierBody, gate: DossierGate): boolean {
  const textLength = body.messages.reduce((sum, m) => sum + m.text.length, 0)
  return body.messages.length < gate.minMessages || textLength < gate.minTextLength
}

/**
 * N3 协商剪除纯核（docs/implement/N3-shadow-mode.md §3/§4；docs/03 §2.1）。
 * 三态门控 + N1 分类器选样 + 1% 确定性对照组 + 回复判定 + 账本 fold。
 * 只做判定与聚合：不挂注记（执行归 domains/shear.ts）、不改史、不发事实。
 *
 * 模块: core 纯核（零 harness/platform import；无时钟、无随机、无 IO）
 * 平面: L0（确定性规则：分类器复用 + FNV-1a 采样 + 三件套解析）
 * 回退链步数: 0（失败方向由调用方统一处理：无标记 / 缺件 / 保真不过 → 一律 hold）
 * 审查清单: 不 import harness/platform（S1）；无 Date/Math.random（D10）；不改史、不发事实
 * 度量: foldNegotiation = 07 协商族账本（notes/replies/三档率/保真率/深度中位数）
 */
import type { LedgerFact } from '../ledger/types.ts'
import { CUT_REASON, classifyToolResult, type CutBasis, type CutReason, type ToolDescriptor } from './classify.ts'
import { judgeConclusion, type ConclusionMarker } from './conclusion.ts'

/** 协商通道三态：off = 零行为；shadow = 只记账不剪；live = 保留给 N4（当前与 shadow 等价）。 */
export type NegotiationMode = 'off' | 'shadow' | 'live'
export const NEGOTIATION_MODES: readonly NegotiationMode[] = ['off', 'shadow', 'live']
export const DEFAULT_NEGOTIATION_MODE: NegotiationMode = 'off'

export function isNegotiationMode(value: unknown): value is NegotiationMode {
  return typeof value === 'string' && (NEGOTIATION_MODES as readonly string[]).includes(value)
}

/** 对照组通道标记：control 只问不剪（N4 白名单永不收录）。 */
export type NegotiationChannel = 'note' | 'control'
/** 对照组采样分母：100 桶取 1 = 1%。 */
export const CONTROL_GROUP_MODULUS = 100
export const CONTROL_GROUP_SLOT = 0
/** 待答注记队列上限：超出按最老先记 no-reply（防无界增长；失败方向 = 保留）。 */
export const NEGOTIATION_PENDING_LIMIT = 64

/**
 * FNV-1a 折叠到 100 桶（与 scripts/probe-n1.mjs 同源；确定性、可回放、禁运行期随机）。
 * @param key - 采样键（callId；回放同输入同桶）。
 * @returns 0..99。
 */
export function controlSlot(key: string): number {
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash % CONTROL_GROUP_MODULUS
}

/** 选样结果：挂注记的通道与判据证据（basis/reason 进账本）。 */
export interface NegotiationSelection {
  readonly channel: NegotiationChannel
  readonly basis: CutBasis
  readonly reason: CutReason
}

/**
 * 选样：cuttable（任意 basis）→ note；never 且 ≥ 候选下限 → 1% 确定性对照组；
 * 低于候选下限（too-small）→ 不挂（省下无收益的注记成本）。
 * @param desc - 工具结果描述符（原文字节/形态判据）。
 * @param key - 对照组采样键（callId）。
 */
export function selectNegotiation(desc: ToolDescriptor, key: string): NegotiationSelection | undefined {
  const decision = classifyToolResult(desc)
  if (decision.reason === CUT_REASON.TOO_SMALL) return undefined
  if (decision.verdict === 'cuttable') {
    return { channel: 'note', basis: decision.basis, reason: decision.reason }
  }
  if (controlSlot(key) !== CONTROL_GROUP_SLOT) return undefined
  return { channel: 'control', basis: decision.basis, reason: decision.reason }
}

export const SHEAR_NEGOTIATION_NOTE_FACT_TYPE = 'context-economy/shear-negotiation-note' // ignorable
export const SHEAR_NEGOTIATION_REPLY_FACT_TYPE = 'context-economy/shear-negotiation-reply' // ignorable

/** 挂注记（只记账不剪；resultSeq 由结果事件结算时补齐）。 */
export interface ShearNegotiationNoteFactData {
  readonly at: number
  readonly callId: string
  readonly name: string
  readonly resultSeq: number
  readonly basis: CutBasis
  readonly reason: CutReason
  /** 被协商文本（模型实际看到的版本）的 UTF-8 字节数；N4 收益分母。 */
  readonly resultBytes: number
  readonly channel: NegotiationChannel
  readonly noteBytes: number
  readonly templateVersion: number
  /** W2(B)：注记是否真的写进模型可见正文（shadow = false 只观察；缺省 = true 兼容历史事实）。 */
  readonly attached?: boolean
}

/** 回复判定（每条注记恰好结算一次：ok / hold / none）。 */
export interface ShearNegotiationReplyFactData {
  readonly at: number
  readonly callId: string
  readonly resultSeq: number
  readonly replySeq: number
  readonly basis: CutBasis
  readonly marker: ConclusionMarker
  readonly complete: boolean
  readonly verifyOk: boolean
  readonly missingCount: number
  readonly conclusionChars: number
  /** 深度比 = 结论字符数 / 被协商字节数（目标 ≤ 1/10；none/hold = 0）。 */
  readonly depthRatio: number
}

/** 回复判定纯函数（解析 + 保真校验 + 深度比）；只读，不抛错。 */
export function judgeNegotiationReply(
  negotiatedText: string,
  replyText: string,
  resultBytes: number,
): Omit<ShearNegotiationReplyFactData, 'at' | 'callId' | 'resultSeq' | 'replySeq' | 'basis'> {
  const { parsed, verify } = judgeConclusion(negotiatedText, replyText)
  const conclusionChars = parsed.conclusion?.length ?? 0
  return {
    marker: parsed.marker,
    complete: parsed.complete,
    verifyOk: verify.ok,
    missingCount: verify.missing.length,
    conclusionChars,
    depthRatio: resultBytes <= 0 ? 0 : conclusionChars / resultBytes,
  }
}

export interface NegotiationLedger {
  /** 选样注记数（含 shadow 未写正文的观察样本）。 */
  notes: number
  /** W2(B)：真的写进正文的注记数（率的分母）。 */
  attachedNotes: number
  notesByBasis: Record<string, number>
  controlNotes: number
  /** 已结算的回复数（ok + hold + noReply；每条注记恰好一条）。 */
  replies: number
  ok: number
  hold: number
  noReply: number
  /** 三件套齐全数（marker = ok 且结论/事实/重取齐全）。 */
  complete: number
  /** 保真通过数（原文关键事实全部出现）。 */
  verifyOk: number
  okRate: number
  holdRate: number
  noReplyRate: number
  /** complete / ok（三件套齐全率）。 */
  completeRate: number
  /** verifyOk / ok（保真率）。 */
  verifyOkRate: number
  medianDepth: number
  medianDepthByBasis: Record<string, number>
}

function emptyNegotiationLedger(): NegotiationLedger {
  return {
    notes: 0,
    attachedNotes: 0,
    notesByBasis: {},
    controlNotes: 0,
    replies: 0,
    ok: 0,
    hold: 0,
    noReply: 0,
    complete: 0,
    verifyOk: 0,
    okRate: 0,
    holdRate: 0,
    noReplyRate: 0,
    completeRate: 0,
    verifyOkRate: 0,
    medianDepth: 0,
    medianDepthByBasis: {},
  }
}

function ratio(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round((part / whole) * 10000) / 10000
}

/** 中位数（偶数取两中位均值）；确定性、不 mutate 输入。 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const value = sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
  return Math.round(value * 10000) / 10000
}

/**
 * 协商族账本 fold（07 §0.5 协商族）：纯函数，同输入同账。
 * 率的分母 = notes（每条注记必有一条回复事实）；completeRate/verifyOkRate 分母 = ok。
 */
export function foldNegotiation(facts: readonly LedgerFact[]): NegotiationLedger {
  const ledger = emptyNegotiationLedger()
  const depths: number[] = []
  const depthsByBasis: Record<string, number[]> = {}
  for (const fact of facts) {
    if (fact.type === SHEAR_NEGOTIATION_NOTE_FACT_TYPE) {
      const data = fact.data as ShearNegotiationNoteFactData | undefined
      if (data == null || typeof data.basis !== 'string') continue
      ledger.notes++
      if (data.attached !== false) ledger.attachedNotes++
      ledger.notesByBasis[data.basis] = (ledger.notesByBasis[data.basis] ?? 0) + 1
      if (data.channel === 'control') ledger.controlNotes++
      continue
    }
    if (fact.type !== SHEAR_NEGOTIATION_REPLY_FACT_TYPE) continue
    const data = fact.data as ShearNegotiationReplyFactData | undefined
    if (data == null || typeof data.marker !== 'string') continue
    ledger.replies++
    if (data.marker === 'ok') {
      ledger.ok++
      if (data.complete === true) ledger.complete++
      if (data.verifyOk === true) ledger.verifyOk++
      if (typeof data.depthRatio === 'number' && data.depthRatio > 0) {
        depths.push(data.depthRatio)
        const basis = typeof data.basis === 'string' ? data.basis : 'none'
        const list = depthsByBasis[basis] ?? []
        list.push(data.depthRatio)
        depthsByBasis[basis] = list
      }
    } else if (data.marker === 'hold') {
      ledger.hold++
    } else {
      ledger.noReply++
    }
  }
  ledger.okRate = ratio(ledger.ok, ledger.attachedNotes)
  ledger.holdRate = ratio(ledger.hold, ledger.attachedNotes)
  ledger.noReplyRate = ratio(ledger.noReply, ledger.attachedNotes)
  ledger.completeRate = ratio(ledger.complete, ledger.ok)
  ledger.verifyOkRate = ratio(ledger.verifyOk, ledger.ok)
  ledger.medianDepth = median(depths)
  for (const [basis, list] of Object.entries(depthsByBasis)) ledger.medianDepthByBasis[basis] = median(list)
  return ledger
}

/** 协商族账本段（纯字符串，无时间戳；附在剪切报表之后）。 */
export function formatNegotiationLedger(ledger: NegotiationLedger): string {
  const lines: string[] = ['协商剪除：']
  const bases = Object.entries(ledger.notesByBasis).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([basis, n]) => `${basis}=${n}`).join(' ')
  lines.push(`  notes: ${ledger.notes}${bases === '' ? '' : ` (${bases})`} / control=${ledger.controlNotes} / attached=${ledger.attachedNotes}`)
  lines.push(`  replies: ${ledger.replies} ok=${ledger.ok} hold=${ledger.hold} noReply=${ledger.noReply}`)
  lines.push(`  rates: ok=${ledger.okRate} hold=${ledger.holdRate} noReply=${ledger.noReplyRate}`)
  lines.push(`  completeRate: ${ledger.completeRate} / verifyOkRate: ${ledger.verifyOkRate}`)
  const depths = Object.entries(ledger.medianDepthByBasis).sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([basis, value]) => `${basis}=${value}`).join(' ')
  lines.push(`  medianDepth: ${ledger.medianDepth}${depths === '' ? '' : ` (${depths})`}`)
  return lines.join('\n')
}

/**
 * 共享压缩事务原语（docs/04 §1；P17a）。边界/压力两路径共用同一顺序契约：
 * open → prune（原区间影子计价）→ replace（同区间遮蔽）→ close；单事务持锁、ID 幂等、失败带 error 收尾。
 * **中性词汇**：`compaction/*` 事件名与配对平衡守卫锁在 `platform/history.ts`（D7），
 * 本层只描述顺序与不变量，执行器见 `domains/assemble.ts` 的 `runCompactionTxn`。
 *
 * 模块: core 边界装配纯核（共享事务原语）
 * 平面: L0（顺序校验 + 状态 fold；零 IO、零模型）
 * 回退链步数: 1（顺序违例 = 拒绝执行，调用方保留原文）
 * 审查清单: 不 import harness/platform（S1）；不出现 compaction/* 协议字面（D7）；无时钟随机（D12）。
 * 度量: 无 07 字段（prune 影子价由 platform/history.ts 落事件）。
 */
import type { LineRange } from './types.ts'

export const TXN_POLICY_VERSION = 1

/**
 * 本插件事务 ID 的**唯一前缀**（U16）。存在理由不是美观：并行的 provider（harness 原生
 * compaction-basic）也用同一份日志里的未闭合标记当锁，**自愈闭合只允许碰自家残留**——
 * 闭合别人的在途事务会让对方随后的收尾成为无主标记，撞上 harness 的压缩不变式。
 * 判据可判定：本插件事务的 open→body→close 是**全同步临界区**（无 await），故执行到自愈分支时
 * 自家不可能真有在途事务，带此前缀的未闭合标记必为自家残留。
 */
export const CE_TXN_ID_PREFIX = 'ce-compact-'

/** 本插件压缩事务 ID（层 + 任务 + 目标区间；边界/压力两路径共用此唯一构造点）。 */
export function ceTxnId(layer: TxnLayer, taskId: string, start: number, end: number): string {
  return `${CE_TXN_ID_PREFIX}${layer}-${taskId}-${start}-${end}`
}

/** 压缩层（生产/消费不对称律；层名只用于账本归因，不影响原语语义）。 */
export type TxnLayer = 'boundary' | 'pressure'

export type TxnStepKind = 'open' | 'replace' | 'prune' | 'close'

/** 事务步骤（surface 区间 = 会话序；shadowedTokenCount = 影子计价原料）。 */
export interface TxnStep {
  readonly kind: TxnStepKind
  readonly range?: LineRange
  readonly shadowedTokenCount?: number
  readonly replaceKind?: 'digest' | 'checkpoint' | 'stub'
  readonly error?: string
}

/** 事务计划（`turn: null` = 独立事务；幂等键 = 层 + 任务 + 目标区间）。 */
export interface TxnPlan {
  readonly version: number
  readonly txnId: string
  readonly layer: TxnLayer
  /** 事务属主轮：打开轮内触发必须传当前轮号（harness 不变式）；null = 轮间独立事务。 */
  readonly turn: number | null
  readonly steps: readonly TxnStep[]
  readonly idempotenceKey: string
}

export interface TxnPlanInput {
  readonly txnId: string
  readonly layer: TxnLayer
  readonly taskId: string
  /** 被折叠的 surface 区间（会话序）。 */
  readonly range: LineRange
  readonly shadowedTokenCount: number
  readonly replaceKind: 'digest' | 'checkpoint' | 'stub'
  /** 事务属主轮（缺省 null = 轮间独立事务；H2 pre-step 触发须传当前轮）。 */
  readonly turn?: number | null
  /** 收尾错误（失败路径仍闭合事务，绝不留下半开标记）。 */
  readonly error?: string
}

/** 计划事务（顺序固定；调用方只负责执行，不再自行编排顺序）。 */
export function planTxn(input: TxnPlanInput): TxnPlan {
  // prune 必须在 replace 之前：影子计价引用的是**被遮蔽的原区间**（替换后区间已不在表面）。
  const steps: TxnStep[] = [
    { kind: 'open' },
    { kind: 'prune', range: input.range, shadowedTokenCount: input.shadowedTokenCount },
    { kind: 'replace', range: input.range, replaceKind: input.replaceKind },
    input.error === undefined ? { kind: 'close' } : { kind: 'close', error: input.error },
  ]
  return {
    version: TXN_POLICY_VERSION,
    txnId: input.txnId,
    layer: input.layer,
    turn: input.turn ?? null,
    steps,
    idempotenceKey: `${input.layer}|${input.taskId}|${input.range.start}..${input.range.end}`,
  }
}

/** 事务标记（open/close 相；平台侧映射为会话日志的事务标记对，见 platform/history.ts）。 */
export interface TxnMarker {
  readonly phase: 'open' | 'close'
  readonly txnId: string
  readonly turn: number | null
  readonly error?: string
}

export interface TxnFoldState {
  readonly active?: { readonly txnId: string; readonly turn: number | null }
  readonly completed: number
  readonly mismatched: number
}

/** fold 标记序：未闭合 / ID 不匹配可见（重启后仍可从日志发现）。 */
export function foldTxnMarkers(markers: readonly TxnMarker[]): TxnFoldState {
  let active: { txnId: string; turn: number | null } | undefined
  let completed = 0
  let mismatched = 0
  for (const marker of markers) {
    if (marker.phase === 'open') {
      if (active !== undefined) mismatched++
      active = { txnId: marker.txnId, turn: marker.turn }
      continue
    }
    if (active === undefined) { mismatched++; continue }
    if (active.txnId !== marker.txnId) { mismatched++; continue }
    active = undefined
    completed++
  }
  return { ...(active === undefined ? {} : { active }), completed, mismatched }
}

/**
 * 顺序校验：open 首、close 尾且各恰一次；prune 先于 replace、同区间（prune 引用被遮蔽原区间）。
 */
export function txnOrderValid(steps: readonly TxnStep[]): boolean {
  if (steps.length < 4) return false
  if (steps[0]?.kind !== 'open' || steps[steps.length - 1]?.kind !== 'close') return false
  let opens = 0
  let closes = 0
  let replaceIndex = -1
  let pruneIndex = -1
  let replace: TxnStep | undefined
  let prune: TxnStep | undefined
  for (let i = 1; i < steps.length - 1; i++) {
    const step = steps[i] as TxnStep
    if (step.kind === 'open') opens++
    else if (step.kind === 'close') closes++
    else if (step.kind === 'replace') { replace = step; replaceIndex = i }
    else if (step.kind === 'prune') { prune = step; pruneIndex = i }
  }
  if (opens !== 0 || closes !== 0) return false
  if (replace === undefined || prune === undefined) return false
  if (pruneIndex >= replaceIndex) return false
  const a = replace.range
  const b = prune.range
  if (a === undefined || b === undefined) return false
  return a.start === b.start && a.end === b.end
}

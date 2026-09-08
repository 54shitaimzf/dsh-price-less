/**
 * 工具剪切纯核：类型与策略初值（docs/03 §2 / docs/11 §2 core/shear/ 行；P15a）。
 * 本地重声明，零 harness/platform import；纯数据契约，无副作用。
 * 平面: L0｜回退链步数: 0（失败语义在 tool/t0r，一律默认保留）｜度量: 阈值初值集中于此（docs/03 §8）
 * 审查清单: 不 import harness/platform（S1）；不写 KV/日志/事实；不改史（执行归 P15b）。
 */

/** 时机档（档 = 时机，时机即经济学；docs/03 §2 表）。 */
export type ShearTier = 'T-entry' | 'T-note' | 'T-boundary'
/** 裁决族：四档时机 + T0/T0-R 两条机械规则（docs/03 §2.2）。 */
export type ShearDecisionTier = ShearTier | 'T0' | 'T0-R'
/** 准入裁决：cut = 落 op；hold = 保留原文待边界搭车；keep = 不动刀。 */
export type ShearDecision = 'cut' | 'hold' | 'keep'
/** 重推导成本档：不可重推导（expensive）一律不许剪。 */
export type RederiveCost = 'trivial' | 'cheap' | 'expensive'
export type ShearToolCategory = 'read' | 'write' | 'search' | 'cmd' | 'other'

export interface ShearToolCall {
  readonly seq: number
  readonly time: number
  readonly callId: string
  readonly name: string
  readonly argsText: string
}
export interface ShearToolResult {
  readonly seq: number
  readonly time: number
  readonly callId: string
  readonly text: string
}
/** 纯核输入事件（会话序；调用 / 结果 / 叙述 / 用户消息）。 */
export type ShearEvent =
  | { readonly kind: 'tool-call'; readonly call: ShearToolCall }
  | { readonly kind: 'tool-result'; readonly result: ShearToolResult }
  | { readonly kind: 'assistant-message'; readonly seq: number; readonly time: number; readonly text: string }
  | { readonly kind: 'user-message'; readonly seq: number; readonly time: number; readonly text: string }

export interface ShearRepairSegment {
  readonly startLine: number
  readonly endLine: number
  readonly lines: readonly string[]
}
/** 产物（T-entry 整形 / T0 整剪 / T0-R 修复）；T-note 协商（§71）与 T-loop 思考后截断（§72）均已退役。 */
export type ShearOp =
  | { readonly kind: 'shape-entry'; readonly callId: string; readonly content: string }
  | { readonly kind: 't0-supersede'; readonly callId: string; readonly writeCallId: string; readonly path: string }
  | {
      readonly kind: 't0r-repair'
      readonly readCallId: string
      readonly writeCallId: string
      readonly path: string
      readonly version: number
      readonly segments: readonly ShearRepairSegment[]
      /** 修复前读窗行数（repairCoverage 分母；docs/07 剪切族）。 */
      readonly windowLines: number
      readonly anchor: string
      readonly envelope: string
    }
export interface ShearDecisionRecord {
  readonly tier: ShearDecisionTier
  readonly decision: ShearDecision
  readonly callId?: string
  readonly reason: string
}
export interface ShearPlan {
  readonly ops: readonly ShearOp[]
  readonly decisions: readonly ShearDecisionRecord[]
}
/** 策略阈值（docs/03 §8 初值；单位：字符 / 缩进级（2 空格 = 1 级））。 */
export interface ShearPolicy {
  readonly version: number
  readonly t0rMaxSegments: number
  readonly t0rMaxIndent: number
}

/** v4：T-entry 保守准入（失败原文保留 / 仅过程日志整形 / 体积门槛），账本 §73。 */
export const SHEAR_POLICY_VERSION = 4
export const DEFAULT_SHEAR_POLICY: ShearPolicy = {
  version: SHEAR_POLICY_VERSION,
  t0rMaxSegments: 4,
  t0rMaxIndent: 1,
}

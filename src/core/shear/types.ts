/**
 * 工具剪切纯核：类型与策略初值（docs/03 §2 / docs/11 §2 core/shear/ 行；P15a）。
 * 本地重声明，零 harness/platform import；纯数据契约，无副作用。
 * 平面: L0｜回退链步数: 0（失败语义在 tool/t0r，一律默认保留）｜度量: 阈值初值集中于此（docs/03 §8）
 * 审查清单: 不 import harness/platform（S1）；不写 KV/日志/事实；不改史（执行归 P15b）。
 */

/** 时机四档（档 = 时机，时机即经济学；docs/03 §2 表）。 */
export type ShearTier = 'T-entry' | 'T-loop' | 'T-note' | 'T-boundary'
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

/** 工具自声明生命周期谓词（docs/03 §2）；未声明工具三级回退：自带 → 类别启发式 → 通用体积年龄。 */
export interface ToolContextLifecycle {
  referenceKeys(call: ShearToolCall): readonly string[]
  rederiveCost(call: ShearToolCall): RederiveCost
  supersededBy(call: ShearToolCall, later: ShearToolCall): boolean
  referencedBy(call: ShearToolCall, later: ShearEvent): boolean
}
export interface ShearRepairSegment {
  readonly startLine: number
  readonly endLine: number
  readonly lines: readonly string[]
}
/** 四档产物（T-entry 整形 / T-loop stub / T-note 结论 / T0 整剪 / T0-R 修复）。 */
export type ShearOp =
  | { readonly kind: 'shape-entry'; readonly callId: string; readonly content: string }
  | { readonly kind: 'stub-replace'; readonly callId: string; readonly stub: string }
  | { readonly kind: 'note-cut'; readonly callId: string; readonly conclusion: string }
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
/** 策略阈值（docs/03 §8 初值；单位：字节 / 字符 / 缩进级（2 空格 = 1 级））。 */
export interface ShearPolicy {
  readonly version: number
  readonly noteMinBytes: number
  readonly loopMaxConclusionChars: number
  readonly t0rMaxSegments: number
  readonly t0rMaxIndent: number
}
/** T-note 贴注模板（docs/03 §2.1；docs/11 §7 已登记资产）。中性叙述、无插件标签、逐字确定。 */
export const SHEAR_NOTE_TEMPLATE_VERSION = 1
export const SHEAR_NOTE_TEMPLATE =
  '（本结果较长。若你已从中得出结论，请在本次回复的最后一行输出 CUT-OK:〈一句结论〉——原始日志将被剪除、只保留该结论；若后续仍需原文，请输出 CUT-HOLD:〈原因〉。不要为此额外调用工具。）'

export const SHEAR_POLICY_VERSION = 1
export const DEFAULT_SHEAR_POLICY: ShearPolicy = {
  version: SHEAR_POLICY_VERSION,
  noteMinBytes: 8192,
  loopMaxConclusionChars: 120,
  t0rMaxSegments: 4,
  t0rMaxIndent: 1,
}

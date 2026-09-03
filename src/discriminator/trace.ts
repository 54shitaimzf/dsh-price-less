/**
 * 判别器溯源图基元：判别记录（节点）+ 依赖引用（边）+ 错误链 + 稳定指纹。
 *
 * 模块: 判别器溯源（可追溯性核心）
 * 平面: L0（纯数据构造 + 确定性散列，无 IO/无模型调用）
 * 回退链步数: 1（判别记录 = 确定性账本数据；全部字段可由日志重放重建）
 * 审查清单: 判别记录只含 plain JSON 字段（可序列化/可回放）；
 *           指纹为确定性散列（FNV-1a 64，同输入同输出——字节稳定口径）；
 *           不读 event.time / Date 作判据（atMs 仅为诊断元数据）；
 *           依赖引用 = 边：每次判定的"为什么"可沿边回溯到来源版本；
 *           模块自证附于本头注释。
 * 度量: judgeCount / judgeErrorRate / judgeCacheHitRate / judgeLatencyMs（docs/07 §18）
 *
 * v0.4.0：判别器接入主循环（docs/07 §18）——本文件为溯源图设施：
 *   - JudgeSourceRef（kind=preset|config|capability|runtime|prompt|context）
 *     记录单次判定的全部输入依赖及其版本/指纹（"依赖关系溯源图"）；
 *   - JudgeError（phase/code/message/action）记录错误链（什么阶段、怎么降级的）；
 *   - JudgeRecord = 一次判定的完整审计记录（节点，plain JSON）。
 */

import { z } from 'zod'
import type { DiscCallConfig } from './presets.ts'
import type { JudgeCost } from './presets.ts'

/** 判别器判定输出（与 prompt v2.2 的 {"decision":"new_task"|"continue"} 对齐）。 */
export type DiscVerdict = 'continue' | 'new-task'

/** 单条判定的触发路径（决策树：每一条可由此回溯"为什么没走 LLM"）。 */
export type JudgeTrigger =
  | 'explicit'        // T0 显式命令（/task，权威通道；判别器只记账不重复判定）
  | 'l0-continue'     // L0 极窄免费通道（延续词整体匹配，0 泄漏验证见 phase-a-l0.md）
  | 'l1-cache'        // L1 精确键缓存（同输入重放防重，不降语料调用）
  | 'llm'             // 唯一主路径（98.8% 消息，docs/07 §17 ④）
  | 'error-fallback'  // 错误降级兜底（fail-lazy：判不了就当 continue，零动作）

/** 错误阶段（错误链的 phase；越靠前越接近输入/配置，越靠后越接近输出）。 */
export type JudgePhase =
  | 'probe'        // 输入面过滤/上下文探测
  | 'config'       // 预设物化（materializeDiscCallConfig）
  | 'context'      // 窗口组装（anchor/patches 抽取）
  | 'prompt'       // 模板渲染（版本/占位符）
  | 'model-info'   // resolveModelInfo（运行时能力查询）
  | 'stream'       // llm.stream 调用（超时/传输/上游）
  | 'parse'        // 输出解析（JSON 提取/校验）
  | 'emit'         // 事件发射
  | 'journal'      // 台账写入

/** 降级动作（错误处理语义——错误链的终点，可审计"这次错误怎么处理的"）。 */
export type JudgeAction =
  | 'none'      // 无（仅记录）
  | 'degrade'   // 降级继续（如 effort → none，判别仍执行）
  | 'fallback'  // 回退兜底（如预设无效 → 默认预设；解析失败 → continue）
  | 'skip'      // 放弃本次判别（如过载/中止——记录留痕，不产生判定）

/** 依赖引用（溯源图的一条边）：一个来源（版本化常量/运行时视图/输入内容）。 */
export interface JudgeSourceRef {
  /** 来源种类。 */
  kind: 'preset' | 'config' | 'capability' | 'runtime' | 'prompt' | 'context'
  /** 来源标识（preset id / provider@model / 版本键等）。 */
  id: string
  /** 来源版本（常量版本号；运行时视图记 'runtime' 与视图指纹）。 */
  version: string
  /** 来源内容指纹（FNV-1a 64 hex；内容变化即指纹变化——依赖图可检测漂移）。 */
  fingerprint: string
}

/** 单条错误链节点。 */
export interface JudgeError {
  phase: JudgePhase
  /** 稳定机器码（stage 级归纳，如 'PRESET_UNKNOWN'/'MODEL_INFO_FAILED'/'STREAM_TIMEOUT'）。 */
  code: string
  /** 人类可读摘要（截断至 512 字符，防日志爆炸）。 */
  message: string
  /** 降级动作。 */
  action: JudgeAction
}

/** LLM 调用快照（仅记录事实，不保留流对象）。 */
export interface JudgeLlmFacts {
  status: 'ok' | 'failed'
  /** 端到端耗时（ms）。 */
  latencyMs: number
  /** finish reason（'stop' 等；failed 时为 error/aborted）。 */
  finish?: string
  /** 用量（DSH TokenUsage 完整字段，plain JSON）。 */
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
}

/** 运行时模型视图快照（resolveModelInfo 的事实投影，不进业务逻辑）。 */
export interface JudgeModelView {
  efforts: readonly string[]
  defaultEffort?: string
  contextWindow?: number
  defaultMaxTokens?: number
}

/** 一次判定的完整审计记录（节点；plain JSON，可序列化/可回放）。 */
export interface JudgeRecord {
  /** 稳定标识：`j:${sessionId}:${seq}`（同会话同消息唯一；重放覆盖而非追加）。 */
  judgeId: string
  sessionId: string
  /** 用户消息 seq（会话日志事件序号，确定性身份）。 */
  seq: number
  /** 记录生成时刻（ms；仅诊断元数据，判定不读时间）。 */
  atMs: number
  /** 运行模式（observe=只读观测；active=额外发 verdict 事件）。 */
  mode: 'observe' | 'active'
  /** 触发路径（决策树回溯起点）。 */
  trigger: JudgeTrigger
  /** 判定输出（语义票）。 */
  verdict: DiscVerdict
  /** T0 显式命令类型（trigger='explicit' 时非空）。 */
  explicitKind?: 'open' | 'close'
  /** 调用参数快照（物化后的请求面——预设 + 覆盖）。 */
  call: DiscCallConfig
  /** 请求档位（= call.effort；独立列便于审计降级）。 */
  requestedEffort: DiscCallConfig['effort']
  /** 最终发送档位（运行时许可 ∩ 实测验证层；'none' = 不发送 reasoningEffort）。 */
  sentEffort: DiscCallConfig['effort']
  /** 窗口快照（输入面事实；只留长度与摘录，原文在会话日志）。 */
  window: {
    anchorChars: number
    patchCount: number
    targetChars: number
    /** 目标消息原文摘录（前 N 字符；N=messageExcerptChars，0=不留）。 */
    targetExcerpt: string
  }
  /** 运行时模型视图（null = resolveModelInfo 失败，已降级不传 effort）。 */
  modelView: JudgeModelView | null
  /** LLM 调用事实（trigger='llm'/'error-fallback' 时可能为 undefined——未发起调用）。 */
  llm?: JudgeLlmFacts
  /** 成本估算（usage + 单价表；缺失单价 → undefined = 不猜价）。 */
  cost?: JudgeCost
  /** 错误链（空 = 全程无错）。 */
  errors: JudgeError[]
  /** 依赖引用（溯源图边集：本次判定吃了哪些来源、什么版本）。 */
  sources: JudgeSourceRef[]
  /** L1 缓存命中（trigger='l1-cache' 时 true）。 */
  cacheHit?: boolean
}

/* ================= 确定性指纹（FNV-1a 64，字节稳定口径） ================= */

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const FNV_MASK = 0xffffffffffffffffn

/** 文本稳定指纹（同输入 → 同输出；非加密，仅作依赖图内容标识）。 */
export function fingerprintText(text: string): string {
  let hash = FNV_OFFSET
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = (hash * FNV_PRIME) & FNV_MASK
  }
  return hash.toString(16).padStart(16, '0')
}

/** 判别缓存精确键（同输入防重；含配置面——配置变即键变，不串味）。 */
export function makeJudgeCacheKey(input: {
  sessionId: string
  seq: number
  provider: string
  model: string
  promptVersion: string
  text: string
}): string {
  return `jck:${fingerprintText(
    `${input.sessionId}\u0000${input.seq}\u0000${input.provider}\u0000${input.model}\u0000${input.promptVersion}\u0000${input.text}`,
  )}`
}

/** 构造判别记录标识（同会话同消息唯一）。 */
export function makeJudgeId(sessionId: string, seq: number): string {
  return `j:${sessionId}:${seq}`
}

/* ================= 判定输出解析（schema 强制输出） ================= */

const decisionSchema = z.object({
  decision: z.enum(['new_task', 'continue']),
})

/**
 * 从 LLM 输出中提取判定 JSON（容忍码围栏/前后废话；剪头尾花括号）。
 * @returns 合法判定；无法提取/校验失败 → undefined（调用方降级 continue 并记 parse 错误）。
 */
export function parseDecision(output: string): DiscVerdict | undefined {
  const first = output.indexOf('{')
  const last = output.lastIndexOf('}')
  if (first < 0 || last <= first) return undefined
  const candidate = output.slice(first, last + 1)
  const parsed = decisionSchema.safeParse(JSON.parse(candidate))
  if (!parsed.success) return undefined
  return parsed.data.decision === 'new_task' ? 'new-task' : 'continue'
}

/** 错误消息截断（防日志爆炸；保留因果头）。 */
export function truncateError(message: string, cap = 512): string {
  return message.length <= cap ? message : `${message.slice(0, cap)}…`
}

/** 判别记录序列化（plain JSON，一行一条 = 权威审计日志行）。 */
export function serializeJudgeRecord(record: JudgeRecord): string {
  return JSON.stringify(record)
}

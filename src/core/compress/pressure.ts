/**
 * 压力路径纯核（docs/04 §3 层 3：35% 主模型窗口触发〔P20c 用户裁定〕/ 进行时检查点 + 缝 / 保留区全量逐字 /
 * 机制 A 续传 + 机制 B 折叠 / 断路器；docs/07 §0.5 压缩族 pressure*；P20a）。
 * 纯函数：触发阈值与断路器判定、折叠区材料转写、检查点渲染、续传链拼接、pressure-fired fold。
 * 模型只做识别（选缝）与摘要；计量、裁剪、保留区取真全部机械完成（04 §2 分工律）。
 *
 * 模块: core 压缩调用纯核（压力路径）
 * 平面: L0（确定性机械判定/渲染/重放；零模型、零 IO）
 * 回退链步数: 1（wire 计量缺失 / 链形态非法 → 调用侧 fail-lazy 不落刀）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D13）；不读盘、不写事实、不改史。
 * 度量: pressure-fired 事实 fold（07 pressureFireCount / pressureTriggerWireTokens /
 *       pressureChainDepth / pressureBreakerTrips）。
 */
import { estimateTokens } from '../ledger/fold.ts'
import type { LedgerFact, LedgerSessionEvent } from '../ledger/types.ts'
import type { ArchiveEntry } from '../assemble/types.ts'
import { renderRegionTranscript } from './region.ts'
import { DEFAULT_COMPRESS_POLICY, type CompressCheckpoint, type CompressPolicy } from './types.ts'

/**
 * 压力阀门默认比例（用户裁定 2026-09-09：模型能力在上下文窗口约 35% 后下降；
 * 修订 docs/04 §3/§4/§5 的旧口径——裸模型窗口不再禁作压缩触发，改由比例旋钮 + 断路器 + 保险丝三层共同约束）。
 */
export const PRESSURE_RATIO = 0.35

/** 单 task 压力上限（04 §3 断路器；链长有界 = checkpoint 条目数）。 */
export const PRESSURE_CHAIN_LIMIT = 3

/** 紧急折叠硬上限（保险丝/溢出接管可越过常规断路器，但不得无限追加检查点链）。 */
export const PRESSURE_EMERGENCY_LIMIT = PRESSURE_CHAIN_LIMIT + 3

/** 压力档缩水重试预算（04 §3「比边界激进一档」；边界档 = 1）。 */
export const PRESSURE_RETRY_BUDGET = 2

/** 压力触发事实（ignorable log-only；声明合并随 domains/compaction-facts.ts）。 */
export const PRESSURE_FIRED_FACT_TYPE = 'context-economy/pressure-fired' // ignorable

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * 触发阈值（优先级，docs/04 §3 修订版）：
 * ① 主模型窗口已知 → ceil(pressureRatio × contextWindow)；
 * ② 窗口未知 → ceil(pressureRatio × domainTokens)（domainTokens = 假定窗口兜底）；
 * ③ 以上都不可用 → thresholdTokens（绝对安全网，宁晚不误压）；
 * ④ 全不可用 → undefined（不触发）。
 */
export function pressureThreshold(input: {
  contextWindow?: number
  domainTokens?: number
  thresholdTokens?: number
  pressureRatio?: number
}): number | undefined {
  const ratio = positiveNumber(input.pressureRatio)
  if (ratio !== undefined) {
    const window = positiveNumber(input.contextWindow) ?? positiveNumber(input.domainTokens)
    if (window !== undefined) return Math.max(1, Math.ceil(window * ratio))
  }
  return positiveNumber(input.thresholdTokens)
}

/** 是否达到压力触发阈（wire 锚定计量 ≥ 阈值；阈值不可得 = 不触发）。 */
export function shouldFirePressure(input: {
  wireTokens: number
  contextWindow?: number
  domainTokens?: number
  thresholdTokens?: number
  pressureRatio?: number
}): boolean {
  if (!Number.isFinite(input.wireTokens) || input.wireTokens <= 0) return false
  const threshold = pressureThreshold(input)
  return threshold !== undefined && input.wireTokens >= threshold
}

/** 链深 = 同 task 已归档检查点条目数（机制 A 链长；断路器分母）。 */
export function pressureChainDepth(priorChain: readonly ArchiveEntry[]): number {
  return priorChain.length
}

/** 断路器：链深达到上限即拒绝再压（04 §3 单 task 上限 3–4）。 */
export function pressureBreakerTripped(depth: number): boolean {
  return depth >= PRESSURE_CHAIN_LIMIT
}

/** 进行时检查点渲染（受众 = 当前任务的自己；字节稳定）。 */
export function renderCheckpoint(checkpoint: CompressCheckpoint): string {
  const constraints = checkpoint.liveConstraints
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) => `- ${item}`)
    .join('\n')
  const parts = [
    `进度：${checkpoint.progress}`,
    `当前状态：${checkpoint.currentState}`,
    `下一步：${checkpoint.nextStep}`,
  ]
  if (constraints !== '') parts.push(`仍生效的约束：\n${constraints}`)
  return parts.join('\n')
}

/** 压力替换节点正文 = 续传旧块 + 新检查点 + 保留区逐字（机制 A + 04 §3 保留区无帽）。 */
export function composePressureArchive(input: {
  priorChain: readonly ArchiveEntry[]
  checkpointText: string
  retainedText: string
}): string {
  return [...input.priorChain.map((entry) => entry.text), input.checkpointText, input.retainedText]
    .filter((part) => part !== '')
    .join('\n\n')
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 本插件/原生压缩检查点节点（plugin:compact）——不进折叠材料（机制 A 续传面）。 */
function isCompactCheckpoint(event: LedgerSessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const root = recordOf(event.data)
  if (root === undefined) return false
  const message = recordOf(root.message) ?? root
  const source = recordOf(message.source)
  return source?.kind === 'plugin' && source.plugin === 'compact'
}

/**
 * 折叠材料判据（04 §3：折叠区 = 上次缝之后的原始材料）：
 * 只取 user/assistant/tool 四类可读材料，剔除 compaction 协议事件、事实事件与检查点节点。
 */
export function isPressureMaterial(event: LedgerSessionEvent): boolean {
  if (event.type === 'user/message') return !isCompactCheckpoint(event)
  return event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result'
}

/**
 * 折叠区材料转写：先剔协议/检查点节点，再按转写序逐字节渲染。
 * 被上次压力替换遮蔽的原文（surfaceOp 仍为 append）在此重新可见 = 机制 B 的折叠输入；
 * 剔除 replace 事件后，材料数组内不存在遮蔽动作，转写的表面过滤自然全通过。
 */
export function renderFoldMaterialTranscript(
  events: readonly LedgerSessionEvent[],
  range: { startSeq: number; endSeq: number },
): string {
  const material = events.filter((event) => event.seq >= range.startSeq && event.seq <= range.endSeq && isPressureMaterial(event))
  return renderRegionTranscript(material, range)
}

/** 折叠区材料体量（缩水校验分母；仅入事实轨）。 */
export function foldMaterialTokens(
  events: readonly LedgerSessionEvent[],
  range: { startSeq: number; endSeq: number },
  policy: CompressPolicy = DEFAULT_COMPRESS_POLICY,
): number {
  return estimateTokens(renderFoldMaterialTranscript(events, range), policy.charsPerToken)
}

/** 压力触发事实载荷（每次**决定开火**一条；outcome=fired|breaker|skip）。 */
export interface PressureFireFactData {
  readonly at: number
  readonly wireTokens: number
  readonly thresholdTokens: number
  /** 计算阀门的输入快照（审计可复算；窗口未知时省略）。 */
  readonly contextWindow?: number
  readonly pressureRatio?: number
  readonly outcome: 'fired' | 'breaker' | 'skip'
  readonly reason?: string
  readonly chainDepth: number
  readonly foldedTokens?: number
  readonly retainedTokens?: number
  readonly cutPointSeq?: number
  readonly emergency?: boolean
}

export interface PressureFireLedger {
  /** 07 字段：实际开火次数（outcome=fired）。 */
  pressureFireCount: number
  /** 07 字段：开火时的 wire 锚定计量之和。 */
  pressureTriggerWireTokens: number
  /** 07 字段：观察到的最大链深。 */
  pressureChainDepth: number
  /** 07 字段：断路器触发次数。 */
  pressureBreakerTrips: number
  /** 自持观测位：跳过次数（skip 细分）。 */
  skips: number
  emergencies: number
}

export function emptyPressureFireLedger(): PressureFireLedger {
  return { pressureFireCount: 0, pressureTriggerWireTokens: 0, pressureChainDepth: 0, pressureBreakerTrips: 0, skips: 0, emergencies: 0 }
}

function numberField(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** pressure-fired 账本（事实序回放；坏载荷跳过，绝不抛错）。 */
export function foldPressureFires(facts: readonly LedgerFact[]): PressureFireLedger {
  const ledger = emptyPressureFireLedger()
  for (const fact of facts) {
    if (fact.type !== PRESSURE_FIRED_FACT_TYPE) continue
    const raw = fact.data
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const data = raw as Record<string, unknown>
    const depth = numberField(data.chainDepth)
    if (depth > ledger.pressureChainDepth) ledger.pressureChainDepth = depth
    if (data.outcome === 'fired') {
      ledger.pressureFireCount++
      ledger.pressureTriggerWireTokens += numberField(data.wireTokens)
      if (data.emergency === true) ledger.emergencies++
    } else if (data.outcome === 'breaker') {
      ledger.pressureBreakerTrips++
    } else if (data.outcome === 'skip') {
      ledger.skips++
    }
  }
  return ledger
}

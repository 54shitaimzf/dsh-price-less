/**
 * task 边界信号检测（纯函数，无副作用）。
 *
 * 模块: task 判界信号
 * 平面: L0（确定性规则：事件观测 + 字符串签名 + 文件簇相似度）+ L1（语义票 = 本地
 *       embedding，回退链第 4 步；本轮落为可注入 vote 通道，'off' 档机械降级）
 * 回退链步数: 2（代码分支）→ 3（机械字符匹配：'/task' 前缀、路径签名、关键词）
 *            → 4（语义票：当前用户消息 vs task 宣言锚的余弦漂移，见 docs/11）
 * 审查清单: 信号取自会话日志确定性事件；**不读 event.time（时间戳非判据，
 *           保证事件流重放字节可复现）**；语义票经 voteTable 同步注入（fold 纯函数，
 *           无 IO/无模型调用）；可匹配/可分支部分全部 L0 化；
 *           模块自证附于本头注释。
 * 度量: taskSwitchRate / semanticVoteLatency / embeddingTier（docs/07）
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TaskRecord } from './types.ts'

/** 用户消息中提取纯文本（跳过 reasoning/image/tool-result 等非文本块）。 */
export function userMessageText(event: SessionEvent<'user/message'>): string {
  const blocks = event.data.content
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/** T0 显式 '/task' 前缀（用户宣言 = 权威边界）。 */
export function isExplicitTaskCommand(text: string): boolean {
  return /^\s*\/task(\s|$)/.test(text)
}

/** T0 显式 '/task close'（显式闭合当前 task）。 */
export function isExplicitTaskClose(text: string): boolean {
  return /^\s*\/task\s+close(\s|$)/i.test(text)
}

/**
 * T1 lexical 目标/风格关键词信号：新指令意图词。
 * 关键词集合是示例基线（可配置语义后由外部字典扩展；本轮保持确定性）。
 */
const LEXICAL_BOUNDARY_HINTS = [
  '重新开始',
  '换一个',
  '新任务',
  '新目标',
  '接下来我们',
  '开始做',
  '/task',
] as const

/** 机械字符匹配信号：用户消息命中意图词 → 边界候选（弱信号）。 */
export function hasLexicalBoundaryHint(text: string): boolean {
  const normalized = text.toLowerCase()
  return LEXICAL_BOUNDARY_HINTS.some(hint => normalized.includes(hint))
}

/**
 * 用户纠正/否决信号（强信号）：对当前实现方向的否定/切换，
 * 而非同任务内的细节修正（"不要改这个文件"是任务内修正，不算）。
 */
export function isUserCorrection(text: string): boolean {
  return /不是这样|不要这样|重新来|方向不对|理解错了|不对|错了|停一下|先别动手|你的思路|太理想化|不现实|我觉得应该有|应该是/.test(text)
}

/**
 * 从工具名与参数中提取文件路径基础信息（用于文件簇构建）。
 * 返回 { tool, dir, name }；非文件工具返回 null。
 */
export function filePathInfo(
  event: SessionEvent<'tool/call'>,
): { tool: string; dir: string; name: string } | null {
  const toolName = event.data.name
  if (!/^(read|write|edit|glob|grep|ls|read_image)$/.test(toolName)) return null
  try {
    const args = JSON.parse(event.data.arguments) as { file_path?: unknown; path?: unknown }
    const path = args.file_path ?? args.path
    if (typeof path !== 'string' || path.length === 0) return null
    const parts = path.split(/[\\/]/).filter(part => part.length > 0)
      // 剥掉 Windows 盘符（'C:'）与用户级绝对前缀
      .filter(part => !/^[a-zA-Z]:$/.test(part))
    const name = parts.at(-1) ?? ''
    // 项目内相对目录：绝对路径 C:/Users/xxx/Desktop/proj/src/ui →
    // 取尾部最多 3 段 → src/ui（使绝对/相对形态与不同用户根归同一簇）。
    const dirTail = parts.slice(0, -1)
    const trimmed = dirTail.length > 3 ? dirTail.slice(-3) : dirTail
    const dir = trimmed.join('/')
    // 规范化：统一小写，降低"同一文件两种身份"偏差。
    return { tool: toolName, dir: dir.toLowerCase(), name: name.toLowerCase() }
  } catch {
    return null
  }
}

/** 文件簇 = 目录 + 文件名（规范化后），作为文件身份键。 */
export function fileClusterKey(info: { tool: string; dir: string; name: string }): string {
  return `${info.dir}/${info.name}`
}

/** 文件目录键（簇粒度：同目录文件归同簇）。 */
export function fileDirKey(info: { tool: string; dir: string; name: string }): string {
  return info.dir
}

/**
 * 簇迁移信号：新文件的目录是否与"当前 task 已见文件目录集"显著不同。
 * 采用 Jaccard 相似度窗口：把新目录加入后，若与最近目录窗口的重合度骤降
 * （即新文件属于一个此前未见过的新目录簇）且新目录在本 task 内首次出现
 * 累计 ≥ `minNewDirOccurrences` —— 才算"簇迁移"信号。
 * 单个新文件（如偶发读一个 config）不触发：避免"相邻文件不同"的武断。
 */
export interface ClusterShiftContext {
  /** 本 task 内已见目录集合（规范化）。 */
  seenDirs: string[]
  /** 当前正在累积的新目录名（null = 尚无正在累积的簇迁移候选）。 */
  pendingDir: string | null
  /** 累积到的连续新目录文件数。 */
  pendingDirCount: number
}

/** 默认判定：新目录文件连续出现 3 次才算簇迁移。 */
export const CLUSTER_SHIFT_THRESHOLD = 3

/**
 * 评估一次文件访问是否构成簇迁移候选。
 * @returns 更新后的簇状态 + 是否触发簇迁移信号。
 */
export function evaluateClusterShift(
  ctx: ClusterShiftContext,
  dir: string,
): { next: ClusterShiftContext; shifted: boolean } {
  // 目录已在 seenDirs：同簇，清除 pending（回到熟悉目录=迁移候选不成立）。
  if (ctx.seenDirs.includes(dir)) {
    return { next: { ...ctx, pendingDir: null, pendingDirCount: 0 }, shifted: false }
  }
  // 新目录：若与正在累积的目录一致→计数+1；换了另一个新目录→重置到 1。
  if (ctx.pendingDir === dir) {
    const count = ctx.pendingDirCount + 1
    return {
      next: { ...ctx, pendingDir: dir, pendingDirCount: count },
      shifted: count >= CLUSTER_SHIFT_THRESHOLD,
    }
  }
  return {
    next: { ...ctx, pendingDir: dir, pendingDirCount: 1 },
    shifted: false,
  }
}

/** todo 全完成信号（todoCompletedRatio = 1 的等价判定；弱信号）。 */
export function isTodoAllCompleted(
  event: SessionEvent<'todo/write'>,
): boolean {
  const todos = event.data.todos
  return todos.length > 0 && todos.every(item => item.status === 'completed')
}

/** 信号分数表（实测校准：信号强度即权重）。
 * 实测教训（card-b5f9 等真实会话）：文件目录访问在任务内频繁跨目录（读源码→测试→构建
 * 是常态），任何"文件簇迁移"都高误判；故 file-cluster-shift 降为弱信号（辅助），
 * 只有用户方向否决（user-correction）与 T0 显式命令是可靠强信号。
 */
export const SIGNAL_SCORES = {
  'user-correction': 1.0,      // 强：用户方向否决（可靠）
  'file-cluster-shift': 0.5,   // 弱：目录簇迁移（任务内探索常态，仅辅助）
  'todo-completed': 0.5,       // 弱：todo 完成（任务内信号）
  'lexical-hint': 0.5,         // 弱：意图词
  'implicit-start': 0,         // 会话首条（直接开 task，不计分）
} as const

export type SignalName = keyof typeof SIGNAL_SCORES

/** 边界转正门槛：总分 ≥ 1.0 且至少含一个强信号（score ≥ 1.0）。 */
export const BOUNDARY_SCORE_THRESHOLD = 1.0
export const STRONG_SIGNAL_THRESHOLD = 1.0

/**
 * 合议判定：总分 + 强信号门槛。
 * 强信号（≥1.0）单独可达标（total ≥ 1.0 && hasStrong）；
 * 纯弱信号组合（0.5+0.5=1.0）无强信号 → 不达标（fail-lazy）。
 * @returns 'boundary'（转正）/ 'pending'（继续累积）/ 'drop'（fail-lazy 丢弃）。
 */
export function decideBoundary(
  signals: readonly SignalName[],
): 'boundary' | 'pending' | 'drop' {
  if (signals.length === 0) return 'drop'
  let total = 0
  let hasStrong = false
  for (const name of signals) {
    const score = SIGNAL_SCORES[name] ?? 0
    total += score
    if (score >= STRONG_SIGNAL_THRESHOLD) hasStrong = true
  }
  if (total >= BOUNDARY_SCORE_THRESHOLD && hasStrong) return 'boundary'
  // 有信号但未达标：turn 未结束时继续累积；turn/end 时按 drop 处理（fail-lazy）。
  return 'pending'
}

/** 语义票档位：'off' 纯机械判定；'on' 语义漂移为主判定（机械强信号保留兜底）。 */
export type SemanticMode = 'off' | 'on'

/** 语义票合议输入/输出裁决（与机械合议正交，组合见 decideBoundaryWithSemantic）。 */
export interface SemanticVote {
  /** 余弦相似度 ∈ [-1,1]（当前用户消息 vs 当前 task 锚）。 */
  score: number
}

/** 语义票合议选项。 */
export interface SemanticVoteOptions {
  /** 档位。 */
  mode: SemanticMode
  /**
   * 语义漂移阈值（docs/07 contract `taskEmbeddingThreshold`，默认 0.5）：
   * score < threshold 视为"语义离开当前 task" → 边界候选。
   */
  threshold: number
}

/**
 * 语义票合议：机械合议（decideBoundary）为底线，语义漂移（cosine < threshold）为
 * 主判据；三票合一。规则（fail-lazy 与机械一致）：
 * - 'off'：完全机械（等价 decideBoundary；语义票被忽略）。
 * - 'on'：'boundary' 当且仅当 (机械合议达标) 或 (语义票存在且 score < threshold)。
 *   机械强信号（user-correction，≥1.0）比 embedding 更可靠，保留为兜底——
 *   语义票失败（null）不影响机械底线（降级即机械档）。
 * @param semantic 语义票（null = 无票/未计算/embedding 失败）。
 */
export function decideBoundaryWithSemantic(
  signals: readonly SignalName[],
  semantic: SemanticVote | null,
  opts: SemanticVoteOptions,
): 'boundary' | 'pending' | 'drop' {
  const mechanical = decideBoundary(signals)
  if (opts.mode === 'off') return mechanical
  if (mechanical === 'boundary') return 'boundary'
  if (semantic !== null && semantic.score < opts.threshold) return 'boundary'
  return mechanical
}

/**
 * 判定一个 user/message 是否是 T0 显式边界。
 * @returns 'open'（新 task 起点）/ 'close'（显式闭合）/ null（非显式）。
 */
export function classifyExplicitUserMessage(
  text: string,
): 'open' | 'close' | null {
  if (isExplicitTaskClose(text)) return 'close'
  if (isExplicitTaskCommand(text)) return 'open'
  return null
}

/** 为新 task 生成 taskId（T0 显式时可带用户命名；否则按起始 seq）。 */
export function makeTaskId(startSeq: number, explicitName?: string): string {
  return explicitName && explicitName.trim().length > 0
    ? `task-${explicitName.trim()}`
    : `task-${startSeq}`
}

/** 从 '/task <name>' 文本中提取显式任务名。 */
export function extractTaskName(text: string): string | undefined {
  const match = text.match(/^\s*\/task\s+(.+?)\s*$/)
  if (match === null) return undefined
  const name = match[1]!.trim()
  return name === 'close' ? undefined : name
}

/** 当前 task 的最后 surface seq 更新（新 surface 事件进入 task 时）。 */
export function touchTaskSurface(task: TaskRecord, seq: number): TaskRecord {
  return { ...task, lastSurfaceSeq: Math.max(task.lastSurfaceSeq, seq) }
}

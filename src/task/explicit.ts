/**
 * 显式任务指令与用户消息文本工具（纯函数，无副作用）。
 *
 * 模块: task 显式指令
 * 平面: L0（确定性规则：'/task' 前缀匹配 + 用户消息文本提取）
 * 回退链步数: 1（用户可控指令：显式 /task = 权威边界）→ 2（代码分支）
 * 审查清单: 数据取自会话日志确定性事件；**不读 event.time（时间戳非判据，
 *           保证事件流重放字节可复现）**；纯函数无 IO/无模型调用；
 *           可匹配部分全部 L0 化；模块自证附于本头注释。
 * 度量: segmentsPerSession / explicitCommandRate（docs/07）
 *
 * v0.3.0：机械判定层整体退役（T1 信号合议/文件簇迁移/todo 完成信号/词汇意图词
 * 全部移除，退役快照见 docs/07 §16）。本文件只保留用户可控的显式边界（/task）
 * 与文本提取工具——判别器接口接入后，userMessageText 同时是判别输入组装
 * （锚 + 消息窗）的文本源；/task 归入判别器 L0 显式指令快速路径。
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

/** T0 显式 '/task' 前缀（用户宣言 = 权威边界，判别器 L0 显式指令路径）。 */
export function isExplicitTaskCommand(text: string): boolean {
  return /^\s*\/task(\s|$)/.test(text)
}

/** T0 显式 '/task close'（显式闭合当前段）。 */
export function isExplicitTaskClose(text: string): boolean {
  return /^\s*\/task\s+close(\s|$)/i.test(text)
}

/**
 * 判定一个 user/message 是否是 T0 显式边界。
 * @returns 'open'（新段起点）/ 'close'（显式闭合）/ null（非显式）。
 */
export function classifyExplicitUserMessage(
  text: string,
): 'open' | 'close' | null {
  if (isExplicitTaskClose(text)) return 'close'
  if (isExplicitTaskCommand(text)) return 'open'
  return null
}

/** 为新段生成 taskId（T0 显式时可带用户命名；否则按起始 seq）。 */
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

/** 当前段最后 surface seq 更新（新 surface 事件进入段时）。 */
export function touchTaskSurface(task: TaskRecord, seq: number): TaskRecord {
  return { ...task, lastSurfaceSeq: Math.max(task.lastSurfaceSeq, seq) }
}
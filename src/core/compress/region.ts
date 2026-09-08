/**
 * 区间转写（docs/04 §2「输入 = 闭合段全量逐字节」；docs/11 §2 core/compress 行；P19a）。
 * 纯函数：表面事件 → 机械逐字节转写（压缩器输入的区域正文）。转写只加机械表头，正文逐字不动；
 * 同输入同字节（REGION_TRANSCRIPT_VERSION 随格式演进升版本）。零 harness/platform import。
 *
 * 模块: core 压缩调用纯核（区间转写）
 * 平面: L0（确定性渲染；零模型、零 IO）
 * 回退链步数: 0（坏形状 = 跳过该节点，绝不抛错）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D13）；不读盘、不写事实、不改史。
 * 度量: regionTokens 由调用侧落 compress-run 事实（07 压缩族同源）。
 */
import { estimateTokens, extractTextFromToolResult } from '../ledger/fold.ts'
import type { LedgerSessionEvent } from '../ledger/types.ts'
import { foldSurfaceNodes } from '../ledger/surface.ts'
import { DEFAULT_COMPRESS_POLICY, type CompressPolicy } from './types.ts'

/** 转写格式版本（表头/字段序变化必须升版本：同版本同字节是缓存键的地基）。 */
export const REGION_TRANSCRIPT_VERSION = 1

export interface RegionRange {
  readonly startSeq: number
  readonly endSeq: number
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** 消息事件（user/assistant）文本：text blocks 拼接（坏形状 = 空串）。 */
export function messageTextOf(data: unknown): string {
  const root = recordOf(data)
  if (root === undefined) return ''
  const message = recordOf(root.message) ?? root
  const content = message?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    const item = recordOf(block)
    if (item === undefined || item.type !== 'text') continue
    if (typeof item.text === 'string') text += item.text
  }
  return text
}

/** tool/result 的 callId（配对标记；坏形状 = 空串）。 */
function resultCallIdOf(data: unknown): string {
  const root = recordOf(data)
  if (root === undefined) return ''
  const message = recordOf(root.message) ?? root
  const content = message?.content
  if (!Array.isArray(content) || content.length === 0) return ''
  const block = recordOf(content[0])
  return typeof block?.toolCallId === 'string' ? block.toolCallId : ''
}

/** 单个表面节点的机械转写块（表头 + 逐字正文）。 */
function nodeBlock(event: LedgerSessionEvent): string | undefined {
  const data = recordOf(event.data)
  if (event.type === 'user/message' || event.type === 'assistant/message') {
    return `[${event.seq}] ${event.type}\n${messageTextOf(event.data)}`
  }
  if (event.type === 'tool/call') {
    const name = typeof data?.name === 'string' ? data.name : ''
    const callId = typeof data?.callId === 'string' ? data.callId : ''
    const args = typeof data?.arguments === 'string' ? data.arguments : ''
    return `[${event.seq}] tool/call ${name} ${callId}\n${args}`
  }
  if (event.type === 'tool/result') {
    return `[${event.seq}] tool/result ${resultCallIdOf(event.data)}\n${extractTextFromToolResult(event.data)}`
  }
  return undefined
}

/** 当前表面且落在区间内的节点（transcript 序）。 */
export function surfaceEventsInRange(
  events: readonly LedgerSessionEvent[],
  range: RegionRange,
): LedgerSessionEvent[] {
  const surface = new Set(foldSurfaceNodes(events))
  return events.filter((event) => surface.has(event.seq) && event.seq >= range.startSeq && event.seq <= range.endSeq)
}

/** 区间正文转写（transcript 序；仅表面节点；同输入同字节）。 */
export function renderRegionTranscript(events: readonly LedgerSessionEvent[], range: RegionRange): string {
  const blocks: string[] = []
  for (const event of surfaceEventsInRange(events, range)) {
    const block = nodeBlock(event)
    if (block !== undefined) blocks.push(block)
  }
  return blocks.join('\n\n')
}

/** 区间转写体量（机械计量，仅入事实轨）。 */
export function regionTokens(
  events: readonly LedgerSessionEvent[],
  range: RegionRange,
  policy: CompressPolicy = DEFAULT_COMPRESS_POLICY,
): number {
  return estimateTokens(renderRegionTranscript(events, range), policy.charsPerToken)
}

/**
 * 表面 fold（通用回放工具；docs/10 §1 H4 表面语义；P17b 从剪切纯核上移到通用回放层）。
 * 纯函数：append 入尾 / replace 遮蔽区间换节点 → 当前表面节点 seq 序。
 * core 零 harness/platform import；不感知事实来源与通道。
 *
 * 模块: core 表面 fold（零 harness/platform import）
 * 平面: L0（确定性重放；无模型、无 IO）
 * 回退链步数: 0（纯计算）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机；不写事实、不改史。
 * 度量: 无 07 字段（剪切/装配域的表面可见性判据）。
 */
import type { LedgerSessionEvent } from './types.ts'

/** 表面 fold（append 入尾 / replace 遮蔽区间换节点）；返回当前表面节点 seq 序。 */
export function foldSurfaceNodes(events: readonly LedgerSessionEvent[]): number[] {
  const nodes: number[] = []
  for (const event of events) {
    const op = (event as { surfaceOp?: unknown }).surfaceOp
    if (op === 'append') { nodes.push(event.seq); continue }
    if (typeof op !== 'object' || op === null) continue
    const replace = op as { op?: unknown; start?: unknown; end?: unknown }
    if (replace.op !== 'replace') continue
    const start = Number(replace.start)
    const end = Number(replace.end)
    const si = nodes.indexOf(start)
    const ei = nodes.indexOf(end)
    if (si >= 0 && ei >= si) nodes.splice(si, ei - si + 1, event.seq)
  }
  return nodes
}

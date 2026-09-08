/**
 * H7 计量端口（docs/10 §1 H7 + docs/04 §1 影子价协议；P19b）。
 * 唯一持有 `ctx.tokenMeter` 的收口点（D15）：暴露"当前表面区间的固定启发式体量"，
 * 供压缩提交的 `shadowedTokenCount` 与 harness token-meter 的 O(1) fold 保持同源
 * （协议要求影子价 = 同一固定估计器下的区间价，否则投影总量漂移）。
 *
 * 模块: platform 计量端口（唯一 harness 触点层）
 * 平面: L0（服务读取 + 区间求和；无模型、无机制逻辑）
 * 回退链步数: 1（服务缺失 / 测量失败 = undefined；调用侧降级为本地估算并标注）
 * 审查清单: 不 import core；不改史、不写 KV；measure 只读。
 * 度量: 无 07 字段（影子价经官方压缩计量事件落账，见 platform/history.ts）。
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only：拉入 dsh-token-meter 的 Context 服务键声明合并（ctx.tokenMeter）。
import type {} from '@deepseek-ai/dsh-token-meter'
import type { Session } from '@deepseek-ai/dsh-session'

export interface MeterPort {
  /** 当前表面区间 [start..end] 的固定启发式体量；服务缺失 / 区间失效 = undefined。 */
  heuristicTokensInRange(session: Session, start: number, end: number): number | undefined
  /**
   * wire 锚定计量（docs/04 §3/§5；P20a 压力触发基准）：provider 精确 usage 锚 + 表面增量，
   * 每步由新 usage 重锚定、误差不累积；服务缺失 / 测量异常 = undefined（调用侧 fail-lazy 不触发）。
   */
  wireTokens(session: Session): number | undefined
}

/** 解析 token-meter 服务（可选能力；未装配 → undefined，调用侧 fail-lazy）。 */
export function createMeterPort(ctx: Pick<Context, 'tokenMeter'>): MeterPort | undefined {
  const service = ctx.tokenMeter
  if (service === undefined) return undefined
  return {
    heuristicTokensInRange(session: Session, start: number, end: number): number | undefined {
      try {
        let total = 0
        let seen = false
        for (const node of service.measure(session).nodes) {
          const seq = Number(node.seq)
          if (seq < start || seq > end) continue
          seen = true
          total += node.heuristicTokens
        }
        return seen ? total : undefined
      } catch {
        return undefined
      }
    },
    wireTokens(session: Session): number | undefined {
      try {
        const total = service.measure(session).totalTokens
        return typeof total === 'number' && Number.isFinite(total) ? total : undefined
      } catch {
        return undefined
      }
    },
  }
}

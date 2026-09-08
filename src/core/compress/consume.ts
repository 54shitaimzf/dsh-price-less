/**
 * 共享消费模块（docs/04 §3 生产/消费不对称律；docs/11 §2 core/compress 行；P18）。
 * 尾部模式是生产签名（边界产热尾、压力产检查点 + 末段子任务），处理能力普遍：
 * 摘要块（checkpoint/boundary）→ 机制 A 原样续传；材料块（热尾）→ 机制 B 折叠（缓存非档案）。
 * 四种触发次序（边→边 / 边→压 / 压→边 / 压→压）在此闭合（端到端交错验收归 P21b）。
 *
 * 模块: core 压缩调用纯核（尾部消费语义）
 * 平面: L0（确定性查表；零模型、零 IO）
 * 回退链步数: 1（链形态非法 → ok:false，调用侧 fail-lazy 不落刀）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D13）；不读盘、不写事实、不改史。
 * 度量: carryCount/appendKind 由调用侧落 compress-run 事实（07 压缩族同源）。
 */
import { archiveChainShape } from '../assemble/archive.ts'
import type { ArchiveEntry } from '../assemble/types.ts'
import type { CompressMode, TailBlockKind, TailConsumeOp, TailConsumption, TailPlanOutcome } from './types.ts'

/** 尾部消费表（04 §3 机制 A/B；唯一真相，两模式共用）。 */
export const TAIL_CONSUME_OPS: Readonly<Record<TailBlockKind, TailConsumeOp>> = {
  checkpoint: 'continue',
  boundary: 'continue',
  material: 'fold',
}

export function classifyTailBlock(kind: TailBlockKind): TailConsumption {
  const op = TAIL_CONSUME_OPS[kind]
  return { kind, op, reason: op === 'continue' ? 'stub-immutable' : 'cache-not-archive' }
}

/**
 * 四次序闭合表：priorChain 形态 × 本次层 → 续传 + 追加语义。
 * 链形态非法（非 empty/prefix/single/chain）= chain-invalid（调用侧 fatal，不落刀）。
 */
export function planTailConsumption(input: {
  priorChain?: readonly ArchiveEntry[]
  layer: CompressMode
}): TailPlanOutcome {
  const priorChain = input.priorChain ?? []
  const shape = archiveChainShape(priorChain)
  if (shape.shape === 'invalid') return { ok: false, reason: 'chain-invalid' }
  return {
    ok: true,
    form: priorChain.length === 0 ? 'single' : 'chain',
    carryCount: priorChain.length,
    appendKind: input.layer === 'boundary' ? 'boundary' : 'checkpoint',
    // 机制 B：压力路径把折叠区内的热尾折进检查点；边界路径由新产物重新申报热尾。
    foldMaterial: input.layer === 'pressure',
  }
}

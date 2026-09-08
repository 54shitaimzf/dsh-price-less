/**
 * P18 共享消费模块单测（docs/implement/P18-compress-call.md §5；docs/04 §3 生产/消费不对称律）。
 * 摘要块续传 / 材料块折叠 / 四触发次序闭合 / 链形态非法。
 */
import { describe, expect, it } from 'vitest'
import {
  TAIL_CONSUME_OPS,
  classifyTailBlock,
  planTailConsumption,
  type ArchiveEntry,
} from '../src/core/compress/index.ts'

const entry = (taskId: string, kind: ArchiveEntry['kind'], text = kind): ArchiveEntry => ({ taskId, kind, text })

describe('P18 消费：尾部模式与四次序闭合', () => {
  it('摘要块 → continue（stub 不可重压）；材料块 → fold（缓存非档案）', () => {
    expect(classifyTailBlock('checkpoint')).toEqual({ kind: 'checkpoint', op: 'continue', reason: 'stub-immutable' })
    expect(classifyTailBlock('boundary')).toEqual({ kind: 'boundary', op: 'continue', reason: 'stub-immutable' })
    expect(classifyTailBlock('material')).toEqual({ kind: 'material', op: 'fold', reason: 'cache-not-archive' })
    expect(Object.keys(TAIL_CONSUME_OPS).sort()).toEqual(['boundary', 'checkpoint', 'material'])
  })

  it('四触发次序闭合表（边→边 / 边→压 / 压→边 / 压→压）', () => {
    const d = entry('t', 'boundary')
    const c1 = entry('t', 'checkpoint', 'C1')
    const c2 = entry('t', 'checkpoint', 'C2')
    expect(planTailConsumption({ layer: 'boundary' })).toEqual({ ok: true, form: 'single', carryCount: 0, appendKind: 'boundary', foldMaterial: false })
    expect(planTailConsumption({ priorChain: [d], layer: 'boundary' })).toEqual({ ok: true, form: 'chain', carryCount: 1, appendKind: 'boundary', foldMaterial: false })
    expect(planTailConsumption({ priorChain: [d], layer: 'pressure' })).toEqual({ ok: true, form: 'chain', carryCount: 1, appendKind: 'checkpoint', foldMaterial: true })
    expect(planTailConsumption({ priorChain: [c1], layer: 'boundary' })).toEqual({ ok: true, form: 'chain', carryCount: 1, appendKind: 'boundary', foldMaterial: false })
    expect(planTailConsumption({ priorChain: [c1, c2], layer: 'pressure' })).toEqual({ ok: true, form: 'chain', carryCount: 2, appendKind: 'checkpoint', foldMaterial: true })
  })

  it('链形态非法 → chain-invalid（调用侧不落刀）', () => {
    expect(planTailConsumption({ priorChain: [entry('t', 'boundary'), entry('t', 'checkpoint')], layer: 'boundary' })).toEqual({ ok: false, reason: 'chain-invalid' })
    expect(planTailConsumption({ priorChain: [entry('a', 'checkpoint'), entry('b', 'checkpoint')], layer: 'pressure' })).toEqual({ ok: false, reason: 'chain-invalid' })
  })
})

/**
 * task 分划压缩范围单测（无 harness）：近因尾 cutoff + 冷区闭合任务选择 + 近因区保留判定。
 */
import { describe, expect, it } from 'vitest'
import {
  recencyTailCutoff,
  selectColdClosedTask,
  isClosedTaskInRecencyTail,
  type SurfaceNodeCost,
} from '../src/task/range-task-partitioned.js'
import type { ContextEconomyTaskState, TaskRecord } from '../src/task/types.js'

function task(partial: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: `task-${partial.startSeq ?? 0}`,
    startSeq: 0,
    lastSurfaceSeq: 9,
    summary: null,
    status: 'closed',
    anchorText: 'do the thing',
    ...partial,
  }
}

function state(partial: Partial<ContextEconomyTaskState> = {}): ContextEconomyTaskState {
  return {
    tasks: [],
    current: null,
    surfaceIndex: {},
    lastBoundarySeq: null,
    compactedTaskIds: [],
    lastBoundary: null,
    ...partial,
  }
}

function nodes(costs: Array<[number, number]>): SurfaceNodeCost[] {
  return costs.map(([seq, tokens]) => ({ seq, tokens }))
}

const surface = (seqs: number[]) => seqs

describe('recencyTailCutoff', () => {
  it('空节点 → null', () => {
    expect(recencyTailCutoff([], 100)).toBeNull()
  })

  it('retainTokens 覆盖整段（头部无可压）→ null', () => {
    const n = nodes([[0, 10], [1, 10]])
    expect(recencyTailCutoff(n, 100)).toBeNull()
  })

  it('retainTokens=0 → 保留最末一个节点（近因尾起点 = 倒数第一）', () => {
    const n = nodes([[0, 10], [1, 10], [2, 10]])
    expect(recencyTailCutoff(n, 0)).toBe(2)
  })

  it('从尾累加：retainTokens 边界命中近因尾起点', () => {
    // 每节点 5，retainTokens=15 → 尾起点在下标 0（累加 5+5+5=15 覆盖全部）→ null？
    // 累加下标2=5, 1=10, 0=15>=15 → keepFromIdx=0 → 无可压 → null。
    const n = nodes([[0, 5], [1, 5], [2, 5]])
    expect(recencyTailCutoff(n, 15)).toBeNull()
  })

  it('近因尾起点正确：冷区在前', () => {
    // 节点 token：0=30, 1=10, 2=10。retainTokens=15 → 尾起点 = 1（近因尾 = node1+node2）。
    const n = nodes([[0, 30], [1, 10], [2, 10]])
    expect(recencyTailCutoff(n, 15)).toBe(1)
    // retainTokens=30 覆盖整段（50）→ 无可压冷区 → null（等价原生 keepFromIdx===0）。
    expect(recencyTailCutoff(n, 30)).toBeNull()
  })
})

describe('selectColdClosedTask', () => {
  it('无闭合任务 → null', () => {
    expect(selectColdClosedTask(state(), surface([0, 9]), 1)).toBeNull()
  })

  it('近因尾内的闭合任务不选（保热）', () => {
    const s = state({
      tasks: [task({ startSeq: 0, lastSurfaceSeq: 5 })],
      compactedTaskIds: [],
    })
    // surface=[0..5]，tailCutoffIdx=4 → 近因尾=下标4,5；task 在尾内 → 不选。
    expect(selectColdClosedTask(s, [0, 1, 2, 3, 4, 5], 4)).toBeNull()
  })

  it('冷区闭合任务、最老优先被选', () => {
    const s = state({
      tasks: [
        task({ taskId: 'b', startSeq: 3, lastSurfaceSeq: 4 }),
        task({ taskId: 'a', startSeq: 0, lastSurfaceSeq: 1 }),
      ],
    })
    // tailCutoffIdx=5 → 近因尾=下标5,6,7（seqs 5,6,7）；task a（lastSeq=1）与 task b（lastSeq=4）
    // 均在冷区（lastIdx < 5）→ 选最老的 a。
    const chosen = selectColdClosedTask(s, [0, 1, 2, 3, 4, 5, 6, 7], 5)
    expect(chosen?.taskId).toBe('a')
  })

  it('冷区闭合任务但 lastIdx >= tailCutoffIdx（在近因尾）→ 不选', () => {
    const s = state({
      tasks: [task({ taskId: 'a', startSeq: 0, lastSurfaceSeq: 3 })],
    })
    // tailCutoffIdx=3 → 近因尾=下标3,4,5；task a lastSeq=3 在尾内 → 不选。
    expect(selectColdClosedTask(s, [0, 1, 2, 3, 4, 5], 3)).toBeNull()
  })

  it('compactedTaskIds 已含 → 不选', () => {
    const s = state({
      tasks: [task({ taskId: 'a', startSeq: 0, lastSurfaceSeq: 2 })],
      compactedTaskIds: ['a'],
    })
    expect(selectColdClosedTask(s, [0, 1, 2], 0)).toBeNull()
  })

  it('引用门 stillReferenced=true → 不选（A4 深度冻结）', () => {
    const s = state({
      tasks: [task({ taskId: 'a', startSeq: 0, lastSurfaceSeq: 2 })],
    })
    const chosen = selectColdClosedTask(s, [0, 1, 2], 0, {
      stillReferenced: (id) => id === 'a',
    })
    expect(chosen).toBeNull()
  })

  it('lastSurfaceSeq 不在表面（被更早压缩吃掉）→ 不选', () => {
    const s = state({
      tasks: [task({ taskId: 'a', startSeq: 0, lastSurfaceSeq: 99 })],
    })
    expect(selectColdClosedTask(s, [0, 1, 2], 0)).toBeNull()
  })
})

describe('isClosedTaskInRecencyTail', () => {
  it('task 在近因尾内 → true', () => {
    const s = state({ tasks: [task({ taskId: 'a', startSeq: 0, lastSurfaceSeq: 5 })] })
    expect(isClosedTaskInRecencyTail(s, [0, 1, 2, 3, 4, 5], 4, s.tasks[0]!)).toBe(true)
  })

  it('task 在冷区 → false', () => {
    const s = state({ tasks: [task({ taskId: 'a', startSeq: 0, lastSurfaceSeq: 2 })] })
    expect(isClosedTaskInRecencyTail(s, [0, 1, 2, 3, 4], 3, s.tasks[0]!)).toBe(false)
  })
})

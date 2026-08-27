/**
 * 压缩范围选择单测（无 harness：mock surface 结构 + 平衡校验器）。
 */
import { describe, expect, it } from 'vitest'
import { selectCompressibleRange, type BalanceChecker } from '../src/task/range.js'
import type { TaskRecord } from '../src/task/types.js'

function task(partial: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task-1',
    startSeq: 0,
    lastSurfaceSeq: 9,
    kind: 'explicit',
    evidence: [],
    summary: null,
    status: 'closed',
    ...partial,
  }
}

/** 平衡校验器 mock：指定哪些 seq 为平衡切点。 */
function checker(balancedSet: Set<number>): BalanceChecker {
  return {
    balancedBefore: (_session, seq) => balancedSet.has(seq),
    balancedAfter: (_session, seq) => balancedSet.has(seq),
  }
}

describe('selectCompressibleRange', () => {
  it('task 未关闭 → null', () => {
    expect(selectCompressibleRange(task({ status: 'active' }), [0, 9])).toBeNull()
  })

  it('seq 不在表面 → null（被更早压缩吃掉，跳过不重复压）', () => {
    expect(selectCompressibleRange(task({ startSeq: 0, lastSurfaceSeq: 9 }), [20, 30])).toBeNull()
  })

  it('完全平衡区间直接返回', () => {
    const session = {} as never
    const allBalanced = new Set([0, 9])
    const range = selectCompressibleRange(task({ startSeq: 0, lastSurfaceSeq: 9 }), [0, 9], {
      session,
      checker: checker(allBalanced),
    })
    expect(range).toEqual({ start: 0, end: 9 })
  })

  it('start 不平衡 → 向右收缩到最近平衡点', () => {
    const session = {} as never
    const balanced = new Set([3, 9]) // 0 不平衡，3 是第一个平衡点
    const range = selectCompressibleRange(
      task({ startSeq: 0, lastSurfaceSeq: 9 }),
      [0, 1, 3, 9],
      { session, checker: checker(balanced) },
    )
    expect(range).toEqual({ start: 3, end: 9 })
  })

  it('end 不平衡 → 向左收缩到最近平衡点', () => {
    const session = {} as never
    const balanced = new Set([0, 4]) // 9 不平衡，4 是最后一个平衡点
    const range = selectCompressibleRange(
      task({ startSeq: 0, lastSurfaceSeq: 9 }),
      [0, 4, 9],
      { session, checker: checker(balanced) },
    )
    expect(range).toEqual({ start: 0, end: 4 })
  })

  it('收缩后 start > end → null（不可压缩）', () => {
    const session = {} as never
    const balanced = new Set<number>()
    const range = selectCompressibleRange(
      task({ startSeq: 1, lastSurfaceSeq: 2 }),
      [1, 2],
      { session, checker: checker(balanced) },
    )
    expect(range).toBeNull()
  })

  it('表面为空 → null', () => {
    expect(selectCompressibleRange(task({ status: 'closed' }), [])).toBeNull()
  })
})

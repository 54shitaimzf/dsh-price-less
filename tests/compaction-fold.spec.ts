/**
 * 压缩域 fold 单测（纯 node，无 harness）。
 * 覆盖：applyReplace 表面重映射 + 相交 task 关闭；applyCompactionSummary 摘要归档。
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyCompactionSummary, applyReplace } from '../src/task/compaction.js'
import type { ContextEconomyTaskState, TaskRecord } from '../src/task/types.js'

/** 构造一个最小 task 记录。 */
function task(partial: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  return {
    startSeq: 1,
    lastSurfaceSeq: 5,
    summary: null,
    status: 'active',
    anchorText: 'anchor',
    ...partial,
  }
}

/** 构造最小状态（v4：机械字段已退役）。 */
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

describe('applyReplace', () => {
  it('把与替换区间相交的 task 标记为 closed，并加入 compactedTaskIds', () => {
    const s = state({
      tasks: [
        task({ taskId: 'task-1', startSeq: 1, lastSurfaceSeq: 10, status: 'active' }),
        task({ taskId: 'task-2', startSeq: 20, lastSurfaceSeq: 30, status: 'active' }),
      ],
    })
    const event = { seq: 40, type: 'user/message' } as SessionEvent<'user/message'>
    const next = applyReplace(s, event, { op: 'replace', start: 5, end: 12 })
    // task-1 区间 [1,10] 与 [5,12] 相交 → closed；task-2 不相交 → 保持 active。
    expect(next.tasks.find(t => t.taskId === 'task-1')!.status).toBe('closed')
    expect(next.tasks.find(t => t.taskId === 'task-2')!.status).toBe('active')
    expect(next.compactedTaskIds).toContain('task-1')
    expect(next.compactedTaskIds).not.toContain('task-2')
  })

  it('重映射 surfaceIndex：被替换的旧 seq 移出，新 seq 落到原区间最小位置', () => {
    const s = state({
      surfaceIndex: { '3': 0, '5': 1, '8': 2, '9': 3 },
    })
    const event = { seq: 10, type: 'user/message' } as SessionEvent<'user/message'>
    const next = applyReplace(s, event, { op: 'replace', start: 5, end: 8 })
    // 5 和 8 被替换出；新 seq 10 落在它们的最小位置 1。
    expect(next.surfaceIndex['3']).toBe(0)
    expect(next.surfaceIndex['10']).toBe(1)
    expect(next.surfaceIndex['5']).toBeUndefined()
    expect(next.surfaceIndex['8']).toBeUndefined()
    expect(next.surfaceIndex['9']).toBe(3)
  })
})

describe('applyCompactionSummary', () => {
  it('把摘要按 shadowedSeqs 归属到区间覆盖的 task 并标记 closed', () => {
    const s = state({
      tasks: [
        task({ taskId: 'task-1', startSeq: 1, lastSurfaceSeq: 10, status: 'active' }),
        task({ taskId: 'task-2', startSeq: 20, lastSurfaceSeq: 30, status: 'active' }),
      ],
    })
    const event = {
      seq: 50,
      type: 'compaction/summary',
      data: {
        summary: [{ type: 'text', text: '压缩摘要内容' }],
        shadowedSeqs: [2, 4, 6],
      },
    } as unknown as SessionEvent<'compaction/summary'>
    const next = applyCompactionSummary(s, event)
    // task-1 覆盖 [2,4,6] → 摘要归属并 closed；task-2 不覆盖 → 不变。
    expect(next.tasks.find(t => t.taskId === 'task-1')!.summary).toBe('压缩摘要内容')
    expect(next.tasks.find(t => t.taskId === 'task-1')!.status).toBe('closed')
    expect(next.tasks.find(t => t.taskId === 'task-2')!.summary).toBeNull()
    expect(next.tasks.find(t => t.taskId === 'task-2')!.status).toBe('active')
  })

  it('空摘要文本不改状态（返回 state）', () => {
    const s = state({ tasks: [task({ taskId: 'task-1' })] })
    const event = {
      seq: 51,
      type: 'compaction/summary',
      data: { summary: [{ type: 'text', text: '   ' }], shadowedSeqs: [] },
    } as unknown as SessionEvent<'compaction/summary'>
    const next = applyCompactionSummary(s, event)
    expect(next).toBe(s)
  })
})

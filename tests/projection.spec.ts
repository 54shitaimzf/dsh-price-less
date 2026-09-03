/**
 * 投影 fold 单测（无 harness：纯 node 构造 SessionEvent 序列，不启动 DSH）。
 * 覆盖：T0 显式边界、隐式开段/段推进、fail-lazy（无判定即惰性）、replace 重映射、
 * 摘要归档、契约守卫（同引用/stateSchema/stateVersion）、无时间戳依赖。
 * v0.3.0：机械判定层（T1 信号/簇迁移/分数合议）已退役——正常新指令不再触发边界，
 * 边界来自显式指令（判别器语义票 v0.8.0 接入：verdict 会话事件 → 段内切分）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { taskProjectionDefinition } from '../src/task/projection.js'

const stateSchema = taskProjectionDefinition.stateSchema

/** 纯函数 replay：按序 fold（模拟 registry 的 drive）。 */
function fold(events: SessionEvent[]) {
  let state = taskProjectionDefinition.init()
  for (const event of events) {
    state = taskProjectionDefinition.apply(state, event)
  }
  return state
}

let seqCounter = 0
function nextSeq() {
  seqCounter += 1
  return seqCounter
}

function user(text: string, surface: 'append' | 'replace' = 'append', replaceSpan?: { start: number; end: number }) {
  const seq = nextSeq()
  const event: SessionEvent = {
    type: 'user/message',
    seq,
    time: 0,
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'human' },
      id: `m-${seq}`,
      role: 'user',
    },
  }
  if (surface === 'replace' && replaceSpan !== undefined) {
    ;(event as { surfaceOp?: unknown }).surfaceOp = { op: 'replace', ...replaceSpan }
  }
  return event
}

function compactionSummary(shadowedSeqs: number[], text: string) {
  const seq = nextSeq()
  return {
    type: 'compaction/summary' as const,
    seq,
    time: 0,
    data: {
      compactionId: `comp-${seq}`,
      summary: [{ type: 'text', text }],
      shadowedRange: { start: shadowedSeqs[0]!, end: shadowedSeqs.at(-1)! },
      shadowedSeqs,
      shadowedTokenCount: 100,
      provider: 'test',
      model: 'test',
    },
  }
}

function resetSeq() {
  seqCounter = 0
}

/** 语义票会话事件（log-only non-surface；data.seq = 目标用户消息 seq）。 */
function verdict(targetSeq: number, v: 'new-task' | 'continue' = 'new-task', anchorText = '') {
  const seq = nextSeq()
  return {
    type: 'context-economy/judge-verdict' as const,
    seq,
    time: 0,
    data: { judgeId: `j:s1:${targetSeq}`, seq: targetSeq, verdict: v, anchorText },
  }
}

beforeEach(() => resetSeq())

describe('T0 显式边界', () => {
  it('user /task 直接开新段，旧段闭合，锚 = 段头原文', () => {
    const events = [
      user('帮我读文件'),
      user('/task 重构'),
    ]
    const state = fold(events)
    expect(state.tasks).toHaveLength(2)
    expect(state.tasks[0]!.status).toBe('closed')
    expect(state.tasks[1]!.taskId).toBe('task-重构')
    expect(state.tasks[1]!.anchorText).toBe('/task 重构')
    expect(state.current?.taskId).toBe('task-重构')
    expect(state.lastBoundary).toEqual({ taskId: 'task-重构' })
  })

  it('/task close 显式闭合，不产生新段', () => {
    const state = fold([user('/task 修 bug'), user('开始干'), user('/task close')])
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]!.status).toBe('closed')
    expect(state.current).toBeNull()
  })

  it('闭合后再来普通消息 → 隐式开新段', () => {
    const state = fold([user('/task 修 bug'), user('/task close'), user('现在做别的')])
    expect(state.tasks).toHaveLength(2)
    expect(state.tasks[1]!.status).toBe('active')
    expect(state.tasks[1]!.anchorText).toBe('现在做别的')
  })
})

describe('隐式开段 / 段推进（机械信号已退役）', () => {
  it('首条普通消息 → 隐式开段（anchorText = 段头原文）', () => {
    const state = fold([user('帮我全面审视一下项目架构')])
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]!.anchorText).toBe('帮我全面审视一下项目架构')
    expect(state.current).not.toBeNull()
  })

  it('后续普通消息（含方向否决措辞）→ 留在当前段（机械信号不再触发边界）', () => {
    const events: SessionEvent[] = [
      user('帮我做 A'),
      user('先别动手，方向不对，重新来'), // 旧 user-correction 措辞：v0.3.0 退役后不产生边界
      user('好的，继续'),
    ]
    const state = fold(events)
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]!.status).toBe('active')
    expect(state.current).not.toBeNull()
  })

  it('tool/todo/turn 事件不参与段判定（返回同一引用）', () => {
    const meh: SessionEvent[] = [
      { type: 'tool/call', seq: nextSeq(), time: 0, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } },
      { type: 'todo/write', seq: nextSeq(), time: 0, data: { todos: [{ content: 'a', status: 'completed' }] } },
      { type: 'turn/end', seq: nextSeq(), time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const state = taskProjectionDefinition.init()
    for (const e of meh) {
      expect(taskProjectionDefinition.apply(state, e)).toBe(state)
    }
  })
})

describe('表面位置与压缩替换', () => {
  it('surface append 记录位置；replace 后旧 seq 移出、新 seq 进入', () => {
    const events: SessionEvent[] = [
      user('第一段'),
      user('第二段'),
      user('压缩替换', 'replace', { start: 1, end: 2 }),
    ]
    const state = fold(events)
    expect(state.surfaceIndex[String(events[0]!.seq)]).toBeUndefined()
    expect(state.surfaceIndex[String(events[2]!.seq)]).toBe(0)
  })
})

describe('压缩摘要归档', () => {
  it('compaction/summary 按 shadowedSeqs 归属 task → summary 写入', () => {
    const events = [
      user('旧任务正文'),
      user('/task 新任务'),
    ]
    const summaryEvent = compactionSummary([events[0]!.seq], '旧任务的摘要：做了ABC')
    const state = fold([...events, summaryEvent])
    const oldTask = state.tasks.find(t => t.startSeq === events[0]!.seq)
    expect(oldTask?.summary).toBe('旧任务的摘要：做了ABC')
    expect(oldTask?.status).toBe('closed')
  })
})

describe('语义票合议（v0.8.0：verdict → 段内切分）', () => {
  it('new-task 切分：旧段闭合于前一条 surface，新段锚 = verdict 原文', () => {
    const state = fold([user('帮我读文件'), user('现在重构接口'), verdict(2, 'new-task', '现在重构接口')])
    expect(state.tasks).toHaveLength(2)
    expect(state.tasks[0]!.status).toBe('closed')
    expect(state.tasks[0]!.lastSurfaceSeq).toBe(1)
    expect(state.tasks[1]!.taskId).toBe('task-2')
    expect(state.tasks[1]!.anchorText).toBe('现在重构接口')
    expect(state.tasks[1]!.status).toBe('active')
    expect(state.current).toEqual({ taskId: 'task-2', startSeq: 2, lastSurfaceSeq: 2 })
    expect(state.lastBoundarySeq).toBe(2)
    expect(state.lastBoundary).toEqual({ taskId: 'task-2' })
  })

  it('verdict 迟到（后续消息已入旧段）→ 尾部随新段迁移', () => {
    const state = fold([
      user('帮我读文件'),
      user('现在重构接口'),
      user('先看下依赖'),
      verdict(2, 'new-task', '现在重构接口'),
    ])
    expect(state.tasks[0]!.status).toBe('closed')
    expect(state.tasks[0]!.lastSurfaceSeq).toBe(1)
    expect(state.tasks[1]!.taskId).toBe('task-2')
    expect(state.tasks[1]!.lastSurfaceSeq).toBe(3) // '先看下依赖'（seq 3）归入新段
    expect(state.current).toEqual({ taskId: 'task-2', startSeq: 2, lastSurfaceSeq: 3 })
  })

  it('verdict 早到 vs 迟到 → 边界事实一致（切分锚定不随折叠时序偏置）', () => {
    // 用显式 seq 构造（两份日志 seq 空间独立、完全对称）：
    // 早到 = verdict 落在后续消息之前；迟到 = verdict 落在后续消息之后。
    const m = (s: number, text: string): SessionEvent => ({
      type: 'user/message', seq: s, time: 0,
      data: { content: [{ type: 'text', text }], source: { kind: 'human' }, id: `m-${s}`, role: 'user' },
    })
    const v = (s: number, target: number, anchor: string): SessionEvent => ({
      type: 'context-economy/judge-verdict', seq: s, time: 0,
      data: { judgeId: `j:s1:${target}`, seq: target, verdict: 'new-task', anchorText: anchor },
    })
    const early = fold([m(1, '帮我读文件'), m(2, '现在重构接口'), v(3, 2, '现在重构接口'), m(4, '先看下依赖')])
    const late = fold([m(1, '帮我读文件'), m(2, '现在重构接口'), m(3, '先看下依赖'), v(4, 2, '现在重构接口')])
    const facts = (s: typeof early) => ({
      tasks: s.tasks.map(t => ({ status: t.status, anchor: t.anchorText })),
      currentAnchor: s.current
        ? s.tasks.find(t => t.taskId === s.current!.taskId)?.anchorText
        : null,
      boundary: s.lastBoundary,
    })
    expect(facts(early)).toEqual(facts(late))
    expect(early.lastBoundarySeq).toBe(2)
    expect(early.tasks[1]!.lastSurfaceSeq).toBe(4)
    expect(late.tasks[1]!.lastSurfaceSeq).toBe(3)
  })

  it('T0 权威 / 同 seq 不可切：verdict 落在段起 seq → no-op（同引用）', () => {
    const events = [user('/task 重构')]
    const before = fold(events)
    const after = taskProjectionDefinition.apply(before, verdict(1, 'new-task', '/task 重构'))
    expect(after).toBe(before)
  })

  it('verdict=continue → no-op（同引用）', () => {
    const before = fold([user('帮我读文件'), user('继续做')])
    const after = taskProjectionDefinition.apply(before, verdict(2, 'continue', ''))
    expect(after).toBe(before)
  })

  it('过期 verdict（目标在已闭合段）→ no-op（同引用）', () => {
    const before = fold([
      user('帮我读文件'), // 1 → task-1
      user('继续做'),    // 2
      user('/task close'), // 3 闭合
      user('换件事做'),  // 4 隐式开 task-4
    ])
    const after = taskProjectionDefinition.apply(before, verdict(2, 'new-task', '继续做'))
    expect(after).toBe(before)
  })

  it('不可定位 verdict（目标已被 replace 移出 surface）→ no-op（同引用）', () => {
    const stateBefore = fold([
      user('帮我读文件'),                 // seq 1, pos 0
      user('继续做'),                     // seq 2, pos 1
      user('压缩替换', 'replace', { start: 1, end: 2 }), // seq 3, pos 0；seq 1/2 移出 surface
    ])
    const after = taskProjectionDefinition.apply(stateBefore, verdict(1, 'new-task', '帮我读文件'))
    expect(after).toBe(stateBefore)
  })

  it('未装配判别器（无 verdict 事件）→ 行为与 v4 一致（fold 纯惰性）', () => {
    const state = fold([user('帮我读文件'), user('继续做')])
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]!.status).toBe('active')
  })
})

describe('契约守卫', () => {
  it('无兴趣事件返回同一引用', () => {
    const state = taskProjectionDefinition.init()
    const next = taskProjectionDefinition.apply(state, {
      type: 'assistant/chunk',
      seq: 999,
      time: 99999999, // 时间戳差异不影响判定
      data: { turn: 1, step: 1, chunk: { type: 'text', delta: 'x' } },
    } as never)
    expect(next).toBe(state)
  })

  it('状态过 stateSchema 校验', () => {
    const state = fold([user('hello')])
    expect(() => stateSchema.parse(state)).not.toThrow()
  })

  it('stateVersion = 5（v5: 语义票合议接入——verdict 会话事件 → 段内切分；旧 checkpoint 失效）', () => {
    expect(Number.isSafeInteger(taskProjectionDefinition.stateVersion)).toBe(true)
    expect(taskProjectionDefinition.stateVersion).toBe(5)
  })
})
/**
 * 投影 fold 单测（无 harness：纯 node 构造 SessionEvent 序列，不启动 DSH）。
 * 覆盖：T0 显式、簇迁移→分数合议→转正、fail-lazy、replace 重映射、摘要归档、
 * 契约守卫（同引用/stateSchema/stateVersion）、无时间戳依赖。
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

function toolCall(name: string, args: Record<string, unknown>) {
  const seq = nextSeq()
  return {
    type: 'tool/call' as const,
    seq,
    time: 0,
    data: { turn: 1, step: 1, callId: `c-${seq}`, name, arguments: JSON.stringify(args) },
  }
}

function turnEnd() {
  const seq = nextSeq()
  return {
    type: 'turn/end' as const,
    seq,
    time: 0,
    data: { turn: 1, reason: { kind: 'completed' } },
  }
}

function todoAllCompleted() {
  const seq = nextSeq()
  return {
    type: 'todo/write' as const,
    seq,
    time: 0,
    data: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }] },
  }
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

beforeEach(() => resetSeq())

describe('T0 显式边界', () => {
  it('user /task 直接开新 task（explicit），簇上下文重置', () => {
    const events = [
      user('帮我读文件'),
      toolCall('read', { file_path: 'src/a.ts' }),
      toolCall('read', { file_path: 'src/b.ts' }),
      user('/task 重构'),
    ]
    const state = fold(events)
    expect(state.tasks).toHaveLength(2)
    expect(state.tasks[0]!.status).toBe('closed')
    expect(state.tasks[1]!.kind).toBe('explicit')
    expect(state.tasks[1]!.taskId).toBe('task-重构')
    expect(state.current?.taskId).toBe('task-重构')
    expect(state.lastBoundary?.kind).toBe('explicit')
    expect(state.seenDirs).toEqual([]) // 新 task 簇重置
  })

  it('/task close 显式闭合，不产生新 task', () => {
    const state = fold([user('/task 修 bug'), user('开始干'), user('/task close')])
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]!.status).toBe('closed')
    expect(state.current).toBeNull()
  })
})

describe('T1 簇迁移 → 分数合议 → 转正', () => {
  it('file-cluster-shift（弱）+ user-correction（强）→ 边界转正', () => {
    const events: SessionEvent[] = [
      user('帮我做 A'),
      toolCall('read', { file_path: 'src/a.ts' }),
      toolCall('read', { file_path: 'src/b.ts' }),
      toolCall('read', { file_path: 'src/c.ts' }),
      toolCall('read', { file_path: 'rust/x.rs' }),
      toolCall('read', { file_path: 'rust/y.rs' }),
      toolCall('read', { file_path: 'rust/z.rs' }),
      user('先别动手，方向不对，重新来'), // 用户方向否决（强）
      turnEnd(),
    ]
    const state = fold(events)
    expect(state.tasks).toHaveLength(2)
    expect(state.tasks[1]!.evidence).toContain('user-correction')
    expect(state.tasks[1]!.kind).toBe('signals')
  })

  it('仅 file-cluster-shift（弱）不单独触发——需用户方向否定（fail-lazy）', () => {
    const events: SessionEvent[] = [
      user('帮我做 A'),
      toolCall('read', { file_path: 'src/a.ts' }),
      toolCall('read', { file_path: 'src/b.ts' }),
      toolCall('read', { file_path: 'src/c.ts' }),
      toolCall('read', { file_path: 'rust/x.rs' }),
      toolCall('read', { file_path: 'rust/y.rs' }),
      toolCall('read', { file_path: 'rust/z.rs' }),
      user('继续读文件'), // 无否决
      turnEnd(),
    ]
    const state = fold(events)
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]!.status).toBe('active')
    expect(state.current).not.toBeNull()
  })

  it('仅切换到新目录少数文件 → 不触发（fail-lazy 维持当前 task）', () => {
    const events: SessionEvent[] = [
      user('帮我做 A'),
      toolCall('read', { file_path: 'src/a.ts' }),
      toolCall('read', { file_path: 'rust/x.rs' }), // 单文件新目录
      toolCall('read', { file_path: 'src/b.ts' }),  // 回到 src
      turnEnd(),
    ]
    const state = fold(events)
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]!.status).toBe('active')
    expect(state.current).not.toBeNull()
  })

  it('todo 完成（弱信号）+ lexical（弱信号）→ 不转正', () => {
    const events: SessionEvent[] = [
      user('做任务'),
      todoAllCompleted(),
      user('接下来继续当前工作'), // lexical hint? '接下来' 命中
      turnEnd(),
    ]
    const state = fold(events)
    // 弱信号组合 0.5+0.5=1.0 < 1.5 → fail-lazy
    expect(state.tasks).toHaveLength(1)
    expect(state.current).not.toBeNull()
  })
})

describe('fail-lazy', () => {
  it('证据不足（无信号）→ turn/end 不动，维持当前 task', () => {
    const events: SessionEvent[] = [
      user('帮我做 A'),
      toolCall('read', { file_path: 'src/a.ts' }),
      turnEnd(),
    ]
    const state = fold(events)
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]!.status).toBe('active')
    expect(state.current).not.toBeNull()
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

describe('实测回归样本（card-b5f9 真实会话提炼）', () => {
  it('T2 战斗界面：用户方向否决（"先别动手，完全不够放开"）→ 命中边界', () => {
    const events: SessionEvent[] = [
      user('现在R12执行完毕……再次为我进行一次计划R12的落地'),
      toolCall('read', { file_path: 'src/ui/battle.ts' }),
      toolCall('edit', { file_path: 'src/ui/battle.ts' }),
      toolCall('read', { file_path: 'src/ui/selector.ts' }),
      user('先别动手，我觉得你完全不够放开，思路太笨了。为什么不把选择器做成拟物筹码？'),
      user('好的，就这么修复吧'),
      turnEnd(),
    ]
    const state = fold(events)
    // 用户否决（强）+ 文件探索（弱）→ 边界成立
    expect(state.tasks).toHaveLength(2)
    expect(state.tasks[1]!.evidence).toContain('user-correction')
  })

  it('T6 架构审查：正常新指令（"帮我全面审视"）不触发当前强信号（已知局限，记录之）', () => {
    const events: SessionEvent[] = [
      user('帮我全面审视一下当前项目的架构是否干净，边界清晰，组件复用度，可维护性高，并为我报告'),
      toolCall('read', { file_path: 'src/main.ts' }),
      toolCall('read', { file_path: 'src/ui/app.ts' }),
      turnEnd(),
    ]
    const state = fold(events)
    // 当前机械强信号=user-correction；正常新指令无否决词 → 不判边界（fail-lazy 保守）
    // 这是已知局限（正常新指令漏检），固化防止未来无意识"变好"或"倒退"。
    expect(state.tasks).toHaveLength(1)
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

  it('stateVersion 为非负整数且 =2（v2: 分数制+簇迁移，旧 checkpoint 行失效）', () => {
    expect(Number.isSafeInteger(taskProjectionDefinition.stateVersion)).toBe(true)
    expect(taskProjectionDefinition.stateVersion).toBe(2)
  })
})

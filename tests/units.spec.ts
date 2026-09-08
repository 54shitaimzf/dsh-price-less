/**
 * P8 分划单位状态机测试（docs/implement/archive/P8-units-prefix.md §3.5）。
 * 全部 fake 事实/事件，零 cordis 运行时 import。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { foldSegmentState, JUDGE_VERDICT_FACT_TYPE, type SegmentFoldOptions } from '../src/core/units.ts'
import { TASK_BOUNDARY_FACT_TYPE, foldCommon, factsFromSessionEvents } from '../src/core/ledger/index.ts'
import type { CommonLedger, LedgerFact, LedgerSessionEvent } from '../src/core/ledger/index.ts'

const fact = (type: string, seq: number, data: unknown, time = seq): LedgerFact => ({ type, seq, time, data })

describe('foldSegmentState', () => {
  it('无事实：恒 1 段 task-1，指标为零', () => {
    const state = foldSegmentState([])
    expect(state.segments).toHaveLength(1)
    expect(state.segments[0]!.taskId).toBe('task-1')
    expect(state.taskCount).toBe(1)
    expect(state.segmentsPerSession).toBe(1)
    expect(state.taskSwitchRate).toBe(0)
  })

  it('P2 兼容：close 事实命名被闭合段并开启自动尾段', () => {
    const state = foldSegmentState([fact(TASK_BOUNDARY_FACT_TYPE, 14, { taskId: 'task-1' })], { stepStartCount: 2 })
    expect(state.segments).toHaveLength(2)
    expect(state.segments[0]).toMatchObject({ taskId: 'task-1', endSeq: 14, closed: true, switchReason: 't0-close' })
    expect(state.segments[1]).toMatchObject({ taskId: 'task-2', startSeq: 14, closed: false })
    expect(state.taskCount).toBe(2)
    expect(state.taskSwitchRate).toBe(0.5)
  })

  it('T0 open：闭合当前段、开启指定 taskId 新段', () => {
    const state = foldSegmentState([fact(TASK_BOUNDARY_FACT_TYPE, 5, { boundary: 'open', taskId: 'task-build' })])
    expect(state.segments[0]).toMatchObject({ taskId: 'task-1', endSeq: 5, closed: true, switchReason: 't0-open' })
    expect(state.segments[1]).toMatchObject({ taskId: 'task-build', startSeq: 5, closed: false, switchReason: 't0-open' })
    expect(state.taskCount).toBe(2)
  })

  it('T0 close 缺 taskId：当前段保持 task-1，尾段自动 task-2', () => {
    const state = foldSegmentState([fact(TASK_BOUNDARY_FACT_TYPE, 9, {})])
    expect(state.segments[0]).toMatchObject({ taskId: 'task-1', endSeq: 9, closed: true, switchReason: 't0-close' })
    expect(state.segments[1]).toMatchObject({ taskId: 'task-2', startSeq: 9, closed: false })
  })

  it('verdict new-task：旧段闭合于 anchorSeq-1，新段以判定消息为段头', () => {
    const state = foldSegmentState([fact(JUDGE_VERDICT_FACT_TYPE, 99, { verdict: 'new-task', anchorSeq: 10, taskId: 'task-verify' })])
    expect(state.segments).toHaveLength(2)
    expect(state.segments[0]).toMatchObject({ endSeq: 9, closed: true, switchReason: 'verdict-new-task' })
    expect(state.segments[1]).toMatchObject({ taskId: 'task-verify', startSeq: 10, closed: false, switchReason: 'verdict-new-task' })
  })

  it('verdict 非 new-task：不参与切分', () => {
    const state = foldSegmentState([fact(JUDGE_VERDICT_FACT_TYPE, 10, { verdict: 'continue', anchorSeq: 10 })])
    expect(state.segments).toHaveLength(1)
    expect(state.taskCount).toBe(1)
  })

  it('T0 优先：verdict 落在 T0 新段起 seq 时 no-op', () => {
    const facts = [
      fact(TASK_BOUNDARY_FACT_TYPE, 10, { boundary: 'open', taskId: 'task-a' }),
      fact(JUDGE_VERDICT_FACT_TYPE, 11, { verdict: 'new-task', anchorSeq: 10, taskId: 'task-b' }),
    ]
    const state = foldSegmentState(facts)
    expect(state.segments).toHaveLength(2)
    expect(state.segments[1]).toMatchObject({ taskId: 'task-a', startSeq: 10 })
    expect(state.segments[1]!.closed).toBe(false)
  })

  it('确定性：同一输入连续 3 次输出逐字节一致', () => {
    const facts = [
      fact(TASK_BOUNDARY_FACT_TYPE, 5, { boundary: 'open', taskId: 'task-build' }),
      fact(JUDGE_VERDICT_FACT_TYPE, 6, { verdict: 'new-task', anchorSeq: 10, taskId: 'task-verify' }),
    ]
    const a = JSON.stringify(foldSegmentState(facts))
    const b = JSON.stringify(foldSegmentState(facts))
    const c = JSON.stringify(foldSegmentState(facts))
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('foldCommon 集成：P2 fixture 回放 taskCount 仍为 2 且其余字段与既有 expected 一致', () => {
    const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures/ledger', name), 'utf8')
    const events = JSON.parse(fixture('session-events.json')) as LedgerSessionEvent[]
    const mirrorFacts = JSON.parse(fixture('mirror-facts.json')) as LedgerFact[]
    const expected = JSON.parse(fixture('session-events.expected.json')) as CommonLedger
    const pricing = JSON.parse(fixture('pricing.json'))
    const fromSession = foldCommon(events, { facts: factsFromSessionEvents(events), pricing, successfulTaskCount: 2 })
    const fromMirror = foldCommon(events, { facts: mirrorFacts, pricing, successfulTaskCount: 2 })
    expect(fromSession.taskCount).toBe(2)
    expect(fromMirror.taskCount).toBe(2)
    expect(fromSession).toEqual(expected)
    expect(fromMirror).toEqual(expected)
  })
})

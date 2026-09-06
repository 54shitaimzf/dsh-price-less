/**
 * harness 真集成（P1 工单 §5 单一真集成点；工单明示，其余测试全 fake）。
 * 前置 = junction 在位（build.sh 链接 @deepseek-ai/dsh-session / -persistence 等）；
 * 缺失时整文件 skip（环境问题，禁 npm install 补装——P0 §6-6 同款）。
 *
 * ① 真实 Context + SessionStore → session.append → firehose → 泵派发（H1 过滤 + H7 透传）。
 * ② 缺口回归测试（P1 工单 §2.4-⑤ 证据链可复核）：未知类型事件无 `ignorable` 标记 →
 *    validateStoredEvents 拒读整条日志（= 砖掉会话重载）；带 `ignorable: true` → 安全阀放行。
 *    这就是 emitCeFact fail-closed 的存在理由；LogIntent 补丁（工单阶段 3）落地后回环升级。
 */
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { createEventPump } from '../src/platform/events.ts'
import { emitCeFact } from '../src/platform/logger.ts'

const hasRuntime = existsSync('node_modules/@deepseek-ai/dsh-session')
  && existsSync('node_modules/@deepseek-ai/dsh-session-persistence')

const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)))

describe.skipIf(!hasRuntime)('harness 真集成（junction 在位时）', () => {
  it('SessionStore append → firehose → 泵派发：H1 过滤 + H7 透传', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const pump = createEventPump(ctx)
    const input: Array<{ text: string; seq: number }> = []
    const metrics: string[] = []
    pump.on('input/user-message', (p) => void input.push({ text: p.text, seq: p.seq }))
    pump.on('metrics/session-event', (p) => void metrics.push(p.event.type))

    const session = ctx.sessions.create()
    session.append('user/message', {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'real prompt' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'demo', arguments: '{}' })
    session.append('turn/start', { turn: 1 }) // 非 face 事件 → 两面均不派发
    await flush()

    expect(input).toEqual([{ text: 'real prompt', seq: 0 }])
    expect(metrics).toEqual(['tool/call'])
    pump.dispose()
  })

  it('缺口回归：未知类型无 ignorable 被拒读；带 ignorable: true 安全阀放行', () => {
    const meta = { id: 'spec-session', version: 2 } as never
    const unknownEvent = (ignorable?: true) => [{
      type: 'context-economy/test-probe',
      seq: 0,
      time: 1,
      data: { probe: 1 },
      ...(ignorable ? { ignorable: true } : {}),
    }]
    expect(() => validateStoredEvents(meta, unknownEvent() as never)).toThrow(/unknown to this harness/)
    expect(validateStoredEvents(meta, unknownEvent(true) as never)).toHaveLength(1)
  })

  it('回环（P1 工单 §8-4）：emitCeFact → append ignorable:true → snapshotEvents 可见 → validateStoredEvents 放行', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    // harness-session.spec 不在 typecheck:tests 面内（词汇合并声明在 ce-logger.spec）——轻转型调用
    ;(emitCeFact as (s: unknown, t: string, d: unknown) => void)(session, 'context-economy/test-probe', { probe: 'round-trip' })
    const event = session.snapshotEvents().at(-1)
    expect(event?.type).toBe('context-economy/test-probe')
    expect(event?.ignorable).toBe(true)
    // 带标记的未知类型通过存储契约校验 = 会话日志可重载（fail-closed 缺口已闭合的机械证明）
    const meta = { id: session.header.id, version: 2 } as never
    expect(validateStoredEvents(meta, [event] as never)).toHaveLength(1)
  })
})

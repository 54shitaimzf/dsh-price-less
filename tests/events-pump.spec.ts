/**
 * events-pump 单测（P1 工单 §5，FakeCtx 手写，零 cordis 运行时依赖）：
 * 输入面五条件过滤、H7 metrics 透传、异步旁路队列语义（FIFO 保序、异常遏制、
 * dispose/dropped、stats）、同输入同派发序（确定性）。u≥1 归 P8（工单 §2.4-①）。
 */
import { describe, expect, it } from 'vitest'
import { createEventPump, METRICS_FACE_TYPES, passesInputFace } from '../src/platform/events.ts'

interface FakeEvent { type: string; seq: number; time: number; data: any; surfaceOp?: string }
interface FakeSession { header: { origin?: string } }

const makeSession = (origin?: string): FakeSession => ({ header: { origin } })

/** 构造 user/message 会话事件（形状按 harness SessionEvent 信封；surfaceOp 仅在显式给出时携带）。 */
const userMsg = (seq: number, opts: { kind?: string; surfaceOp?: string; blocks?: Array<{ type: string; text?: string }> } = {}): FakeEvent => ({
  type: 'user/message',
  seq,
  time: 1000 + seq,
  data: { role: 'user', source: { kind: opts.kind ?? 'user' }, content: opts.blocks ?? [{ type: 'text', text: 'hello' }] },
  ...('surfaceOp' in opts ? { surfaceOp: opts.surfaceOp } : { surfaceOp: 'append' }),
})

const otherEvent = (type: string, seq: number): FakeEvent => ({ type, seq, time: 1000 + seq, data: { turn: 1 } })

/** 微任务排空（泵 schedule 用 queueMicrotask；双 tick 保证 drain 完成后再断言）。 */
const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)))

/**
 * FakeCtx：只实现 pump 用到的 ctx.on（记录监听器，手动触发 firehose）。
 * snapshotDispatch=true 时 unlisten 不阻止已在途的派发（模拟 cordis「监听器快照先于
 * 回调解析」的竞态——dropped 计数的真实语义场景）。
 */
function makeFakeCtx(opts: { snapshotDispatch?: boolean } = {}) {
  let listener: ((session: FakeSession, event: FakeEvent) => void) | undefined
  const ctx = {
    on: (_name: string, fn: (session: FakeSession, event: FakeEvent) => void) => {
      listener = fn
      return () => { if (!opts.snapshotDispatch) listener = undefined }
    },
  }
  const fire = (session: FakeSession, event: FakeEvent) => listener?.(session, event)
  return { ctx, fire, isListening: () => listener !== undefined }
}

describe('输入面过滤（02 §2 五条件；docs/10 §1 H1）', () => {
  it('正例：user/message append + kind=user + 主会话 + 文本非空 → input/user-message', async () => {
    const { ctx, fire } = makeFakeCtx()
    const pump = createEventPump(ctx as never)
    const seen: Array<{ text: string; seq: number }> = []
    pump.on('input/user-message', (p) => void seen.push({ text: p.text, seq: p.seq }))
    const session = makeSession()
    fire(session, userMsg(3))
    await flush()
    expect(seen).toEqual([{ text: 'hello', seq: 3 }])
    pump.dispose()
  })

  it('条件①：非 user/message 事件不进输入面', async () => {
    const { ctx, fire } = makeFakeCtx()
    const pump = createEventPump(ctx as never)
    const seen: unknown[] = []
    pump.on('input/user-message', (p) => void seen.push(p))
    fire(makeSession(), otherEvent('turn/start', 1))
    await flush()
    expect(seen).toEqual([])
    pump.dispose()
  })

  it('条件②：replace（非 append）排除', async () => {
    const { ctx, fire } = makeFakeCtx()
    const pump = createEventPump(ctx as never)
    const seen: unknown[] = []
    pump.on('input/user-message', (p) => void seen.push(p))
    fire(makeSession(), userMsg(4, { surfaceOp: 'replace' }))
    fire(makeSession(), userMsg(5, { surfaceOp: undefined })) // 信封无 surfaceOp 的日志事件
    await flush()
    expect(seen).toEqual([])
    pump.dispose()
  })

  it('条件③：source.kind 非 user（plugin 伪 user）排除', async () => {
    const { ctx, fire } = makeFakeCtx()
    const pump = createEventPump(ctx as never)
    const seen: unknown[] = []
    pump.on('input/user-message', (p) => void seen.push(p))
    fire(makeSession(), userMsg(6, { kind: 'plugin' }))
    await flush()
    expect(seen).toEqual([])
    pump.dispose()
  })

  it('条件④：子代理会话（origin=subagent）排除', async () => {
    const { ctx, fire } = makeFakeCtx()
    const pump = createEventPump(ctx as never)
    const seen: unknown[] = []
    pump.on('input/user-message', (p) => void seen.push(p))
    fire(makeSession('subagent'), userMsg(7))
    await flush()
    expect(seen).toEqual([])
    pump.dispose()
  })

  it('条件⑤：空文本排除（无 text block / 纯空白）', async () => {
    const { ctx, fire } = makeFakeCtx()
    const pump = createEventPump(ctx as never)
    const seen: unknown[] = []
    pump.on('input/user-message', (p) => void seen.push(p))
    fire(makeSession(), userMsg(8, { blocks: [] }))
    fire(makeSession(), userMsg(9, { blocks: [{ type: 'text', text: '   ' }] }))
    fire(makeSession(), userMsg(10, { blocks: [{ type: 'reasoning', text: 'thinking' } as never] }))
    await flush()
    expect(seen).toEqual([])
    pump.dispose()
  })

  it('passesInputFace 纯函数直测：同输入同输出、无状态', () => {
    const event = userMsg(11) as never
    expect(passesInputFace(undefined, event)).toBe(true)
    expect(passesInputFace(undefined, event)).toBe(true)
    expect(passesInputFace('subagent', event)).toBe(false)
  })
})

describe('H7 metrics 透传（docs/10 §1 H7）', () => {
  it('六类 face 事件全部透传（frozen 原事件引用）', async () => {
    const { ctx, fire } = makeFakeCtx()
    const pump = createEventPump(ctx as never)
    const seen: FakeEvent[] = []
    pump.on('metrics/session-event', (p) => void seen.push(p.event as never))
    const session = makeSession()
    const fired: FakeEvent[] = []
    for (const type of METRICS_FACE_TYPES) {
      const ev = otherEvent(type, fired.length + 1)
      fired.push(ev)
      fire(session, ev)
    }
    await flush()
    expect(seen).toEqual(fired) // 同引用透传
    pump.dispose()
  })

  it('非 face 事件（如 turn/start）静默', async () => {
    const { ctx, fire } = makeFakeCtx()
    const pump = createEventPump(ctx as never)
    const seen: unknown[] = []
    pump.on('metrics/session-event', (p) => void seen.push(p))
    fire(makeSession(), otherEvent('turn/start', 1))
    fire(makeSession(), otherEvent('session/created', 2))
    await flush()
    expect(seen).toEqual([])
    pump.dispose()
  })
})

describe('异步旁路队列（docs/11 §4 纪律②）', () => {
  it('FIFO 保序：多事件按到达顺序派发', async () => {
    const { ctx, fire } = makeFakeCtx()
    const pump = createEventPump(ctx as never)
    const order: number[] = []
    pump.on('metrics/session-event', (p) => void order.push((p.event as unknown as FakeEvent).seq))
    const session = makeSession()
    fire(session, otherEvent('step/start', 1))
    fire(session, otherEvent('step/end', 2))
    fire(session, otherEvent('tool/call', 3))
    await flush()
    expect(order).toEqual([1, 2, 3])
    pump.dispose()
  })

  it('handler 异常遏制：先抛的 handler 不影响后续 handler 与后续事件', async () => {
    const { ctx, fire } = makeFakeCtx()
    const pump = createEventPump(ctx as never)
    const calls: string[] = []
    pump.on('input/user-message', () => { throw new Error('boom') })
    pump.on('input/user-message', (p) => void calls.push(`ok:${p.seq}`))
    const session = makeSession()
    fire(session, userMsg(1))
    fire(session, userMsg(2))
    await flush()
    expect(calls).toEqual(['ok:1', 'ok:2'])
    expect(pump.stats().listenerErrors).toBe(2)
    expect(pump.stats().dispatched).toBe(2)
    pump.dispose()
  })

  it('dispose：清队列、停派发；在途快照派发到达计 dropped', async () => {
    const { ctx, fire } = makeFakeCtx({ snapshotDispatch: true }) // 模拟 cordis 在途派发竞态
    const pump = createEventPump(ctx as never)
    const seen: unknown[] = []
    pump.on('metrics/session-event', (p) => void seen.push(p))
    fire(makeSession(), otherEvent('step/start', 1)) // 已入队未派发
    pump.dispose()
    fire(makeSession(), otherEvent('step/end', 2)) // dispose 后经在途快照到达
    await flush()
    expect(seen).toEqual([])
    expect(pump.stats().dropped).toBe(1)
    expect(pump.stats().enqueued).toBe(1)
    expect(pump.stats().depth).toBe(0)
  })

  it('退订：on() 返回的退订函数生效（排空后再退订，后续事件不派发）', async () => {
    const { ctx, fire } = makeFakeCtx()
    const pump = createEventPump(ctx as never)
    const seen: unknown[] = []
    const off = pump.on('metrics/session-event', (p) => void seen.push(p))
    fire(makeSession(), otherEvent('step/start', 1))
    await flush()
    expect(seen).toHaveLength(1)
    off()
    fire(makeSession(), otherEvent('step/end', 2))
    await flush()
    expect(seen).toHaveLength(1)
    pump.dispose()
  })

  it('stats 计数：enqueued/dispatched/depth', async () => {
    const { ctx, fire } = makeFakeCtx()
    const pump = createEventPump(ctx as never)
    pump.on('metrics/session-event', () => undefined)
    const session = makeSession()
    fire(session, otherEvent('step/start', 1))
    expect(pump.stats().depth).toBe(1) // 微任务排空前已入队
    fire(session, otherEvent('step/end', 2))
    expect(pump.stats().enqueued).toBe(2)
    await flush()
    expect(pump.stats().dispatched).toBe(2)
    expect(pump.stats().depth).toBe(0)
    pump.dispose()
  })

  it('确定性：同输入跑两遍，派发序逐项相同', async () => {
    const run = async () => {
      const { ctx, fire } = makeFakeCtx()
      const pump = createEventPump(ctx as never)
      const log: string[] = []
      pump.on('input/user-message', (p) => void log.push(`in:${p.seq}`))
      pump.on('metrics/session-event', (p) => void log.push(`m:${(p.event as unknown as FakeEvent).type}`))
      const session = makeSession()
      fire(session, otherEvent('step/start', 1))
      fire(session, userMsg(2))
      fire(session, userMsg(3, { kind: 'plugin' })) // 被过滤
      fire(session, otherEvent('tool/result', 4))
      await flush()
      pump.dispose()
      return log
    }
    expect(await run()).toEqual(await run())
  })
})

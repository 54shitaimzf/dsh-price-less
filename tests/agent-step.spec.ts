/**
 * P19a H2 步准入端口单测（docs/implement/archive/P19-boundary-path.md §5；docs/10 §1 H2）。
 * 覆盖：回调载荷 / 恒 return next() / 异常遏制 / signal 中止跳过 / 退订。
 */
import { describe, expect, it } from 'vitest'
import { onAgentPreStep, onAgentRequestError, type AgentPreStepPayload, type AgentRequestErrorPayload } from '../src/platform/agent-step.ts'

type Listener = (payload: unknown, next: () => Promise<string>) => Promise<string>

function makeCtx() {
  let listener: Listener | undefined
  let offCalled = 0
  const ctx = {
    on(_name: string, fn: Listener) {
      listener = fn
      return () => { offCalled++; listener = undefined }
    },
  }
  const fire = (payload: unknown, next: () => Promise<string> = async () => 'next'): Promise<string> => {
    if (listener === undefined) throw new Error('listener not registered')
    return listener(payload, next)
  }
  return { ctx, fire, offCalled: () => offCalled }
}

const payload = (over: Partial<{ session: unknown; turn: number; step: number; aborted: boolean }> = {}) => ({
  agent: { session: over.session ?? { id: 's1' } },
  messages: [],
  turn: over.turn ?? 7,
  step: over.step ?? 2,
  signal: { aborted: over.aborted ?? false },
})

describe('P19a H2 步准入端口', () => {
  it('回调收到 session/turn/step；waterfall 恒 return next()', async () => {
    const { ctx, fire } = makeCtx()
    const seen: AgentPreStepPayload[] = []
    onAgentPreStep(ctx as never, { handler: (p) => { seen.push(p) } })
    const decision = await fire(payload())
    expect(decision).toBe('next')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ turn: 7, step: 2 })
    expect(seen[0]!.session).toMatchObject({ id: 's1' })
  })

  it('A：载荷 userTexts = 本步即将落会话的用户消息；回调未 resolve 前 next() 不得被调用', async () => {
    const { ctx, fire } = makeCtx()
    const seen: AgentPreStepPayload[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    onAgentPreStep(ctx as never, { handler: async (p) => { seen.push(p); await gate } })
    let nextCalled = false
    const done = fire(
      {
        ...payload(),
        messages: [
          { role: 'user', content: [{ type: 'text', text: '第一条' }], source: { kind: 'user' } },
          // 非用户来源的同型 user/message（AGENTS 注入 / 插件通知）——**不得**进 userTexts
          { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }], source: { kind: 'agent-instructions' } },
          { role: 'user', content: [{ type: 'text', text: '第二条' }], source: { kind: 'user' } },
          { role: 'user', content: [{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'x' } }], source: { kind: 'user' } },
        ],
      },
      async () => { nextCalled = true; return 'next' },
    )
    await Promise.resolve()
    await Promise.resolve()
    // 只收文本非空的消息（图片块 → 无文本 → 不进 userTexts）
    expect(seen[0]!.userTexts).toEqual(['第一条', '第二条'])
    // 阻塞证明：回调还挂在 gate 上时，waterfall 尚未放行（F2 边界压缩靠这一点压在第一模型调用之前）
    expect(nextCalled).toBe(false)
    release?.()
    await expect(done).resolves.toBe('next')
    expect(nextCalled).toBe(true)
  })

  it('回调异常只 warn 不外溢，仍放行下一步', async () => {
    const { ctx, fire } = makeCtx()
    const warnings: unknown[][] = []
    onAgentPreStep(ctx as never, {
      handler: () => { throw new Error('boom') },
      logger: { info() {}, warn: (...args: unknown[]) => { warnings.push(args) }, error() {} },
    })
    await expect(fire(payload())).resolves.toBe('next')
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]![0])).toContain('fail-lazy')
  })

  it('异步回调被等待；signal 中止时跳过回调', async () => {
    const { ctx, fire } = makeCtx()
    let finished = false
    onAgentPreStep(ctx as never, { handler: async () => { await Promise.resolve(); finished = true } })
    await fire(payload())
    expect(finished).toBe(true)
    const { ctx: ctx2, fire: fire2 } = makeCtx()
    let called = 0
    onAgentPreStep(ctx2 as never, { handler: () => { called++ } })
    await fire2(payload({ aborted: true }))
    expect(called).toBe(0)
  })

  it('退订后监听器注销', () => {
    const { ctx, offCalled } = makeCtx()
    const off = onAgentPreStep(ctx as never, { handler: () => {} })
    off()
    expect(offCalled()).toBe(1)
  })
})

const errorPayload = (over: Partial<{ session: unknown; turn: number; step: number; provider: string; code: string; aborted: boolean }> = {}) => ({
  agent: { session: over.session ?? { id: 's1' } },
  turn: over.turn ?? 7,
  step: over.step ?? 2,
  provider: over.provider ?? 'p',
  failure: { code: over.code ?? 'X', message: 'boom' },
  signal: { aborted: over.aborted ?? false },
})

describe('P20b H3 请求失败端口', () => {
  it('载荷归一（failureCode）+ 非接管恒 next()', async () => {
    const { ctx, fire } = makeCtx()
    const seen: AgentRequestErrorPayload[] = []
    onAgentRequestError(ctx as never, { handler: (p) => { seen.push(p); return 'pass' } })
    const decision = await fire(errorPayload({ code: 'CONTEXT_WINDOW_EXCEEDED' }))
    expect(decision).toBe('next')
    expect(seen[0]).toMatchObject({ turn: 7, step: 2, provider: 'p', failureCode: 'CONTEXT_WINDOW_EXCEEDED' })
  })

  it('接管：返回 retry 且不调 next()', async () => {
    const { ctx, fire } = makeCtx()
    onAgentRequestError(ctx as never, { handler: () => 'retry' })
    let nextCalled = 0
    const decision = await fire(errorPayload(), async () => { nextCalled++; return 'next' })
    expect(decision).toEqual({ kind: 'retry' })
    expect(nextCalled).toBe(0)
  })

  it('回调异常只 warn 并委派上游；signal 中止时直接委派', async () => {
    const { ctx, fire } = makeCtx()
    const warnings: unknown[][] = []
    onAgentRequestError(ctx as never, {
      handler: () => { throw new Error('boom') },
      logger: { info() {}, warn: (...args: unknown[]) => { warnings.push(args) }, error() {} },
    })
    await expect(fire(errorPayload())).resolves.toBe('next')
    expect(warnings).toHaveLength(1)
    const { ctx: ctx2, fire: fire2 } = makeCtx()
    let called = 0
    onAgentRequestError(ctx2 as never, { handler: () => { called++; return 'retry' } })
    await fire2(errorPayload({ aborted: true }))
    expect(called).toBe(0)
  })
})

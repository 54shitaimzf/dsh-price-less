/**
 * client apply 冒烟（P1.2 地基修补）——settings.plugin.item 槽注册/订阅/卸载净的离线替身。
 * FakeCtx 手写（零 cordis 运行时依赖；被测对象 = 真实 client/index.ts 的 apply）。
 * 真浏览器挂载仍属用户核验项；本 spec 只锁「注册面正确 + client 半边可卸载」的机械部分。
 */
import { describe, expect, it, vi } from 'vitest'
import { CONTEXT_ECONOMY_NS, apply } from '../client/index.ts'

interface Registration {
  options: { name?: string; key?: string; inject?: () => unknown }
  component: unknown
  inject: () => unknown
}

function makeClientCtx() {
  const unsubs: Array<() => void> = []
  const disposers: Array<() => void> = []
  const registrations: Registration[] = []
  const slotsCalls: string[] = []
  const remoteEvents: string[] = []
  const connectionEvents: string[] = []

  const scope = {
    getSnapshot: () => ({
      status: 'ready' as const,
      value: {},
      base: {},
      user: {},
      revision: 1,
      writable: true,
    }),
    subscribe: vi.fn(() => {
      const unsub = () => { unsubs.splice(unsubs.indexOf(unsub), 1) }
      unsubs.push(unsub)
      return unsub
    }),
    mutate: vi.fn(async () => {}),
  }
  const session = {
    modelCatalog: vi.fn(async () => ({
      ok: true as const,
      value: { groups: [], failures: [] },
    })),
  }
  const remote = {
    session,
    $on: vi.fn((name: string, _fn: unknown) => {
      remoteEvents.push(name)
      const unsub = () => { unsubs.splice(unsubs.indexOf(unsub), 1) }
      unsubs.push(unsub)
      return unsub
    }),
  }
  const slots = {
    inject: vi.fn((name: string, init: () => Generator<Registration> | Registration) => {
      slotsCalls.push(name)
      const result = init()
      if (result !== null && typeof result === 'object' && Symbol.iterator in result) {
        for (const reg of result as Generator<Registration>) registrations.push(reg)
      } else {
        registrations.push(result as Registration)
      }
      return () => {}
    }),
    register: vi.fn((options: Registration['options'], component: unknown) => ({
      options,
      component,
      inject: options.inject ?? (() => ({} as unknown)),
    })),
  }
  const ctx = {
    slots,
    settingsScope: { bind: vi.fn(() => scope) },
    remote,
    on: vi.fn((name: string, _fn: unknown) => {
      connectionEvents.push(name)
      const unsub = () => { unsubs.splice(unsubs.indexOf(unsub), 1) }
      unsubs.push(unsub)
      return unsub
    }),
    effect: vi.fn((fn: () => unknown) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
      return disposer
    }),
  }

  const runAllCleanup = () => {
    for (const unsub of [...unsubs]) unsub()
    for (const disposer of [...disposers]) disposer()
    for (const disposer of [...disposers]) disposer() // 幂等容错
  }

  return { ctx, registrations, slotsCalls, remoteEvents, connectionEvents, session, runAllCleanup }
}

const flush = async () => { await Promise.resolve(); await Promise.resolve() }

describe('client apply 冒烟（P1.2）', () => {
  it('槽注册面正确：settings.plugin.item + key=context-economy + face/actions 完整', () => {
    const { ctx, registrations, slotsCalls } = makeClientCtx()
    expect(() => apply(ctx as never)).not.toThrow()
    expect(slotsCalls).toEqual(['settings.plugin.item'])
    expect(registrations).toHaveLength(1)
    const reg = registrations[0]!
    expect(reg.options).toMatchObject({ name: 'settings.plugin.item', key: CONTEXT_ECONOMY_NS })
    expect(reg.component).toBeTypeOf('function')
    const face = reg.inject() as { hooks?: { economyCard?: unknown }; save?: unknown; edit?: unknown }
    expect(face.hooks?.economyCard).toBeTruthy()
    for (const action of ['edit', 'resetField', 'restoreDefaults', 'retryCatalog', 'save', 'discard'] as const) {
      expect(face[action]).toBeTypeOf('function')
    }
  })

  it('订阅面完整：scope/模型目录 + llm/adapters-updated + settings/document-updated + connection/reset', async () => {
    const { ctx, remoteEvents, connectionEvents, session } = makeClientCtx()
    apply(ctx as never)
    await flush()
    expect(session.modelCatalog).toHaveBeenCalledTimes(1)
    expect(remoteEvents).toEqual(['llm/adapters-updated', 'settings/document-updated'])
    expect(connectionEvents).toEqual(['connection/reset'])
  })

  it('卸载净：全部 disposer/退订幂等执行，无异常、目录晚到不爆炸', async () => {
    const { ctx, runAllCleanup } = makeClientCtx()
    apply(ctx as never)
    await flush()
    expect(() => runAllCleanup()).not.toThrow()
    // dispose 后模型目录仍可安全刷新（controller 已屏蔽晚到结算）
    expect(() => {
      const listeners = (ctx.remote as never as { $on: { mock: { calls: Array<[string, unknown]> } } }).$on.mock.calls
      const refresh = listeners.find(([name]) => name === 'llm/adapters-updated')?.[1] as (() => void) | undefined
      refresh?.()
    }).not.toThrow()
  })
})

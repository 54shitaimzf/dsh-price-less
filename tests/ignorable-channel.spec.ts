/**
 * ignorable-channel 单测（docs/12 §2 契约）：探测双侧（patched-sim true / vanilla-sim false）、
 * 进程级记忆、发射路由三态（emitted/mirrored/blocked）、append 失败不回退镜像（两种失败不同因）。
 * 路由/降级概念全部居于 platform/ignorable-channel.ts（D3 断言锁定）；机制代码零感知。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  emitFact,
  factModeStats,
  ignorableChannelAvailable,
  resetIgnorableChannelProbe,
  setFactMirror,
} from '../src/platform/ignorable-channel.ts'

const MARKER = 'must not be marked ignorable'

/** fake session：patched-sim 的 append.toString 含补丁特征串；vanilla-sim 不含。 */
function makeFakeSession(opts: { patched?: boolean; behavior?: () => never } = {}) {
  const appends: Array<{ type: unknown; data: unknown; opts: unknown }> = []
  const append = (type: unknown, data: unknown, optsArg: unknown) => {
    if (opts.behavior) opts.behavior()
    appends.push({ type, data, opts: optsArg })
    return { type, seq: 0, time: 1, data }
  }
  if (opts.patched) Object.defineProperty(append, 'toString', { value: () => `function append(...) { throw new Error('x ${MARKER} y') }`, configurable: true })
  return { session: { append } as unknown as Session, appends }
}

describe('ignorableChannelAvailable 探测（docs/12 §2）', () => {
  beforeEach(() => resetIgnorableChannelProbe())

  it('补丁版 append → true；vanilla append → false', () => {
    expect(ignorableChannelAvailable(makeFakeSession({ patched: true }).session)).toBe(true)
    resetIgnorableChannelProbe()
    expect(ignorableChannelAvailable(makeFakeSession().session)).toBe(false)
  })

  it('进程级记忆：探测一次后不再读 append 源码', () => {
    const { session } = makeFakeSession({ patched: true })
    let reads = 0
    const ts = Object.getOwnPropertyDescriptor(session.append, 'toString')
    Object.defineProperty(session.append, 'toString', { value: () => { reads++; return `x ${MARKER} y` } })
    expect(ignorableChannelAvailable(session)).toBe(true)
    expect(ignorableChannelAvailable(session)).toBe(true)
    expect(reads).toBe(1)
    Object.defineProperty(session.append, 'toString', ts!)
  })
})

describe('emitFact 路由（docs/12 §2：emitted / mirrored / blocked）', () => {
  beforeEach(() => { resetIgnorableChannelProbe(); setFactMirror(undefined) })
  afterEach(() => setFactMirror(undefined))

  it('通道可用 → emitted：append 携带 { ignorable: true }，载荷逐字传递', () => {
    const log = { info: () => undefined, warn: vi.fn(), error: () => undefined }
    const { session, appends } = makeFakeSession({ patched: true })
    const before = factModeStats().emitted
    expect(emitFact(session, 'x', { v: 1 } as never, log as never)).toBe('emitted')
    expect(appends).toEqual([{ type: 'x', data: { v: 1 }, opts: { ignorable: true } }])
    expect(factModeStats().emitted).toBe(before + 1)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('通道缺失 + 未接线镜像 → blocked：warn + 计数（降级可见，绝不静默）', () => {
    const warn = vi.fn()
    const { session, appends } = makeFakeSession()
    const before = factModeStats().blocked
    expect(emitFact(session, 'x', { v: 2 } as never, { info: () => undefined, warn, error: () => undefined } as never)).toBe('blocked')
    expect(appends).toEqual([])
    expect(factModeStats().blocked).toBe(before + 1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('degraded')
  })

  it('通道缺失 + 镜像已接线 → mirrored：镜像收到 (type, data)', () => {
    const mirrored: Array<{ type: string; data: unknown }> = []
    setFactMirror((type, data) => void mirrored.push({ type, data }))
    const { session, appends } = makeFakeSession()
    const before = factModeStats().mirrored
    expect(emitFact(session, 'x', { v: 3 } as never)).toBe('mirrored')
    expect(appends).toEqual([])
    expect(mirrored).toEqual([{ type: 'x', data: { v: 3 } }])
    expect(factModeStats().mirrored).toBe(before + 1)
  })

  it('append 失败不回退镜像（两种失败不同因，防双重记账）→ blocked', () => {
    const mirrored: unknown[] = []
    setFactMirror((type, data) => void mirrored.push({ type, data }))
    const warn = vi.fn()
    const { session, appends } = makeFakeSession({ patched: true, behavior: (): never => { throw new Error('session detached') } })
    expect(emitFact(session, 'x', { v: 4 } as never, { info: () => undefined, warn, error: () => undefined } as never)).toBe('blocked')
    expect(appends).toEqual([])
    expect(mirrored).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('镜像写入失败 → blocked + warn（不外溢）', () => {
    setFactMirror(() => { throw new Error('kv down') })
    const warn = vi.fn()
    const { session } = makeFakeSession()
    expect(emitFact(session, 'x', { v: 5 } as never, { info: () => undefined, warn, error: () => undefined } as never)).toBe('blocked')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

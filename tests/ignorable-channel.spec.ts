/**
 * ignorable-channel 单测（docs/12 §2 契约）：探测双侧（capability-sim true / vanilla-sim false）、
 * 进程级记忆、发射路由三态（emitted/mirrored/blocked）、append 失败不回退镜像（两种失败不同因）。
 * 探测 = 结构化能力常量 SESSION_LOG_INTENT（harness commit ea04b581a5；vanilla 缺导出 → undefined），
 * 不再解析 append 实现源码文本。路由/降级概念全部居于 platform/ignorable-channel.ts（D3 断言锁定）。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  emitFact,
  factModeStats,
  ignorableChannelAvailable,
  resetIgnorableChannelProbe,
  setFactMirror,
  type SessionRuntimeCapabilities,
} from '../src/platform/ignorable-channel.ts'

const PATCHED: SessionRuntimeCapabilities = { SESSION_LOG_INTENT: 1 }
const VANILLA: SessionRuntimeCapabilities = {}

/** fake session：仅 append 间谍（探测已与会话实例解耦——能力属 harness 构建层）。 */
function makeFakeSession(behavior?: () => never) {
  const appends: Array<{ type: unknown; data: unknown; opts: unknown }> = []
  const append = (type: unknown, data: unknown, optsArg: unknown) => {
    if (behavior) behavior()
    appends.push({ type, data, opts: optsArg })
    return { type, seq: 0, time: 1, data }
  }
  return { session: { append } as unknown as Session, appends }
}

describe('ignorableChannelAvailable 能力探测（docs/12 §2）', () => {
  beforeEach(() => resetIgnorableChannelProbe())

  it('补丁版能力常量=1 → true；vanilla 缺导出 → false', () => {
    expect(ignorableChannelAvailable(PATCHED)).toBe(true)
    resetIgnorableChannelProbe()
    expect(ignorableChannelAvailable(VANILLA)).toBe(false)
  })

  it('进程级记忆：探测一次后不再读能力源', () => {
    let reads = 0
    const spy = new Proxy({ SESSION_LOG_INTENT: 1 }, {
      get(target, key) { if (key === 'SESSION_LOG_INTENT') reads++; return target[key as keyof typeof target] },
    })
    expect(ignorableChannelAvailable(spy as never)).toBe(true)
    expect(ignorableChannelAvailable(spy as never)).toBe(true)
    expect(reads).toBe(1)
  })
})

describe('emitFact 路由（docs/12 §2：emitted / mirrored / blocked）', () => {
  beforeEach(() => { resetIgnorableChannelProbe(); setFactMirror(undefined); ignorableChannelAvailable(PATCHED) })
  afterEach(() => setFactMirror(undefined))

  it('通道可用 → emitted：append 携带 { ignorable: true }，载荷逐字传递', () => {
    const log = { info: () => undefined, warn: vi.fn(), error: () => undefined }
    const { session, appends } = makeFakeSession()
    const before = factModeStats().emitted
    expect(emitFact(session, 'x', { v: 1 } as never, log as never)).toBe('emitted')
    expect(appends).toEqual([{ type: 'x', data: { v: 1 }, opts: { ignorable: true } }])
    expect(factModeStats().emitted).toBe(before + 1)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('通道缺失 + 未接线镜像 → blocked：warn + 计数（降级可见，绝不静默）', () => {
    resetIgnorableChannelProbe()
    ignorableChannelAvailable(VANILLA)
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
    resetIgnorableChannelProbe()
    ignorableChannelAvailable(VANILLA)
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
    const { session, appends } = makeFakeSession((): never => { throw new Error('session detached') })
    expect(emitFact(session, 'x', { v: 4 } as never, { info: () => undefined, warn, error: () => undefined } as never)).toBe('blocked')
    expect(appends).toEqual([])
    expect(mirrored).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('镜像写入失败 → blocked + warn（不外溢）', () => {
    resetIgnorableChannelProbe()
    ignorableChannelAvailable(VANILLA)
    setFactMirror(() => { throw new Error('kv down') })
    const warn = vi.fn()
    const { session } = makeFakeSession()
    expect(emitFact(session, 'x', { v: 5 } as never, { info: () => undefined, warn, error: () => undefined } as never)).toBe('blocked')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

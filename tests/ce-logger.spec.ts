/**
 * ce-logger 单测（P1 工单 §5）：named logger 接线 + emitCeFact 真实发射
 * （append 带 ignorable:true，append 异常 fail-lazy 遏制：warn + 计数、不外溢）
 * + 词汇派生类型级验证（本 spec 在 tsconfig.tests.json 内被 typecheck:tests 编译——
 * 声明合并 'context-economy/test-probe' 后载荷类型立即可用，未合并的族外类型被
 * CeFactType 前缀守卫拒绝，双侧类型断言）。
 * 写入通道 = harness Session.append LogIntent（本地补丁 commit 04cba8f394）；
 * 端口翻转记录见 P1 工单 §2.4 决策点⑤。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'
import { ceFactStats, ceLogger, emitCeFact, type CeFactType } from '../src/platform/logger.ts'
import { resetIgnorableChannelProbe } from '../src/platform/ignorable-channel.ts'

// 词汇派生类型级验证（P1 工单 §5）：与 harness compaction/* 同款声明合并形态
// （packages/compaction/compaction/src/types.ts:17，目标模块 '@deepseek-ai/dsh-session/types'）。
// IgnorableSessionEventMap = harness 侧 append 编译闸（社区共识形态 #5463/#5474，
// harness commit a3c0a8bc02）——类型并入 SessionEventMap（载荷）+ IgnorableSessionEventMap
// （可标记）后才可在 session.append 携带 { ignorable: true }；该 map 只活在写入侧，读取不查。
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 测试探针事件（仅测试类型面；生产词汇表为空——P1 工单 §2.4-③）。 */
    'context-economy/test-probe': { probe: string }
    /** 编译闸反例专用：并入 SessionEventMap 但刻意不并入 IgnorableSessionEventMap。 */
    'context-economy/gate-probe': { x: number }
  }
  interface IgnorableSessionEventMap {
    'context-economy/test-probe': { probe: string }
  }
}

function makeLoggerCtx() {
  const calls: Array<{ name: string; level: string; args: unknown[] }> = []
  const ctx = {
    logger: (name: string) => ({
      info: (...args: unknown[]) => void calls.push({ name, level: 'info', args }),
      warn: (...args: unknown[]) => void calls.push({ name, level: 'warn', args }),
      error: (...args: unknown[]) => void calls.push({ name, level: 'error', args }),
    }),
  }
  return { ctx, calls }
}

/** 带 append 间谍的 fake session（patched-sim：toString 含补丁特征串 → 探测为通道可用）。 */
function makeSessionSpy(opts: { patched?: boolean; behavior?: () => never } = {}) {
  const appends: Array<{ type: string; data: unknown; opts: unknown }> = []
  const append = (type: string, data: unknown, optsArg: unknown) => {
    if (opts.behavior) opts.behavior()
    appends.push({ type, data, opts: optsArg })
    return { type, seq: 0, time: 1, data }
  }
  if (opts.patched) Object.defineProperty(append, 'toString', { value: () => "function append(...) { throw new Error('must not be marked ignorable') }" })
  return { session: { append } as never, appends }
}

describe('ceLogger（docs/11 §4 纪律③）', () => {
  it('named logger 接线：ctx.logger("context-economy")', () => {
    const { ctx, calls } = makeLoggerCtx()
    const log = ceLogger(ctx as never)
    log.warn('diag')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe('context-economy')
    expect(calls[0]!.level).toBe('warn')
  })
})

describe('emitCeFact 真实发射（经 ignorable-channel 路由，docs/12 §2）', () => {
  // 探测记忆进程级一次——本文件模块加载期的类型占位调用会先污染探测，逐用例重置。
  beforeEach(() => resetIgnorableChannelProbe())
  it('通道可用 → emitted：append 携带 { ignorable: true }，零 warn', () => {
    const { ctx, calls } = makeLoggerCtx()
    const log = ceLogger(ctx as never)
    const { session, appends } = makeSessionSpy({ patched: true })
    const before = ceFactStats().emitted
    expect(() => emitCeFact(session, 'context-economy/test-probe', { probe: 'x' }, log)).not.toThrow()
    expect(appends).toEqual([{ type: 'context-economy/test-probe', data: { probe: 'x' }, opts: { ignorable: true } }])
    expect(ceFactStats().emitted).toBe(before + 1)
    expect(calls.some((c) => c.level === 'warn')).toBe(false)
  })

  it('append 异常 fail-lazy 遏制：warn + blocked 递增、不外溢、不回退镜像', () => {
    const { ctx, calls } = makeLoggerCtx()
    const log = ceLogger(ctx as never)
    const { session } = makeSessionSpy({ patched: true, behavior: (): never => { throw new Error('session detached') } })
    const before = ceFactStats().blocked
    expect(() => emitCeFact(session, 'context-economy/test-probe', { probe: 'y' }, log)).not.toThrow()
    expect(ceFactStats().blocked).toBe(before + 1)
    expect(calls.some((c) => c.level === 'warn' && String(c.args[0]).includes('contained'))).toBe(true)
  })

  it('未传 logger 时异常同样安全遏制：计数递增、不抛出', () => {
    const { session } = makeSessionSpy({ patched: true, behavior: (): never => { throw new Error('no logger variant') } })
    const before = ceFactStats().blocked
    expect(() => emitCeFact(session, 'context-economy/test-probe', { probe: 'z' })).not.toThrow()
    expect(ceFactStats().blocked).toBe(before + 1)
  })
})

// —— 类型级断言（typecheck:tests 实际编译本文件；运行期以下仅占位） ——
// 正例：声明合并后 'context-economy/test-probe' 进入词汇表且载荷类型生效（emitCeFact 泛型收口）。
const probeType: CeFactType = 'context-economy/test-probe'
const probeData: SessionEventMap['context-economy/test-probe'] = { probe: 'typed' }
emitCeFact({ append: () => ({}) } as never, 'context-economy/test-probe', { probe: 'typed' })
void probeType
void probeData
// 编译闸正例：双 map 合并后 raw append 可携带 { ignorable: true }。
const probeSession = { append: () => ({}) } as unknown as Session
probeSession.append('context-economy/test-probe', { probe: 'typed' }, { ignorable: true })
void probeSession
// 编译闸反例：并入 SessionEventMap 但未并入 IgnorableSessionEventMap 的类型不可标记
//（若闸失效，@ts-expect-error 自身报"未使用"→ typecheck:tests 红）。
const gateSession = { append: () => ({}) } as unknown as Session
// @ts-expect-error 未并入 IgnorableSessionEventMap 的类型不可携带 ignorable opts
gateSession.append('context-economy/gate-probe', { x: 1 }, { ignorable: true })
void gateSession
// 反例：族外类型不进 CeFactType（若前缀守卫失效，@ts-expect-error 自身报错 → typecheck 红）。
const outside = 'other/event' as string
// @ts-expect-error 未声明合并的族外事件类型不得通过 CeFactType
const badType: CeFactType = outside
void badType

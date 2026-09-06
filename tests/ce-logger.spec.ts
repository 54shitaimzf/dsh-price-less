/**
 * ce-logger 单测（P1 工单 §5）：named logger 接线 + emitCeFact fail-closed（warn + 计数、
 * 不写日志、不外溢）+ 词汇派生类型级验证（本 spec 在 tsconfig.tests.json 内被 typecheck:tests
 * 编译——声明合并 'context-economy/test-probe' 后 SessionEventMap 载荷类型立即可用，
 * 未合并的族外类型被 CeFactType 前缀守卫拒绝，双侧类型断言）。
 * 真实发射翻转见 P1 工单 §2.4 决策点⑤（harness LogIntent 补丁落地后）。
 */
import { describe, expect, it } from 'vitest'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import { ceFactStats, ceLogger, emitCeFact, type CeFactType } from '../src/platform/logger.ts'

// 词汇派生类型级验证（P1 工单 §5）：与 harness compaction/* 同款声明合并形态
// （packages/compaction/compaction/src/types.ts:17，目标模块 '@deepseek-ai/dsh-session/types'）。
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 测试探针事件（仅测试类型面；运行期无生产写入——P1 生产词汇表为空，工单 §2.4-③）。 */
    'context-economy/test-probe': { probe: string }
  }
}

const fakeSession = { id: 'spec' } as never

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

describe('emitCeFact fail-closed（P1 工单 §2.4-⑤）', () => {
  it('发射被阻塞：warn + 计数递增、零 session.append、不抛出', () => {
    const { ctx, calls } = makeLoggerCtx()
    const log = ceLogger(ctx as never)
    const before = ceFactStats().blockedNoIgnorableChannel
    const appends: unknown[] = []
    const sessionWithAppend = Object.assign(Object.create(null), { append: (...a: unknown[]) => void appends.push(a) })
    expect(() => emitCeFact(sessionWithAppend as never, 'context-economy/test-probe', { probe: 'x' }, log)).not.toThrow()
    expect(ceFactStats().blockedNoIgnorableChannel).toBe(before + 1)
    expect(appends).toHaveLength(0)
    // warn 侧通（可观测，非静默）
    expect(calls.some((c) => c.level === 'warn' && String(c.args[0]).includes('blocked'))).toBe(true)
  })

  it('未传 logger 时同样安全：计数递增、零日志调用、不抛出', () => {
    const before = ceFactStats().blockedNoIgnorableChannel
    expect(() => emitCeFact(fakeSession, 'context-economy/test-probe', { probe: 'y' })).not.toThrow()
    expect(ceFactStats().blockedNoIgnorableChannel).toBe(before + 1)
  })
})

// —— 类型级断言（typecheck:tests 实际编译本文件；运行期以下仅占位） ——
// 正例：声明合并后 'context-economy/test-probe' 进入词汇表且载荷类型生效。
const probeType: CeFactType = 'context-economy/test-probe'
const probeData: SessionEventMap['context-economy/test-probe'] = { probe: 'typed' }
void probeType
void probeData
// 反例：族外类型不进 CeFactType（若前缀守卫失效，@ts-expect-error 自身报错 → typecheck 红）。
const outside = 'other/event' as string
// @ts-expect-error 未声明合并的族外事件类型不得通过 CeFactType
const badType: CeFactType = outside
void badType

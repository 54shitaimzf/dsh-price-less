/**
 * apply 冒烟（P0 工单 §3.3）——R0 门「注入/卸载净」的离线替身。
 * FakeCtx 手写（禁 import cordis 运行时；schemastery 允许——src/config.ts 的真实运行时依赖）。
 * 被测对象 = 真实 apply（src/index.ts）；真机全链路（dev_self_test）仍属用户择机核验项（P0 §6-5）。
 */
import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { apply } from '../src/index.ts'

interface LogEntry { level: 'info' | 'warn' | 'error'; args: unknown[] }
interface InstallRecord { owner: unknown; ns: string; schema: unknown; entry: unknown; hooks: unknown }

/** FakeCtx 最小语义（按 src/settings.ts 实际行为）：logger 记账 / inject 依赖缺失不执行 / effect 收 disposer。 */
function makeFakeCtx(opts: { settings?: boolean } = {}) {
  const logs: LogEntry[] = []
  const disposers: Array<() => void> = []
  const installed: InstallRecord[] = []
  const fakeSettings = {
    installSection: (owner: unknown, ns: string, schema: unknown, entry: unknown, hooks: { setSource: (f: () => unknown) => void; onChange: () => void }) => {
      installed.push({ owner, ns, schema, entry, hooks })
      hooks.setSource(() => entry)
      hooks.onChange()
      return () => {}
    },
  }
  const ctx = {
    logger: {
      info: (...args: unknown[]) => void logs.push({ level: 'info', args }),
      warn: (...args: unknown[]) => void logs.push({ level: 'warn', args }),
      error: (...args: unknown[]) => void logs.push({ level: 'error', args }),
    },
    inject: (deps: readonly string[], cb: (provided: unknown) => unknown) => {
      if (deps.includes('settings') && opts.settings) {
        const d = cb({ settings: fakeSettings })
        if (typeof d === 'function') disposers.push(d)
      }
    },
    effect: (fn: () => unknown) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    },
  }
  return { ctx, logs, disposers, installed }
}

const runAll = (disposers: Array<() => void>) => { for (const d of [...disposers]) d() }

describe('apply 冒烟（R0 门离线替身）', () => {
  it('组 1：无 settings 服务 → 不抛、静默跳过、零残留注册', () => {
    const { ctx, logs, disposers, installed } = makeFakeCtx()
    expect(() => apply(ctx as never, {})).not.toThrow()
    expect(logs.some((l) => String(l.args[0]).includes('applying (template state)'))).toBe(true)
    expect(installed).toHaveLength(0)
    expect(disposers).toHaveLength(0)
  })

  it('组 2：注册面正确——installSection 恰 1 次，ns/schema/entry/hooks 逐项符合', () => {
    const { ctx, installed } = makeFakeCtx({ settings: true })
    apply(ctx as never, {})
    expect(installed).toHaveLength(1)
    const rec = installed[0]!
    expect(rec.ns).toBe('context-economy')
    expect(rec.schema).toBe(Config)
    expect((rec.entry as { discriminator: { mode: string } }).discriminator.mode).toBe('off')
    const hooks = rec.hooks as { setSource: unknown; onChange: unknown }
    expect(typeof hooks.setSource).toBe('function')
    expect(typeof hooks.onChange).toBe('function')
  })

  it('组 3：卸载净——disposers 依次执行无异常，重复执行亦无异常，再无 error 日志', () => {
    const { ctx, logs, disposers } = makeFakeCtx({ settings: true })
    apply(ctx as never, {})
    const errorsBefore = logs.filter((l) => l.level === 'error').length
    expect(() => runAll(disposers)).not.toThrow()
    expect(() => runAll(disposers)).not.toThrow()
    expect(logs.filter((l) => l.level === 'error').length).toBe(errorsBefore)
  })
})

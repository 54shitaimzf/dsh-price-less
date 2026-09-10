/**
 * diag-sink spec（P1.1 工单 §5）——诊断落盘九组用例，全部 fake（无 cordis 运行时 import，
 * 同 apply-smoke 纪律；Message/Exporter 仅 type-only）。真机全链路属 dev_self_test 用户核验项。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Exporter, Message } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { attachDiagSink, resetDiagSinkWarnOnce, resolveDiagDir } from '../src/platform/diag-sink.ts'

const TS = 1725600000000

let sn = 0
const msg = (over: Partial<Message> = {}): Message =>
  ({ sn: ++sn, ts: TS, name: 'context-economy', type: 'info', level: 1, args: ['hello'], ...over })

type Sink = {
  exporter: (ex: Exporter) => () => void
  info: (...a: unknown[]) => void
  warn: (...a: unknown[]) => void
  error: (...a: unknown[]) => void
}

/** FakeCtx（smoke 形态 + exporter 面）：effect 收 disposer；named logger 经 exporter 表派发。 */
function makeCtx() {
  const exporters = new Map<number, Exporter>()
  const disposers: Array<() => void> = []
  let seq = 0
  const emit = (name: string, type: Message['type'], level: number, args: unknown[]) => {
    const message: Message = { sn: ++seq, ts: Date.now(), name, type, level, args }
    for (const ex of [...exporters.values()]) ex.export(message)
  }
  const loggerFn = ((name: string) => ({
    info: (...a: unknown[]) => emit(name, 'info', 1, a),
    warn: (...a: unknown[]) => emit(name, 'warn', 2, a),
    error: (...a: unknown[]) => emit(name, 'error', 0, a),
    debug: (...a: unknown[]) => emit(name, 'debug', 3, a),
  })) as unknown as Sink
  loggerFn.info = (...a: unknown[]) => emit('(default)', 'info', 1, a)
  loggerFn.warn = (...a: unknown[]) => emit('(default)', 'warn', 2, a)
  loggerFn.error = (...a: unknown[]) => emit('(default)', 'error', 0, a)
  loggerFn.exporter = (ex: Exporter) => {
    const id = exporters.size + 1
    exporters.set(id, ex)
    return () => exporters.delete(id)
  }
  const ctx = {
    logger: loggerFn,
    on: () => () => {},
    inject: () => {},
    effect: (fn: () => unknown) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => void)
    },
  }
  return { ctx, disposers, exporters }
}

const lines = (file: string) =>
  readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)

describe('diag-sink（P1.1）', () => {
  let dir: string
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ce-diag-'))
    resetDiagSinkWarnOnce()
    delete process.env.CE_DIAG_DIR
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  it('① named 过滤 + 行 schema 四字段（ts/level/name/msg）', () => {
    const { ctx, exporters } = makeCtx()
    const r = attachDiagSink(ctx as never, { dir })
    expect(r?.path).toBe(join(dir, 'context-economy.log'))
    for (const ex of exporters.values()) {
      ex.export(msg())
      ex.export(msg({ name: 'other-logger' }))
      ex.export(msg({ args: ['second'] }))
    }
    const file = join(dir, 'context-economy.log')
    const recs = lines(file)
    expect(recs).toHaveLength(2)
    expect(recs[0]).toMatchObject({ ts: new Date(TS).toISOString(), level: 'info', name: 'context-economy', msg: 'hello' })
    expect(recs[1]!.msg).toBe('second')
    expect(existsSync(`${file}.1`)).toBe(false)
  })

  it('② 格式化：%o/%s/%d 占位、Error 首参 stack、尾参拼接、对象 JSON 化', () => {
    const { ctx, exporters } = makeCtx()
    attachDiagSink(ctx as never, { dir })
    const ex = [...exporters.values()][0]!
    ex.export(msg({ args: ['x=%o y=%s z=%d', { a: 1 }, 'S', '7'] }))
    ex.export(msg({ type: 'warn', level: 2, args: [new Error('boom')] }))
    ex.export(msg({ args: ['pre', { b: 2 }] }))
    const recs = lines(join(dir, 'context-economy.log'))
    expect(recs[0]!.msg).toBe('x={"a":1} y=S z=7')
    expect(String(recs[1]!.msg)).toContain('boom')
    expect(recs[2]!.msg).toBe('pre {"b":2}')
  })

  it('③ levels.default === 3 数据面钉住（DEBUG 全档捕获，门在 cordis 读取）', () => {
    const { ctx, exporters } = makeCtx()
    attachDiagSink(ctx as never, { dir })
    const ex = [...exporters.values()][0] as Exporter & { levels?: Record<string, number> }
    expect(ex.levels?.default).toBe(3)
  })

  it('④ 封顶滚动：capBytes 极小 → .log.1 出现、当前文件只余最新行', () => {
    const { ctx, exporters } = makeCtx()
    attachDiagSink(ctx as never, { dir: dir, capBytes: 64 })
    const file = join(dir, 'context-economy.log')
    for (let i = 1; i <= 5; i++) {
      for (const ex of exporters.values()) ex.export(msg({ args: ['x'.repeat(20), i] }))
    }
    expect(existsSync(`${file}.1`)).toBe(true)
    expect(lines(file)).toHaveLength(1)
    expect(lines(`${file}.1`)).toHaveLength(1)
  })

  it('⑤ 能力缺失 → 静默 undefined：无 exporter / logger 为普通函数 / 无 effect', () => {
    expect(attachDiagSink({ logger: {}, effect: (f: () => unknown) => f() } as never, { dir })).toBeUndefined()
    expect(attachDiagSink({ logger: () => {}, effect: (f: () => unknown) => f() } as never, { dir })).toBeUndefined()
    expect(attachDiagSink({ logger: makeCtx().ctx.logger } as never, { dir })).toBeUndefined()
    expect(errSpy).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'context-economy.log'))).toBe(false) // 未触达目录/文件创建
  })

  it('⑥ 建目录失败 → undefined + console.error 恰 1 次；reset 钩子复原', () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    const badDir = join(blocker, 'sub')
    const { ctx } = makeCtx()
    expect(attachDiagSink(ctx as never, { dir: badDir })).toBeUndefined()
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(existsSync(badDir)).toBe(false)
    resetDiagSinkWarnOnce()
    expect(attachDiagSink(ctx as never, { dir: badDir })).toBeUndefined()
    expect(errSpy).toHaveBeenCalledTimes(2)
  })

  it('⑦ 写失败自停用：目录被删后 emit → 告警恰 1 次，二次 emit 零告警', () => {
    const { ctx, exporters } = makeCtx()
    const r = attachDiagSink(ctx as never, { dir })
    expect(r).toBeDefined()
    rmSync(dir, { recursive: true, force: true })
    for (const ex of exporters.values()) {
      ex.export(msg({ args: ['one'] }))
      ex.export(msg({ args: ['two'] }))
    }
    expect(errSpy).toHaveBeenCalledTimes(1)
  })

  it('U12.1①：滚动 rename 失败 → 原地截断兜底并继续 append（旧实现静默放弃 = 文件无界增长）', () => {
    const { ctx, exporters } = makeCtx()
    attachDiagSink(ctx as never, { dir, capBytes: 256 })
    const file = join(dir, 'context-economy.log')
    // 占位：让 `${file}.1` 是**目录** → renameSync 必失败（Windows / POSIX 同）
    mkdirSync(`${file}.1`)
    for (let i = 0; i < 20; i++) {
      for (const ex of exporters.values()) ex.export(msg({ args: ['y'.repeat(60), i] }))
    }
    // 旧实现：rename 失败被吞 → 20 行全留（无界）；新实现：原地截断，文件保持有界
    expect(statSync(file).size).toBeLessThan(3 * 256)
    const kept = lines(file) // 截断对齐行边界 → 仍是完整 JSONL
    expect(kept.length).toBeGreaterThan(0)
    expect(errSpy).toHaveBeenCalled()
    // 截断 ≠ 停用：后续日志继续落盘（末行就是刚写的那条）
    for (const ex of exporters.values()) ex.export(msg({ args: ['after-truncate'] }))
    expect(lines(file).at(-1)?.msg).toContain('after-truncate')
  })

  it('U12.1②：单条坏消息只丢该条——sink 不停用（旧实现 warnOnce 停用整个 sink）', () => {
    const { ctx, exporters } = makeCtx()
    attachDiagSink(ctx as never, { dir })
    const file = join(dir, 'context-economy.log')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    for (const ex of exporters.values()) {
      ex.export(msg({ args: ['ok-1'] }))
      ex.export(msg({ args: [circular] })) // JSON.stringify 抛错
      ex.export(msg({ args: ['ok-2'] }))
    }
    expect(lines(file).map((r) => r.msg)).toEqual(['ok-1', 'ok-2'])
    expect(errSpy).toHaveBeenCalled() // 丢条不静默
  })

  it('⑧ 注销即净：disposer 后 emit 零新增行', () => {
    const { ctx, disposers, exporters } = makeCtx()
    attachDiagSink(ctx as never, { dir })
    const file = join(dir, 'context-economy.log')
    for (const ex of exporters.values()) ex.export(msg())
    expect(lines(file)).toHaveLength(1)
    for (const d of [...disposers]) d()
    for (const ex of exporters.values()) ex.export(msg({ args: ['after'] }))
    expect(lines(file)).toHaveLength(1)
    expect(lines(file)[0]!.msg).toBe('hello')
  })

  it('⑨ 真 apply e2e：CE_DIAG_DIR 重定向 + apply 挂载 → named 引导行落盘、卸载即净', () => {
    process.env.CE_DIAG_DIR = dir
    const { ctx, disposers } = makeCtx()
    expect(() => apply(ctx as never, {})).not.toThrow()
    const file = join(dir, 'context-economy.log')
    // apply 的引导行经 ceLogger（named）→ 即 sink 首行（纪律③：诊断走 named logger）
    expect(lines(file)).toHaveLength(1)
    expect(lines(file)[0]).toMatchObject({ name: 'context-economy', msg: 'context-economy: applying (template state)' })
    ;(ctx.logger as unknown as (n: string) => { info: (...a: unknown[]) => void })('context-economy')
      .info('audit line %o', { k: 1 })
    expect(lines(file)).toHaveLength(2)
    expect(lines(file)[1]).toMatchObject({ msg: 'audit line {"k":1}' })
    for (const d of [...disposers]) d()
    ;(ctx.logger as unknown as (n: string) => { info: (...a: unknown[]) => void })('context-economy')
      .info('after unload')
    expect(lines(file)).toHaveLength(2)
  })

  it('resolveDiagDir：opts.dir > CE_DIAG_DIR > <插件根>/logs（默认 = 仓库/包根，回归锚）', () => {
    process.env.CE_DIAG_DIR = join(dir, 'envdir')
    expect(resolveDiagDir('explicit')).toBe('explicit')
    expect(resolveDiagDir()).toBe(join(dir, 'envdir'))
    delete process.env.CE_DIAG_DIR
    // spec 在 tests/ 下 → 上两级 = 根；diag-sink.ts（src|lib/platform）上三级同根。曾因少跳
    // 一级把日志建进 lib/logs，弱断言 endsWith('logs') 未拦截——本断言钉死防回归。
    const root = dirname(dirname(fileURLToPath(import.meta.url)))
    expect(resolveDiagDir()).toBe(join(root, 'logs'))
  })
})

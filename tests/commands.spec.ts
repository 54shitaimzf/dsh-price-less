/**
 * P13 命令面测试（docs/implement/archive/P13-commands.md §3.6）。
 * 九组：task-facts 声明、init 纯核、/task open/close/status、/init propose/confirm/守卫、
 * /optimize-prompt 委托、dispose 与计数。全部 fake，零 cordis 运行时 import。
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import { buildTaskBoundaryData, TASK_BOUNDARY_FACT_TYPE } from '../src/domains/task-facts.ts'
import type { TaskBoundaryFactData } from '../src/core/units.ts'
import { clampInitGoal, parseInitOutput, renderInitPrompt } from '../src/core/init.ts'
import { createProjectFrame, projectFrameStorageKey, type SkillCatalogSnapshot } from '../src/core/prefix.ts'
import { mountCommandFace, type CommandFaceDeps } from '../src/domains/commands.ts'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'

type AssertSessionEventMap = SessionEventMap['context-economy/task-boundary'] extends TaskBoundaryFactData ? true : never
const _sessionEventMapCheck: AssertSessionEventMap = true

const logger = { info() {}, warn() {}, error() {} }

function makeSession(events: unknown[] = [], id = 's1'): Session {
  return {
    header: { id },
    id,
    snapshotEvents: () => events,
  } as unknown as Session
}

function makeInvocation(session: Session, rawInput = ''): CommandInvocation {
  return {
    commandId: 'cmd',
    agent: { session },
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  } as unknown as CommandInvocation
}

interface FakeRecord { version: number; body: unknown }

function makeStorage(initial: Record<string, FakeRecord> = {}) {
  const data = new Map<string, FakeRecord>(Object.entries(initial))
  return {
    data,
    getEntity(_table: string, key: string) { return data.get(key) },
    async putEntity(_table: string, key: string, body: unknown, _source: unknown, opts?: { baseVersion?: number }) {
      const current = data.get(key)
      const base = opts?.baseVersion ?? 0
      if (current !== undefined && current.version !== base) throw new Error('CAS mismatch')
      const record = { version: current ? current.version + 1 : 1, body }
      data.set(key, record)
      return record
    },
  }
}

function makeRegistry() {
  const definitions: CommandDefinition[] = []
  const removed: string[] = []
  const register = vi.fn((def: CommandDefinition) => {
    definitions.push(def)
    return () => { removed.push(def.name) }
  })
  return { commandsCtx: { commands: { register } } as never, definitions, removed }
}

function makeLlm(output: string): { llm: { stream: () => AsyncGenerator<never, void, unknown> } } {
  return {
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: output }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as never,
  }
}

function makeSkills(catalog: SkillCatalogSnapshot) {
  const skills = catalog.skills.map((s) => ({ ...s, invocation: { modelInvocable: true, userInvocable: true } }))
  return {
    skills: { snapshot: async () => ({ skills, complete: catalog.complete }) },
    logger: () => logger,
  } as never
}

function mount(deps: Partial<CommandFaceDeps> = {}) {
  const registry = makeRegistry()
  const storage = makeStorage()
  const face = mountCommandFace({
    commandsCtx: registry.commandsCtx,
    storage: storage as never,
    getConfig: () => ({ discriminator: {} }) as never,
    logger,
    workspace: 'ws',
    ...deps,
  } as never)
  return { face, registry, storage }
}

function taskDef(registry: { definitions: CommandDefinition[] }) {
  return registry.definitions.find((d) => d.name === 'task')!
}
function initDef(registry: { definitions: CommandDefinition[] }) {
  return registry.definitions.find((d) => d.name === 'init')!
}
function optimizeDef(registry: { definitions: CommandDefinition[] }) {
  return registry.definitions.find((d) => d.name === 'optimize-prompt')!
}

describe('command face', () => {
  it('task-facts: buildTaskBoundaryData 省略 reason 且返回新对象', () => {
    const a = buildTaskBoundaryData({ boundary: 'open', taskId: 'task-1' })
    const b = buildTaskBoundaryData({ boundary: 'open', taskId: 'task-1', reason: 'x' })
    expect(a).toEqual({ taskId: 'task-1', boundary: 'open' })
    expect(Object.hasOwn(a, 'reason')).toBe(false)
    expect(b).toEqual({ taskId: 'task-1', boundary: 'open', reason: 'x' })
    expect(a).not.toBe(b)
    expect(_sessionEventMapCheck).toBe(true)
    expect(TASK_BOUNDARY_FACT_TYPE).toBe('context-economy/task-boundary')
  })

  it('init 纯核：clamp/render/parse 边界', () => {
    expect(clampInitGoal('  hi  ')).toBe('hi')
    expect(clampInitGoal('x'.repeat(501)).length).toBe(500)
    const rendered = renderInitPrompt('goal')
    expect(rendered).toContain('goal')
    expect(rendered.startsWith('你是项目帧采集器')).toBe(true)
    expect(parseInitOutput('{"goal":"g","aspects":["a"," a ","b"]}')).toEqual({ goal: 'g', aspects: ['a', 'b'] })
    expect(parseInitOutput('{"goal":"' + 'x'.repeat(501) + '","aspects":["a"]}')).toBeNull()
    expect(parseInitOutput('{bad')).toBeNull()
    expect(parseInitOutput('{"goal":"g","aspects":["' + 'x'.repeat(81) + '"]}')).toBeNull()
    expect(parseInitOutput('{"goal":"g","aspects":["a","b","c","d","e","f","g","h","i"]}')).toBeNull()
    expect(parseInitOutput('{"goal":"","aspects":["a"]}')).toBeNull()
  })

  it('/task open 从空事实开启 task-2 并发射事实', async () => {
    const emitFact = vi.fn()
    const { registry } = mount({ emitFact: emitFact as never })
    const session = makeSession([])
    const result = await taskDef(registry).handler(makeInvocation(session, ' 做点事'))
    expect(result.kind).toBe('success')
    expect(result).toMatchObject({ text: expect.stringContaining('task-2') })
    expect(emitFact).toHaveBeenCalledWith(session, TASK_BOUNDARY_FACT_TYPE, expect.objectContaining({ taskId: 'task-2', boundary: 'open', reason: '做点事' }), logger)
    const other = await taskDef(registry).handler(makeInvocation(makeSession([], 'other'), ' 另做'))
    expect(other).toMatchObject({ text: expect.stringContaining('task-2') })
  })

  it('/task close 闭合当前 task-2', async () => {
    const emitFact = vi.fn()
    const events = [{ type: TASK_BOUNDARY_FACT_TYPE, seq: 1, time: 1, data: { taskId: 'task-2', boundary: 'open', reason: 'x' } }]
    const { registry } = mount({ emitFact: emitFact as never })
    const session = makeSession(events)
    const result = await taskDef(registry).handler(makeInvocation(session, ' close'))
    expect(result).toMatchObject({ text: expect.stringContaining('task-2') })
    expect(emitFact).toHaveBeenCalledWith(session, TASK_BOUNDARY_FACT_TYPE, expect.objectContaining({ taskId: 'task-2', boundary: 'close', reason: '/task close' }), logger)
  })

  it('/task 无参 status 展示卷宗版本和消息数', async () => {
    const emitFact = vi.fn()
    const storage = makeStorage({
      'dossier:s1:task-1': {
        version: 3,
        body: { taskId: 'task-1', messages: [{ seq: 1, time: 1, text: 'a' }, { seq: 2, time: 2, text: 'b' }], annotations: {} },
      },
    })
    const { registry } = mount({ storage: storage as never, emitFact: emitFact as never })
    const result = await taskDef(registry).handler(makeInvocation(makeSession([]), ''))
    expect(result).toMatchObject({ text: expect.stringContaining('task-1') })
    expect(result).toMatchObject({ text: expect.stringContaining('2') })
    expect(result).toMatchObject({ text: expect.stringContaining('卷宗版本：3') })
    expect(emitFact).not.toHaveBeenCalled()
  })

  it('/init propose + confirm 写 project_frame v1 并清 pending', async () => {
    const catalog = { skills: [{ name: 'tool', description: 'Tool' }], complete: true }
    const { registry, storage } = mount({
      llmCtx: makeLlm('{"goal":"g","aspects":["a","b"]}') as never,
      skillsCtx: makeSkills(catalog),
    })
    const session = makeSession([])
    const proposed = await initDef(registry).handler(makeInvocation(session, 'g'))
    expect(proposed).toMatchObject({ text: expect.stringContaining('请运行 /init confirm') })
    const confirmed = await initDef(registry).handler(makeInvocation(session, 'confirm'))
    expect(confirmed).toMatchObject({ text: '项目帧 v1 已初始化' })
    const key = projectFrameStorageKey('ws')
    expect(storage.data.get(key)?.body).toEqual(createProjectFrame('g', ['a', 'b'], catalog).body)
    expect(storage.data.get(key)?.version).toBe(1)
    const again = await initDef(registry).handler(makeInvocation(session, 'again'))
    expect(again).toMatchObject({ kind: 'error' })
  })

  it('/init 守卫：无 pending、skills 缺失、目录不完整、坏 JSON', async () => {
    const { registry } = mount({})
    const session = makeSession([])
    const a = await initDef(registry).handler(makeInvocation(session, 'confirm'))
    expect(a).toMatchObject({ kind: 'error' })
    const b = await initDef(registry).handler(makeInvocation(session, 'g'))
    expect(b).toMatchObject({ kind: 'error' })
    const { registry: r2 } = mount({ llmCtx: makeLlm('{"goal":"g","aspects":["a"]}') as never })
    await initDef(r2).handler(makeInvocation(session, 'g'))
    const c = await initDef(r2).handler(makeInvocation(session, 'confirm'))
    expect(c).toMatchObject({ kind: 'error' })
    const { registry: r3 } = mount({ llmCtx: makeLlm('{"goal":"g","aspects":["a"]}') as never, skillsCtx: makeSkills({ skills: [], complete: false }) })
    await initDef(r3).handler(makeInvocation(session, 'g'))
    const d = await initDef(r3).handler(makeInvocation(session, 'confirm'))
    expect(d).toMatchObject({ kind: 'error' })
    const { registry: r4 } = mount({ llmCtx: makeLlm('{bad') as never })
    const e = await initDef(r4).handler(makeInvocation(session, 'g'))
    expect(e).toMatchObject({ kind: 'error', text: expect.stringContaining('命令执行失败') })
  })

  it('/optimize-prompt 委托：默认错误，传入 handler 生效且计数+1', async () => {
    const { registry: r1 } = mount({})
    const r1res = await optimizeDef(r1).handler(makeInvocation(makeSession([])))
    expect(r1res).toEqual({ kind: 'error', text: '/optimize-prompt 入口已注册；完整断面由 P14b 接入后开放。' })
    const manual = vi.fn(async (_s: Session, _raw: string): Promise<CommandResult> => ({ kind: 'success', text: 'ok' }))
    const { registry: r2, face } = mount({ manualOptimize: manual })
    const r2res = await optimizeDef(r2).handler(makeInvocation(makeSession([]), 'raw'))
    expect(r2res).toEqual({ kind: 'success', text: 'ok' })
    expect(manual).toHaveBeenCalledTimes(1)
    expect(face.stats().optimizeCommands).toBe(1)
  })

  it('dispose 逆序 unregister，stats 计数准确', async () => {
    const { registry, face } = mount({ llmCtx: makeLlm('{"goal":"g","aspects":["a"]}') as never, skillsCtx: makeSkills({ skills: [], complete: true }) })
    const session = makeSession([])
    await taskDef(registry).handler(makeInvocation(session, 'x'))
    await initDef(registry).handler(makeInvocation(session, 'g'))
    await optimizeDef(registry).handler(makeInvocation(session))
    const before = face.stats()
    expect(before).toEqual({ pendingInits: 1, taskCommands: 1, initCommands: 1, optimizeCommands: 1 })
    face.dispose()
    expect(registry.removed).toEqual(['optimize-prompt', 'init', 'task'])
    expect(face.stats()).toEqual(before)
  })
})

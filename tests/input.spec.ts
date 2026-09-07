/**
 * P12 自动断面服务测试（docs/implement/P12-input.md §3.7）。
 * 十一组：T0 解析、模型路由、auto=false 零行为、T0/L0/L1/对表/LLM/fail-lazy、
 * 卷宗追加、会话事实隔离。全部 fake，零 cordis 运行时 import。
 */
import { describe, expect, it } from 'vitest'
import { parseT0Command } from '../src/core/t0.ts'
import {
  foldJudgeLedger,
  type JudgeRecord,
} from '../src/core/judge.ts'
import {
  resolveJudgeModel,
  mountAutoDiscriminator,
  readJudgeTable,
  type AutoDiscriminatorDeps,
} from '../src/domains/input.ts'
import { judgeRecordToFactData, factDataToJudgeRecord } from '../src/domains/judge-facts.ts'

interface FakeStorageRecord { version: number; body: unknown }
interface FakeStorage {
  getEntity(table: string, key: string): FakeStorageRecord | undefined
  putEntity(table: string, key: string, body: unknown, source: unknown, opts?: { baseVersion?: number }): Promise<FakeStorageRecord>
  data: Map<string, FakeStorageRecord>
}

function makeStorage(initial: Record<string, unknown> = {}): FakeStorage {
  const data = new Map<string, FakeStorageRecord>()
  for (const [k, v] of Object.entries(initial)) data.set(k, v as FakeStorageRecord)
  return {
    data,
    getEntity(table, key) { return data.get(`${table}:${key}`) },
    async putEntity(table, key, body, _source, opts = {}) {
      const recKey = `${table}:${key}`
      const current = data.get(recKey)
      const base = opts.baseVersion ?? 0
      if (base === 0 && current !== undefined) throw new Error('exists')
      if (base !== 0 && (current === undefined || current.version !== base)) throw new Error('cas')
      const next = { version: current ? current.version + 1 : 1, body }
      data.set(recKey, next)
      return next
    },
  }
}

function makePump() {
  const handlers = new Map<string, Set<(p: unknown) => void>>()
  return {
    on(kind: string, fn: (p: unknown) => void) {
      if (!handlers.has(kind)) handlers.set(kind, new Set())
      handlers.get(kind)!.add(fn)
      return () => handlers.get(kind)!.delete(fn)
    },
    emit(kind: string, payload: unknown) {
      for (const fn of handlers.get(kind) ?? []) fn(payload)
    },
  }
}

const flush = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)) }
const llmStream = (text: string) => ({ stream: async function* () {
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'finish', reason: { kind: 'stop' } }
} })


const cfg = (auto: boolean, provider?: string, model?: string) => ({
  discriminator: { auto, ...(provider ? { provider } : {}), ...(model ? { model } : {}) },
})

const deps = (overrides: Partial<AutoDiscriminatorDeps> = {}): AutoDiscriminatorDeps => ({
  pump: makePump() as never,
  storage: makeStorage() as never,
  getConfig: () => cfg(true),
  logger: { info() {}, warn() {}, error() {} },
  workspace: 'ws',
  ...overrides,
})

describe('parseT0Command', () => {
  it('T0: /task close、open、无效输入', () => {
    expect(parseT0Command('/task close')).toEqual({ boundary: 'close' })
    expect(parseT0Command('/task 写测试')).toEqual({ boundary: 'open', description: '写测试' })
    expect(parseT0Command('/task')).toEqual({ boundary: null })
    expect(parseT0Command('/compact')).toEqual({ boundary: null })
  })
})

describe('resolveJudgeModel', () => {
  it('缺省使用预设；配置覆盖生效', () => {
    expect(resolveJudgeModel(cfg(true))).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    expect(resolveJudgeModel(cfg(true, 'p', 'm'))).toEqual({ provider: 'p', model: 'm' })
  })
})

describe('auto discriminator zero behavior', () => {
  it('auto=false：不读存储、不调 LLM、不发记录', async () => {
    const pump = makePump()
    const storage = makeStorage()
    let llmCalled = false
    const llm = { stream: async function* () { llmCalled = true; yield { type: 'finish', reason: { kind: 'stop' } } } }
    const auto = mountAutoDiscriminator({ llm } as never, deps({ pump: pump as never, storage: storage as never, getConfig: () => cfg(false) }))
    pump.emit('input/user-message', { session: { header: { id: 's1' } }, seq: 1, time: 1, text: 'hello' })
    await flush()
    expect(storage.data.size).toBe(0)
    expect(llmCalled).toBe(false)
    expect(auto.stats().records).toEqual([])
    auto.dispose()
  })
})

describe('auto discriminator quick paths', () => {
  it('T0：记账为 t0，不调 LLM，不发 verdict', async () => {
    const pump = makePump()
    let llmCalled = false
    const llm = { stream: async function* () { llmCalled = true; yield { type: 'finish', reason: { kind: 'stop' } } } }
    const auto = mountAutoDiscriminator({ llm } as never, deps({ pump: pump as never, storage: makeStorage() as never }))
    pump.emit('input/user-message', { session: { header: { id: 's1' } }, seq: 1, time: 1, text: '/task close' })
    await flush()
    expect(llmCalled).toBe(false)
    expect(auto.stats().records[0]).toMatchObject({ trigger: 't0', decision: 'continue' })
    auto.dispose()
  })

  it('L0：好的 命中延续词，不调 LLM', async () => {
    const pump = makePump()
    let llmCalled = false
    const llm = { stream: async function* () { llmCalled = true; yield { type: 'finish', reason: { kind: 'stop' } } } }
    const auto = mountAutoDiscriminator({ llm } as never, deps({ pump: pump as never, storage: makeStorage() as never }))
    pump.emit('input/user-message', { session: { header: { id: 's1' } }, seq: 1, time: 1, text: '好的' })
    await flush()
    expect(llmCalled).toBe(false)
    expect(auto.stats().records[0]).toMatchObject({ trigger: 'l0-continue', decision: 'continue' })
    auto.dispose()
  })
})

describe('auto discriminator llm and cache', () => {

  it('L1：同消息第二次命中缓存，LLM 只调一次', async () => {
    const pump = makePump()
    let calls = 0
    const llm = { stream: async function* () {
      calls++
      yield { type: 'text-delta', index: 0, text: '{"decision":"continue","class":"action"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    const auto = mountAutoDiscriminator({ llm } as never, deps({ pump: pump as never, storage: makeStorage() as never }))
    const payload = { session: { header: { id: 's1' } }, seq: 1, time: 1, text: 'start something' }
    pump.emit('input/user-message', payload)
    await flush()
    pump.emit('input/user-message', { ...payload, seq: 1, time: 2, text: 'start something' })
    await flush()
    expect(calls).toBe(1)
    const records = auto.stats().records
    expect(records[1]).toMatchObject({ trigger: 'l1-cache', decision: 'continue', class: 'action' })
    auto.dispose()
  })

  it('LLM 成功：trigger llm、class action、dossier 有标注', async () => {
    const pump = makePump()
    const storage = makeStorage()
    const llm = llmStream('{"decision":"continue","class":"action"}')
    const auto = mountAutoDiscriminator({ llm } as never, deps({ pump: pump as never, storage: storage as never }))
    pump.emit('input/user-message', { session: { header: { id: 's1' } }, seq: 1, time: 1, text: 'implement feature' })
    await flush()
    const rec = auto.stats().records[0]
    expect(rec).toMatchObject({ trigger: 'llm', decision: 'continue', class: 'action' })
    const dossierData = storage.getEntity('dossier', 'dossier:task-1')
    expect((dossierData!.body as { annotations: Record<string, unknown[]> }).annotations['1']?.[0]).toMatchObject({ class: 'action', by: 'auto' })
    auto.dispose()
  })

  it('fail-lazy：坏 JSON 走 error-fallback，不抛、不发射 verdict', async () => {
    const pump = makePump()
    const llm = { stream: async function* () {
      yield { type: 'text-delta', index: 0, text: 'not-json' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    const auto = mountAutoDiscriminator({ llm } as never, deps({ pump: pump as never, storage: makeStorage() as never }))
    pump.emit('input/user-message', { session: { header: { id: 's1' } }, seq: 1, time: 1, text: 'do thing' })
    await flush()
    const recs = auto.stats().records
    expect(recs[0]).toMatchObject({ trigger: 'error-fallback', decision: 'continue' })
    expect(recs.some((r: JudgeRecord) => r.trigger === 'llm')).toBe(false)
    auto.dispose()
  })
})

describe('auto discriminator table and dossier', () => {
  it('对表命中：返回 trigger table，不调 LLM', async () => {
    const pump = makePump()
    const storage = makeStorage({
      'optimize_artifact:optimize_artifact:latest:ws': {
        version: 1,
        body: { judgeTable: { version: 1, aspects: [], fileSignatures: [], keywords: ['cache'] } },
      },
    })
    let llmCalled = false
    const llm = { stream: async function* () { llmCalled = true; yield { type: 'finish', reason: { kind: 'stop' } } } }
    const auto = mountAutoDiscriminator({ llm } as never, deps({ pump: pump as never, storage: storage as never }))
    pump.emit('input/user-message', { session: { header: { id: 's1' } }, seq: 1, time: 1, text: 'use cache' })
    await flush()
    expect(llmCalled).toBe(false)
    expect(auto.stats().records[0]).toMatchObject({ trigger: 'table', decision: 'continue' })
    auto.dispose()
  })

  it('卷宗追加：两条消息写入同一 dossier 不同版本', async () => {
    const pump = makePump()
    const storage = makeStorage()
    const auto = mountAutoDiscriminator({} as never, deps({ pump: pump as never, storage: storage as never }))
    pump.emit('input/user-message', { session: { header: { id: 's1' } }, seq: 1, time: 1, text: '好的' })
    await flush()
    pump.emit('input/user-message', { session: { header: { id: 's1' } }, seq: 2, time: 2, text: '继续' })
    await flush()
    const rec = storage.getEntity('dossier', 'dossier:task-1')
    expect(rec?.version).toBe(2)
    expect((rec!.body as { messages: unknown[] }).messages).toHaveLength(2)
    auto.dispose()
  })
})

describe('auto discriminator facts isolation', () => {
  it('会话事实分桶与去重：A 的 new-task 不串到 B，重复事实不重复入桶', async () => {
    const pump = makePump()
    const storage = makeStorage()
    const auto = mountAutoDiscriminator({} as never, deps({ pump: pump as never, storage: storage as never }))
    const fact = { type: 'context-economy/judge-verdict', seq: 1, time: 1, data: { verdict: 'new-task', anchorSeq: 1 } }
    pump.emit('facts/session-event', { session: { header: { id: 'A' } }, event: fact })
    pump.emit('facts/session-event', { session: { header: { id: 'A' } }, event: fact })
    await flush()
    expect(auto.stats().facts).toBe(1)
    auto.dispose()
  })
})

describe('judge facts mapping', () => {
  it('judge-recorded 载荷往返且不含 error', () => {
    const record: JudgeRecord = { seq: 1, time: 2, trigger: 'llm', decision: 'continue', class: 'action', ctxTokens: 10, llmUsage: { inputTokens: 1, outputTokens: 2 } }
    const data = judgeRecordToFactData(record)
    expect(data).toMatchObject({ seq: 1, time: 2, trigger: 'llm', decision: 'continue', class: 'action' })
    expect(factDataToJudgeRecord(data)).toEqual(record)
  })
})

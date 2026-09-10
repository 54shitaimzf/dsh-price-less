/**
 * P12 自动断面服务测试（docs/implement/archive/P12-input.md §3.7）。
 * 十一组：T0 解析、模型路由、auto=false 零行为、T0/L1/对表/LLM/fail-lazy（P14c 已删 L0）、
 * 卷宗追加、会话事实隔离。全部 fake，零 cordis 运行时 import。
 */
import { describe, expect, it } from 'vitest'
import { parseT0Command } from '../src/core/t0.ts'
import {
  foldJudgeLedger,
  type JudgeRecord,
} from '../src/core/judge.ts'
import { readSessionModel } from '../src/platform/events.ts'
import {
  resolveJudgeModel,
  mountAutoDiscriminator,
  readJudgeTable,
  type AutoDiscriminatorDeps,
} from '../src/domains/input.ts'
import { judgeRecordToFactData, factDataToJudgeRecord } from '../src/domains/judge-facts.ts'
import { annotateDossier, type DossierBody } from '../src/core/dossier.ts'
import { resolveConfig } from '../src/config.ts'

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


const cfg = (auto: boolean, provider?: string, model?: string) => resolveConfig({
  shear: { enabled: true },
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
  it('缺省使用内置默认；配置覆盖优先；会话模型次之', () => {
    expect(resolveJudgeModel(cfg(true))).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash-expires-on-0910' })
    expect(resolveJudgeModel(cfg(true), { provider: 'sess-p', model: 'sess-m' })).toEqual({ provider: 'sess-p', model: 'sess-m' })
    expect(resolveJudgeModel(cfg(true, 'p', 'm'), { provider: 'sess-p', model: 'sess-m' })).toEqual({ provider: 'p', model: 'm' })
  })
  it('readSessionModel：取最近一次 request/header 的 provider/model；无记录 → undefined', () => {
    const sessionOf = (events: unknown[]) => ({ header: { id: 's1' }, snapshotEvents: () => events }) as never
    const withHeader = sessionOf([
      { type: 'request/header', seq: 0, time: 1, data: { header: { config: { provider: 'p1', model: 'm1' } } } },
      { type: 'assistant/message', seq: 1, time: 2, data: {} },
      { type: 'request/header', seq: 2, time: 3, data: { header: { config: { provider: 'p2', model: 'm2' } } } },
    ])
    expect(readSessionModel(withHeader)).toEqual({ provider: 'p2', model: 'm2' })
    expect(readSessionModel(sessionOf([]))).toBeUndefined()
    expect(readSessionModel(sessionOf([{ type: 'request/header', seq: 0, time: 1, data: {} }]))).toBeUndefined()
    expect(readSessionModel({ header: { id: 's1' } } as never)).toBeUndefined()
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

  it('极短消息不再机械延续（P14c 删 L0）→ 走 LLM 主路径', async () => {
    const pump = makePump()
    let llmCalled = false
    const llm = { stream: async function* () {
      llmCalled = true
      yield { type: 'text-delta', index: 0, text: '{"decision":"continue","class":"action"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    const auto = mountAutoDiscriminator({ llm } as never, deps({ pump: pump as never, storage: makeStorage() as never }))
    pump.emit('input/user-message', { session: { header: { id: 's1' } }, seq: 1, time: 1, text: '好的' })
    await flush()
    expect(llmCalled).toBe(true)
    expect(auto.stats().records[0]).toMatchObject({ trigger: 'llm', decision: 'continue' })
    auto.dispose()
  })

  it('U5：判词在飞期间并发回填 → 重放式 CAS 不丢并发内容（旧实现拿陈旧体盲写必丢 backfill 标注）', async () => {
    const pump = makePump()
    const storage = makeStorage()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const llm = { stream: async function* () {
      await gate
      yield { type: 'text-delta', index: 0, text: '{"decision":"continue","class":"action"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    const auto = mountAutoDiscriminator({ llm } as never, deps({ pump: pump as never, storage: storage as never }))
    pump.emit('input/user-message', { session: { header: { id: 's1' } }, seq: 5, time: 100, text: '改一下配置' })
    // 等 append 落盘（v1）且判词流已挂起在 gate 上
    const dossierEntry = async (): Promise<[string, FakeStorageRecord]> => {
      for (let i = 0; i < 50; i++) {
        const found = [...storage.data.entries()].find(([k]) => k.startsWith('dossier:'))
        if (found !== undefined) return found as [string, FakeStorageRecord]
        await new Promise((r) => setTimeout(r, 2))
      }
      throw new Error('dossier record never appeared')
    }
    const [recKey, v1] = await dossierEntry()
    // 并发 ★ 回填：以当前体（含判别消息 seq 5）为基加 backfill 标注 → v2
    const backfilled = annotateDossier(v1.body as DossierBody, 5, 'action', 'backfill', 999)
    await storage.putEntity('dossier', recKey.slice('dossier:'.length), backfilled, {}, { baseVersion: v1.version })
    release()
    await flush()
    const final = ([...storage.data.entries()].find(([k]) => k.startsWith('dossier:'))![1]!.body) as DossierBody
    expect(final.messages.some((m) => m.seq === 5)).toBe(true)
    const annotations = final.annotations['5'] ?? []
    expect(annotations.some((a) => a.by === 'backfill')).toBe(true)
    expect(annotations.some((a) => a.by === 'auto')).toBe(true)
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
    const dossierData = storage.getEntity('dossier', 'dossier:s1:task-1')
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
  it('对表影子记账：命中不再短路，照常走 LLM 并记录 tableShadow', async () => {
    const pump = makePump()
    const storage = makeStorage({
      'optimize_artifact:optimize_artifact:latest:ws': {
        version: 1,
        body: { judgeTable: { version: 1, aspects: [], fileSignatures: ['src/a.ts'], keywords: ['cache'] } },
      },
    })
    const llm = llmStream('{"decision":"new_task","class":"action"}')
    const auto = mountAutoDiscriminator({ llm } as never, deps({ pump: pump as never, storage: storage as never }))
    pump.emit('input/user-message', { session: { header: { id: 's1' } }, seq: 1, time: 1, text: 'use cache in src/a.ts' })
    await flush()
    // 影子命中但 LLM 判 new-task = 一次"本会漏掉的边界"（正是短路会造成的无声错误）
    expect(auto.stats().records[0]).toMatchObject({ trigger: 'llm', decision: 'new-task', tableShadow: { hit: true, score: 4 } })
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
    const rec = storage.getEntity('dossier', 'dossier:s1:task-1')
    expect(rec?.version).toBe(2)
    expect((rec!.body as { messages: unknown[] }).messages).toHaveLength(2)
    auto.dispose()
  })

  it('会话级卷宗隔离：A/B 的 task-1 使用不同 storage key', async () => {
    const pump = makePump()
    const storage = makeStorage()
    const auto = mountAutoDiscriminator({} as never, deps({ pump: pump as never, storage: storage as never }))
    pump.emit('input/user-message', { session: { header: { id: 'A' } }, seq: 1, time: 1, text: 'A 的消息' })
    pump.emit('input/user-message', { session: { header: { id: 'B' } }, seq: 1, time: 1, text: 'B 的消息' })
    await flush()
    const a = storage.getEntity('dossier', 'dossier:A:task-1')
    const b = storage.getEntity('dossier', 'dossier:B:task-1')
    expect(a?.version).toBe(1)
    expect(b?.version).toBe(1)
    expect((a!.body as { messages: Array<{ text: string }> }).messages[0]?.text).toBe('A 的消息')
    expect((b!.body as { messages: Array<{ text: string }> }).messages[0]?.text).toBe('B 的消息')
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

describe('F2 边界判词屏障（settle）', () => {
  it('settle：判词被挡住时保持等待，落地后返回 settled', async () => {
    const pump = makePump()
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => { release = r })
    const llm = { stream: async function* () {
      await gate
      yield { type: 'text-delta', index: 0, text: '{"decision":"new_task","class":"action"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    const auto = mountAutoDiscriminator({ llm } as never, deps({ pump: pump as never, storage: makeStorage() as never }))
    const session = { header: { id: 's1' } }
    pump.emit('input/user-message', { session, seq: 7, time: 1, text: '换话题' })
    let outcome: string | undefined
    const wait = auto.settle(session as never, 7, 5_000).then((o) => { outcome = o; return o })
    await flush()
    expect(outcome).toBeUndefined()
    release!()
    await expect(wait).resolves.toBe('settled')
    expect(auto.stats().records[0]).toMatchObject({ decision: 'new-task' })
    auto.dispose()
  })

  it('settle：超时返回 timeout（fail-lazy）；无在飞工作立即 settled', async () => {
    const pump = makePump()
    const llm = { stream: async function* () { await new Promise(() => {}); yield { type: 'finish', reason: { kind: 'stop' } } } }
    const auto = mountAutoDiscriminator({ llm } as never, deps({ pump: pump as never, storage: makeStorage() as never }))
    const session = { header: { id: 's1' } }
    pump.emit('input/user-message', { session, seq: 3, time: 1, text: 'x' })
    await expect(auto.settle(session as never, 3, 10)).resolves.toBe('timeout')
    await expect(auto.settle({ header: { id: 'other' } } as never, 1, 10)).resolves.toBe('settled')
    auto.dispose()
  })

  it('settle：已落地（seq 已处理）立即 settled，不重复等待', async () => {
    const pump = makePump()
    const llm = llmStream('{"decision":"continue","class":"action"}')
    const auto = mountAutoDiscriminator({ llm } as never, deps({ pump: pump as never, storage: makeStorage() as never }))
    const session = { header: { id: 's1' } }
    pump.emit('input/user-message', { session, seq: 4, time: 1, text: '继续' })
    await flush()
    await expect(auto.settle(session as never, 4, 10)).resolves.toBe('settled')
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

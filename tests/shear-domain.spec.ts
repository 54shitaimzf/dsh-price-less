/**
 * P15b 剪切调度域单测（工单 §5/§6）——fake ctx + fake pump + FakeSession，零 cordis 运行时。
 * 覆盖：T-entry/T0/T0-R 端到端、门槛 G1–G9 各 ≥1、失败默认保留与零重试、
 * 回填基线不执行历史 op、确定性双跑同账。事件序与真实会话一致（assistant(含 tool-call) → tool/call → tool/result）。
 */
import { describe, expect, it } from 'vitest'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { mountShearDomain } from '../src/domains/shear.ts'
import {
  SHEAR_APPLIED_FACT_TYPE,
  SHEAR_DECISION_FACT_TYPE,
  SHEAR_ERROR_FACT_TYPE,
  SHEAR_RUN_PLAN_FACT_TYPE,
} from '../src/domains/shear-facts.ts'
import { JUDGE_RECORDED_FACT_TYPE } from '../src/domains/judge-facts.ts'
import { ignorableChannelAvailable } from '../src/platform/ignorable-channel.ts'
import { expectedReplaceOp, replaceEndpoints } from './replace-op.ts'

// 测试进程内强制走 ignorable 通道直发路径（事实经 session.append 落 FakeSession）。
ignorableChannelAvailable({ SESSION_LOG_INTENT: 1 })

interface FakeEvent { type: string; seq: number; time: number; data: any; surfaceOp?: any; sourceEventSeqs?: unknown; ignorable?: true }

class FakeSession {
  readonly events: FakeEvent[] = []
  nodes: number[] = []
  generation = 0
  readonly header: { id: string; origin?: string } = { id: 's1' }
  readonly appends: Array<{ type: string; data: any; opts?: any }> = []
  get surface() { return { nodes: this.nodes, replaceGeneration: this.generation } }
  append(type: string, data: any, opts?: any): FakeEvent {
    this.appends.push({ type, data, opts })
    const event: FakeEvent = { type, seq: this.events.length, time: 1000 + this.events.length, data }
    if (opts?.surfaceOp !== undefined) event.surfaceOp = opts.surfaceOp
    if (opts?.sourceEventSeqs !== undefined) event.sourceEventSeqs = opts.sourceEventSeqs
    if (opts?.ignorable === true) event.ignorable = true
    this.events.push(event)
    if (event.surfaceOp === 'append') this.nodes.push(event.seq)
    else {
      const span = replaceEndpoints(event.surfaceOp)
      if (span !== undefined) {
        const si = this.nodes.indexOf(span.start)
        const ei = this.nodes.indexOf(span.end)
        if (si >= 0 && ei >= si) { this.nodes.splice(si, ei - si + 1, event.seq); this.generation++ }
      }
    }
    return event
  }
  eventAt(seq: number): FakeEvent | undefined { return this.events.find((event) => event.seq === seq) }
  snapshotEvents(): readonly FakeEvent[] { return this.events.slice() }
}

const textBlock = (text: string) => ({ type: 'text', text })
const toolCallBlock = (callId: string, name: string, args: unknown) => ({ type: 'tool-call', toolCallId: callId, name, arguments: JSON.stringify(args) })

const READ_ENVELOPE = ['1: export const x = 2', '2: const y = 3'].join('\n')
const BIG_ENVELOPE = Array.from({ length: 40 }, (_, i) => `${i + 1}: const v${i} = ${i}`).join('\n')
const BIG = 'x'.repeat(9000)
const MID = Array.from({ length: 5 }, (_, i) => `line ${i} ${'y'.repeat(800)}`).join('\n')
const LONG_READ = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
/** W2：过体积门槛的过程日志（400 行 × ~50 字符 ≈ 20 KB）。 */
const LOG_400 = Array.from({ length: 400 }, (_, i) => `line ${i}: ${'x'.repeat(40)}`).join('\n')

function makeEnv(options: { enabled?: boolean } = {}) {
  const listeners = new Map<string, Array<(...args: any[]) => unknown>>()
  const ctx = {
    on(name: string, fn: (...args: any[]) => unknown) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1) }
    },
  }
  const pumpHandlers = new Map<string, Set<(payload: any) => void>>()
  const pump = {
    on(kind: string, fn: (payload: any) => void) {
      const set = pumpHandlers.get(kind) ?? new Set()
      set.add(fn)
      pumpHandlers.set(kind, set)
      return () => set.delete(fn)
    },
    dispose() {},
    stats() { return { enqueued: 0, dispatched: 0, listenerErrors: 0, dropped: 0, depth: 0 } },
  }
  const config = { shear: { enabled: options.enabled !== false }, discriminator: { auto: false } }
  const session = new FakeSession()
  const domain = mountShearDomain(ctx as never, {
    pump: pump as never,
    getConfig: () => config as never,
    logger: { info() {}, warn() {}, error() {} },
    now: () => 1000,
  })
  const emit = (kind: string, payload: unknown): void => { for (const fn of pumpHandlers.get(kind) ?? []) fn(payload) }
  const emitEvent = (event: FakeEvent): void => emit('metrics/session-event', { session, event })
  const appendUser = (text: string): FakeEvent => {
    const event = session.append('user/message', { id: `u${session.events.length}`, role: 'user', content: [textBlock(text)], source: { kind: 'user' } }, { surfaceOp: 'append' })
    emit('input/user-message', { session, seq: event.seq, time: event.time, text })
    return event
  }
  const appendAssistant = (blocks: unknown[]): FakeEvent => {
    const event = session.append('assistant/message', { turn: 1, step: 1, message: { id: `a${session.events.length}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: blocks }, stream: [] }, { surfaceOp: 'append' })
    emitEvent(event)
    return event
  }
  const appendCall = (callId: string, name: string, args: unknown): FakeEvent => {
    const event = session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
    emitEvent(event)
    return event
  }
  const appendResult = (callId: string, text: string, isError = false): FakeEvent => {
    const event = session.append('tool/result', { turn: 1, step: 1, message: { id: `t${session.events.length}`, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [textBlock(text)], isError }] }, ...(isError ? { error: { name: 'E', code: 'E' } } : {}) }, { surfaceOp: 'append' })
    emitEvent(event)
    return event
  }
  const postExecute = async (exec: unknown, result: unknown) => {
    const listener = (listeners.get('tools/post-execute') ?? [])[0]!
    let nextCalls = 0
    const next = () => { nextCalls++; return Promise.resolve({ kind: 'accept' }) }
    const decision = await listener(exec, result, next)
    return { decision, nextCalls }
  }
  const facts = () => session.appends.filter((item) => item.opts?.ignorable === true).map((item) => ({ type: item.type, data: item.data }))
  const applied = () => facts().filter((fact) => fact.type === SHEAR_APPLIED_FACT_TYPE)
  const replacements = () => session.appends.filter((item) => typeof item.opts?.surfaceOp === 'object')
  return { session, domain, config, emit, emitEvent, appendUser, appendAssistant, appendCall, appendResult, postExecute, facts, applied, replacements }
}

function fakeExec(overrides: { callId?: string; name?: string; arguments?: unknown; parent?: unknown; origin?: string } = {}) {
  const agent = overrides.origin === undefined ? undefined : { session: { header: { origin: overrides.origin } } }
  return {
    callId: overrides.callId ?? 'c1',
    rootCallId: overrides.callId ?? 'c1',
    token: Symbol('t'),
    name: overrides.name ?? 'bash',
    arguments: overrides.arguments ?? {},
    ...(agent === undefined ? {} : { agent }),
    ...(overrides.parent === undefined ? {} : { parent: overrides.parent }),
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}
const fakeResult = (text: string, isError = false) => ({ isError, content: [textBlock(text)] } as unknown as ToolExecutionResult)

describe('P15b 同步相：T-entry 整形（W2 保守准入）', () => {
  it('T-entry：过程日志大输出落账前整形（省略标记），结果事件到达后发 shear-applied 事实', async () => {
    const env = makeEnv()
    const exec = fakeExec({ name: 'bash', arguments: { command: 'npm test' } })
    const { decision, nextCalls } = await env.postExecute(exec, fakeResult(LOG_400))
    expect(nextCalls).toBe(0)
    const content = (decision as { content: Array<{ text: string }> }).content
    expect(content[0]!.text).toContain('省略')
    env.appendUser('跑个命令')
    env.appendAssistant([toolCallBlock('c1', 'bash', { command: 'npm test' })])
    env.appendCall('c1', 'bash', { command: 'npm test' })
    env.appendResult('c1', content[0]!.text)
    const applied = env.applied()
    expect(applied).toHaveLength(1)
    expect(applied[0]!.data).toMatchObject({ tier: 'T-entry', kind: 'shape-entry', callId: 'c1', category: 'cmd' })
    expect(env.replacements()).toHaveLength(0)
  })
  it('T-entry 门槛：失败 / 数据查询 / 体积不足 / read 类 / subagent / 子分发 → 不整形（委托 next）', async () => {
    const env = makeEnv()
    const bash = (args: unknown) => fakeExec({ name: 'bash', arguments: args })
    // 过程日志但体积不足（100 行 < 120 行门槛）
    expect((await env.postExecute(bash({ command: 'npm test' }), fakeResult(LONG_READ))).nextCalls).toBe(1)
    expect((await env.postExecute(bash({ command: 'npm test' }), fakeResult(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')))).nextCalls).toBe(1)
    // W2：数据查询类命令即使超体积门槛也不整形
    expect((await env.postExecute(bash({ command: 'git log --oneline' }), fakeResult(LOG_400))).nextCalls).toBe(1)
    expect((await env.postExecute(bash({ command: 'Get-Content README.md' }), fakeResult(LOG_400))).nextCalls).toBe(1)
    // 失败方向 = 保留
    expect((await env.postExecute(bash({ command: 'npm test' }), fakeResult(`${LOG_400}\n[exit code: 1]`))).nextCalls).toBe(1)
    expect((await env.postExecute(fakeExec({ name: 'read' }), fakeResult(LOG_400))).nextCalls).toBe(1)
    expect((await env.postExecute(fakeExec({ name: 'bash', origin: 'subagent' }), fakeResult(LOG_400))).nextCalls).toBe(1)
    expect((await env.postExecute(fakeExec({ name: 'bash', parent: Symbol('p') }), fakeResult(LOG_400))).nextCalls).toBe(1)
    expect(env.facts()).toHaveLength(0)
  })
  it('U11.4：结果 isError=true → 一律不整形（工具层权威判定；失败原文保留）', async () => {
    const env = makeEnv()
    const exec = fakeExec({ name: 'bash', arguments: { command: 'npm test' } })
    // 干净文本 + isError：形态判据本会放行（旧实现只看文本里的失败特征），必须按 isError 拦下
    expect((await env.postExecute(exec, fakeResult(LOG_400, true))).nextCalls).toBe(1)
    // 对照组：同一 exec、同一文本、isError=false → 照常整形（证明拦下的原因就是 isError）
    expect((await env.postExecute(exec, fakeResult(LOG_400, false))).nextCalls).toBe(0)
  })

  it('G1：enabled=false → 同步相与异步相全部零行为', async () => {
    const env = makeEnv({ enabled: false })
    expect((await env.postExecute(fakeExec({ name: 'bash' }), fakeResult(BIG))).nextCalls).toBe(1)
    env.appendUser('hi')
    expect(env.facts()).toHaveLength(0)
    expect(env.replacements()).toHaveLength(0)
    expect(env.domain.stats().sessions).toBe(0)
  })
})

describe('P15b 异步相：机械档执行与门槛', () => {
  it('T0：读后写（写成功）→ 旧读剪为纯痕迹 stub', () => {
    const env = makeEnv()
    env.appendUser('改文件')
    env.appendAssistant([toolCallBlock('r1', 'read', { file_path: 'src/foo.ts' })])
    env.appendCall('r1', 'read', { file_path: 'src/foo.ts' })
    env.appendResult('r1', BIG_ENVELOPE)
    env.appendAssistant([toolCallBlock('w1', 'write', { file_path: 'src/foo.ts', content: 'x' })])
    env.appendCall('w1', 'write', { file_path: 'src/foo.ts', content: 'x' })
    env.appendResult('w1', 'ok')
    const replaced = env.replacements()
    expect(replaced).toHaveLength(1)
    const message = (replaced[0]!.data as { message: { content: Array<{ content: Array<{ text: string }> }> } }).message
    expect(message.content[0]!.content[0]!.text).toContain('src/foo.ts')
    expect(env.applied()[0]!.data).toMatchObject({ tier: 'T0', kind: 't0-supersede' })
  })
  it('G4：写结果失败 → 旧读保留（不发事实）', () => {
    const env = makeEnv()
    env.appendUser('改文件')
    env.appendAssistant([toolCallBlock('r1', 'read', { file_path: 'src/foo.ts' })])
    env.appendCall('r1', 'read', { file_path: 'src/foo.ts' })
    env.appendResult('r1', READ_ENVELOPE)
    env.appendAssistant([toolCallBlock('w1', 'write', { file_path: 'src/foo.ts', content: 'x' })])
    env.appendCall('w1', 'write', { file_path: 'src/foo.ts', content: 'x' })
    env.appendResult('w1', 'boom', true)
    expect(env.replacements()).toHaveLength(0)
    expect(env.applied()).toHaveLength(0)
  })
  it('G5：被超越读件超出尾部窗（≥8 节点）→ 不剪', () => {
    const env = makeEnv()
    env.appendUser('长任务')
    env.appendAssistant([toolCallBlock('r1', 'read', { file_path: 'src/foo.ts' })])
    env.appendCall('r1', 'read', { file_path: 'src/foo.ts' })
    env.appendResult('r1', READ_ENVELOPE)
    for (let i = 0; i < 8; i++) {
      env.appendAssistant([toolCallBlock(`f${i}`, 'read', { file_path: `src/f${i}.ts` })])
      env.appendCall(`f${i}`, 'read', { file_path: `src/f${i}.ts` })
      env.appendResult(`f${i}`, READ_ENVELOPE)
    }
    env.appendAssistant([toolCallBlock('w1', 'write', { file_path: 'src/foo.ts', content: 'x' })])
    env.appendCall('w1', 'write', { file_path: 'src/foo.ts', content: 'x' })
    env.appendResult('w1', 'ok')
    expect(env.replacements()).toHaveLength(0)
  })
  it('T0-R：声明表读后写 → 修复信封（行号 + edited 锚）替换原读', () => {
    const env = makeEnv()
    env.appendUser('改 barrel')
    env.appendAssistant([toolCallBlock('r1', 'read', { file_path: 'src/index.ts' })])
    env.appendCall('r1', 'read', { file_path: 'src/index.ts' })
    env.appendResult('r1', BIG_ENVELOPE)
    env.appendAssistant([toolCallBlock('e1', 'edit', { file_path: 'src/index.ts', old_string: 'const v3 = 3', new_string: 'const v3 = 9' })])
    env.appendCall('e1', 'edit', { file_path: 'src/index.ts', old_string: 'const v3 = 3', new_string: 'const v3 = 9' })
    env.appendResult('e1', 'ok')
    const replaced = env.replacements()
    expect(replaced).toHaveLength(1)
    const message = (replaced[0]!.data as { message: { content: Array<{ content: Array<{ text: string }> }> } }).message
    const text = message.content[0]!.content[0]!.text
    expect(text).toContain('4: const v3 = 9')
    expect(text).toContain('(edited: src/index.ts, v1, 4-4)')
    expect(env.applied()[0]!.data).toMatchObject({ tier: 'T0-R', kind: 't0r-repair', segments: 1, windowLines: 40 })
  })
  it('G3 幂等：同一 op 不重复落刀（后续事件重折仍只剪一次）', () => {
    const env = makeEnv()
    env.appendUser('改文件')
    env.appendAssistant([toolCallBlock('r1', 'read', { file_path: 'src/foo.ts' })])
    env.appendCall('r1', 'read', { file_path: 'src/foo.ts' })
    env.appendResult('r1', BIG_ENVELOPE)
    env.appendAssistant([toolCallBlock('w1', 'write', { file_path: 'src/foo.ts', content: 'x' })])
    env.appendCall('w1', 'write', { file_path: 'src/foo.ts', content: 'x' })
    env.appendResult('w1', 'ok')
    env.appendUser('继续')
    expect(env.replacements()).toHaveLength(1)
    expect(env.applied()).toHaveLength(1)
  })
  it('G6/G9：目标已被其他生产者遮蔽 → 遏制 + shear-error 事实 + 零重试', () => {
    const env = makeEnv()
    env.appendUser('改文件')
    env.appendAssistant([toolCallBlock('r1', 'read', { file_path: 'src/foo.ts' })])
    env.appendCall('r1', 'read', { file_path: 'src/foo.ts' })
    const readResult = env.appendResult('r1', READ_ENVELOPE)
    // harness 压缩遮蔽该读件节点 → 目标不再在当前表面。
    env.session.append('tool/result', readResult.data, { surfaceOp: expectedReplaceOp(readResult.seq, readResult.seq), sourceEventSeqs: [readResult.seq] })
    const before = env.replacements().length
    env.appendAssistant([toolCallBlock('w1', 'write', { file_path: 'src/foo.ts', content: 'x' })])
    env.appendCall('w1', 'write', { file_path: 'src/foo.ts', content: 'x' })
    env.appendResult('w1', 'ok')
    expect(env.replacements().length).toBe(before)
    const errors = env.facts().filter((fact) => fact.type === SHEAR_ERROR_FACT_TYPE)
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect((errors[0]!.data as { code: string }).code).toBe('CE_SHEAR_NOT_ON_SURFACE')
    const factsBefore = env.facts().length
    env.appendUser('继续')
    expect(env.facts().length).toBe(factsBefore)
  })
  it('回填基线：挂载前已存在的历史 op 不执行、不发事实', () => {
    const env = makeEnv()
    env.session.append('user/message', { id: 'u', role: 'user', content: [textBlock('历史')], source: { kind: 'user' } }, { surfaceOp: 'append' })
    env.session.append('assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [toolCallBlock('r1', 'read', { file_path: 'src/foo.ts' })] }, stream: [] }, { surfaceOp: 'append' })
    env.session.append('tool/call', { turn: 1, step: 1, callId: 'r1', name: 'read', arguments: JSON.stringify({ file_path: 'src/foo.ts' }) })
    env.session.append('tool/result', { turn: 1, step: 1, message: { id: 't', role: 'user', source: { kind: 'tool', callId: 'r1' }, content: [{ type: 'tool-result', toolCallId: 'r1', content: [textBlock(READ_ENVELOPE)], isError: false }] } }, { surfaceOp: 'append' })
    env.session.append('assistant/message', { turn: 1, step: 1, message: { id: 'a2', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [toolCallBlock('w1', 'write', { file_path: 'src/foo.ts', content: 'x' })] }, stream: [] }, { surfaceOp: 'append' })
    env.session.append('tool/call', { turn: 1, step: 1, callId: 'w1', name: 'write', arguments: JSON.stringify({ file_path: 'src/foo.ts', content: 'x' }) })
    env.session.append('tool/result', { turn: 1, step: 1, message: { id: 't2', role: 'user', source: { kind: 'tool', callId: 'w1' }, content: [{ type: 'tool-result', toolCallId: 'w1', content: [textBlock('ok')], isError: false }] } }, { surfaceOp: 'append' })
    env.appendUser('新消息')
    expect(env.replacements()).toHaveLength(0)
    expect(env.applied()).toHaveLength(0)
    expect(env.domain.stats().sessions).toBe(1)
  })
  it('G2：subagent 会话不裁', () => {
    const env = makeEnv()
    env.session.header.origin = 'subagent'
    env.appendUser('子会话')
    env.appendAssistant([toolCallBlock('c1', 'bash', { command: 'npm test' })])
    env.appendCall('c1', 'bash', { command: 'npm test' })
    env.appendResult('c1', BIG)
    env.appendAssistant([textBlock('结论\nCUT-OK: 结论')])
    expect(env.replacements()).toHaveLength(0)
    expect(env.domain.stats().sessions).toBe(0)
  })
  it('确定性：同一事件序在两个独立域实例产出同一事实序列', () => {
    const run = () => {
      const env = makeEnv()
      env.appendUser('跑测试')
      env.appendAssistant([toolCallBlock('c1', 'bash', { command: 'npm test' })])
      env.appendCall('c1', 'bash', { command: 'npm test' })
      env.appendResult('c1', MID)
      env.appendAssistant([textBlock('测试全绿。')])
      return JSON.stringify(env.facts())
    }
    expect(run()).toBe(run())
  })
})

describe('P16b 异步相：run 冲刷（吸收证明 → 整段换一句结论）', () => {
  type Env = ReturnType<typeof makeEnv>
  const verdict = (env: Env, anchorSeq: number, klass: 'action' | 'pureQ' | 'verifyQ', decision: 'continue' | 'new-task' = 'continue') => {
    const event = env.session.append(JUDGE_RECORDED_FACT_TYPE, { seq: anchorSeq, time: 1000, trigger: 'llm', decision, class: klass }, { ignorable: true })
    env.emitEvent(event)
    return event
  }
  const runPlan = (env: Env, items: { startSeq: number; endSeq: number; note: string }[]) => {
    const event = env.session.append(SHEAR_RUN_PLAN_FACT_TYPE, { at: 1000, source: 'star', items }, { ignorable: true })
    env.emitEvent(event)
    return event
  }

  it('吸收证明到达 → 整段 run 换 notice 用户消息（影子计价 + 配对平衡 + 表面收拢）', () => {
    const env = makeEnv()
    const u1 = env.appendUser('为什么要用 A？')
    verdict(env, u1.seq, 'pureQ')
    const a1 = env.appendAssistant([textBlock(`因为 B 更稳，而且可回放。${'说明'.repeat(120)}`)])
    const u2 = env.appendUser('动手改吧')
    verdict(env, u2.seq, 'action')
    const applied = env.applied()
    expect(applied).toHaveLength(1)
    expect(applied[0]!.data).toMatchObject({
      tier: 'run', kind: 'run-flush', startSeq: u1.seq, endSeq: a1.seq,
      runClass: 'pureQ', runPairs: 1, conclusionTier: 'mechanical-quote', category: 'other',
    })
    expect(applied[0]!.data.savedTokens).toBeGreaterThan(0)
    const replacements = env.replacements()
    expect(replacements).toHaveLength(1)
    expect(replacements[0]!.type).toBe('user/message')
    expect(replacements[0]!.opts.surfaceOp).toEqual(expectedReplaceOp(u1.seq, a1.seq))
    expect(replacements[0]!.data.source).toMatchObject({ kind: 'plugin', plugin: 'context-economy', form: 'notice' })
    expect(replacements[0]!.data.content[0].text).toContain('已吸收：关于「为什么要用 A？」的 1 轮问答')
    const landedSeq = env.session.events.find((event) => typeof event.surfaceOp === 'object')!.seq
    expect(env.session.nodes).toEqual([landedSeq, u2.seq])
    expect(env.session.appends.some((item) => item.type === 'compaction/prune')).toBe(true)
    expect(env.domain.stats().runsCut).toBe(1)
  })

  it('星标剪切清单 = 吸收证明 + 结论来源（长 run 走 star-note）', () => {
    const env = makeEnv()
    const longAnswer = (label: string) => textBlock(`${label}：${'细节'.repeat(120)}`)
    const u1 = env.appendUser('Q1'); verdict(env, u1.seq, 'pureQ'); env.appendAssistant([longAnswer('A1')])
    const u2 = env.appendUser('Q2'); verdict(env, u2.seq, 'pureQ'); env.appendAssistant([longAnswer('A2')])
    const u3 = env.appendUser('Q3'); verdict(env, u3.seq, 'pureQ')
    const a3 = env.appendAssistant([longAnswer('A3')])
    runPlan(env, [{ startSeq: u1.seq, endSeq: a3.seq, note: '三轮讨论结论是 A' }])
    const applied = env.applied()
    expect(applied).toHaveLength(1)
    expect(applied[0]!.data).toMatchObject({ conclusionTier: 'star-note', runPairs: 3, startSeq: u1.seq, endSeq: a3.seq })
    // 幂等：同清单/同分类重复到达不二次落刀
    runPlan(env, [{ startSeq: u1.seq, endSeq: a3.seq, note: '三轮讨论结论是 A' }])
    expect(env.applied()).toHaveLength(1)
    expect(env.domain.stats().runsCut).toBe(1)
  })

  it('无净省（结论 ≥ 被遮蔽体积）→ hold run-no-saving，零落刀零重试', () => {
    const env = makeEnv()
    const u1 = env.appendUser('Q1'); verdict(env, u1.seq, 'pureQ'); const a1 = env.appendAssistant([textBlock('A1')])
    const u2 = env.appendUser('动手'); verdict(env, u2.seq, 'action')
    expect(env.applied()).toHaveLength(0)
    expect(env.replacements()).toHaveLength(0)
    const holds = env.facts().filter((fact) => fact.type === SHEAR_DECISION_FACT_TYPE && fact.data.tier === 'run')
    expect(holds).toHaveLength(1)
    expect(holds[0]!.data).toMatchObject({ decision: 'hold', reason: 'run-no-saving', runKey: `${u1.seq}..${a1.seq}` })
    expect(env.domain.stats().runsHeld).toBe(1)
  })

  it('吸收证明未到 → 积压保留（不发事实、零落刀）', () => {
    const env = makeEnv()
    const u1 = env.appendUser('Q1'); verdict(env, u1.seq, 'pureQ'); env.appendAssistant([textBlock('A1')])
    expect(env.applied()).toHaveLength(0)
    expect(env.replacements()).toHaveLength(0)
    expect(env.facts().filter((fact) => fact.type === SHEAR_DECISION_FACT_TYPE && fact.data.tier === 'run')).toHaveLength(0)
    expect(env.domain.stats().runsCut).toBe(0)
  })

  it('★ CLASS 回填（无 SHEAR 行）= 分类输入 → 机械摘句落刀', () => {
    const env = makeEnv()
    const u1 = env.appendUser('为什么要用 A？')
    env.appendAssistant([textBlock(`因为 B 更稳。${'说明'.repeat(120)}`)])
    const u2 = env.appendUser('动手改吧')
    const event = env.session.append(SHEAR_RUN_PLAN_FACT_TYPE, {
      at: 1000, source: 'star', items: [],
      classes: [{ anchorSeq: u1.seq, class: 'pureQ' }, { anchorSeq: u2.seq, class: 'action' }],
    }, { ignorable: true })
    env.emitEvent(event)
    expect(env.applied()).toHaveLength(1)
    expect(env.applied()[0]!.data).toMatchObject({ tier: 'run', kind: 'run-flush', conclusionTier: 'mechanical-quote' })
    expect(env.applied()[0]!.data.startSeq).toBe(u1.seq)
  })

  it('G10 尾部窗：分类迟到导致 run 距尾部 ≥8 节点 → hold run-too-old（中段剪除负收益）', () => {
    const env = makeEnv()
    const u1 = env.appendUser('Q1')
    verdict(env, u1.seq, 'pureQ')
    env.appendAssistant([textBlock('说明'.repeat(120))])
    const u2 = env.appendUser('动手')
    for (let index = 0; index < 5; index++) {
      env.appendUser(`后续 ${index}`)
      env.appendAssistant([textBlock('x'.repeat(80))])
    }
    verdict(env, u2.seq, 'action')
    expect(env.applied()).toHaveLength(0)
    expect(env.facts().some((fact) => fact.type === SHEAR_DECISION_FACT_TYPE && fact.data.reason === 'run-too-old')).toBe(true)
  })

  it('G1：关闭 shear 开关 → run 半边零行为', () => {
    const env = makeEnv({ enabled: false })
    const u1 = env.appendUser('Q1'); verdict(env, u1.seq, 'pureQ'); env.appendAssistant([textBlock('A1')])
    const u2 = env.appendUser('动手'); verdict(env, u2.seq, 'action')
    expect(env.applied()).toHaveLength(0)
    expect(env.replacements()).toHaveLength(0)
    expect(env.domain.stats().runsCut).toBe(0)
  })
})
/**
 * U2 剪切域事实接线回归：判词/星标事实经**真实 createEventPump** 路由到达剪切域。
 * 缺陷背景（2026-09-10 审查 P1）：pump 只把六类字面事件路由进 metrics 面，context-economy/*
 * 事实只进 facts 面；剪切域旧实现只订 metrics 面 → run 分类输入 live 永不可达，run 冲刷/
 * ★ 回填/CLASS 回填真机零触发（既有用例用 fake pump 手动 emit 绕过了真实路由，漏检）。
 * 附：run 幂等键只锚 startSeq——冲刷后 run 增长的残余不再被二次落刀。
 */
import { describe, expect, it } from 'vitest'
import { mountShearDomain } from '../src/domains/shear.ts'
import { SHEAR_RUN_PLAN_FACT_TYPE } from '../src/domains/shear-facts.ts'
import { JUDGE_RECORDED_FACT_TYPE } from '../src/domains/judge-facts.ts'
import { createEventPump } from '../src/platform/events.ts'
import { ignorableChannelAvailable } from '../src/platform/ignorable-channel.ts'

ignorableChannelAvailable({ SESSION_LOG_INTENT: 1 })

interface FakeEvent { type: string; seq: number; time: number; data: any; surfaceOp?: any; sourceEventSeqs?: unknown; ignorable?: true }

class FakeSession {
  readonly events: FakeEvent[] = []
  nodes: number[] = []
  generation = 0
  readonly header: { id: string; origin?: string } = { id: 'sr1' }
  get surface() { return { nodes: this.nodes, replaceGeneration: this.generation } }
  append(type: string, data: any, opts?: any): FakeEvent {
    const event: FakeEvent = { type, seq: this.events.length, time: 1000 + this.events.length, data }
    if (opts?.surfaceOp !== undefined) event.surfaceOp = opts.surfaceOp
    if (opts?.sourceEventSeqs !== undefined) event.sourceEventSeqs = opts.sourceEventSeqs
    if (opts?.ignorable === true) event.ignorable = true
    this.events.push(event)
    if (event.surfaceOp === 'append') this.nodes.push(event.seq)
    else if (event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
      const si = this.nodes.indexOf(event.surfaceOp.start)
      const ei = this.nodes.indexOf(event.surfaceOp.end)
      if (si >= 0 && ei >= si) { this.nodes.splice(si, ei - si + 1, event.seq); this.generation++ }
    }
    return event
  }
  eventAt(seq: number): FakeEvent | undefined { return this.events.find((event) => event.seq === seq) }
  snapshotEvents(): readonly FakeEvent[] { return this.events.slice() }
}

const textBlock = (text: string) => ({ type: 'text', text })

/** 真实 createEventPump 的 harness 侧：只实现 pump 用到的 ctx.on（手动 fire firehose）。 */
function makeFirehose() {
  let listener: ((session: FakeSession, event: FakeEvent) => void) | undefined
  const ctx = {
    on: (_name: string, fn: (session: FakeSession, event: FakeEvent) => void) => {
      listener = fn
      return () => { listener = undefined }
    },
  }
  const fire = (session: FakeSession, event: FakeEvent): void => listener?.(session, event)
  return { ctx, fire }
}

const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)))

function makeEnv() {
  const { ctx, fire } = makeFirehose()
  const pump = createEventPump(ctx as never)
  const domain = mountShearDomain({ on: () => () => {} } as never, {
    pump: pump as never,
    getConfig: () => ({ shear: { enabled: true }, discriminator: { auto: false } }) as never,
    logger: { info() {}, warn() {}, error() {} },
    now: () => 1000,
  })
  const session = new FakeSession()
  const emitEvent = (event: FakeEvent): void => fire(session, event)
  const appendUser = (text: string): FakeEvent => {
    const event = session.append('user/message', { id: `u${session.events.length}`, role: 'user', content: [textBlock(text)], source: { kind: 'user' } }, { surfaceOp: 'append' })
    emitEvent(event)
    return event
  }
  const appendAssistant = (text: string): FakeEvent => {
    const event = session.append('assistant/message', { turn: 1, step: 1, message: { id: `a${session.events.length}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [textBlock(text)] }, stream: [] }, { surfaceOp: 'append' })
    emitEvent(event)
    return event
  }
  const verdict = (anchorSeq: number, klass: 'action' | 'pureQ' | 'verifyQ'): FakeEvent => {
    const event = session.append(JUDGE_RECORDED_FACT_TYPE, { seq: anchorSeq, time: 1000, trigger: 'llm', decision: 'continue', class: klass }, { ignorable: true })
    emitEvent(event)
    return event
  }
  const runPlan = (items: { startSeq: number; endSeq: number; note: string }[]): FakeEvent => {
    const event = session.append(SHEAR_RUN_PLAN_FACT_TYPE, { at: 1000, source: 'star', items }, { ignorable: true })
    emitEvent(event)
    return event
  }
  const replacements = (): FakeEvent[] => session.events.filter((event) => event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace')
  return { session, domain, appendUser, appendAssistant, verdict, runPlan, replacements, dispose: () => { pump.dispose(); domain.dispose() } }
}

describe('U2：判词/星标事实经真实 pump 路由到达剪切域', () => {
  it('纯问答 run：判词事实（facts 面）驱动 run 冲刷落刀', async () => {
    const env = makeEnv()
    const u1 = env.appendUser('为什么要用 A？')
    env.verdict(u1.seq, 'pureQ')
    const a1 = env.appendAssistant(`因为 B 更稳，而且可回放。${'说明'.repeat(120)}`)
    const u2 = env.appendUser('动手改吧')
    env.verdict(u2.seq, 'action')
    await flush()
    // 事实经 facts/session-event 进入 run 状态机 → 冲刷落刀（旧实现：路由缺失 → 永不落刀）
    expect(env.domain.stats().runsCut).toBe(1)
    const replacements = env.replacements()
    expect(replacements).toHaveLength(1)
    expect(replacements[0]!.surfaceOp).toEqual({ op: 'replace', start: u1.seq, end: a1.seq })
    expect(replacements[0]!.data.source).toMatchObject({ kind: 'plugin', plugin: 'context-economy', form: 'notice' })
    env.dispose()
  })

  it('run 幂等键只锚 startSeq：冲刷后 run 增长的残余不被二次落刀', async () => {
    const env = makeEnv()
    const u1 = env.appendUser('Q1')
    env.verdict(u1.seq, 'pureQ')
    const a1 = env.appendAssistant(`A1：${'细节'.repeat(120)}`)
    const u2 = env.appendUser('Q2')
    env.verdict(u2.seq, 'pureQ')
    const a2 = env.appendAssistant(`A2：${'细节'.repeat(120)}`)
    env.runPlan([{ startSeq: u1.seq, endSeq: a2.seq, note: '两轮问答结论' }])
    await flush()
    expect(env.domain.stats().runsCut).toBe(1)
    // run 冲刷后又长出新消息 + 新清单（同 start、更大 end）→ 不得对残余再落第二刀
    const a3 = env.appendAssistant(`A3：${'细节'.repeat(120)}`)
    env.runPlan([{ startSeq: u1.seq, endSeq: a3.seq, note: '两轮问答结论' }])
    await flush()
    expect(env.domain.stats().runsCut).toBe(1)
    expect(env.replacements()).toHaveLength(1)
    env.dispose()
  })
})

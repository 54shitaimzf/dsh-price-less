/**
 * P14b1 星标 host 断面服务测试（docs/implement/P14b1-star-host-service.md §3.6）。
 * 十二组：全量断面 / 门控 / 解析失败 / 非 stop / 无会话 / apply 回填+产物+两相事实 /
 * 未知预览 / 幂等 / 版本递增 / fold / summarizeVerdict / pending 容量；另加 RPC 端口组。
 * 全部 fake，零网络、零真模型、零 cordis 运行时。
 */
import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { dossierStorageKey, sessionScopedTaskId, type DossierBody } from '../src/core/dossier.ts'
import { createProjectFrame, projectFrameStorageKey, type SkillCatalogSnapshot } from '../src/core/prefix.ts'
import { mountStarHost, readSessionId, renderPreviewCommandText, summarizeVerdict, STAR_VERDICT_SUMMARY_MAX_CHARS, type StarPreviewDto } from '../src/domains/star.ts'
import { foldOptimizeRunFacts, OPTIMIZE_RUN_FACT_TYPE, previewRunFact, appliedRunFact, type OptimizeRunFactData } from '../src/domains/optimize-facts.ts'
import { SHEAR_RUN_PLAN_FACT_TYPE, type ShearRunPlanFactData } from '../src/domains/shear-facts.ts'
import { readJudgeTable } from '../src/domains/input.ts'
import {
  parseApplyPayload, parsePreviewPayload, registerStarBridge, STAR_BRIDGE_CHANNEL, STAR_BRIDGE_CODES,
  STAR_PREVIEW_LIMIT, type StarConnectionFace, type StarRpcHandler,
} from '../src/platform/star-bridge.ts'

const logger = { info() {}, warn() {}, error() {} }
const CATALOG: SkillCatalogSnapshot = { skills: [{ name: 'run-tests', description: '跑测试' }], complete: true }
const PROMPT = '读取 src/a.ts 并运行 npm test'
const FULL_OUTPUT = '[PRODUCT]\n' + PROMPT + '\n\n[VERDICTS]\nASPECT 构建\nFILE src/a.ts\nKEYWORD npm test\nKEEP 1\n'

interface FakeRecord { version: number; body: unknown }

function makeStorage(initial: Record<string, FakeRecord> = {}) {
  const data = new Map<string, FakeRecord>(Object.entries(initial))
  const puts: Array<{ table: string; key: string; body: unknown }> = []
  return {
    data,
    puts,
    getEntity(_table: string, key: string) { return data.get(key) },
    async putEntity(table: string, key: string, body: unknown, _source: unknown, opts?: { baseVersion?: number }) {
      const current = data.get(key)
      const base = opts?.baseVersion ?? 0
      if (base === 0 ? current !== undefined : current?.version !== base) throw new Error('CAS mismatch')
      const record: FakeRecord = { version: current === undefined ? 1 : current.version + 1, body }
      data.set(key, record)
      puts.push({ table, key, body })
      return record
    },
  }
}

function makeSession(events: unknown[] = [], id = 's1'): Session {
  return { header: { id }, id, snapshotEvents: () => events } as unknown as Session
}

/** 把卷宗消息装成会话 user/message 事件（P14c：★ 上下文改从会话事件读）。 */
function userEvents(messages: DossierBody['messages']): unknown[] {
  return messages.map((m) => ({
    type: 'user/message', seq: m.seq, time: m.time, surfaceOp: 'append',
    data: { role: 'user', content: [{ type: 'text', text: m.text }], source: { kind: 'user' } },
  }))
}

function makeLlm(
  output: string,
  calls: { count: number; prompts: string[]; options: Array<Record<string, unknown>> },
  finishKind = 'stop',
  efforts?: string[],
) {
  return {
    llm: {
      resolveModelInfo: efforts === undefined ? undefined : async () => ({ reasoning: { efforts: efforts.map((id) => ({ id })) } }),
      stream: async function* (options: { messages: Array<{ content: Array<{ text: string }> }> }) {
        calls.count++
        calls.prompts.push(options.messages[0]!.content[0]!.text)
        calls.options.push(options as unknown as Record<string, unknown>)
        yield { type: 'text-delta', index: 0, text: output }
        yield { type: 'finish', reason: { kind: finishKind } }
      },
    } as never,
  }
}

interface MountInput {
  output?: string
  sessionId?: string
  session?: boolean
  llm?: boolean
  skills?: boolean
  finishKind?: string
  frame?: boolean
  /** 推理档探测：给定即让假 llm 声明这些档（P14d §3）。 */
  efforts?: string[]
  /** 配置里的推理档设置（P14f；缺省 = 跟随模型默认）。 */
  effort?: string
  /** 覆盖判别路由（探测缓存键隔离用）。 */
  model?: string
  dossier?: { messages: DossierBody['messages']; annotations?: DossierBody['annotations'] }
}

function mount(input: MountInput = {}) {
  const sessionId = input.sessionId ?? 's1'
  const seed: Record<string, FakeRecord> = {}
  if (input.dossier !== undefined) {
    const taskId = sessionScopedTaskId(sessionId, 'task-1')
    seed[dossierStorageKey(taskId)] = { version: 1, body: { taskId, messages: input.dossier.messages, annotations: input.dossier.annotations ?? {} } }
  }
  if (input.frame === true) seed[projectFrameStorageKey('ws')] = { version: 1, body: createProjectFrame('目标', ['方面'], CATALOG).body }
  const storage = makeStorage(seed)
  const facts: OptimizeRunFactData[] = []
  // P16：星标剪切清单事实单独收（载荷形状与 optimize-run 不同）。
  const planFacts: ShearRunPlanFactData[] = []
  const calls = { count: 0, prompts: [] as string[], options: [] as Array<Record<string, unknown>> }
  const sessionEvents = input.dossier === undefined ? [] : userEvents(input.dossier.messages)
  const session = input.session === false ? undefined : makeSession(sessionEvents, sessionId)
  const host = mountStarHost({
    storage: storage as never,
    getConfig: () => ({
      discriminator: {
        ...(input.model === undefined ? {} : { provider: 'probe', model: input.model }),
        ...(input.effort === undefined ? {} : { reasoningEffort: input.effort }),
      },
    }) as never,
    logger,
    workspace: 'ws',
    now: () => 5000,
    skillsCtx: input.skills === false ? undefined : {
      skills: { snapshot: async () => ({ skills: CATALOG.skills.map((s) => ({ ...s, invocation: { modelInvocable: true, userInvocable: true } })), complete: true }) },
      logger: () => logger,
    } as never,
    llmCtx: input.llm === false ? undefined : makeLlm(input.output ?? FULL_OUTPUT, calls, input.finishKind ?? 'stop', input.efforts),
    resolveSession: session === undefined ? undefined : () => session,
    emitFact: (_session: unknown, type: string, data: unknown) => {
      if (type === SHEAR_RUN_PLAN_FACT_TYPE) { planFacts.push(data as ShearRunPlanFactData); return }
      facts.push(data as OptimizeRunFactData)
    },
  })
  return { host, storage, facts, planFacts, calls, sessionId }
}

const okValue = <T>(result: { ok: boolean }): T => (result as { ok: true; value: T }).value
const failCode = (result: { ok: boolean }): string => (result as { ok: false; code: string }).code

describe('star host service', () => {
  it('1. 全量断面：输入栈装配 + 双通道解析 + DTO 字段逐项', async () => {
    const { host, storage, facts, calls } = mount({
      frame: true,
      dossier: { messages: [{ seq: 5, time: 1, text: 'hello world' }, { seq: 7, time: 2, text: 'more text here' }] },
    })
    const result = await host.preview({ sessionId: 's1', prompt: PROMPT })
    expect(result.ok).toBe(true)
    const dto = okValue<StarPreviewDto>(result)
    expect(dto.previewId).toBe('s1#task-1#1#1')
    expect(dto.originalPrompt).toBe(PROMPT)
    expect(dto.product).toBe(PROMPT)
    expect(dto.verdicts.map((v) => v.kind)).toEqual(['aspect', 'file', 'keyword', 'keep'])
    expect(dto.verdicts[0]!.summary).toBe('方面：构建')
    expect(dto.missingAuthority).toEqual([])
    expect(dto.droppedLines).toBe(0)
    expect(dto.ctxTokens).toBeGreaterThan(0)
    expect(dto.historyCount).toBe(2)
    expect(calls.count).toBe(1)
    expect(calls.prompts[0]).toContain('[稳定前缀]')
    expect(calls.prompts[0]).toContain('目标')
    expect(calls.prompts[0]).toContain('<msg seq="5">hello world</msg>')
    expect(calls.prompts[0]).toContain('[候选权威段]')
    expect(storage.puts).toHaveLength(0)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ phase: 'preview', previewId: 's1#task-1#1#1', verdictCount: 4, keptSpanCount: 1, missingAuthorityCount: 0, latencyMs: 0, short: false, historyCount: 2 })
    // P14f：未配置推理档 = 跟随模型默认（不覆盖；两个字段都不落，请求不带 reasoningEffort）。
    expect(facts[0]!.requestedEffort).toBeUndefined()
    expect(facts[0]!.sentEffort).toBeUndefined()
    expect(Object.hasOwn(calls.options[0]!, 'reasoningEffort')).toBe(false)
    expect(facts[0]!.llmUsage).toBeUndefined()
    expect(renderPreviewCommandText(dto)).toContain('断面预览')
    expect(readSessionId(makeSession([], 'sid-2'))).toBe('sid-2')
  })

  it('2. 唯一门控：极短提示词 → 零调用短路（不调 LLM、不发事实、不写盘）', async () => {
    const { host, facts, calls, storage } = mount({ dossier: { messages: [{ seq: 5, time: 1, text: 'hello world' }] } })
    const result = await host.preview({ sessionId: 's1', prompt: '好' })
    expect(failCode(result)).toBe(STAR_BRIDGE_CODES.badRequest)
    expect(calls.count).toBe(0)
    expect(facts).toHaveLength(0)
    expect(storage.puts).toHaveLength(0)
    expect(host.stats().previews).toBe(0)
  })

  it('2b. 无历史素材不再跳过产品层：product 正常产出、historyCount=0', async () => {
    const { host, facts, calls } = mount({ output: FULL_OUTPUT })
    const result = await host.preview({ sessionId: 's1', prompt: PROMPT })
    const dto = okValue<StarPreviewDto>(result)
    expect(dto.historyCount).toBe(0)
    expect(dto.product).toBe(PROMPT)
    expect(calls.count).toBe(1)
    expect(facts[0]).toMatchObject({ short: true, historyCount: 0, productChars: PROMPT.length })
  })

  it('2c. P14d：产品开头元注释机械剥离 + 必保事实并入包含性检查 + 推理档探测', async () => {
    const metaOutput = '[PRODUCT]\n原样保留用户提示词\n' + PROMPT + '\n\n[VERDICTS]\nKEEP 1\n'
    const { host, facts, calls } = mount({
      output: metaOutput,
      model: 'probe-meta',
      efforts: ['off', 'high'],
      effort: 'off',
      dossier: { messages: [{ seq: 5, time: 1, text: 'hello world' }] },
    })
    const dto = okValue<StarPreviewDto>(await host.preview({ sessionId: 's1', prompt: PROMPT }))
    expect(dto.product).toBe(PROMPT)
    expect(dto.missingAuthority).toEqual([])
    expect(facts[0]).toMatchObject({ metaStrippedLines: 1, requestedEffort: 'off', sentEffort: 'off', keptSpanCount: 1 })
    expect(calls.options[0]!.reasoningEffort).toBe('off')
  })

  it('2d. 必保事实缺失 → 警告；模型未声明所选档 → 回退为跟随（不传 effort）', async () => {
    const { host, facts, calls } = mount({
      output: '[PRODUCT]\n重写后的提示词\n\n[VERDICTS]\n',
      model: 'probe-plain',
      efforts: ['low', 'high'],
      effort: 'off',
      dossier: { messages: [{ seq: 5, time: 1, text: 'hello world' }] },
    })
    const dto = okValue<StarPreviewDto>(await host.preview({ sessionId: 's1', prompt: PROMPT }))
    expect(dto.missingAuthority).toEqual([{ index: 1, text: 'src/a.ts' }])
    expect(facts[0]).toMatchObject({ missingAuthorityCount: 1, requestedEffort: 'off' })
    expect(facts[0]!.sentEffort).toBeUndefined()
    expect(Object.hasOwn(calls.options[0]!, 'reasoningEffort')).toBe(false)
  })

  it('3. 解析失败：乱码输出 → CE_STAR_PARSE_FAILED 且零 putEntity', async () => {
    const { host, storage, facts } = mount({
      dossier: { messages: [{ seq: 5, time: 1, text: 'hello world' }] },
      output: 'no markers at all',
    })
    const result = await host.preview({ sessionId: 's1', prompt: PROMPT })
    expect(failCode(result)).toBe(STAR_BRIDGE_CODES.parseFailed)
    expect(storage.puts).toHaveLength(0)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ phase: 'preview', errorCode: STAR_BRIDGE_CODES.parseFailed })
    expect(host.stats().parseFailures).toBe(1)
  })

  it('4. 非 stop 结束 → CE_STAR_LLM_FAILED 且零 putEntity', async () => {
    const { host, storage, facts } = mount({ finishKind: 'error', dossier: { messages: [{ seq: 5, time: 1, text: 'hello world' }] } })
    const result = await host.preview({ sessionId: 's1', prompt: PROMPT })
    expect(failCode(result)).toBe(STAR_BRIDGE_CODES.llmFailed)
    expect(storage.puts).toHaveLength(0)
    expect(facts[0]).toMatchObject({ phase: 'preview', errorCode: STAR_BRIDGE_CODES.llmFailed })
    expect(host.stats().llmFailures).toBe(1)
  })

  it('5. 无 live session → CE_STAR_NO_SESSION 且未调用 LLM', async () => {
    const { host, calls, storage } = mount({ session: false })
    const result = await host.preview({ sessionId: 's1', prompt: PROMPT })
    expect(failCode(result)).toBe(STAR_BRIDGE_CODES.noSession)
    expect(calls.count).toBe(0)
    expect(storage.puts).toHaveLength(0)
  })

  it('6. apply：卷宗回填 + 冲突计数 + 产物形状被 readJudgeTable 接受 + 两相事实 + 剪切清单事实', async () => {
    const { host, storage, facts, planFacts } = mount({
      dossier: { messages: [{ seq: 5, time: 1, text: 'hello world' }, { seq: 7, time: 2, text: 'more text here' }], annotations: { '5': [{ class: 'pureQ', by: 'auto', at: 1 }] } },
      output: '[PRODUCT]\n产品文本\n\n[VERDICTS]\nCLASS 5 action\nSHEAR 5..5 已吸收：结论\n',
    })
    const previewId = okValue<StarPreviewDto>(await host.preview({ sessionId: 's1', prompt: PROMPT })).previewId
    const applied = await host.apply({ sessionId: 's1', previewId, editedProduct: '用户编辑后的产品' })
    expect(applied.ok).toBe(true)
    expect(okValue<{ text?: string }>(applied).text).toContain('回填 1 条，冲突 1 条')
    const dossier = storage.data.get('dossier:s1:task-1')!.body as DossierBody
    expect(dossier.annotations['5']).toEqual([{ class: 'action', by: 'backfill', at: 5000 }])
    const artifact = storage.data.get('optimize_artifact:latest:ws')!.body as Record<string, unknown>
    expect(artifact).toMatchObject({
      product: '用户编辑后的产品', taskId: 's1:task-1', sessionId: 's1', previewId, appliedAt: 5000,
      shear: [{ startSeq: 5, endSeq: 5, note: '结论' }], keptSpanIndexes: [1],
    })
    expect(readJudgeTable(storage as never, 'ws')).toEqual({ version: 1, aspects: [], fileSignatures: [], keywords: [] })
    expect(facts.map((f) => f.phase)).toEqual(['preview', 'applied'])
    expect(facts[0]!.previewId).toBe(facts[1]!.previewId)
    expect(facts[1]).toMatchObject({ backfillCount: 1, backfillConflicts: 1, shearPairs: 1 })
    expect(facts[1]!.shearTokens).toBeGreaterThan(0)
    // P16：星标 = 吸收证明 → 剪切清单落成 ignorable 事实（坐标 + 结论原样搬运）
    expect(planFacts).toHaveLength(1)
    expect(planFacts[0]).toMatchObject({ source: 'star', items: [{ startSeq: 5, endSeq: 5, note: '结论' }] })
    expect(host.stats()).toMatchObject({ previews: 1, applies: 1, reapplies: 0, pending: 1 })
  })

  it('7. apply 未知 previewId / 跨会话 → CE_STAR_UNKNOWN_PREVIEW', async () => {
    const { host } = mount({ dossier: { messages: [{ seq: 5, time: 1, text: 'hello world' }] } })
    expect(failCode(await host.apply({ sessionId: 's1', previewId: 'nope', editedProduct: 'x' }))).toBe(STAR_BRIDGE_CODES.unknownPreview)
    const previewId = okValue<StarPreviewDto>(await host.preview({ sessionId: 's1', prompt: PROMPT })).previewId
    expect(failCode(await host.apply({ sessionId: 's2', previewId, editedProduct: 'x' }))).toBe(STAR_BRIDGE_CODES.unknownPreview)
  })

  it('8. apply 幂等：二次提交不写盘、不发事实，reapplies 计数', async () => {
    const { host, storage, facts } = mount({ dossier: { messages: [{ seq: 5, time: 1, text: 'hello world' }] } })
    const previewId = okValue<StarPreviewDto>(await host.preview({ sessionId: 's1', prompt: PROMPT })).previewId
    await host.apply({ sessionId: 's1', previewId, editedProduct: 'x' })
    const puts = storage.puts.length
    const factCount = facts.length
    const again = await host.apply({ sessionId: 's1', previewId, editedProduct: 'x' })
    expect(again.ok).toBe(true)
    expect(okValue<{ text?: string }>(again).text).toContain('重复提交')
    expect(storage.puts).toHaveLength(puts)
    expect(facts).toHaveLength(factCount)
    expect(host.stats().reapplies).toBe(1)
  })

  it('9. 产物版本递增：第二次断面 apply 后 judgeTable.version 1 → 2', async () => {
    const { host, storage } = mount({ dossier: { messages: [{ seq: 5, time: 1, text: 'hello world' }] } })
    const first = okValue<StarPreviewDto>(await host.preview({ sessionId: 's1', prompt: PROMPT })).previewId
    await host.apply({ sessionId: 's1', previewId: first, editedProduct: 'v1' })
    const second = okValue<StarPreviewDto>(await host.preview({ sessionId: 's1', prompt: PROMPT })).previewId
    await host.apply({ sessionId: 's1', previewId: second, editedProduct: 'v2' })
    expect(readJudgeTable(storage as never, 'ws')!.version).toBe(2)
    expect((storage.data.get('optimize_artifact:latest:ws')!.body as { product: string }).product).toBe('v2')
  })

  it('10. foldOptimizeRunFacts：preview×2（其一无 applied）→ 归并口径', () => {
    const base = (previewId: string, at: number) => ({ previewId, taskId: 't', sessionId: 's', at })
    const facts = [
      previewRunFact(base('p1', 1), { short: false, ctxTokens: 100, llmUsage: { inputTokens: 10, outputTokens: 5 } }),
      appliedRunFact(base('p1', 2), { backfillCount: 2, backfillConflicts: 1, shearPairs: 1, shearTokens: 30 }),
      previewRunFact(base('p2', 3), { short: true, ctxTokens: 50, llmUsage: { inputTokens: 3, outputTokens: 1 } }),
    ]
    const ledger = foldOptimizeRunFacts(facts)
    expect(ledger.optimizeCount).toBe(2)
    expect(ledger.optimizePromptTokens).toMatchObject({ inputTokens: 13, outputTokens: 6 })
    expect(ledger.verdictBackfill).toEqual({ count: 2, conflicts: 1 })
    expect(ledger.shearAtStar).toEqual({ pairs: 1, tokens: 30 })
    expect(Object.hasOwn(facts[2]!, 'backfillCount')).toBe(false)
    expect(OPTIMIZE_RUN_FACT_TYPE).toBe('context-economy/optimize-run')
  })

  it('11. summarizeVerdict：八种 kind 行文 + 长度钳制', () => {
    const views = [
      summarizeVerdict({ kind: 'class', seq: 3, class: 'action' }),
      summarizeVerdict({ kind: 'boundary', seq: 4 }),
      summarizeVerdict({ kind: 'shear', startSeq: 5, endSeq: 6, note: '结论' }),
      summarizeVerdict({ kind: 'skill', name: 'run-tests' }),
      summarizeVerdict({ kind: 'keep', spanIndex: 2 }),
      summarizeVerdict({ kind: 'aspect', text: '构建' }),
      summarizeVerdict({ kind: 'file', signature: 'src/a.ts' }),
      summarizeVerdict({ kind: 'keyword', keyword: 'npm test' }),
    ]
    expect(views.map((v) => v.kind)).toEqual(['class', 'boundary', 'shear', 'skill', 'keep', 'aspect', 'file', 'keyword'])
    expect(views[0]!.summary).toBe('消息 #3 标注为 action')
    expect(views[1]!.summary).toBe('消息 #4 为任务边界')
    expect(views[2]!.summary).toBe('剪切 #5..#6：结论')
    expect(views[4]!.summary).toBe('保留权威段 #2')
    expect(views[7]!.summary).toBe('关键词：npm test')
    const long = summarizeVerdict({ kind: 'aspect', text: 'x'.repeat(500) })
    expect(long.summary.length).toBe(STAR_VERDICT_SUMMARY_MAX_CHARS)
    expect(long.summary.endsWith('…')).toBe(true)
  })

  it('12. pending 容量：第 33 个预览淘汰最旧', async () => {
    const { host } = mount({ dossier: { messages: [{ seq: 5, time: 1, text: 'hello world' }] } })
    let firstId = ''
    for (let i = 0; i < STAR_PREVIEW_LIMIT + 1; i++) {
      const id = okValue<StarPreviewDto>(await host.preview({ sessionId: 's1', prompt: `${PROMPT} ${i}` })).previewId
      if (i === 0) firstId = id
    }
    expect(host.stats().pending).toBe(STAR_PREVIEW_LIMIT)
    expect(failCode(await host.apply({ sessionId: 's1', previewId: firstId, editedProduct: 'x' }))).toBe(STAR_BRIDGE_CODES.unknownPreview)
    host.dispose()
    expect(host.stats().pending).toBe(0)
  })

  it('12b. 结果复用：同 prompt 同上下文二次点击零调用、零事实；apply 后失效；换 prompt 重新断面', async () => {
    const { host, facts, calls } = mount({ dossier: { messages: [{ seq: 5, time: 1, text: 'hello world' }] } })
    const first = okValue<StarPreviewDto>(await host.preview({ sessionId: 's1', prompt: PROMPT }))
    const again = okValue<StarPreviewDto>(await host.preview({ sessionId: 's1', prompt: PROMPT }))
    expect(again).toEqual(first)
    expect(calls.count).toBe(1)
    expect(facts.filter((f) => f.phase === 'preview')).toHaveLength(1)
    expect(host.stats()).toMatchObject({ previews: 1, previewCacheHits: 1, pending: 1 })
    // 缓存的预览仍可 apply（pending 随缓存同步保活）。
    expect((await host.apply({ sessionId: 's1', previewId: again.previewId, editedProduct: 'x' })).ok).toBe(true)
    // 已消费 → 失效：同 prompt 再点击重新断面（新 previewId、新事实）。
    const third = okValue<StarPreviewDto>(await host.preview({ sessionId: 's1', prompt: PROMPT }))
    expect(third.previewId).not.toBe(first.previewId)
    expect(calls.count).toBe(2)
    expect(facts.filter((f) => f.phase === 'preview')).toHaveLength(2)
    // 换 prompt → 新断面。
    await host.preview({ sessionId: 's1', prompt: `${PROMPT} 追加一句` })
    expect(calls.count).toBe(3)
  })

  it('13. RPC 端口：channel/端点常量、payload 校验、分派、未知端点、handler 抛错', async () => {
    const seen: { channel?: string; removed: boolean } = { removed: false }
    let handler: StarRpcHandler | undefined
    const connection: StarConnectionFace = {
      rpc: {
        handle(channel, next) {
          seen.channel = channel
          handler = next
          return async () => { seen.removed = true }
        },
      },
    }
    const stop = registerStarBridge(connection, {
      preview: async (payload) => ({ ok: true, value: { echo: payload } }),
      apply: async () => ({ ok: true, value: { text: 'ok' } }),
    }, logger)
    expect(seen.channel).toBe(STAR_BRIDGE_CHANNEL)
    const signal = new AbortController().signal
    expect(await handler!('star.preview', { sessionId: 's1', prompt: '' }, signal)).toEqual({ ok: true, value: { echo: { sessionId: 's1', prompt: '' } } })
    expect(await handler!('star.preview', { sessionId: '' }, signal)).toMatchObject({ ok: false, error: { code: STAR_BRIDGE_CODES.badRequest, details: {} } })
    expect(await handler!('star.nope', {}, signal)).toMatchObject({ ok: false, error: { code: STAR_BRIDGE_CODES.unknownEndpoint } })
    registerStarBridge(connection, {
      preview: async () => { throw new Error('boom') },
      apply: async () => ({ ok: true, value: {} }),
    }, logger)
    expect(await handler!('star.preview', { sessionId: 's1', prompt: 'x' }, signal)).toMatchObject({ ok: false, error: { code: STAR_BRIDGE_CODES.internal } })
    expect(parsePreviewPayload(null)).toBeUndefined()
    expect(parsePreviewPayload({ sessionId: 's1', prompt: 1 })).toBeUndefined()
    expect(parseApplyPayload({ sessionId: 's1', previewId: 'p', editedProduct: '' })).toEqual({ sessionId: 's1', previewId: 'p', editedProduct: '' })
    expect(parseApplyPayload({ sessionId: 's1', previewId: 'p' })).toBeUndefined()
    await stop()
    expect(seen.removed).toBe(true)
  })
})

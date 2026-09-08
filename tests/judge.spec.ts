/**
 * P10 判据与对表纯核测试（docs/implement/P10-judge.md §3.2）。
 * 九组用例：L0/L1/对表/prompt 渲染/解析/fold/P8-P9 集成/datasets 同源/确定性。
 * 全部纯函数与 fake 数据，零 cordis 运行时 import。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DOSSIER_CLASSES, TRIVIAL_MESSAGE_MAX_CHARS, createDossier, foldDossierLedger, isTrivialMessage,
  normalizeMessageText, type DossierBody, type DossierMessage,
} from '../src/core/dossier.ts'
import { JUDGE_VERDICT_FACT_TYPE } from '../src/core/units.ts'
import {
  JUDGE_PROMPT_CONTEXT,
  JUDGE_PROMPT_HEAD,
  JUDGE_PROMPT_OUTPUT,
  JUDGE_PROMPT_RULES_CLAUSES,
  createEmptyJudgeTable,
  foldJudgeLedger,
  freezeJudgeConfig,
  judgeKeywordScore,
  judgeL1CacheKey,
  matchJudgeTable,
  parseJudgeLlmOutput,
  renderJudgePrompt,
  toJudgeVerdictFactData,
  type JudgeRecord,
} from '../src/core/judge.ts'

const msg = (seq: number, text: string): DossierMessage => ({ seq, time: seq, text })

function bodyWith(messages: DossierMessage[]): DossierBody {
  let body = createDossier('task-1')
  for (const m of messages) body = { ...body, messages: [...body.messages, m] }
  return body
}

describe('judge', () => {
  it('judge 极短消息判据（P14c：L0 延续词表已删——实测 0.6% 命中）', () => {
    expect(TRIVIAL_MESSAGE_MAX_CHARS).toBe(4)
    expect(isTrivialMessage('好')).toBe(true)
    expect(isTrivialMessage('ok')).toBe(true)
    expect(isTrivialMessage('继续')).toBe(true)
    expect(isTrivialMessage('好，继续！')).toBe(true)
    expect(isTrivialMessage('')).toBe(true)
    expect(isTrivialMessage('继续做')).toBe(true)   // 去噪后 3 字 < 4
    expect(isTrivialMessage('继续做完')).toBe(false)  // 4 字 = 阈值，保留
    expect(isTrivialMessage('帮我写个测试')).toBe(false)
    expect(normalizeMessageText('  Hello，World！ ')).toBe('helloworld')
  })

  it('judge L1: 缓存键确定性、配置指纹与嵌套顺序无关', () => {
    const scope = { sessionId: 's1', seq: 2, text: 'hello', configFingerprint: 'cfg' }
    const a = judgeL1CacheKey(scope)
    const b = judgeL1CacheKey({ ...scope })
    expect(a).toBe(b)
    expect(judgeL1CacheKey(scope, 4)).not.toBe(judgeL1CacheKey(scope, 5))
    expect(judgeL1CacheKey({ ...scope, sessionId: 's2' })).not.toBe(a)
    expect(judgeL1CacheKey({ ...scope, seq: 3 })).not.toBe(a)
    expect(judgeL1CacheKey({ ...scope, text: 'world' })).not.toBe(a)
    expect(judgeL1CacheKey({ ...scope, configFingerprint: 'other' })).not.toBe(a)
    expect(freezeJudgeConfig({ b: 1, a: 2 })).toBe(freezeJudgeConfig({ a: 2, b: 1 }))
    expect(freezeJudgeConfig({ x: { b: 1, a: 2 }, y: [3, { d: 4, c: 5 }] }))
      .toBe(freezeJudgeConfig({ y: [3, { c: 5, d: 4 }], x: { a: 2, b: 1 } }))
  })

  it('judge table: 保守打分（签名 2 分 / 关键词各 1 分，总分 ≥2 才命中）', () => {
    expect(matchJudgeTable('hello', undefined)).toEqual({ hit: false, score: 0 })
    expect(matchJudgeTable('hello', { version: 0, aspects: [], fileSignatures: [], keywords: ['cache'] })).toEqual({ hit: false, score: 0 })
    const table = { version: 1, aspects: [], fileSignatures: ['Report.pdf'], keywords: ['缓存', '解析器', '自动判别'] }
    const before = JSON.stringify(table)
    expect(judgeKeywordScore('缓存')).toBe(1)
    expect(judgeKeywordScore('自动判别')).toBe(2)
    expect(judgeKeywordScore('p14b')).toBe(2)
    expect(judgeKeywordScore('b2')).toBe(1)
    // 单条泛关键词只值 1 分——不再足以静默短路（P14c §2）
    expect(matchJudgeTable('use 缓存', table)).toEqual({ hit: false, score: 1 })
    // 具体关键词 = 强特征（2 分）
    expect(matchJudgeTable('自动判别', table)).toEqual({ hit: true, reason: 'keyword', score: 2 })
    // 文件签名 = 强特征（2 分）
    expect(matchJudgeTable('open REPORT.PDF', table)).toEqual({ hit: true, reason: 'file-signature', score: 2 })
    expect(matchJudgeTable('report.pdf 缓存', table)).toEqual({ hit: true, reason: 'file-signature', score: 3 })
    // 两条泛关键词共现 = 2 分
    expect(matchJudgeTable('缓存 解析器', table)).toEqual({ hit: true, reason: 'keyword', score: 2 })
    expect(matchJudgeTable('unrelated', table)).toEqual({ hit: false, score: 0 })
    expect(JSON.stringify(table)).toBe(before)
    expect(createEmptyJudgeTable()).toEqual({ version: 1, aspects: [], fileSignatures: [], keywords: [] })
  })

  it('judge renderPrompt: 模板头部/上下文/规则/卷宗/target/输出、排除当前消息、ctxTokens 口径、不可变', () => {
    const dossier = bodyWith([msg(1, 'first'), msg(2, 'second')])
    const before = JSON.stringify(dossier)
    const result = renderJudgePrompt(dossier, { seq: 3, text: 'new task?' })
    expect(result.prompt.startsWith(JUDGE_PROMPT_HEAD)).toBe(true)
    expect(result.prompt).toContain(JUDGE_PROMPT_CONTEXT)
    expect(result.prompt).toContain(JUDGE_PROMPT_RULES_CLAUSES)
    expect(result.prompt).toContain('<dossier>')
    expect(result.prompt).toContain('<target>new task?</target>')
    expect(result.prompt).toContain(JUDGE_PROMPT_OUTPUT)
    expect(result.prompt).not.toContain('<msg seq="3">')
    expect(result.prompt).toContain('<msg seq="1">first</msg>')
    expect(result.prompt).toContain('<msg seq="2">second</msg>')
    const ctxBody = { ...dossier, messages: dossier.messages.slice(0, 2), annotations: dossier.annotations }
    expect(result.ctxTokens).toBe(foldDossierLedger(ctxBody).ctxTokens)
    expect(JSON.stringify(dossier)).toBe(before)
  })

  it('judge parse: new_task 归一、continue、markdown 围栏、非法输入 null', () => {
    expect(parseJudgeLlmOutput('{"decision":"new_task","class":"action"}')).toEqual({ decision: 'new-task', class: 'action' })
    expect(parseJudgeLlmOutput('{"decision":"continue","class":"pureQ"}')).toEqual({ decision: 'continue', class: 'pureQ' })
    expect(parseJudgeLlmOutput('```json\n{"decision":"new_task","class":"verifyQ"}\n```')).toEqual({ decision: 'new-task', class: 'verifyQ' })
    expect(parseJudgeLlmOutput('not json')).toBeNull()
    expect(parseJudgeLlmOutput('{"decision":"new_task"}')).toBeNull()
    expect(parseJudgeLlmOutput('{"decision":"new_task","class":"bogus"}')).toBeNull()
    expect(parseJudgeLlmOutput('{"decision":"maybe","class":"action"}')).toBeNull()
  })

  it('judge fold: 六种 trigger 手算全部判别族字段', () => {
    const records: JudgeRecord[] = [
      { seq: 1, time: 1, trigger: 't0', decision: 'continue', class: 'action', latencyMs: 10, ctxTokens: 100 },
      { seq: 2, time: 2, trigger: 'l0-continue', decision: 'continue' },
      { seq: 3, time: 3, trigger: 'l1-cache', decision: 'continue', class: 'pureQ', latencyMs: 5, ctxTokens: 200, llmUsage: { inputTokens: 1, outputTokens: 2 } },
      { seq: 4, time: 4, trigger: 'table', decision: 'continue', class: 'verifyQ', ctxTokens: 300 },
      { seq: 5, time: 5, trigger: 'llm', decision: 'new-task', class: 'action', latencyMs: 15, ctxTokens: 400, llmUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cacheReadTokens: 4, cacheWriteTokens: 5, reasoningTokens: 6 } },
      { seq: 6, time: 6, trigger: 'error-fallback', decision: 'continue', latencyMs: 7, ctxTokens: 500, error: { code: 'E', message: 'boom' } },
    ]
    const ledger = foldJudgeLedger(records)
    expect(ledger.judgeCount).toBe(6)
    expect(ledger.judgeErrorRate).toBe(1 / 6)
    expect(ledger.judgeCacheHitRate).toBe(1 / 6)
    expect(ledger.l0CaptureRate).toBe(1 / 6)
    expect(ledger.tableHitRate).toBe(1 / 2)
    expect(ledger.judgeLatencyMs).toBe((10 + 5 + 15 + 7) / 4)
    expect(ledger.judgeLLMUsage).toEqual({ inputTokens: 11, outputTokens: 22, totalTokens: 30, cacheReadTokens: 4, cacheWriteTokens: 5, reasoningTokens: 6 })
    expect(ledger.judgeCtxTokens).toBe(1500)
    expect(ledger.judgeVerdictDist).toEqual({ action: 2, pureQ: 1, verifyQ: 1 })
    expect(foldJudgeLedger([]).judgeErrorRate).toBe(0)
    expect(foldJudgeLedger([]).judgeLatencyMs).toBe(0)
  })

  it('judge P8/P9 集成: verdict 契约、toJudgeVerdictFactData、三分类 key 一致', () => {
    expect(JUDGE_VERDICT_FACT_TYPE).toBe('context-economy/judge-verdict')
    const parsed = parseJudgeLlmOutput('{"decision":"new_task","class":"action"}')!
    expect(parsed.decision).toBe('new-task')
    expect(toJudgeVerdictFactData('new-task', 10, 'task-x')).toEqual({ verdict: 'new-task', anchorSeq: 10, taskId: 'task-x' })
    const cont = toJudgeVerdictFactData('continue', 10)
    expect(cont).toEqual({ verdict: 'continue', anchorSeq: 10 })
    expect('taskId' in cont).toBe(false)
    const dist = foldJudgeLedger([{ seq: 1, time: 1, trigger: 'llm', decision: 'new-task', class: 'action' }]).judgeVerdictDist
    expect(Object.keys(dist).sort()).toEqual([...DOSSIER_CLASSES].sort())
  })

  it('judge datasets 同源: 规则分句与 v2.2 切片逐字节一致、输出含三分类', () => {
    const v22 = readFileSync('datasets/prompt-discriminator-v2.2.txt', 'utf8')
    const expected = v22.slice(v22.indexOf('先决排除：'), v22.indexOf('\n\n<anchor>'))
    expect(expected.length).toBeGreaterThan(800)
    expect(JUDGE_PROMPT_RULES_CLAUSES).toBe(expected)
    expect(JUDGE_PROMPT_OUTPUT).toContain('"action"|"pureQ"|"verifyQ"')
  })

  it('judge deterministic: prompt 与 fold 连续三次字节一致', () => {
    const dossier = bodyWith([msg(1, 'a'), msg(2, 'b')])
    const prompt = JSON.stringify(renderJudgePrompt(dossier, { seq: 3, text: 'c' }))
    expect(JSON.stringify(renderJudgePrompt(dossier, { seq: 3, text: 'c' }))).toBe(prompt)
    expect(JSON.stringify(renderJudgePrompt(dossier, { seq: 3, text: 'c' }))).toBe(prompt)
    const records: JudgeRecord[] = [{ seq: 1, time: 1, trigger: 'llm', decision: 'new-task', class: 'action' }]
    const ledger = JSON.stringify(foldJudgeLedger(records))
    expect(JSON.stringify(foldJudgeLedger(records))).toBe(ledger)
    expect(JSON.stringify(foldJudgeLedger(records))).toBe(ledger)
  })
})

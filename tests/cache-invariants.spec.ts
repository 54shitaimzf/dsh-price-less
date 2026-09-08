/**
 * P21b 四道缓存断言（docs/10 §6 / docs/06 §3–§7；P21b 进 CI）。
 * ① 本轮请求 = 上轮请求 + 新增段（前缀性质）；② 同版本逐字节一致；
 * ③ 同 purpose 辅助调用共享模板前缀（实例数据只在尾区）；④ 档案堆只追加（硬帽整条截断，不改写）。
 * 纯函数断言：零网络、零模型、零 IO；同输入同输出。
 */
import { describe, expect, it } from 'vitest'
import { flatDensity } from '../src/core/meter/index.ts'
import {
  COMPRESS_BOUNDARY_HEAD,
  COMPRESS_BOUNDARY_OUTPUT,
  COMPRESS_BOUNDARY_RULES,
  appendArchiveEntry,
  emptyArchiveStore,
  renderBoundaryPrompt,
  renderPressurePrompt,
  renderRegionTranscript,
} from '../src/core/compress/index.ts'
import { DEFAULT_ASSEMBLE_POLICY, archiveChainAppendOnly, archiveChainShape, truncateArchiveArea } from '../src/core/assemble/index.ts'
import { foldSegmentState } from '../src/core/units.ts'
import { rebuildDossiers } from '../src/core/restore/index.ts'
import { JUDGE_PROMPT_CONTEXT, JUDGE_PROMPT_HEAD, renderJudgePrompt } from '../src/core/judge.ts'
import { createDossier, appendDossierMessage, type DossierBody } from '../src/core/dossier.ts'
import type { LedgerSessionEvent } from '../src/core/ledger/types.ts'

const text = (value: string) => [{ type: 'text', text: value }]
const ev = (type: string, seq: number, data: unknown, surfaceOp?: string): LedgerSessionEvent =>
  ({ type, seq, time: 100 + seq, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) })

const commonPrefix = (a: string, b: string): string => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return a.slice(0, i)
}

describe('断言 1：本轮请求 = 上轮请求 + 新增段（前缀性质）', () => {
  const events: LedgerSessionEvent[] = [
    ev('user/message', 0, { content: text('做 A'), source: { kind: 'user' } }, 'append'),
    ev('assistant/message', 1, { message: { content: [{ type: 'tool-call', toolCallId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }] } }, 'append'),
    ev('context-economy/task-boundary', 2, { boundary: 'open', taskId: 'task-1' }), // 非表面事件：不改变转写
    ev('tool/result', 3, { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: text('1: line') }] } }, 'append'),
    ev('user/message', 4, { content: text('继续'), source: { kind: 'user' } }, 'append'),
    ev('assistant/message', 5, { message: { content: text('好的') } }, 'append'),
  ]

  it('表面区间逐步增长：旧转写恒为新转写前缀（含非表面事件插入）', () => {
    for (let k = 0; k < events.length - 1; k++) {
      const prev = renderRegionTranscript(events, { startSeq: 0, endSeq: k })
      const next = renderRegionTranscript(events, { startSeq: 0, endSeq: k + 1 })
      expect(next.startsWith(prev)).toBe(true)
    }
  })

  it('同输入同输出：同一区间两次转写逐字节一致', () => {
    const range = { startSeq: 0, endSeq: events.length - 1 }
    expect(renderRegionTranscript(events, range)).toBe(renderRegionTranscript(events, range))
  })
})

describe('断言 2：同版本实体逐字节一致', () => {
  it('段状态机 / 卷宗重建 / 档案追加 / prompt 渲染：同输入两次全等', () => {
    const facts = [
      { type: 'context-economy/task-boundary', seq: 1, time: 1, data: { boundary: 'close', taskId: 'task-1' } },
      { type: 'context-economy/judge-verdict', seq: 2, time: 2, data: { verdict: 'new-task', anchorSeq: 3 } },
    ]
    expect(JSON.stringify(foldSegmentState(facts))).toBe(JSON.stringify(foldSegmentState(facts)))
    const rebuildInput = {
      sessionId: 's1',
      segments: foldSegmentState(facts).segments,
      messages: [{ seq: 0, time: 1, text: 'A' }, { seq: 4, time: 2, text: 'B' }],
    }
    expect(JSON.stringify(rebuildDossiers(rebuildInput))).toBe(JSON.stringify(rebuildDossiers(rebuildInput)))
    const entry = { taskId: 't', kind: 'boundary' as const, text: 'S' }
    expect(JSON.stringify(appendArchiveEntry(emptyArchiveStore('w'), entry).body))
      .toBe(JSON.stringify(appendArchiveEntry(emptyArchiveStore('w'), entry).body))
    const promptInput = { regionText: 'REGION', units: [] }
    expect(renderBoundaryPrompt(promptInput).prompt).toBe(renderBoundaryPrompt(promptInput).prompt)
    expect(renderPressurePrompt(promptInput).prompt).toBe(renderPressurePrompt(promptInput).prompt)
  })
})

describe('断言 3：同 purpose 辅助调用共享模板前缀（实例数据只在尾区）', () => {
  const boundaryTemplate = [COMPRESS_BOUNDARY_HEAD, COMPRESS_BOUNDARY_RULES, COMPRESS_BOUNDARY_OUTPUT].join('\n\n')

  it('压缩调用：两次渲染公共前缀 ⊇ 模板；实例正文不在前缀内', () => {
    const a = renderBoundaryPrompt({ regionText: 'REGION-ALPHA'.repeat(8), units: [] })
    const b = renderBoundaryPrompt({ regionText: 'REGION-BETA'.repeat(8), units: [] })
    const prefix = commonPrefix(a.prompt, b.prompt)
    expect(prefix.length).toBeGreaterThanOrEqual(boundaryTemplate.length)
    expect(prefix).not.toContain('REGION-ALPHA')
    expect(a.prompt).not.toBe(b.prompt)
  })

  it('判别调用：两次渲染公共前缀 ⊇ 静态判据；实例消息不在前缀内', () => {
    const base = (message: string): DossierBody => appendDossierMessage(createDossier('t'), { seq: 0, time: 1, text: message })
    const a = renderJudgePrompt(base('MESSAGE-ALPHA'), { seq: 9, text: 'target' })
    const b = renderJudgePrompt(base('MESSAGE-BETA'), { seq: 9, text: 'target' })
    const prefix = commonPrefix(a.prompt, b.prompt)
    expect(prefix.length).toBeGreaterThanOrEqual(JUDGE_PROMPT_HEAD.length + JUDGE_PROMPT_CONTEXT.length)
    expect(prefix).not.toContain('MESSAGE-ALPHA')
  })
})

describe('断言 4：档案堆只追加（硬帽整条截断，不改写）', () => {
  const entry = (taskId: string, kind: 'checkpoint' | 'boundary', body: string) => ({ taskId, kind, text: body })

  it('追加不触碰既有条目字节；链形态两形态皆可校验', () => {
    const e1 = entry('t', 'checkpoint', 'C1')
    const e2 = entry('t', 'checkpoint', 'C2')
    const e3 = entry('t', 'boundary', 'D')
    const r1 = appendArchiveEntry(emptyArchiveStore('w'), e1)
    const r2 = appendArchiveEntry(r1.body, e2)
    const r3 = appendArchiveEntry(r2.body, e3)
    expect(JSON.stringify(r2.body.entries[0])).toBe(JSON.stringify(r1.body.entries[0]))
    expect(JSON.stringify(r3.body.entries.slice(0, 2))).toBe(JSON.stringify(r2.body.entries))
    expect(archiveChainAppendOnly(r1.body.entries, r2.body.entries)).toBe(true)
    expect(archiveChainAppendOnly(r2.body.entries, r3.body.entries)).toBe(true)
    expect(archiveChainShape(r2.body.entries).shape).toBe('prefix')
    expect(archiveChainShape(r3.body.entries).shape).toBe('chain')
  })

  it('硬帽截断只删最老整条：保留后缀逐字节不变 + 计数入账', () => {
    // 三条各 30 token（单桶密度 1 字符/token）；帽 45 → 只留最新整条且不超帽。
    const policy = { ...DEFAULT_ASSEMBLE_POLICY, density: flatDensity(1), archiveTokens: 45 }
    const big = [entry('t', 'boundary', 'x'.repeat(30)), entry('t', 'boundary', 'y'.repeat(30)), entry('t', 'boundary', 'z'.repeat(30))]
    const result = truncateArchiveArea(big, policy)
    expect(result.kept.length).toBe(1)
    expect(result.truncated.count).toBe(2)
    expect(JSON.stringify(result.kept[0])).toBe(JSON.stringify(big[2]))
    expect(result.overCap).toBe(false)
  })

  it('截断本身是受控 bump：追加后的 body 是新对象，原 body 不变', () => {
    const policy = { ...DEFAULT_ASSEMBLE_POLICY, density: flatDensity(1), archiveTokens: 10 }
    const body = { ...emptyArchiveStore('w'), entries: [entry('t', 'boundary', 'x'.repeat(60))] }
    const snapshot = JSON.stringify(body)
    const appended = appendArchiveEntry(body, entry('t', 'boundary', 'y'.repeat(60)), policy)
    expect(JSON.stringify(body)).toBe(snapshot)
    expect(appended.body).not.toBe(body)
    expect(appended.body.entries.length).toBe(1)
  })
})

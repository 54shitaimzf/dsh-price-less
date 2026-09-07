/**
 * 真实 Session 改史冒烟（P6.1 工单 §3.2；P6 审查补正 D——真机验证 H4/H5 端口）。
 * 前置 = junction 在位（build.sh 链接 @deepseek-ai/dsh-session / -compaction）；
 * 缺失时整文件 skip（环境问题，禁 npm install 补装——P0 §6-6 同款纪律）。
 *
 * ① 真实 SessionStore + createHistoryPort：单节点 user/message replace → surface 只含新 seq、
 *    sourceEventSeqs 覆盖被遮蔽节点、事件落日志（H4 契约真机接受面）。
 * ② recordPrune → compaction/prune 的 shadowedRange/shadowedSeqs 与当前 surface 一致（影子计价）。
 * 本文件不进 tsconfig.tests.json include（真集成类型面单独守卫，与 harness-session.spec 同款）。
 */
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { createHistoryPort } from '../src/platform/history.ts'

const hasRuntime = existsSync('node_modules/@deepseek-ai/dsh-session')
  && existsSync('node_modules/@deepseek-ai/dsh-compaction')

const userMessage = (id: string) => ({
  id,
  role: 'user' as const,
  content: [{ type: 'text' as const, text: `msg-${id}` }],
  source: { kind: 'user' as const },
})

describe.skipIf(!hasRuntime)('真实 Session 改史冒烟（junction 在位时）', () => {
  it('H4：单节点 replace → surface 只含新 seq，sourceEventSeqs 覆盖被遮蔽节点', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('user/message', userMessage('m1'), { surfaceOp: 'append' })
    const port = createHistoryPort(session)
    const result = port.replaceSurface({
      type: 'user/message',
      data: userMessage('m2'),
      range: { start: 0, end: 0 },
    })
    expect(Number(result.event.seq)).toBe(1)
    expect(result.shadowedSeqs.map((n) => Number(n))).toEqual([0])
    expect(session.surface.nodes.map((n) => Number(n))).toEqual([1])
    const last = session.snapshotEvents().at(-1)
    expect(last?.type).toBe('user/message')
    if (last?.type === 'user/message') {
      expect(last.sourceEventSeqs?.map((n) => Number(n))).toEqual([0])
      expect(last.data.id).toBe('m2')
    }
  })

  it('H5 影子计价：recordPrune 的 shadowedRange/shadowedSeqs 与当前 surface 一致', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('user/message', userMessage('p1'), { surfaceOp: 'append' })
    const port = createHistoryPort(session)
    const event = port.recordPrune({ start: 0, end: 0, shadowedTokenCount: 321 })
    expect(event.type).toBe('compaction/prune')
    expect(event.data.shadowedRange).toEqual({ start: 0, end: 0 })
    expect(event.data.shadowedSeqs.map((n) => Number(n))).toEqual([0])
    expect(event.data.shadowedTokenCount).toBe(321)
    expect(session.surface.nodes.map((n) => Number(n))).toEqual([0])
  })
})

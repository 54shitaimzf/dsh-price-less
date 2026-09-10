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

  /**
   * HC5 残余（REPAIR-2026-09-10 §8.5-3）：会话格式 v3 把系统提示词搬成 surface **节点 0**
   * （`system/message`，`EpochHeader.system` 已移除），并加 `assertSystemHeadRewrite`：
   * 覆盖节点 0 的 replace 必须**自身是** `system/message` 且恰好只罩那一个节点，否则抛。
   *
   * 本用例钉死插件的承重不变量：**压缩/剪切的区间起点永远是首条 `user/message`（序 ≥ 1），
   * 永远不落在系统节点上**——否则第一次边界压缩就会炸。
   */
  it('HC5/v3：surface 节点 0 = system/message → 插件区间起点 > 0，replace 被接受且系统节点存活', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append(
      'system/message',
      { turn: 0, step: 0, message: { role: 'system', content: [{ type: 'text', text: 'system prompt' }] } } as never,
      { surfaceOp: 'append' },
    )
    session.append('user/message', userMessage('u1'), { surfaceOp: 'append' })
    session.append('user/message', userMessage('u2'), { surfaceOp: 'append' })

    const nodes = session.surface.nodes.map(Number)
    expect(nodes).toEqual([0, 1, 2])
    const systemSeq = nodes[0]!
    // 插件口径：区间起点 = 首条 user/message 的 seq（`firstUserSeq`）。
    const firstUser = session.snapshotEvents().find((event) => event.type === 'user/message')!
    const lastUser = [...session.snapshotEvents()].reverse().find((event) => event.type === 'user/message')!
    expect(Number(firstUser.seq)).toBeGreaterThan(systemSeq)

    const port = createHistoryPort(session)
    const landed = port.replaceSurface({
      type: 'user/message',
      data: userMessage('summary'),
      range: { start: firstUser.seq, end: lastUser.seq },
    })
    // 系统节点仍独占节点 0，压缩结果落在其后。
    expect(session.surface.nodes.map((n) => Number(n))).toEqual([systemSeq, Number(landed.event.seq)])
    expect(landed.shadowedSeqs.map((n) => Number(n))).toEqual([1, 2])

    // 反证：起点落在系统节点上的 replace 会被 harness 拒绝——这正是上条不变量的存在理由。
    const bare = new Context()
    await bare.plugin(SessionStore)
    const s2 = bare.sessions.create()
    s2.append(
      'system/message',
      { turn: 0, step: 0, message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } } as never,
      { surfaceOp: 'append' },
    )
    s2.append('user/message', userMessage('x1'), { surfaceOp: 'append' })
    expect(() => createHistoryPort(s2).replaceSurface({
      type: 'user/message',
      data: userMessage('y'),
      range: { start: 0 as never, end: 1 as never },
    })).toThrow(/system prompt/)
  })
})

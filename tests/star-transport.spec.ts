/**
 * P14b2 星标传输契约与端到端（两侧同测；docs/implement/archive/P14b2-star-live-bridge.md §3.4）。
 * 契约等价 / 进程内 E2E（client 桥 → fake wire → 真实 host 端口）/ 失败映射 / 无 connection /
 * host 端口行为。全部 fake，零网络、零真模型。
 */
import { describe, expect, it } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { buildPreviewDto, type StarPreviewDto } from '../src/domains/star.ts'
import {
  registerStarBridge, STAR_APPLY_ENDPOINT as HOST_APPLY, STAR_BRIDGE_CHANNEL as HOST_CHANNEL,
  STAR_BRIDGE_CODES, STAR_PREVIEW_ENDPOINT as HOST_PREVIEW,
  type StarBridgeHandlers, type StarConnectionFace, type StarRpcHandler,
} from '../src/platform/star-bridge.ts'
import { createHostStarBridge } from '../client/star/star-bridge.ts'
import {
  isStarApplyValue, isStarPreviewData, STAR_APPLY_ENDPOINT, STAR_BRIDGE_CHANNEL, STAR_CLIENT_CODES,
  STAR_NO_CONTEXT_NOTICE, STAR_PREVIEW_ENDPOINT,
} from '../client/star/star-protocol.ts'
import { TRIVIAL_PROMPT_MAX_CHARS as CLIENT_TRIVIAL_PROMPT_MAX_CHARS } from '../client/star/star-model.ts'
import type { StarPreviewData } from '../client/star/star-types.ts'
import { TRIVIAL_MESSAGE_MAX_CHARS as HOST_TRIVIAL_MESSAGE_MAX_CHARS } from '../src/core/dossier.ts'

const logger = { info() {}, warn() {}, error() {} }

/** host 侧真实产出的 DTO（经 P14b1 buildPreviewDto）。 */
const HOST_DTO: StarPreviewDto = buildPreviewDto({
  previewId: 'p1', originalPrompt: '原始 prompt', product: '产品文本',
  verdicts: [{ kind: 'aspect', text: '构建' }],
  missingAuthority: [{ index: 1, text: '权威段' }],
  droppedLines: 2, ctxTokens: 30, historyCount: 2,
})

/** client 侧类型样例（satisfies 保证必填键齐全；运行时比对键集合）。 */
const CLIENT_SAMPLE = {
  previewId: 'p1', originalPrompt: '原始 prompt', product: '产品文本',
  verdicts: [{ kind: 'aspect', summary: '方面：构建' }],
  missingAuthority: [{ index: 1, text: '权威段' }],
  droppedLines: 2, ctxTokens: 30, historyCount: 2,
} satisfies StarPreviewData

const clientCtx = (connection: unknown): Pick<ClientContext, 'get'> =>
  ({ get: (name: string) => (name === 'connection' ? connection : undefined) }) as unknown as Pick<ClientContext, 'get'>

/** fake wire：client rpc.call → 真实 host 端口 handler（含信封语义）。 */
function makeWire(handlers: StarBridgeHandlers) {
  let handler: StarRpcHandler | undefined
  let channel = ''
  const hostFace: StarConnectionFace = {
    rpc: { handle: (name, next) => { channel = name; handler = next; return async () => { handler = undefined } } },
  }
  const stop = registerStarBridge(hostFace, handlers, logger)
  const calls: Array<{ channel: string; endpoint: string; payload: unknown }> = []
  const bridge = createHostStarBridge(clientCtx({
    rpc: {
      async call(name: string, endpoint: string, payload: unknown) {
        calls.push({ channel: name, endpoint, payload })
        if (handler === undefined) throw new Error('host handler absent')
        return handler(endpoint, payload, new AbortController().signal)
      },
    },
  }))
  return { bridge, calls, stop, channel: () => channel, hasHandler: () => handler !== undefined }
}

describe('star transport (P14b2)', () => {
  it('1. 契约等价：channel/端点逐字相等 + DTO 键集合相等 + 形状守卫', () => {
    expect(STAR_BRIDGE_CHANNEL).toBe(HOST_CHANNEL)
    expect(STAR_PREVIEW_ENDPOINT).toBe(HOST_PREVIEW)
    expect(STAR_APPLY_ENDPOINT).toBe(HOST_APPLY)
    expect(Object.keys(HOST_DTO).sort()).toEqual(Object.keys(CLIENT_SAMPLE).sort())
    expect(isStarPreviewData(HOST_DTO)).toBe(true)
    expect(isStarPreviewData(CLIENT_SAMPLE)).toBe(true)
    expect(STAR_NO_CONTEXT_NOTICE).toBe('无历史素材：仅基于当前提示词与项目帧优化')
    // 两侧极短判据常量不得漂移（client 镜像 host，S4）
    expect(CLIENT_TRIVIAL_PROMPT_MAX_CHARS).toBe(HOST_TRIVIAL_MESSAGE_MAX_CHARS)
    expect(isStarPreviewData({ ...CLIENT_SAMPLE, product: 1 })).toBe(false)
    expect(isStarPreviewData({ ...CLIENT_SAMPLE, droppedLines: Number.NaN })).toBe(false)
    expect(isStarPreviewData({ ...CLIENT_SAMPLE, verdicts: [{}] })).toBe(false)
    expect(isStarPreviewData({ ...CLIENT_SAMPLE, historyCount: 'yes' })).toBe(false)
    expect(isStarPreviewData({ ...CLIENT_SAMPLE, historyCount: -1 })).toBe(false)
    expect(isStarPreviewData(null)).toBe(false)
    expect(isStarApplyValue({})).toBe(true)
    expect(isStarApplyValue({ text: 1 })).toBe(false)
    expect(isStarApplyValue(null)).toBe(false)
  })

  it('2. 端到端（进程内）：client 桥 → fake wire → 真实 host 端口', async () => {
    const wire = makeWire({
      preview: async (payload) => ({ ok: true, value: { ...HOST_DTO, previewId: payload.prompt } }),
      apply: async () => ({ ok: true, value: { text: '已应用' } }),
    })
    const preview = await wire.bridge.preview('s1', '原始 prompt')
    expect(preview).toEqual({ ok: true, data: { ...HOST_DTO, previewId: '原始 prompt' } })
    expect(wire.channel()).toBe(STAR_BRIDGE_CHANNEL)
    expect(wire.calls[0]).toEqual({
      channel: STAR_BRIDGE_CHANNEL, endpoint: STAR_PREVIEW_ENDPOINT,
      payload: { sessionId: 's1', prompt: '原始 prompt' },
    })
    const applied = await wire.bridge.apply('s1', { previewId: 'p1', editedProduct: '用户编辑' })
    expect(applied).toEqual({ ok: true, text: '已应用' })
    expect(wire.calls[1]).toEqual({
      channel: STAR_BRIDGE_CHANNEL, endpoint: STAR_APPLY_ENDPOINT,
      payload: { sessionId: 's1', previewId: 'p1', editedProduct: '用户编辑' },
    })
    await wire.stop()
  })

  it('3. 失败映射：call 抛错→UNAVAILABLE；ok:false 原样透传；非法 value→BAD_REQUEST', async () => {
    const throwing = createHostStarBridge(clientCtx({ rpc: { call: async () => { throw new Error('HTTP 500') } } }))
    expect(await throwing.preview('s1', 'p')).toEqual({ ok: false, code: STAR_CLIENT_CODES.unavailable, message: 'HTTP 500' })
    const failing = createHostStarBridge(clientCtx({
      rpc: { call: async () => ({ ok: false, error: { code: STAR_BRIDGE_CODES.noSession, message: '会话不存在或未激活', details: {} } }) },
    }))
    expect(await failing.preview('s1', 'p')).toEqual({ ok: false, code: STAR_BRIDGE_CODES.noSession, message: '会话不存在或未激活' })
    expect(await failing.apply('s1', { previewId: 'p', editedProduct: 'e' })).toMatchObject({ ok: false, code: STAR_BRIDGE_CODES.noSession })
    const bad = createHostStarBridge(clientCtx({ rpc: { call: async () => ({ ok: true, value: { previewId: 1 } }) } }))
    expect(await bad.preview('s1', 'p')).toEqual({ ok: false, code: STAR_CLIENT_CODES.badValue, message: '预览数据形状非法' })
    const badApply = createHostStarBridge(clientCtx({ rpc: { call: async () => ({ ok: true, value: { text: 1 } }) } }))
    expect(await badApply.apply('s1', { previewId: 'p', editedProduct: 'e' })).toEqual({ ok: false, code: STAR_CLIENT_CODES.badValue, message: '应用结果形状非法' })
    const noText = createHostStarBridge(clientCtx({ rpc: { call: async () => ({ ok: true, value: {} }) } }))
    expect(await noText.apply('s1', { previewId: 'p', editedProduct: 'e' })).toEqual({ ok: true })
  })

  it('4. 无 connection：两个方法都返回 UNAVAILABLE，不抛', async () => {
    const bridge = createHostStarBridge(clientCtx(undefined))
    expect(await bridge.preview('s1', 'p')).toEqual({ ok: false, code: STAR_CLIENT_CODES.unavailable, message: '连接服务不可用' })
    expect(await bridge.apply('s1', { previewId: 'p', editedProduct: 'e' }))
      .toMatchObject({ ok: false, code: STAR_CLIENT_CODES.unavailable })
  })

  it('5. host 端口：未知端点 / 缺字段 / handler 抛错 / disposer 卸载', async () => {
    let handler: StarRpcHandler | undefined
    let disposed = false
    const connection: StarConnectionFace = {
      rpc: { handle: (_name, next) => { handler = next; return async () => { disposed = true; handler = undefined } } },
    }
    const stop = registerStarBridge(connection, {
      preview: async () => { throw new Error('boom') },
      apply: async () => ({ ok: true, value: {} }),
    }, logger)
    const signal = new AbortController().signal
    expect(await handler!('star.nope', {}, signal)).toMatchObject({ ok: false, error: { code: STAR_BRIDGE_CODES.unknownEndpoint } })
    expect(await handler!(HOST_PREVIEW, { sessionId: 's1' }, signal)).toMatchObject({ ok: false, error: { code: STAR_BRIDGE_CODES.badRequest } })
    expect(await handler!(HOST_APPLY, { sessionId: 's1', previewId: 'p' }, signal)).toMatchObject({ ok: false, error: { code: STAR_BRIDGE_CODES.badRequest } })
    expect(await handler!(HOST_PREVIEW, { sessionId: 's1', prompt: 'p' }, signal)).toMatchObject({ ok: false, error: { code: STAR_BRIDGE_CODES.internal } })
    expect(await handler!(HOST_APPLY, { sessionId: 's1', previewId: 'p', editedProduct: '' }, signal)).toEqual({ ok: true, value: {} })
    await stop()
    expect(disposed).toBe(true)
    expect(handler).toBeUndefined()
  })
})

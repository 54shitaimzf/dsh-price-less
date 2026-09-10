/**
 * 星标 Connection RPC 桥端口（P14b1；docs/13 §3.11 / docs/10 §1 H11）。
 *
 * 唯一 connection 触点：channel/端点常量、信封与 handler 结构面、payload 校验、注册/卸载。
 * 类型锚只从源文件子路径 type-only 取（@deepseek-ai/dsh-client-connection/src/rpc.ts 只依赖
 * 已链接的 dsh-brand，零级联 webserver/credentials/attachment——P14b1 §2.3 策略）；
 * 本地结构面与公开契约做互赋性编译期断言，任一处漂移即 typecheck 红。
 *
 * 模块: platform 星标 RPC 桥端口（唯一 harness 触点层）
 * 平面: L0（注册 + 形状校验 + 信封转换；无模型、无机制逻辑）
 * 回退链步数: 1（handler 抛错 → 捕获 + warn + CE_STAR_INTERNAL，绝不外溢）
 * 审查清单: 端口只记 endpoint/code，不记 prompt/product（用户数据）；signal 不消费（断面不可中断）。
 * 度量: 两相 optimize-run 事实由 domains/star.ts 发射；本文件零计数。
 */

import type { ConnectionRpcHandler, ConnectionRpcResult, HostConnectionHandle, HostConnectionRpc } from '@deepseek-ai/dsh-client-connection/src/rpc.ts'
import type { AssertAssignable } from './anchors.ts'
import type { CeLogger } from './events.ts'

/** 渠道与端点（wire 契约冻结；P14b2 client 侧常量必须逐字相等）。 */
export const STAR_BRIDGE_CHANNEL = '/context-economy'
export const STAR_PREVIEW_ENDPOINT = 'star.preview'
export const STAR_APPLY_ENDPOINT = 'star.apply'
/** 预览态内存容量（插入序淘汰，无 timer——docs/11 §2）。 */
export const STAR_PREVIEW_LIMIT = 32

/** 稳定错误码表（冻结；client 侧同名常量，P14b2 契约测试断言逐字相等）。 */
export const STAR_BRIDGE_CODES = {
  badRequest: 'CE_STAR_BAD_REQUEST',
  unknownEndpoint: 'CE_STAR_UNKNOWN_ENDPOINT',
  noSession: 'CE_STAR_NO_SESSION',
  llmFailed: 'CE_STAR_LLM_FAILED',
  parseFailed: 'CE_STAR_PARSE_FAILED',
  unknownPreview: 'CE_STAR_UNKNOWN_PREVIEW',
  storageFailed: 'CE_STAR_STORAGE_FAILED',
  internal: 'CE_STAR_INTERNAL',
  unavailable: 'CE_STAR_UNAVAILABLE',
} as const
export type StarBridgeCode = (typeof STAR_BRIDGE_CODES)[keyof typeof STAR_BRIDGE_CODES]

/** 本地结构面（仿 core 本地重声明纪律；形状 = ConnectionRpcFailure/Result/Handler）。 */
export interface StarRpcFailure { readonly code: string; readonly message: string; readonly details: object }
export type StarRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: StarRpcFailure }
export type StarRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<StarRpcResult>
export interface StarConnectionFace {
  readonly rpc: { handle(channel: string, handler: StarRpcHandler): () => Promise<void> }
}

// 编译期结构锚：本地面 ⇄ harness 公开契约双向可赋（任一漂移 → typecheck 红）。
// 原语见 platform/anchors.ts（唯一出处）。
export type StarRpcResultAnchor = AssertAssignable<StarRpcResult, ConnectionRpcResult<unknown>>
export type StarRpcResultAnchorBack = AssertAssignable<ConnectionRpcResult<unknown>, StarRpcResult>
export type StarRpcHandlerAnchor = AssertAssignable<StarRpcHandler, ConnectionRpcHandler>
export type StarRpcHandlerAnchorBack = AssertAssignable<ConnectionRpcHandler, StarRpcHandler>
export type StarRpcFaceAnchor = AssertAssignable<HostConnectionRpc, StarConnectionFace['rpc']>
export type StarConnectionFaceAnchor = AssertAssignable<HostConnectionHandle, StarConnectionFace>

export interface StarPreviewPayload { sessionId: string; prompt: string }
export interface StarApplyPayload { sessionId: string; previewId: string; editedProduct: string }

/** 业务结果（domains 面）：成功带 DTO，失败带稳定错误码。 */
export type StarBridgeOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string }

export interface StarBridgeHandlers<TPreview = unknown> {
  preview(payload: StarPreviewPayload): Promise<StarBridgeOutcome<TPreview>>
  apply(payload: StarApplyPayload): Promise<StarBridgeOutcome<{ text?: string }>>
}

function asRecord(payload: unknown): Record<string, unknown> | undefined {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined
}
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 纯校验：star.preview payload 形状（零副作用，可单测）。 */
export function parsePreviewPayload(payload: unknown): StarPreviewPayload | undefined {
  const record = asRecord(payload)
  if (record === undefined) return undefined
  const sessionId = nonEmptyString(record.sessionId)
  if (sessionId === undefined || typeof record.prompt !== 'string') return undefined
  return { sessionId, prompt: record.prompt }
}

/** 纯校验：star.apply payload 形状（用户编辑即终稿，空编辑不拦——P14b1 §0.4）。 */
export function parseApplyPayload(payload: unknown): StarApplyPayload | undefined {
  const record = asRecord(payload)
  if (record === undefined) return undefined
  const sessionId = nonEmptyString(record.sessionId)
  const previewId = nonEmptyString(record.previewId)
  if (sessionId === undefined || previewId === undefined || typeof record.editedProduct !== 'string') return undefined
  return { sessionId, previewId, editedProduct: record.editedProduct }
}

function failure(code: string, message: string): StarRpcResult {
  return { ok: false, error: { code, message, details: {} } }
}
function toWire<T>(outcome: StarBridgeOutcome<T>): StarRpcResult {
  return outcome.ok ? { ok: true, value: outcome.value } : failure(outcome.code, outcome.message)
}

/**
 * 注册 /context-economy 通道（owner = connection 的 ctx，故 disposer 必须由装配点持有并卸载）。
 * endpoint 分派：形状非法 → BAD_REQUEST；未知 → UNKNOWN_ENDPOINT；handler 抛错 → warn + INTERNAL。
 * signal 不消费：本单断面不可中断，客户端断开由连接层处理。
 */
export function registerStarBridge<TPreview>(
  connection: StarConnectionFace,
  handlers: StarBridgeHandlers<TPreview>,
  logger?: CeLogger,
): () => Promise<void> {
  return connection.rpc.handle(STAR_BRIDGE_CHANNEL, async (endpoint, payload) => {
    try {
      if (endpoint === STAR_PREVIEW_ENDPOINT) {
        const parsed = parsePreviewPayload(payload)
        return parsed === undefined
          ? failure(STAR_BRIDGE_CODES.badRequest, 'invalid star.preview payload')
          : toWire(await handlers.preview(parsed))
      }
      if (endpoint === STAR_APPLY_ENDPOINT) {
        const parsed = parseApplyPayload(payload)
        return parsed === undefined
          ? failure(STAR_BRIDGE_CODES.badRequest, 'invalid star.apply payload')
          : toWire(await handlers.apply(parsed))
      }
      return failure(STAR_BRIDGE_CODES.unknownEndpoint, 'unknown endpoint')
    } catch (e) {
      logger?.warn('context-economy: star bridge handler failed (contained)', endpoint, e instanceof Error ? e.message : String(e))
      return failure(STAR_BRIDGE_CODES.internal, 'star bridge internal error')
    }
  })
}

/**
 * 星标桥（client 半边）：P14a mock + P14b2 真实 Connection RPC 实现。
 *
 * 真实桥只经 `ctx.get('connection')`（client Context 无 connection 属性合并，只有 connection/reset
 * 事件合并——P14b2 §0.1）→ `rpc.call('/context-economy', endpoint, payload)`；每次调用现取服务
 * （连接重置/迟到都不影响）；失败一律返回结果对象，**绝不抛错、绝不重试、绝不缓存**。
 * 不 import host 侧 src/（S4）；channel/端点/形状校验见 star-protocol.ts。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { parseMockPreview } from './star-model.ts'
import {
  isStarApplyValue, isStarPreviewData, STAR_APPLY_ENDPOINT, STAR_BRIDGE_CHANNEL, STAR_CLIENT_CODES,
  STAR_PREVIEW_ENDPOINT,
} from './star-protocol.ts'
import type { StarApplyRequest, StarApplyResult, StarHostBridge, StarPreviewResult } from './star-types.ts'

type CallResult = { ok: true; value: unknown } | { ok: false; code: string; message: string }

/** 创建 P14b2 真实桥：Connection RPC → P14b1 host 端口。 */
export function createHostStarBridge(ctx: Pick<ClientContext, 'get'>): StarHostBridge {
  const call = async (endpoint: string, payload: unknown): Promise<CallResult> => {
    try {
      const connection = ctx.get('connection') as ConnectionHandle | undefined
      if (connection === undefined) return { ok: false, code: STAR_CLIENT_CODES.unavailable, message: '连接服务不可用' }
      const result = await connection.rpc.call(STAR_BRIDGE_CHANNEL, endpoint, payload)
      return result.ok
        ? { ok: true, value: result.value }
        : { ok: false, code: result.error.code, message: result.error.message }
    } catch (e) {
      return { ok: false, code: STAR_CLIENT_CODES.unavailable, message: e instanceof Error ? e.message : String(e) }
    }
  }
  return {
    async preview(sessionId: string, prompt: string): Promise<StarPreviewResult> {
      const result = await call(STAR_PREVIEW_ENDPOINT, { sessionId, prompt })
      if (!result.ok) return result
      return isStarPreviewData(result.value)
        ? { ok: true, data: result.value }
        : { ok: false, code: STAR_CLIENT_CODES.badValue, message: '预览数据形状非法' }
    },
    async apply(sessionId: string, request: StarApplyRequest): Promise<StarApplyResult> {
      const result = await call(STAR_APPLY_ENDPOINT, {
        sessionId, previewId: request.previewId, editedProduct: request.editedProduct,
      })
      if (!result.ok) return result
      if (!isStarApplyValue(result.value)) {
        return { ok: false, code: STAR_CLIENT_CODES.badValue, message: '应用结果形状非法' }
      }
      return result.value.text === undefined ? { ok: true } : { ok: true, text: result.value.text }
    },
  }
}

/** 创建确定性的 mock 桥（测试资产；运行期 client/index.ts 用 createHostStarBridge）。 */
export function createMockStarBridge(_now?: () => number): StarHostBridge {
  return {
    async preview(_sessionId: string, prompt: string): Promise<StarPreviewResult> {
      return { ok: true, data: parseMockPreview(prompt) }
    },
    async apply(_sessionId: string, _request: StarApplyRequest): Promise<StarApplyResult> {
      return { ok: true, text: 'P14a mock 已应用' }
    },
  }
}

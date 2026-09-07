/**
 * P14a mock StarHostBridge。
 *
 * 仅内存、确定性；不 import host 侧文件、不写 storage、不调 LLM、不访问 src/。
 * P14b 实现真实 bridge 后替换 `createMockStarBridge()` 即可，UI/类型不变。
 */

import { parseMockPreview } from './star-model.ts'
import type { StarApplyRequest, StarApplyResult, StarHostBridge, StarPreviewResult } from './star-types.ts'

/** 创建确定性的 mock 桥。`now` 保留用于未来生成不可变 previewId（当前不使用随机）。 */
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

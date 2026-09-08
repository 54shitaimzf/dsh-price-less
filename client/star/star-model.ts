/**
 * P14a 星标纯逻辑（client 半边，零 React、零 host import）。
 *
 * P14d：删除行级 diff 与展示裁剪（重写场景下 diff 信噪比≈0，正文即唯一交付面）；
 * 裁决不再平铺成一行，改为折叠详情用的计数摘要。mock 预览解析仍确定性。
 * 注意：客户端不实现“断面”，此处只做 P14b 接入前的 UI 占位桥接。
 */

import type { StarPreviewData, StarVerdictView } from './star-types.ts'

const MOCK_PRODUCT = 'mock 优化后 prompt\n（P14a 预览占位，P14b 接入真实断面）'
const MOCK_PREVIEW_ID = 'mock-preview-1'

/**
 * 极短提示词阈值与判据（镜像 host `src/core/dossier.ts` 的 TRIVIAL_MESSAGE_MAX_CHARS；
 * client 不得 import host src，S4——两侧由 tests/star-model.spec.ts 的漂移断言守住）。
 */
export const TRIVIAL_PROMPT_MAX_CHARS = 4
const PROMPT_NOISE_RE = /[\s\u3000！？。，、；：""''（）《》【】!?.,;:()\[\]{}~\-—_…]/gu

/** 去噪后短于阈值的提示词：★ 按钮禁用、host 零调用短路（两侧同口径）。 */
export function isTrivialPrompt(text: string): boolean {
  return text.replace(PROMPT_NOISE_RE, '').length < TRIVIAL_PROMPT_MAX_CHARS
}

function localCandidates(prompt: string): Array<{ index: number; text: string }> {
  return prompt.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 40)
    .map((text, index) => ({ index: index + 1, text }))
}

/** mock 预览解析：从当前草稿生成确定性预览数据（P14a 占位）。 */
export function parseMockPreview(input: string): StarPreviewData {
  const candidates = localCandidates(input)
  const product = input.trim().length === 0 ? null : MOCK_PRODUCT
  return {
    previewId: MOCK_PREVIEW_ID,
    originalPrompt: input,
    product,
    verdicts: [
      { kind: 'KEEP', summary: '保留候选权威段' },
      { kind: 'ASPECT', summary: '确认完成标准与验证方式' },
    ],
    missingAuthority: candidates,
    droppedLines: 0,
    ctxTokens: Math.ceil(input.length / 1.5),
    historyCount: 0,
  }
}

/** 裁决计数摘要（P14d：折叠详情的一行概览，不再平铺全文）。 */
export function verdictSummary(verdicts: readonly StarVerdictView[]): string {
  if (verdicts.length === 0) return '（无裁决）'
  const counts = new Map<string, number>()
  for (const verdict of verdicts) counts.set(verdict.kind, (counts.get(verdict.kind) ?? 0) + 1)
  return `裁决 ${verdicts.length}（${[...counts.entries()].map(([kind, n]) => `${kind} ${n}`).join(' · ')}）`
}

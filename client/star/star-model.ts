/**
 * P14a 星标纯逻辑（client 半边，零 React、零 host import）。
 *
 * 行级 diff 为轻量 LCS 纯函数，不引入 diff 依赖；mock 预览解析与展示裁剪均确定性。
 * 注意：客户端不实现“断面”，此处只做 P14b 接入前的 UI 占位桥接。
 */

import type { DiffLine, StarPreviewData, StarVerdictView } from './star-types.ts'

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

/** 轻量行级 LCS diff：同/加/删。空输入按整批处理。 */
export function diffLines(original: string, product: string): DiffLine[] {
  const a = original.length === 0 ? [] : original.split('\n')
  const b = product.length === 0 ? [] : product.split('\n')
  if (original === '') return b.map((text) => ({ type: 'add' as const, text }))
  if (product === '') return a.map((text) => ({ type: 'del' as const, text }))
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] })
      i++
    } else {
      out.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: a[i] })
    i++
  }
  while (j < m) {
    out.push({ type: 'add', text: b[j] })
    j++
  }
  return out
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

/** 预览文本裁剪：超长时保留头/尾并加省略标记。 */
export function clampPreviewText(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, 3000)}\n…[preview truncated]…\n${text.slice(-1000)}`
}

/** 行式裁决摘要（纯字符串，弹层首行概览用）。 */
export function summaryOfVerdicts(verdicts: readonly StarVerdictView[]): string {
  if (verdicts.length === 0) return '（无裁决）'
  return verdicts.map((v) => `${v.kind}: ${v.summary}`).join('；')
}

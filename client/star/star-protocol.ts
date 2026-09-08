/**
 * P14b2 星标 client 侧 wire 协议（常量 + 形状校验；零 host import，S4）。
 *
 * channel/端点与 `src/platform/star-bridge.ts` 逐字相等——两侧独立声明（client 不得 import src），
 * 由 `tests/star-transport.spec.ts` 机械断言不漂移。
 */
import type { StarPreviewData } from './star-types.ts'

export const STAR_BRIDGE_CHANNEL = '/context-economy'
export const STAR_PREVIEW_ENDPOINT = 'star.preview'
export const STAR_APPLY_ENDPOINT = 'star.apply'

/** client 侧错误码（host 侧错误码原样透传；这两个只由 client 产生）。 */
export const STAR_CLIENT_CODES = { unavailable: 'CE_STAR_UNAVAILABLE', badValue: 'CE_STAR_BAD_REQUEST' } as const

/** 短卷宗提示文案（P14b2 冻结；UI 壳消费归后续 UI 工单——本单禁区不动 StarButton.tsx）。 */
export const STAR_SHORT_NOTICE = '卷宗过短，本次仅回填裁决'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const isText = (value: unknown): value is string => typeof value === 'string'
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isVerdict = (value: unknown): boolean => isRecord(value) && isText(value.kind) && isText(value.summary)
const isMissingAuthority = (value: unknown): boolean => isRecord(value) && isFiniteNumber(value.index) && isText(value.text)

/** 严格逐字段校验：缺失必填字段/类型不符即失败（多余字段不推断、不采信）。 */
export function isStarPreviewData(value: unknown): value is StarPreviewData {
  if (!isRecord(value)) return false
  return isText(value.previewId)
    && isText(value.originalPrompt)
    && (value.product === null || isText(value.product))
    && Array.isArray(value.verdicts) && value.verdicts.every(isVerdict)
    && Array.isArray(value.missingAuthority) && value.missingAuthority.every(isMissingAuthority)
    && isFiniteNumber(value.droppedLines)
    && isFiniteNumber(value.ctxTokens)
    && typeof value.short === 'boolean'
}

/** apply 成功值：`{text?}`；text 缺失合法，存在必须是字符串。 */
export function isStarApplyValue(value: unknown): value is { text?: string } {
  if (!isRecord(value)) return false
  return value.text === undefined || isText(value.text)
}

/**
 * P14a 星标按钮类型契约（client 半边）。
 *
 * `StarHostBridge` 是 P14a 冻结、P14b 实现的桥接口；UI 只依赖本接口，
 * 不直接接触 host/storage/LLM。预览数据形状对齐 P11 纯核的 `OptimizeParseResult`
 * 可消费面（product/missingAuthority/droppedLines/短卷宗）。
 */

/** 行式裁决的 UI 展示视图（与 L1 内部 verdict 解耦，只保留用户可见摘要）。 */
export interface StarVerdictView {
  readonly kind: string
  readonly summary: string
}

/** 权威段缺失项。 */
export interface StarMissingAuthority {
  readonly index: number
  readonly text: string
}

/** 一次星标预览的完整数据。 */
export interface StarPreviewData {
  readonly previewId: string
  readonly originalPrompt: string
  /** P14a mock 阶段可能是占位文本；P14b 接入真实断面后为 LLM 产物。 */
  readonly product: string | null
  readonly verdicts: readonly StarVerdictView[]
  readonly missingAuthority: readonly StarMissingAuthority[]
  readonly droppedLines: number
  readonly ctxTokens: number
  readonly short: boolean
}

/** 预览返回：成功带数据，失败带稳定错误码/文案。 */
export type StarPreviewResult =
  | { readonly ok: true; readonly data: StarPreviewData }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** 应用（确认即终稿）请求。 */
export interface StarApplyRequest {
  readonly previewId: string
  readonly editedProduct: string
}

/** 应用返回：成功可带提示文本，失败稳定错误码/文案。 */
export type StarApplyResult =
  | { readonly ok: true; readonly text?: string }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** 星标按钮依赖的注入桥（P14b 以真实实现替换，UI 不变）。 */
export interface StarHostBridge {
  preview(sessionId: string, prompt: string): Promise<StarPreviewResult>
  apply(sessionId: string, request: StarApplyRequest): Promise<StarApplyResult>
}

/** 组件注入面：slot inject 返回的 business face。 */
export interface StarButtonInjected {
  readonly star: StarHostBridge
}

/** 行级 diff 类型。 */
export type DiffType = 'same' | 'add' | 'del'
export interface DiffLine {
  readonly type: DiffType
  readonly text: string
}

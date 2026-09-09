/**
 * H6 工具事件端口（docs/10 §1 H6；docs/11 §2 tools.ts 行；docs/13 §3.9）。
 *
 * 只建端口、不发剪切行为：`tools/execute` 仅信号/计量 around-wrapper（监听器恒
 * `return next()`，见决策点 1——execute 返回值会被 harness 按 `value` 重新渲染
 * content，content-only 修改会丢，所以 T-entry 内容整形必须挂 `tools/post-execute`，
 * 见 docs/13 §3.9）；`tools/post-execute` 监听器返回 `PostToolDecision` 即短路
 * （覆盖 = T-entry 写时整形，由 `replaceContent` 构造）；业务判据归 P15a/P15b，
 * 本单不内置任何剪切规则（T-note 追加能力随协商线退役，docs/legacy.md §9）。
 * P15b 增 `createShearToolPort`：把 harness 执行视图收敛成 `ToolResultView`（domains 零
 * harness 类型，D8 归口不变），只挂 post-execute，子分发/subagent 直接委托 next()。
 * N1 描述符扩面：`ToolResultView` 增 args/meta/kind/card/resultBytes——kind/card 取
 * `getTools().get(name, agent).presentCall(args)`（软校验、只读、异常即降级为空），meta 取
 * `result.meta`（已算好，不调 presentResult）；任何取签名失败都只降级、不打断工具执行。
 * **tools 服务必须由调用侧 `ctx.inject(['tools'], …)` 注入后经 `getTools` 回调提供**——
 * 直接读 `ctx.tools` 在真运行时抛 "cannot get property tools without inject"（端口整体空转）。
 *
 * 模块: platform 工具事件端口（唯一 harness 触点层）
 * 平面: L0（确定性规则：注册 + 计量 + 决策转发；无模型、无机制逻辑）
 * 回退链步数: 1（失败默认保留——hook 异常只 warn 并委托 next()，度量不得打断工具执行）
 * 审查清单: 不 import core；本文件零改史（改史唯一通道 = history 端口，docs/10 §1 H4/H5）；
 *           无 timer、无网络、无文件 IO；execute 监听器永不短路（决策点 1）。
 * 度量: executeSeen/postExecuteSeen/decisions/listenerErrors 计数；入账归 P15b/P21b。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// Type-only：拉入 dsh-tools 的 Context/Events merge（tools/execute、tools/post-execute）。
import type {} from '@deepseek-ai/dsh-tools'
import type {
  PostToolDecision,
  ToolDispatchExecution,
  ToolExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'

/** 端口 hooks：本单只转发；裁决逻辑（T-entry 判据）归 P15a/P15b。 */
export interface ToolPortHooks {
  /** tools/execute around-wrapper：仅信号/计量；返回值被忽略。 */
  onExecute?: (exec: ToolDispatchExecution) => void
  /** tools/post-execute：返回决策则短路；返回 void 则委托 next()。 */
  onPostExecute?: (exec: ToolExecution, result: Readonly<ToolExecutionResult>) => PostToolDecision | void
}

/** 端口计量（工具剪切账本原料，docs/12 §3；入账归 P15b）。 */
export interface ToolPortStats {
  executeSeen: number
  postExecuteSeen: number
  decisions: number
  listenerErrors: number
}

export interface ToolPort {
  /** 卸载两个监听器；幂等（重复调用 no-op）。 */
  dispose(): void
  /** 计量快照（调用时刻；内部计数器不受影响）。 */
  stats(): ToolPortStats
}

/** T-entry 写时整形：覆盖 content 的 accept 决策（输出新数组，不引用输入）。 */
export function replaceContent(content: ContentBlock[]): PostToolDecision {
  return { kind: 'accept', content: [...content] }
}

/**
 * 创建 H6 工具端口：注册 execute/post-execute 两个监听器并返回端口服。
 * execute 监听器恒 `return next()`（决策点 1）；post-execute 监听器按决策点 2
 * 短路/委托。两个监听器对 hook 异常都 catch + warn + 计数，绝不打断 harness 瀑布。
 */
export function createToolPort(
  ctx: Pick<Context, 'on'>,
  hooks?: ToolPortHooks,
  logger?: { warn: (...args: unknown[]) => void },
): ToolPort {
  const stats: ToolPortStats = { executeSeen: 0, postExecuteSeen: 0, decisions: 0, listenerErrors: 0 }
  let disposed = false

  const disposeExecute = ctx.on('tools/execute', (exec, next) => {
    stats.executeSeen++
    try {
      hooks?.onExecute?.(exec)
    } catch (e) {
      stats.listenerErrors++
      logger?.warn(
        'context-economy: tools/execute hook failed (contained)',
        e instanceof Error ? e.message : String(e),
      )
    }
    // 恒 return next()：execute 只做信号/计量，不得改变工具执行（决策点 1）。
    return next()
  })

  const disposePost = ctx.on('tools/post-execute', (exec, result, next) => {
    stats.postExecuteSeen++
    if (!hooks?.onPostExecute) return next()
    try {
      const decision = hooks.onPostExecute(exec, result)
      if (decision == null) return next()
      stats.decisions++
      // 返回决策 = 短路后续监听器（含 harness 默认 accept）。
      return Promise.resolve(decision)
    } catch (e) {
      stats.listenerErrors++
      logger?.warn(
        'context-economy: tools/post-execute hook failed (contained)',
        e instanceof Error ? e.message : String(e),
      )
      // 失败默认保留：异常只 warn 并委托 next()（回退链步数 1）。
      return next()
    }
  })

  return {
    dispose() {
      if (disposed) return
      disposed = true
      disposeExecute()
      disposePost()
    },
    stats() {
      return { ...stats }
    },
  }
}

/** 工具签名来源（N1）：只取 presentCall 的 kind/card，结构性最小面，避免绑死 harness 类型。 */
export interface ToolSignatureSource {
  get(
    name: string,
    scope?: unknown,
  ): { presentCall?(args: unknown): { card?: unknown; kind?: unknown } | undefined } | undefined
}

/**
 * 剪切工具端口 ctx（N1）：只取事件注册面。工具签名通道经 `getTools` 回调注入
 * （cordis 服务必须 `ctx.inject(['tools'], …)` 取得；缺省 = 无签名通道，分类器退化 `none`）。
 */
export type ShearToolPortContext = Pick<Context, 'on'>

/** 工具结果视图（P15b；N1 扩面；本地结构面，domains 不接触 harness 类型）。 */
export interface ToolResultView {
  readonly callId: string
  readonly name: string
  /** result.content 的 text 块拼接（非 text 块不计）。 */
  readonly resultText: string
  readonly isError: boolean
  /** 含非 text 块（图片等）——此时不做 T-entry 整形（保原块）。 */
  readonly hasNonText: boolean
  /** 会话来源（subagent 会话不裁）。 */
  readonly origin?: string
  /** resultText 的 UTF-8 字节数（N1 候选下限判据）。 */
  readonly resultBytes: number
  /** 解析后调用参数（`ToolExecution.arguments`；N1 副作用扫描源）。 */
  readonly args?: unknown
  /** `ToolExecutionResult.meta`（presentationMeta 投影；N2/N3 结论与重取句柄原料）。 */
  readonly meta?: unknown
  /** presentCall 声明的类别（read/edit/delete/move/search/execute/fetch/other）。 */
  readonly kind?: string
  /** presentCall 声明的卡片（generic/terminal/diff）。 */
  readonly card?: string
}

/** 剪切判定钩子（纯函数语义；返回 undefined = 不动刀，委托 next()）。 */
export interface ShearToolHooks {
  /** T-entry 写时整形：返回覆盖后的完整文本；undefined = 不整形。 */
  shapeEntry(view: ToolResultView): string | undefined
}

function textOfContent(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) if (block.type === 'text') text += block.text
  return text
}

/** 取工具签名（N1）：presentCall 软校验、只读、异常/缺失一律降级为空对象（不打断执行）。 */
function signatureOf(
  tools: ToolSignatureSource | undefined,
  exec: ToolExecution,
): { kind?: string; card?: string } {
  try {
    const view = tools?.get(exec.name, exec.agent)?.presentCall?.(exec.arguments)
    if (view === undefined) return {}
    const card = typeof view.card === 'string' ? view.card : undefined
    const kind = typeof view.kind === 'string' ? view.kind : undefined
    return { ...(card === undefined ? {} : { card }), ...(kind === undefined ? {} : { kind }) }
  } catch {
    return {}
  }
}

function toToolResultView(
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  tools?: ToolSignatureSource,
): ToolResultView {
  const content = result.content
  let hasNonText = false
  for (const block of content) if (block.type !== 'text') hasNonText = true
  const agent = exec.agent as { session?: { header?: { origin?: unknown } } } | undefined
  const origin = agent?.session?.header?.origin
  const resultText = textOfContent(content)
  return {
    callId: String(exec.callId),
    name: exec.name,
    resultText,
    isError: result.isError,
    hasNonText,
    resultBytes: Buffer.byteLength(resultText, 'utf8'),
    ...(typeof origin === 'string' ? { origin } : {}),
    ...(exec.arguments === undefined ? {} : { args: exec.arguments }),
    ...(result.meta === undefined ? {} : { meta: result.meta }),
    ...signatureOf(tools, exec),
  }
}

/**
 * P15b 剪切工具端口：只挂 `tools/post-execute`（T-entry 覆盖）。
 * 子分发（`parent !== undefined`，run_code 内）与 subagent 会话直接委托 next()；
 * 含非 text 块时不整形；异常由 createToolPort 遏制为 warn + next()（失败默认保留）。
 */
export function createShearToolPort(
  ctx: ShearToolPortContext,
  hooks: ShearToolHooks,
  logger?: { warn: (...args: unknown[]) => void },
  getTools?: () => ToolSignatureSource | undefined,
): ToolPort {
  return createToolPort(ctx, {
    onPostExecute: (exec, result) => {
      if (exec.parent !== undefined) return undefined
      const view = toToolResultView(exec, result, getTools?.())
      if (view.origin === 'subagent') return undefined
      if (!view.hasNonText) {
        const shaped = hooks.shapeEntry(view)
        if (shaped !== undefined) return replaceContent([{ type: 'text', text: shaped }])
      }
      return undefined
    },
  }, logger)
}

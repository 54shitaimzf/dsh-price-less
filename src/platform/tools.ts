/**
 * H6 工具事件端口（docs/10 §1 H6；docs/11 §2 tools.ts 行；docs/13 §3.9）。
 *
 * 只建端口、不发剪切行为：`tools/execute` 仅信号/计量 around-wrapper（监听器恒
 * `return next()`，见决策点 1——execute 返回值会被 harness 按 `value` 重新渲染
 * content，content-only 修改会丢，所以 T-entry 内容整形必须挂 `tools/post-execute`，
 * 见 docs/13 §3.9）；`tools/post-execute` 监听器返回 `PostToolDecision` 即短路
 * （覆盖 = T-entry 写时整形、追加 = T-note 贴注，由 replaceContent/appendContent
 * 构造）；T-entry/T-note 的业务判据归 P15a/P15b，本单不内置任何剪切规则。
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

/** 端口 hooks：本单只转发；裁决逻辑（T-entry/T-note 判据）归 P15a/P15b。 */
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

/** T-note 贴注：在既有 content 后追加的 accept 决策（输出新组合数组，不动原块）。 */
export function appendContent(result: Readonly<ToolExecutionResult>, extra: ContentBlock[]): PostToolDecision {
  return { kind: 'accept', content: [...result.content, ...extra] }
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

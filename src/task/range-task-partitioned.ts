/**
 * task 压缩范围选择（task 分划版，纯函数）：把"近因保留尾 + 冷区闭合任务整压"的
 * 统一保留策略落成 L0 规则。
 *
 * 语义（对比主轴：近因保留 × 边界压缩）：
 *  - 近因尾（recencyTailCutoff）：从表面尾部反向累加 token，累计 >= retainTokens 处定为
 *    近因尾起点。近因尾内的内容**逐字保留**（与原生 selectCompactableRange 同语义、与任务
 *    边界无关）——这是"刚闭合、还很热"的任务不被立即压缩的保证。
 *  - 冷区闭合任务（selectColdClosedTask）：在近因尾之外（冷区）的、已闭合且未压缩的 task 中，
 *    挑选**最老**的一个作为本轮压缩候选——它已冷却、整段可安全压成结构化 digest。
 *  - 引用门（stillReferenced）：保守升级——闭合任务的产物若仍被活动窗口引用，则不压
 *    （深度冻结/引用门，A4 档）。默认关闭（仅近因门），引用门由调用方注入判据。
 *
 * 模块: task 压缩范围（task 分划版）
 * 平面: L0（确定性规则：表面位置运算 + token 累加 + 冷区判定）
 * 回退链步数: 2（代码分支）
 * 审查清单: 输入为投影状态与 surface 结构；无副作用；无 LLM 调用；失败安全（返回 null
 *           表示本轮无候选，绝不抛错）；不读 event.time（时间戳非判据，冷区由位置/token 判定）。
 * 度量: compaction/* 事件（docs/07）；近因区内闭合任务保留由回放断言观测。
 */

import type { ContextEconomyTaskState, TaskRecord } from './types.ts'

/** 表面节点 token 权重（seq + 路由计价的 token），供近因尾累加。 */
export interface SurfaceNodeCost {
  seq: number
  tokens: number
}

/** 近因尾保留门（A3）：`stillReferenced` 为空时不启用引用门，默认 false（不被引用即可压）。 */
export interface ColdSelectionOptions {
  /** 保守引用门（A4）：返回 true 表示该闭合任务产物仍被活动窗口引用 → 不压。 */
  stillReferenced?: (taskId: string) => boolean
}

/**
 * 近因尾起点：从 `nodes` 尾部反向累加 token，累计 >= `retainTokens` 的首个下标。
 * 下标 >= 返回值的内容为**近因尾（逐字保留）**；下标 < 返回值为**冷区（可压）**。
 *
 * 与原生 `selectCompactableRange` 语义一致（retainTokens <= 0 时仍保留最末一个表面节点，
 * 永不压空尾），保证在"近因保留"上与原生可比。
 *
 * @returns 近因尾起点下标；null 表示整段皆为近因尾（无可压冷区）。
 */
export function recencyTailCutoff(
  nodes: readonly SurfaceNodeCost[],
  retainTokens: number,
): number | null {
  if (nodes.length === 0) return null
  let accumulated = 0
  let keepFromIdx = nodes.length
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    accumulated += nodes[index]!.tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx === 0) return null
  return keepFromIdx
}

/**
 * 从"已闭合 + 未压缩"的 task 中挑选本轮可压的**冷区闭合任务**（最老优先）：
 * - 仅任务整个 span 位于冷区（`lastSurfaceSeq` 在表面下标 < tailCutoffIdx）才候选——近因尾内的
 *   闭合任务**逐字保留**（不选，保热）；
 * - 引用门 `stillReferenced(taskId)` 为 true 的任务**不选**（A4 保守升级，默认关闭）；
 * - 返回 null 表示本轮无冷区闭合任务（不压，fail-lazy）。
 *
 * @param state - 投影状态（task 表）。
 * @param surfaceNodes - 当前表面 seq 列表（`session.surface.nodes`，有序）。
 * @param tailCutoffIdx - 近因尾起点在 surfaceNodes 中的下标（`recencyTailCutoff` 结果）。
 * @param options - 引用门等保守选项。
 * @returns 最老的、冷区内的、未被引用的闭合任务；无则 null。
 */
export function selectColdClosedTask(
  state: ContextEconomyTaskState,
  surfaceNodes: readonly number[],
  tailCutoffIdx: number,
  options: ColdSelectionOptions = {},
): TaskRecord | null {
  const coldTasks = state.tasks
    .filter(task => (
      task.status === 'closed' && !state.compactedTaskIds.includes(task.taskId)
    ))
    .filter(task => {
      // 任务整个 span 必须仍在表面上（lastSurfaceSeq 有效），且位于冷区（下标 < tailCutoffIdx）。
      const lastIdx = surfaceNodes.indexOf(task.lastSurfaceSeq)
      if (lastIdx === -1) return false
      if (lastIdx >= tailCutoffIdx) return false // 在近因尾内 → 逐字保留（保热）
      if (options.stillReferenced?.(task.taskId) === true) return false // 被引用 → 不压（A4）
      return true
    })
    // 最老优先：按 lastSurfaceSeq（升序 = 时序）挑选最老的任务。
    .sort((a, b) => a.startSeq - b.startSeq)
  return coldTasks[0] ?? null
}

/** 便捷：给定统计，返回"近因尾内闭合任务是否全部保留"的判定（回放断言用）。 */
export function isClosedTaskInRecencyTail(
  state: ContextEconomyTaskState,
  surfaceNodes: readonly number[],
  tailCutoffIdx: number,
  task: TaskRecord,
): boolean {
  const lastIdx = surfaceNodes.indexOf(task.lastSurfaceSeq)
  return lastIdx !== -1 && lastIdx >= tailCutoffIdx
}

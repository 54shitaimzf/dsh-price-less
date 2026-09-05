/**
 * task 压缩范围选择（纯函数）：把已关闭 task 的 surface 范围收缩为
 * `compactRegion` 可接受的合法区间（平衡边界，不切半开的工具调用对）。
 *
 * 模块: task 压缩范围
 * 平面: L0（确定性规则：surface 位置运算 + 平衡校验）
 * 回退链步数: 2（代码分支）
 * 审查清单: 输入为投影状态与 surface 结构；无副作用；无 LLM 调用；
 *           失败安全：返回 null（跳过该 task，不重复压），绝不抛错。
 * 度量: compaction 相关度量经 docs/07（compaction/* 事件）观测。
 */

import { createRequire } from 'node:module'
// SessionSeq 构造器（运行时值导入）：0.1.3 起 harness 压缩 API 以品牌类型接收 seq，
// 非负安全整数校验随构造进行；插件内部表示保持 number（与 zod 持久化 schema 同形），
// 仅在产出 harness-ready 范围/调用原生 checker 时品牌化。
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import type { TaskRecord } from './types.ts'

/** 一个可供压缩的闭合 surface 区间（start/end 为当前 surface 上的 seq；
 * 已品牌化为 harness SessionSeq——直接可传 compactRegion / 平衡校验器）。 */
export interface CompressibleRange {
  start: SessionSeq
  end: SessionSeq
}

/** 提供的平衡校验器抽象（便于无 harness 单测注入 mock）。 */
export interface BalanceChecker {
  balancedBefore(session: Session, seq: number): boolean
  balancedAfter(session: Session, seq: number): boolean
}

/** 原生平衡校验器（延迟加载 dsh-compaction；注入点 = 运行时默认实现）。 */
export function createNativeBalanceChecker(): BalanceChecker {
  // 延迟加载：测试（无 harness）路径不加载 dsh-compaction，仅依赖注入的 mock。
  const require = createRequire(import.meta.url)
  let mod: typeof import('@deepseek-ai/dsh-compaction') | undefined
  const load = (): typeof import('@deepseek-ai/dsh-compaction') => {
    mod ??= require('@deepseek-ai/dsh-compaction') as typeof import('@deepseek-ai/dsh-compaction')
    return mod
  }
  return {
    balancedBefore: (session, seq) => load().toolPairingBalancedBefore(session, SessionSeq(seq)),
    balancedAfter: (session, seq) => load().toolPairingBalancedAfter(session, SessionSeq(seq)),
  }
}

/** 默认平衡校验器（延迟构造）。 */
export const nativeBalanceChecker: BalanceChecker = createNativeBalanceChecker()

/**
 * 为一个已关闭 task 选择可压缩区间：
 * - start = task.startSeq（必须 balanced before；否则向右移到最近平衡点）；
 * - end = task.lastSurfaceSeq（必须 balanced after；否则向左移到最近平衡点）；
 * - 任一 seq 已不在当前表面 / 区间空 / 收缩后 start > end → null（跳过，不重复压）。
 *
 * @param task - 已关闭的 task 记录。
 * @param surfaceNodes - 当前表面 seq 列表（`session.surface.nodes`）。
 * @param session - 真实 Session（供默认 checker）；为 null 时使用注入的 mock checker 且跳过平衡检查（测试路径）。
 * @param checker - 平衡校验器（缺省原生导出；测试注入 mock）。
 */
export function selectCompressibleRange(
  task: TaskRecord,
  surfaceNodes: readonly number[],
  options: { session?: Session; checker?: BalanceChecker } = {},
): CompressibleRange | null {
  if (task.status !== 'closed') return null
  if (surfaceNodes.length === 0) return null

  const { session, checker = nativeBalanceChecker } = options
  const inSurface = (seq: number): boolean => surfaceNodes.includes(seq)
  if (!inSurface(task.startSeq) || !inSurface(task.lastSurfaceSeq)) return null

  // start：向右收缩至 balanced before。
  let start = task.startSeq
  while (start <= task.lastSurfaceSeq) {
    if (session === undefined || checker.balancedBefore(session, start)) break
    const idx = surfaceNodes.indexOf(start)
    if (idx === -1 || idx + 1 >= surfaceNodes.length) return null
    start = surfaceNodes[idx + 1]!
  }

  // end：向左收缩至 balanced after。
  let end = task.lastSurfaceSeq
  while (end >= start) {
    if (session === undefined || checker.balancedAfter(session, end)) break
    const idx = surfaceNodes.indexOf(end)
    if (idx === -1 || idx === 0) return null
    end = surfaceNodes[idx - 1]!
  }

  if (start > end) return null
  return { start: SessionSeq(start), end: SessionSeq(end) }
}

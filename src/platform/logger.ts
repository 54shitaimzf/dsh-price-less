/**
 * 诊断与自定义事实事件端口（docs/11 §2 logger.ts 行 + §4 纪律①③）。
 *
 * 职责：① `ceLogger` = ctx.logger('context-economy')——诊断走 named logger，运营事实
 * 不进 stdout（纪律③）；② `emitCeFact` = `context-economy/*` 自定义会话事实事件发射端口：
 * `session.append(type, data, { ignorable: true })`。ignorable 标记 = 未知类型安全阀——
 * `context-economy/*` 全族在 harness `KNOWN_SESSION_EVENT_TYPES` 之外，必须带标记落盘，
 * 否则旧版 harness 拒读整条日志；带标记则读取方跳过不认识的行、其余照常重建。
 * （写入通道 = harness Session.append LogIntent，本地补丁 commit 04cba8f394。）
 *
 * 模块: platform 日志/事实端口（唯一 harness 触点层）
 * 平面: L0（命名诊断 + 事实发射端口；无模型、无机制逻辑）
 * 回退链步数: 1（失败默认保留——append 异常被遏制（warn + 计数），绝不外溢、绝不静默）
 * 审查清单: 自定义事件全族 log-only（09 §1，只记账、可回放、零副作用）；发射必带
 *           ignorable:true（11 §4 纪律①，harness append 运行期强制）；词汇表 = 泛型约束
 *           `T extends CeFactType`（CeFactType 从 SessionEventMap 声明合并派生，当前为
 *           never——未合并事件类型的机制工单无法发射，杜绝发明正典外事件名）；
 *           surface 事件永不携带 ignorable（harness append 运行期拒绝）。
 * 度量: emitErrors 计数可观测；context-economy/* 各机制字段随各域工单落 07。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'
import type { CeLogger } from './events.ts'

/** 诊断通道（纪律③）：ctx.logger('context-economy')。 */
export function ceLogger(ctx: Context): CeLogger {
  return ctx.logger('context-economy')
}

/** 允许发射的事实事件类型 = 声明合并后的 `context-economy/*` 全族（词汇表自动派生）。 */
export type CeFactType = Extract<keyof SessionEventMap & string, `context-economy/${string}`>

const factStats = { emitErrors: 0 }

/**
 * 发射一条 `context-economy/*` log-only 事实事件（ignorable:true 随行）。
 *
 * 泛型约束 `T extends CeFactType`：词汇表由各机制工单经 `SessionEventMap` 声明合并扩展
 * （本文件零改动）；未合并时 CeFactType = never，生产代码无字面事件名可传（决策点③）。
 * append 失败（会话未挂/非 JSON 数据/配对校验拒绝…）按 fail-lazy 遏制：warn + emitErrors
 * 计数，异常不外溢——失败方向永远朝用户数据安全侧（宪法条文八）。
 */
export function emitCeFact<T extends CeFactType>(session: Session, type: T, data: SessionEventMap[T], logger?: CeLogger): void {
  try {
    // CeFactType（`context-economy/*` 前缀）按构造排除 surface 类型——append 的条件 opts
    // 在泛型 T 下不可消解，此处经类型化适配器单点收窄为 log-only 形态；
    // harness append 运行期仍强制拒绝 surface+ignorable。
    const appendLogOnly = session.append.bind(session) as unknown as
      <U extends SessionEventType>(type: U, data: SessionEventMap[U], opts?: { ignorable?: true }) => SessionEvent<U>
    appendLogOnly(type, data, { ignorable: true })
  } catch (e) {
    factStats.emitErrors++
    logger?.warn(
      'context-economy: emitCeFact append failed (contained, fail-lazy)',
      type,
      e instanceof Error ? e.message : String(e),
    )
  }
}

/** 发射失败计数（可观测性：每次 append 异常必计数，绝不静默——纪律③）。 */
export function ceFactStats(): { emitErrors: number } {
  return { ...factStats }
}

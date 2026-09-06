/**
 * 诊断与自定义事实事件端口（docs/11 §2 logger.ts 行 + §4 纪律①③）。
 *
 * 职责：① `ceLogger` = ctx.logger('context-economy')——诊断走 named logger，运营事实
 * 不进 stdout（纪律③）；② `emitCeFact` = `context-economy/*` 自定义会话事实事件发射端口，
 * 允许类型从 `SessionEventMap` 声明合并自动派生——各机制工单（P9 judge-*、P13 optimize-run、
 * P19/P20 压缩域…）在 src 内声明合并即扩词汇表，本端口零改动。
 *
 * 模块: platform 日志/事实端口（唯一 harness 触点层）
 * 平面: L0（命名诊断 + 事实发射端口；无模型、无机制逻辑）
 * 回退链步数: 1（失败默认保留——发射被阻塞即 warn 侧通，绝不静默、绝不抛出外溢）
 * 审查清单: 自定义事件全族 log-only（09 §1，只记账、可回放、零副作用）；事件类型必须
 *           ignorable:true（11 §4 纪律①）——harness Session.append 现无 ignorable 写入通道
 *           （packages/core/session/src/index.ts:699 信封仅六字段），未知类型无标记落盘会被
 *           validateStoredEvents 整条拒读（session-persistence/src/storage-contract.ts:75），
 *           故运行期 fail-closed：warn + 计数、不写日志；harness LogIntent 补丁落地后翻转。
 * 度量: blockedNoIgnorableChannel 计数可观测；context-economy/* 各机制字段随各域工单落 07。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { CeLogger } from './events.ts'

/** 诊断通道（纪律③）：ctx.logger('context-economy')。 */
export function ceLogger(ctx: Context): CeLogger {
  return ctx.logger('context-economy')
}

/** 允许发射的事实事件类型 = 声明合并后的 `context-economy/*` 全族（词汇表自动派生）。 */
export type CeFactType = Extract<keyof SessionEventMap & string, `context-economy/${string}`>

const factStats = { blockedNoIgnorableChannel: 0 }

/**
 * 发射一条 `context-economy/*` log-only 事实事件。
 *
 * **fail-closed（P1 工单 §2.4 决策点⑤）**：ignorable 标记是会话日志重载的安全阀——未知
 * 类型必须带 ignorable:true 落盘，否则旧版 harness 拒读整条日志。当前 harness
 * `Session.append` 无写入该标记的参数，本端口拒绝发射（绝不写无标记的未知类型行）、
 * warn + 计数，永不抛出（异常不外溢）；LogIntent 补丁落地后翻转为
 * `session.append(type, data, { ignorable: true })`。
 */
export function emitCeFact(session: Session, type: CeFactType, data: JsonValue, logger?: CeLogger): void {
  void session
  void data
  factStats.blockedNoIgnorableChannel++
  logger?.warn(
    'context-economy: emitCeFact blocked (fail-closed) — ignorable write channel unavailable,'
    + ` refusing to append unmarked unknown-type event ${type} (would brick session reload)`,
  )
}

/** fail-closed 阻塞计数（可观测性：每次 blocked 必计数，绝不静默——纪律③）。 */
export function ceFactStats(): { blockedNoIgnorableChannel: number } {
  return { ...factStats }
}

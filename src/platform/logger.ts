/**
 * 诊断与自定义事实事件端口（docs/11 §2 logger.ts 行 + §4 纪律①③）。
 *
 * 职责：① `ceLogger` = ctx.logger('context-economy')——诊断走 named logger，运营事实
 * 不进 stdout（纪律③）；② `emitCeFact` = `context-economy/*` 自定义会话事实事件发射端口。
 * 词汇表从 `SessionEventMap` 声明合并自动派生，且须并入 harness `IgnorableSessionEventMap`
 * （append 侧编译闸，docs/12 §1）——各机制工单在 src 内声明合并即扩词汇表，本端口零改动。
 *
 * **模式零感知**：发射路由（通道直发 / KV 镜像降级 / blocked）整体居于
 * `platform/ignorable-channel.ts`（docs/12 §2 耦合铁律）——本文件只做类型收口与委托，
 * 上游合并后仅本文件 emitCeFact 一行改直连（docs/12 §2 删除清单②）。
 *
 * 模块: platform 日志/事实端口（唯一 harness 触点层）
 * 平面: L0（命名诊断 + 事实发射端口；无模型、无机制逻辑）
 * 回退链步数: 1（失败默认保留——发射失败 warn + 计数，绝不外溢、绝不静默）
 * 审查清单: 自定义事件全族 log-only（09 §1）；词汇表 = 泛型 `T extends CeFactType`
 *           （CeFactType 当前 = never——未合并事件类型的机制工单无法发射，杜绝发明正典外事件名）；
 *           事件类型必须 ignorable:true（11 §4 纪律①，通道单元统一保证）。
 * 度量: factModeStats 经 ceFactStats 转出；context-economy/* 各机制字段随各域工单落 07。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { CeLogger } from './events.ts'
import { emitFact, factModeStats, setFactMirror, type FactMirror } from './ignorable-channel.ts'

/** 诊断通道（纪律③）：ctx.logger('context-economy')。 */
export function ceLogger(ctx: Context): CeLogger {
  return ctx.logger('context-economy')
}

/** 允许发射的事实事件类型 = 声明合并后的 `context-economy/*` 全族（词汇表自动派生）。 */
export type CeFactType = Extract<keyof SessionEventMap & string, `context-economy/${string}`>

/**
 * 发射一条 `context-economy/*` log-only 事实事件（路由见 ignorable-channel.emitFact）。
 * 泛型 `T extends CeFactType`：词汇表由各机制工单经声明合并扩展，本文件零改动；
 * 未合并时 CeFactType = never，生产代码无字面事件名可传（P1 工单决策点③）。
 */
export function emitCeFact<T extends CeFactType>(session: Session, type: T, data: SessionEventMap[T], logger?: CeLogger): void {
  emitFact(session, type, data, logger)
}

/** 事实写入模式计数（emitted/mirrored/blocked；docs/12 §2 降级可见化）。 */
export function ceFactStats(): { emitted: number; mirrored: number; blocked: number } {
  return factModeStats()
}

/** 注册/注销 KV 事实镜像（D3 单点：index.ts 只经此函数，不出现 ignorable-channel 概念）。 */
export function registerFactMirror(mirror: FactMirror | undefined): void {
  setFactMirror(mirror)
}

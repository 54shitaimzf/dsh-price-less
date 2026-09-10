/**
 * 会话事实通道（docs/12 §2 契约的唯一实现单元）——能力探测、发射路由、镜像降级。
 *
 * **耦合铁律（docs/12 §2）**：探测/降级/镜像概念全部居于本文件；机制代码（core/domains）
 * 只经 platform/logger.ts 的 emitCeFact 端口发射、对模式零感知。D3 结构断言锁定本边界——
 * 上游合并 ignorable 通道后，删除 = 本文件 + logger.ts 一行 + D3 条目（docs/12 §2 清单）。
 *
 * 模块: platform 事实通道（唯一 harness 触点层）
 * 平面: L0（探测 + 路由；无模型、无机制逻辑）
 * 回退链步数: 1（失败默认保留——一切失败 warn + 计数，绝不外溢、绝不静默）
 * 审查清单: 探测只读零副作用（进程级记忆一次，不经配置无设置面）；append 失败不回退镜像
 *           （镜像只承接"通道缺失"，不承接"写入出错"——两种失败不同因，混同会双重记账）；
 *           镜像接口由 P3 事实镜像表接线（接线前降级 = blocked）。
 * 度量: factModeStats 计数可观测（emitted/mirrored/blocked）；事实内容随各域工单落 07。
 */

import type { Session, SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'
import * as dshSessionRuntime from '@deepseek-ai/dsh-session'
import type { CeLogger } from './events.ts'

/**
 * 能力探测源（docs/12 §2）：补丁版 harness 导出显式运行时能力常量
 * `SESSION_LOG_INTENT = 1`（harness commit ea04b581a5）；vanilla 构建无此导出
 * （读得 undefined）。探测不解析实现源码文本，minify/混淆/改名安全。
 * 测试可经可选参数注入假能力源；生产代码只走无参调用。
 */
export interface SessionRuntimeCapabilities {
  SESSION_LOG_INTENT?: unknown
}

let channelProbe: boolean | undefined

/**
 * ignorable 通道可用性（结构化能力探测，进程级记忆一次，只读零副作用）。
 * @param api - 测试注入用能力源；缺省读 @deepseek-ai/dsh-session 运行期导出。
 */
export function ignorableChannelAvailable(api?: SessionRuntimeCapabilities): boolean {
  if (channelProbe === undefined) {
    const source = api ?? dshSessionRuntime as unknown as SessionRuntimeCapabilities
    channelProbe = source.SESSION_LOG_INTENT === 1
  }
  return channelProbe
}

/** 测试专用：重置探测记忆（生产代码禁用）。 */
export function resetIgnorableChannelProbe(): void {
  channelProbe = undefined
}

export type FactWriteResult = 'emitted' | 'mirrored' | 'blocked'

/** KV 事实镜像接口（降级态的事实去处；P3 storage 事实镜像表落位时经 setFactMirror 接线）。 */
export type FactMirror = (type: string, data: unknown, meta?: { sessionId?: string }) => void

let factMirror: FactMirror | undefined

/** 注册/注销 KV 事实镜像（P3 接线点；docs/12 §3——同 fold 同账的事实源之一）。 */
export function setFactMirror(mirror: FactMirror | undefined): void {
  factMirror = mirror
}

const factStats = { emitted: 0, mirrored: 0, blocked: 0 }

/** 事实写入模式计数（可观测性：降级绝不静默——docs/11 §4 纪律③）。 */
export function factModeStats(): { emitted: number; mirrored: number; blocked: number } {
  return { ...factStats }
}

/**
 * 发射一条 log-only 事实事件（机制代码的唯一事实写入路径；emitCeFact 委托本函数）。
 *
 * 路由：通道可用 → `session.append(type, data, { ignorable: true })`；通道缺失 →
 * KV 镜像（未接线则 blocked）；append 失败（会话未挂/非 JSON/配对校验拒绝）→ blocked——
 * **不回退镜像**：镜像只承接"能力缺失"，不承接"写入出错"，混同会双重记账。
 * 一切失败 warn + 计数，异常不外溢（fail-lazy，宪法条文八）。
 */
export function emitFact<T extends keyof SessionEventMap & string>(
  session: Session,
  type: T,
  data: SessionEventMap[T],
  logger?: CeLogger,
): FactWriteResult {
  if (ignorableChannelAvailable()) {
    try {
      // CeFactType 前缀按构造排除 surface 类型；append 的条件 opts 在泛型下不可消解，
      // 经类型化适配器单点收窄（harness 运行期仍强制拒绝 surface+ignorable）。
      const appendLogOnly = session.append.bind(session) as unknown as
        <U extends SessionEventType>(t: U, d: SessionEventMap[U], o?: { ignorable?: true }) => SessionEvent<U>
      appendLogOnly(type, data, { ignorable: true })
      factStats.emitted++
      return 'emitted'
    } catch (e) {
      factStats.blocked++
      logger?.warn(
        'context-economy: fact append failed (contained, fail-lazy)',
        type,
        e instanceof Error ? e.message : String(e),
      )
      return 'blocked'
    }
  }
  if (factMirror !== undefined) {
    try {
      // U7：镜像带会话维度（恢复侧按会话过滤比对，跨会话不串账）。
      const header = (session as unknown as { header?: { id?: unknown } }).header
      const sessionId = typeof header?.id === 'string' ? header.id : undefined
      factMirror(type, data, { ...(sessionId === undefined ? {} : { sessionId }) })
      factStats.mirrored++
      return 'mirrored'
    } catch (e) {
      factStats.blocked++
      logger?.warn(
        'context-economy: fact mirror write failed (contained, fail-lazy)',
        type,
        e instanceof Error ? e.message : String(e),
      )
      return 'blocked'
    }
  }
  factStats.blocked++
  logger?.warn(
    'context-economy: session-facts degraded (blocked) — ignorable channel unavailable'
    + ' and no fact mirror registered; fact dropped (fail-lazy, docs/12 §2)',
    type,
  )
  return 'blocked'
}

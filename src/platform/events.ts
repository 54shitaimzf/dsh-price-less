/**
 * H1/H7 事件面接线（docs/10 §1；docs/11 §2 events.ts 行 + §4 纪律②③）。订阅 `session/event`
 * firehose（同步 post-commit 派发），按输入面五条件（02 §2）产出 `input/user-message`、按 H7
 * 字面透传 `metrics/session-event`，全部经异步旁路队列派发——监听器 O(1)，重活由消费者
 * （P2 core/ledger 起）在队列上消化，永不阻塞 append。
 * 模块: platform 事件端口（唯一 harness 触点层）
 * 平面: L0（订阅 + 过滤 + 队列；无模型、无机制逻辑）
 * 回退链步数: 1（确定性规则——过滤纯函数 + FIFO 队列）
 * 审查清单: 监听器异常只 warn 不外溢（纪律②）；无 timer（微任务排空，S5）；领域事件 map
 *           本地声明——P2 以本地重声明消费（core 零 harness import）；dispose 后在途到达计 dropped。
 * 度量: 本模块即 H7 度量原料出口（docs/07 §5 回放管道订阅面）；自身无 07 字段。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionEventType, SessionLogOffset, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
import type { AssertAssignable } from './anchors.ts'

/** 结构化诊断通道（cordis logger 的最小结构面；由 index.ts 传 ceLogger(ctx)）。 */
export interface CeLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/** 进程内领域事件（本模块私有口；不进 cordis Events，core 侧本地重声明同构类型）。 */
export interface CeDomainEvents {
  /** H1：判别器输入面通过的用户消息（02 §2 五条件；u≥1 段状态机事实归 P8）。 */
  'input/user-message': { session: Session; seq: SessionSeq; time: number; text: string }
  /** H7：度量回放原料（frozen 原事件引用；07 全字段从此 fold 重算）。 */
  'metrics/session-event': { session: Session; event: SessionEvent }
  /** P12：context-economy/* ignorable 事实回灌（供自动断面按会话分桶 fold）。 */
  'facts/session-event': { session: Session; event: SessionEvent }
}

export type CeDomainEventKind = keyof CeDomainEvents

/** H7 字面六类（docs/10 §1 H7 行；账本回放的订阅白名单）。 */
export const METRICS_FACE_TYPES: ReadonlySet<SessionEventType> = new Set<SessionEventType>([
  'step/start',
  'step/end',
  'assistant/message',
  'request/header',
  'tool/call',
  'tool/result',
])

/**
 * 会话当前模型（最近一次 `request/header` 的 config.provider/model；判别/断面辅助调用的默认跟随）。
 * 倒序扫描到首个 header 即返回；无请求记录 → undefined（调用侧回落静态默认）。
 */
export function readSessionModel(session: Session): { provider: string; model: string } | undefined {
  const events = readSessionEvents(session)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type !== 'request/header') continue
    const config = (event.data as unknown as { header?: { config?: { provider?: unknown; model?: unknown } } }).header?.config
    if (typeof config?.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
    return undefined
  }
  return undefined
}

// —— HC4 编译期锚（原语见 platform/anchors.ts）——
// 同步读面的**签名**在 A/B 两基线一致（`2026-09-09-deprecate-synchronous-session-event-reads.md`
// 只标 `@deprecated`、未改形状），故本锚两侧都成立；它守的是"形状漂移率"——上游真改签名
// （如切分页异步读）时此处先红，而不是等到 13 处调用点齐炸。
export type SessionSnapshotEventsAnchor = AssertAssignable<
  Session['snapshotEvents'],
  (fromSeq?: SessionLogOffset, toSeqExclusive?: SessionLogOffset) => readonly SessionEvent[]
>
export type SessionSnapshotEventsAnchorBack = AssertAssignable<
  (fromSeq?: SessionLogOffset, toSeqExclusive?: SessionLogOffset) => readonly SessionEvent[],
  Session['snapshotEvents']
>
export type SessionEventAtAnchor = AssertAssignable<Session['eventAt'], (seq: SessionSeq) => SessionEvent | undefined>
export type SessionEventAtAnchorBack = AssertAssignable<(seq: SessionSeq) => SessionEvent | undefined, Session['eventAt']>

/**
 * 会话全史同步读的**唯一收口**（HC4；登记见 `docs/legacy.md §14`）。
 *
 * 契约：读该会话已提交的全部事件（含 fork 继承前缀），只读零副作用；会话未提供
 * `snapshotEvents`（测试替身 / 未来上游移除）→ 空数组（失败默认保留，调用侧自会判空）。
 *
 * **为什么收口**：上游已把 `snapshotEvents`/`eventAt`/`ownEvents` 标 `@deprecated` 且
 * "new calls are prohibited"（B 基线）。本战役不重构，但 `domains/*` 不允许再直读——
 * 未来迁移（projections + 分页异步读）的改动面收敛在本文件一层，符合分层铁律。
 */
export function readSessionEvents(session: Session): readonly SessionEvent[] {
  const face = session as { snapshotEvents?: () => readonly SessionEvent[] }
  return typeof face.snapshotEvents === 'function' ? face.snapshotEvents.call(session) : []
}

/**
 * user/message 文本（text blocks 拼接 trim）；空文本 → null（02 §2「文本非空」条件）。
 * A（2026-09-11）：`export` 供步准入端口复用——harness 传给 `pre-step` 的 `messages` 与会话事件的
 * `data` 同形，两处必须同一读取口径（否则"即将落会话的消息"与"已落会话的消息"会判出不同文本）。
 */
export function userMessageText(data: UserMessage): string | null {
  const text = data.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n').trim()
  return text.length > 0 ? text : null
}

/**
 * 输入面过滤（02 §2 五条件，纯函数、无状态）：user/message append + source.kind==='user'
 * （非伪 user 单条件承担）+ 主会话（origin!=='subagent'，无第三态）+ 文本非空；u≥1 归 P8。
 */
export function passesInputFace(origin: string | undefined, event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  if (event.surfaceOp !== 'append') return false
  if (event.data.source?.kind !== 'user') return false
  if (origin === 'subagent') return false
  return userMessageText(event.data) !== null
}

/** 一条 task 内用户消息（★ 上下文组装原料；P14c）。 */
export interface SessionUserMessage { readonly seq: number; readonly time: number; readonly text: string }

/**
 * 从会话事件读取「task 内用户消息」上下文（P14c §4）。
 * 过滤口径同输入面五条件（source.kind==='user' / append / 主会话 / 文本非空），按事件序升序；
 * 极短消息与 task 切分由调用侧处理。只读无副作用；会话未提供 snapshotEvents 时返回空数组（防御）。
 */
export function readSessionUserMessages(session: Session): SessionUserMessage[] {
  const events = readSessionEvents(session)
  const origin = (session as unknown as { header?: { origin?: string } }).header?.origin
  const out: SessionUserMessage[] = []
  for (const event of events) {
    if (!passesInputFace(origin, event)) continue
    const text = userMessageText(event.data as UserMessage)
    if (text === null) continue
    out.push({ seq: event.seq, time: event.time, text })
  }
  return out
}

export interface EventPumpStats {
  enqueued: number   // 入队总数（过滤后）
  dispatched: number // 已派发总数
  listenerErrors: number // 消费者 handler 异常次数（遏制，不影响后续派发）
  dropped: number    // dispose 后在途到达数（不派发，计数可见）
  depth: number      // 当前队列深度（stats() 调用时刻）
}

export interface EventPump {
  /** 订阅领域事件；返回退订函数。 */
  on<K extends CeDomainEventKind>(kind: K, fn: (payload: CeDomainEvents[K]) => void): () => void
  /**
   * 内部投递入口（HC3）：把一条领域事件直接入队——与 firehose 同一条队列、同一 FIFO 派发、
   * 同一计数（enqueued / dispose 后 dropped）。供降级态的「镜像事实回灌」使用，
   * 使 domains 侧对事实来源保持零感知（docs/12 §2 耦合铁律）。
   */
  publish<K extends CeDomainEventKind>(kind: K, payload: CeDomainEvents[K]): void
  /** 停止订阅 firehose、清空队列；之后在途到达的事件计 dropped。 */
  dispose(): void
  stats(): EventPumpStats
}

/**
 * 创建事件泵：firehose 监听器 O(1)（过滤 + enqueue + 微任务排空调度），同步段
 * try/catch 只 warn 不外溢；排空 FIFO 保序逐条派发，handler 异常 catch + warn + 计数。
 */
export function createEventPump(ctx: Context, logger?: CeLogger): EventPump {
  const handlers = new Map<CeDomainEventKind, Set<(payload: never) => void>>()
  const queue: Array<{ kind: CeDomainEventKind; payload: CeDomainEvents[CeDomainEventKind] }> = []
  const stats = { enqueued: 0, dispatched: 0, listenerErrors: 0, dropped: 0 }
  let scheduled = false; let disposed = false

  const drain = (): void => {
    scheduled = false
    // U13.5：只消费**入队时快照**的那一批——处理期间新入队的事件走下一轮 schedule。
    // 旧实现 `while (queue.length > 0)` 在同一轮里消化自馈入队（handler 又 publish/触发 append），
    // 使一轮 drain 可无限长（微任务饿死定时器/IO，极端情况下表现为事件循环卡死）。
    let depth = queue.length
    while (depth-- > 0) {
      const item = queue.shift()
      if (item === undefined) break
      for (const fn of handlers.get(item.kind) ?? []) {
        try {
          ;(fn as (p: unknown) => void)(item.payload)
        } catch (e) {
          stats.listenerErrors++
          logger?.warn('context-economy: event handler error contained', item.kind, e instanceof Error ? e.message : String(e))
        }
      }
      stats.dispatched++
    }
    // 本轮期间入队的事件由 publish/firehose 的 schedule() 安排（scheduled 已在函数头置 false）
  }
  const schedule = (): void => {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(drain)
  }

  const unlisten = ctx.on('session/event', (session, event) => {
    if (disposed) {
      stats.dropped++
      return
    }
    try {
      if (passesInputFace(session.header.origin, event)) {
        const text = userMessageText(event.data as UserMessage)
        if (text !== null) {
          queue.push({ kind: 'input/user-message', payload: { session, seq: event.seq, time: event.time, text } })
          stats.enqueued++
        }
      }
      if (METRICS_FACE_TYPES.has(event.type)) {
        queue.push({ kind: 'metrics/session-event', payload: { session, event } })
        stats.enqueued++
      }
      // P12：只透传 context-economy/* ignorable 事实（docs/12 §2），供领域侧按会话分桶。
      if (event.type.startsWith('context-economy/')) {
        queue.push({ kind: 'facts/session-event', payload: { session, event } })
        stats.enqueued++
      }
    } catch (e) {
      logger?.warn('context-economy: firehose filter error contained', e instanceof Error ? e.message : String(e))
    }
    schedule()
  })

  return {
    on(kind, fn) {
      let set = handlers.get(kind)
      if (!set) handlers.set(kind, (set = new Set()))
      set.add(fn as (payload: never) => void)
      return () => set!.delete(fn as (payload: never) => void)
    },
    publish(kind, payload) {
      if (disposed) {
        stats.dropped++
        return
      }
      queue.push({ kind, payload } as { kind: CeDomainEventKind; payload: CeDomainEvents[CeDomainEventKind] })
      stats.enqueued++
      schedule()
    },
    dispose() {
      disposed = true
      queue.length = 0
      unlisten()
    },
    stats: () => ({ ...stats, depth: queue.length }),
  }
}

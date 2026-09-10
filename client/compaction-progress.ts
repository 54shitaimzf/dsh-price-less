/**
 * U17④ 压缩进度（client 纯核）：把会话事件窗折成"当前是否正在压缩"。
 *
 * **为什么客户端自己折、而不是宿主推一条状态**：`context-economy/*` 事实本来就经
 * `session/follow` 到浏览器（ignorable 事件不过滤），事件窗 `SessionBinding.eventSource`
 * 就是它的浏览器侧真源。再开一条宿主→浏览器的推送通道 = 同一事实两条投递路径，
 * 断一条就两边不一致（docs/12 §2 的耦合铁律同理）。
 *
 * **折叠语义**（只看**最后一条**进度事实，O(1)）：
 * - `phase:'start'` → 正在压缩（宿主在模型调用前后各发一条，故"最后一条是 start"⇔ 在途）；
 * - `phase:'end'` / 没有进度事实 → 空闲。
 *
 * 事实名与载荷形状**结构镜像**宿主侧（`core/compress/ledger.ts`）。此处刻意不 import host 的
 * `../src/`（S4 结构断言：client 不得依赖 host 源码）——两侧同源断言由
 * `tests/compaction-progress.spec.ts` 的字面钉 + 真机冒烟承接。
 *
 * 模块: client 压缩进度纯核
 * 平面: L0（纯函数折叠 + 观察源；无 IO、无模型、无定时器）
 * 回退链步数: 1（事件形状不认识 → 视为空闲，绝不显示假进度）
 * 审查清单: 不 import host src；无 timer（进度只由事件驱动，退出即消失）；不改写任何状态。
 * 度量: 无自有 07 字段（读数在宿主侧 compact-progress / compress-run 事实里）。
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'

/** 进度事实的会话事件类型（与宿主 `COMPACT_PROGRESS_FACT_TYPE` 同字面）。 */
export const COMPACT_PROGRESS_FACT_TYPE = 'context-economy/compact-progress'

/** 折叠所用的最小事件形状（`SessionEventLikeEntry` 的结构子集；不 import 具体类）。 */
export interface ProgressEntryLike {
  readonly type: string
  readonly event: { readonly type: string; readonly time?: number; readonly data?: unknown }
}

/** 一条进度事实的载荷（结构镜像宿主 `CompactProgressFactData`）。 */
export interface CompactionProgressFact {
  readonly phase: 'start' | 'end'
  readonly mode: 'boundary' | 'pressure'
  readonly startSeq?: number
  readonly endSeq?: number
  readonly elapsedMs?: number
}

/** 进行中的压缩（dock 渲染面；`null` = 空闲）。 */
export interface CompactionInFlight {
  readonly mode: 'boundary' | 'pressure'
  /** 被压区间端点（宿主在 start 时报；缺失则只显示"压缩中"）。 */
  readonly startSeq?: number
  readonly endSeq?: number
  /** `start` 事件的会话时间（用于展示"已进行多久"的就地读数）。 */
  readonly since: number
}

const MODES: readonly string[] = ['boundary', 'pressure']

/** 载荷收窄（形状不认识 → null；绝不把畸形数据渲染成进度）。 */
function parseFact(data: unknown): CompactionProgressFact | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as { phase?: unknown; mode?: unknown; startSeq?: unknown; endSeq?: unknown; elapsedMs?: unknown }
  if (record.phase !== 'start' && record.phase !== 'end') return null
  if (typeof record.mode !== 'string' || !MODES.includes(record.mode)) return null
  return {
    phase: record.phase,
    mode: record.mode as 'boundary' | 'pressure',
    ...(typeof record.startSeq === 'number' ? { startSeq: record.startSeq } : {}),
    ...(typeof record.endSeq === 'number' ? { endSeq: record.endSeq } : {}),
    ...(typeof record.elapsedMs === 'number' ? { elapsedMs: record.elapsedMs } : {}),
  }
}

/**
 * 事件窗 → 进行中状态（纯核）。
 * @param entries - 会话事件窗（时间升序）。
 * @returns 进行中的压缩；`null` = 空闲。
 */
export function foldCompactionProgress(entries: readonly ProgressEntryLike[]): CompactionInFlight | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry === undefined || entry.type !== 'event') continue
    if (entry.event.type !== COMPACT_PROGRESS_FACT_TYPE) continue
    const fact = parseFact(entry.event.data)
    if (fact === null || fact.phase === 'end') return null
    return {
      mode: fact.mode,
      ...(fact.startSeq === undefined ? {} : { startSeq: fact.startSeq }),
      ...(fact.endSeq === undefined ? {} : { endSeq: fact.endSeq }),
      since: typeof entry.event.time === 'number' ? entry.event.time : 0,
    }
  }
  return null
}

/**
 * 把会话事件窗包成一个**观察源**（`getSnapshot` 引用稳定 = React 不空转）。
 *
 * 快照缓存按窗口 `revision` 失效：同一 revision 返回同一个对象，故
 * `useSyncExternalStore` 语义下不会无限重渲染。
 * @param feed - 会话事件窗观察源（`SessionBinding.eventSource`）。
 * @returns 进度观察源（供槽位 `inject.hooks` 使用）。
 */
export function createCompactionProgressSource(feed: SessionEventSource): HostObservable<CompactionInFlight | null> {
  const listeners = new Set<() => void>()
  let unsubscribeFeed: (() => void) | undefined
  let revision = -1
  let cached: CompactionInFlight | null = null
  const notify = (): void => { for (const listener of [...listeners]) listener() }
  /** 首次有人订阅时才挂到 feed 上（无人看的会话不产生任何订阅开销）。 */
  const ensureFeed = (): void => { unsubscribeFeed ??= feed.subscribe(notify) }
  const read = (): CompactionInFlight | null => {
    const window = feed.getSnapshot()
    if (window.revision !== revision) {
      revision = window.revision
      const next = foldCompactionProgress(window.entries as unknown as readonly ProgressEntryLike[])
      // 引用稳定：字段没变就沿用旧对象（否则每个会话事件都换引用 → React 空转）。
      cached = sameFlight(cached, next) ? cached : next
    }
    return cached
  }
  return {
    getSnapshot: read,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      ensureFeed()
      // 订阅那一刻的窗口可能已经变过（read 未被调用）⇒ 主动失效一次，避免首帧显示旧快照。
      read()
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        unsubscribeFeed?.()
        unsubscribeFeed = undefined
      }
    },
  }
}

/** 两个进行中状态是否等价（字段级；`since` 相等即同一把刀）。 */
function sameFlight(left: CompactionInFlight | null, right: CompactionInFlight | null): boolean {
  if (left === null || right === null) return left === right
  return left.mode === right.mode && left.startSeq === right.startSeq
    && left.endSeq === right.endSeq && left.since === right.since
}

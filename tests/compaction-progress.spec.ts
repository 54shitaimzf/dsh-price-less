/**
 * U17④ 压缩进度（client 纯核）合同测试。
 *
 * 三条不变量：① 只有"最后一条进度事实是 start"才算进行中（end/无事实 = 空闲）；
 * ② 形状不认识 → 空闲（**绝不显示假进度**）；③ 观察源快照**引用稳定**（同 revision 同对象，
 * 否则 React 每次会话事件都重渲染）+ 无人订阅时不挂 feed、退订后摘掉。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  COMPACT_PROGRESS_FACT_TYPE,
  createCompactionProgressSource,
  foldCompactionProgress,
  type ProgressEntryLike,
} from '../client/compaction-progress.ts'

const progressEvent = (data: unknown, time = 100): ProgressEntryLike => ({
  type: 'event',
  event: { type: COMPACT_PROGRESS_FACT_TYPE, time, data },
})

const START = { phase: 'start', mode: 'boundary', startSeq: 0, endSeq: 3, at: 100 }
const END = { phase: 'end', mode: 'boundary', startSeq: 0, endSeq: 3, elapsedMs: 62600, at: 62700 }

/** 最小事件窗观察源替身（revision 手动推进）。 */
function fakeFeed(initial: readonly ProgressEntryLike[] = []) {
  let entries = initial
  let revision = 0
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => ({ entries, hasMore: false, revision, change: { kind: 'replace' as const, entries } }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    push: (entry: ProgressEntryLike) => {
      entries = [...entries, entry]
      revision++
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

describe('U17④ foldCompactionProgress：事件窗 → 进行中状态', () => {
  it('最后一条是 start → 进行中（带模式与区间）', () => {
    expect(foldCompactionProgress([progressEvent(START)])).toEqual({
      mode: 'boundary', startSeq: 0, endSeq: 3, since: 100,
    })
  })

  it('start 后跟 end → 空闲（提示消失，不留"上次压缩"噪声）', () => {
    expect(foldCompactionProgress([progressEvent(START), progressEvent(END)])).toBeNull()
  })

  it('只看最后一条：end → start → 进行中；start → end → 空闲', () => {
    expect(foldCompactionProgress([progressEvent(END), progressEvent(START)]))
      .toMatchObject({ mode: 'boundary' })
    expect(foldCompactionProgress([progressEvent(START), progressEvent(END)])).toBeNull()
  })

  it('无事实 / 只有别的 context-economy 事实 → 空闲', () => {
    expect(foldCompactionProgress([])).toBeNull()
    expect(foldCompactionProgress([
      { type: 'event', event: { type: 'context-economy/compress-run', time: 1, data: { outcome: 'ok' } } },
      { type: 'transient', event: { type: 'assistant/live-chunk', time: 2 } },
    ])).toBeNull()
  })

  it('载荷形状不认识（phase/mode 非法、非对象）→ 空闲，绝不显示假进度', () => {
    expect(foldCompactionProgress([progressEvent({ phase: 'middle', mode: 'boundary' })])).toBeNull()
    expect(foldCompactionProgress([progressEvent({ phase: 'start', mode: 'unknown-mode' })])).toBeNull()
    expect(foldCompactionProgress([progressEvent('start')])).toBeNull()
    expect(foldCompactionProgress([progressEvent(null)])).toBeNull()
  })

  it('压力模式的区间端点按事实原样带出（零算术：不显示宿主没报的数字）', () => {
    expect(foldCompactionProgress([progressEvent({ phase: 'start', mode: 'pressure', startSeq: 12, endSeq: 30, at: 5 })]))
      .toEqual({ mode: 'pressure', startSeq: 12, endSeq: 30, since: 100 })
  })
})

describe('U17④ createCompactionProgressSource：观察源（getSnapshot 引用稳定 + 订阅生命周期）', () => {
  it('同 revision 返回同一对象；窗口推进后按内容决定是否换引用', () => {
    const feed = fakeFeed([progressEvent(START)])
    const source = createCompactionProgressSource(feed as never)
    const first = source.getSnapshot()
    expect(source.getSnapshot()).toBe(first)
    // 追加一条无关事件 → revision 变、折叠结果不变 ⇒ **引用不变**（React 不空转）
    feed.push({ type: 'transient', event: { type: 'assistant/live-chunk', time: 3 } })
    expect(source.getSnapshot()).toBe(first)
    // 追加 end ⇒ 结果变 null
    feed.push(progressEvent(END))
    expect(source.getSnapshot()).toBeNull()
  })

  it('无人订阅时不挂 feed；订阅后转发失效通知；全部退订后摘掉', () => {
    const feed = fakeFeed()
    const source = createCompactionProgressSource(feed as never)
    expect(feed.listenerCount()).toBe(0)

    const listener = vi.fn()
    const dispose = source.subscribe(listener)
    expect(feed.listenerCount()).toBe(1)
    feed.push(progressEvent(START))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(source.getSnapshot()).toMatchObject({ mode: 'boundary' })

    dispose()
    expect(feed.listenerCount()).toBe(0)
    feed.push(progressEvent(END))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

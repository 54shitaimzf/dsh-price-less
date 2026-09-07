/**
 * H6 工具端口（P7 工单 §3.2）：七组全部 fake——手写 ctx（记录监听器 + 可触发），
 * 验证注册/卸载/计量与 execute/post-execute 的短路/委托契约（决策点 1/2）。
 * 零 cordis 运行时 import；T-entry/T-note 语义不在此（归 P15a/P15b）。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  PostToolDecision,
  ToolDispatchExecution,
  ToolExecutionResult,
  ToolExecutionToken,
} from '@deepseek-ai/dsh-tools'
import { appendContent, createToolPort, replaceContent } from '../src/platform/tools.ts'

type Listener = (...args: any[]) => unknown

function makeFakeCtx() {
  const listeners = new Map<string, Listener[]>()
  const ctx = {
    on(name: string, listener: Listener) {
      const arr = listeners.get(name) ?? []
      arr.push(listener)
      listeners.set(name, arr)
      return () => {
        const idx = arr.indexOf(listener)
        if (idx >= 0) arr.splice(idx, 1)
        return idx >= 0
      }
    },
  } as unknown as Pick<Context, 'on'>
  return {
    ctx,
    count(name: string) { return (listeners.get(name) ?? []).length },
    async emit(name: string, ...args: unknown[]) {
      const results: unknown[] = []
      for (const l of [...(listeners.get(name) ?? [])]) results.push(await l(...args))
      return results
    },
  }
}

function makeNext(value: unknown) {
  let calls = 0
  return {
    next: () => { calls++; return Promise.resolve(value) },
    calls: () => calls,
  }
}

function fakeExec(): ToolDispatchExecution {
  return {
    callId: 'fake-call-1',
    rootCallId: 'fake-call-1',
    token: Symbol('fake-token') as ToolExecutionToken,
    name: 'read_file',
    arguments: { path: 'a.txt' },
    signal: new AbortController().signal,
  } as ToolDispatchExecution
}

const text = (t: string): ContentBlock => ({ type: 'text', text: t })
const fakeResult = (blocks: ContentBlock[]): ToolExecutionResult =>
  ({ isError: false, value: 'ok', content: blocks }) as ToolExecutionResult
const ACCEPT_RESULT = fakeResult([text('accept')])
const acceptContent = (d: PostToolDecision): ContentBlock[] => {
  if (d.kind !== 'accept' || !d.content) throw new Error('expected accept with content')
  return d.content
}

describe('tools 端口（P7）', () => {
  it('1. 注册与卸载：两事件注册；dispose 移除；重复 dispose no-op', () => {
    const fake = makeFakeCtx()
    const port = createToolPort(fake.ctx)
    expect(fake.count('tools/execute')).toBe(1)
    expect(fake.count('tools/post-execute')).toBe(1)
    port.dispose()
    expect(fake.count('tools/execute')).toBe(0)
    expect(fake.count('tools/post-execute')).toBe(0)
    expect(() => port.dispose()).not.toThrow()
    expect(fake.count('tools/execute')).toBe(0)
  })

  it('2. execute 仅信号/计量：hook 收到 exec；抛错/返回假值不影响 next 与透传', async () => {
    const fake = makeFakeCtx()
    const seen: ToolDispatchExecution[] = []
    const warns: unknown[][] = []
    const port = createToolPort(fake.ctx, {
      onExecute: (exec) => { seen.push(exec); if (seen.length === 1) throw new Error('observer boom') },
    }, { warn: (...args) => { warns.push(args) } })
    const next = makeNext(ACCEPT_RESULT)
    const results = await fake.emit('tools/execute', fakeExec(), next.next)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ name: 'read_file', callId: 'fake-call-1' })
    expect(next.calls()).toBe(1)
    expect(results).toEqual([ACCEPT_RESULT])
    expect(warns).toHaveLength(1)
    expect(String(warns[0]?.[0])).toContain('tools/execute hook failed')
    const next2 = makeNext(ACCEPT_RESULT)
    await fake.emit('tools/execute', fakeExec(), next2.next)
    expect(next2.calls()).toBe(1)
    expect(port.stats().listenerErrors).toBe(1)
  })

  it('3. post-execute 无决策委托 next：hook 返回 undefined → next 被调且返回其决策', async () => {
    const fake = makeFakeCtx()
    const port = createToolPort(fake.ctx, { onPostExecute: () => undefined })
    const next = makeNext(ACCEPT_RESULT)
    const results = await fake.emit('tools/post-execute', fakeExec(), fakeResult([text('orig')]), next.next)
    expect(next.calls()).toBe(1)
    expect(results).toEqual([ACCEPT_RESULT])
    expect(port.stats().decisions).toBe(0)
  })

  it('4. post-execute 有决策短路：next 未调；监听器解析为该决策', async () => {
    const fake = makeFakeCtx()
    const port = createToolPort(fake.ctx, { onPostExecute: () => replaceContent([text('rewritten')]) })
    const next = makeNext(ACCEPT_RESULT)
    const results = await fake.emit('tools/post-execute', fakeExec(), fakeResult([text('orig')]), next.next)
    expect(next.calls()).toBe(0)
    expect(results).toEqual([{ kind: 'accept', content: [text('rewritten')] }])
    expect(port.stats().decisions).toBe(1)
  })

  it('5. post-execute hook 抛错委托 next：warn 恰一次；next 被调', async () => {
    const fake = makeFakeCtx()
    const warns: unknown[][] = []
    const port = createToolPort(fake.ctx, {
      onPostExecute: () => { throw new Error('judge boom') },
    }, { warn: (...args) => { warns.push(args) } })
    const next = makeNext(ACCEPT_RESULT)
    const results = await fake.emit('tools/post-execute', fakeExec(), fakeResult([text('orig')]), next.next)
    expect(next.calls()).toBe(1)
    expect(results).toEqual([ACCEPT_RESULT])
    expect(warns).toHaveLength(1)
    expect(String(warns[0]?.[0])).toContain('post-execute hook failed')
    expect(port.stats().listenerErrors).toBe(1)
  })

  it('6. 决策构造器：replace 覆盖、append 追加；输出不共享输入引用', () => {
    const input = [text('a'), text('b')]
    const replaced = replaceContent(input)
    expect(replaced).toEqual({ kind: 'accept', content: [text('a'), text('b')] })
    expect(acceptContent(replaced)).not.toBe(input)
    input[0] = text('mutated')
    expect(acceptContent(replaced)).toEqual([text('a'), text('b')])

    const result = fakeResult([text('x'), text('y')])
    const appended = appendContent(result, [text('z')])
    expect(appended).toEqual({ kind: 'accept', content: [text('x'), text('y'), text('z')] })
    const out = acceptContent(appended)
    expect(out).not.toBe(result.content)
    expect(result.content).toEqual([text('x'), text('y')])
    out[0] = text('mutated')
    expect(result.content).toEqual([text('x'), text('y')])
  })

  it('7. stats 计数：多次 emit 后各计数正确；快照独立', async () => {
    const fake = makeFakeCtx()
    const port = createToolPort(fake.ctx, {
      onExecute: () => {},
      onPostExecute: () => replaceContent([text('r')]),
    })
    await fake.emit('tools/execute', fakeExec(), makeNext(ACCEPT_RESULT).next)
    await fake.emit('tools/execute', fakeExec(), makeNext(ACCEPT_RESULT).next)
    await fake.emit('tools/post-execute', fakeExec(), fakeResult([text('o')]), makeNext(ACCEPT_RESULT).next)
    await fake.emit('tools/post-execute', fakeExec(), fakeResult([text('o')]), makeNext(ACCEPT_RESULT).next)
    expect(port.stats()).toEqual({ executeSeen: 2, postExecuteSeen: 2, decisions: 2, listenerErrors: 0 })
    const snapshot = port.stats()
    snapshot.executeSeen = 99
    expect(port.stats().executeSeen).toBe(2)
  })
})

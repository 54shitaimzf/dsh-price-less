/**
 * N1 分类器单测（docs/implement/N1-identity-and-eligible.md §5）：
 * 决策序列每行 ≥1 用例 + basis 四档 + 形态四类否决 + 异常降级 + 平台签名提取。
 * 纯核零依赖；平台侧用假 ctx（记录监听器 + 可注入 tools），不启 cordis。
 */
import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import {
  CUT_CANDIDATE_MIN_BYTES,
  CUT_REASON,
  classifyToolResult,
  type ToolDescriptor,
} from '../src/core/shear/classify.ts'
import {
  createShearToolPort,
  type ShearToolPortContext,
  type ToolResultView,
  type ToolSignatureSource,
} from '../src/platform/tools.ts'

/** 造一个 ≥2KB、无形态否决特征的正文（单行重复，避开语料/错误/截断特征）。 */
function big(seed = 'PASS 12 tests, 0 failures\n', times = 120): string {
  return seed.repeat(times)
}
function desc(over: Partial<ToolDescriptor>): ToolDescriptor {
  return { name: 'pwsh', resultText: big(), ...over }
}
const v = (d: ReturnType<typeof classifyToolResult>): [string, string, string] => [d.verdict, d.basis, d.reason]

describe('N1 分类器 · 身份阶段（决策序列 §4.1）', () => {
  it('0. 低于 2KB 不入候选', () => {
    expect(classifyToolResult(desc({ name: 'run_code', resultText: 'ok', args: { code: 'console.log(1)' } })))
      .toEqual({ verdict: 'never', stage: 'identity', basis: 'none', reason: CUT_REASON.TOO_SMALL })
    expect(CUT_CANDIDATE_MIN_BYTES).toBe(2048)
  })

  it('1. 改史：card=diff 与 kind∈{edit,delete,move} 一律 never/signature', () => {
    expect(v(classifyToolResult(desc({ name: 'write', card: 'diff', resultText: big() })))).toEqual(['never', 'signature', 'write-history'])
    for (const kind of ['edit', 'delete', 'move']) {
      expect(v(classifyToolResult(desc({ name: 'x', kind, resultText: big() })))).toEqual(['never', 'signature', 'write-history'])
    }
  })

  it('2. 文件事实：kind=read / card=read 一律 never/signature（job_output 例外）', () => {
    expect(v(classifyToolResult(desc({ name: 'read', kind: 'read', card: 'generic' })))).toEqual(['never', 'signature', 'file-fact'])
    expect(v(classifyToolResult(desc({ name: 'read', card: 'read' })))).toEqual(['never', 'signature', 'file-fact'])
    expect(v(classifyToolResult(desc({ name: 'read_image', kind: 'read' })))).toEqual(['never', 'signature', 'file-fact'])
  })

  it('3. 外部事实：kind=fetch / card=web 一律 never/signature', () => {
    expect(v(classifyToolResult(desc({ name: 'web_fetch', kind: 'fetch', card: 'generic' })))).toEqual(['never', 'signature', 'external-fact'])
    expect(v(classifyToolResult(desc({ name: 'web_fetch', card: 'web' })))).toEqual(['never', 'signature', 'external-fact'])
  })

  it('4. 检索事实：kind=search / card=search 一律 never/signature（grep 归此不归外部事实）', () => {
    expect(v(classifyToolResult(desc({ name: 'grep', kind: 'search', card: 'search' })))).toEqual(['never', 'signature', 'search-fact'])
    expect(v(classifyToolResult(desc({ name: 'glob', card: 'search' })))).toEqual(['never', 'signature', 'search-fact'])
  })

  it('5/6. terminal→command、名字白名单→name；其余→never/none', () => {
    expect(classifyToolResult(desc({ name: 'pwsh', card: 'terminal', args: { command: 'npm test' } })))
      .toMatchObject({ verdict: 'cuttable', stage: 'shape', basis: 'command' })
    expect(classifyToolResult(desc({ name: 'subagent', args: { prompt: 'x' }, resultText: big('## Findings\nThe fix is one line.\n') })))
      .toMatchObject({ verdict: 'cuttable', stage: 'shape', basis: 'name' })
    expect(v(classifyToolResult(desc({ name: 'mystery', resultText: big() })))).toEqual(['never', 'none', 'unknown'])
  })
})

describe('N1 分类器 · 形态阶段（§4.2 四类否决）', () => {
  const term = (command: string, resultText = big()): ToolDescriptor =>
    desc({ name: 'pwsh', card: 'terminal', args: { command }, resultText })

  it('副作用：命令含 git commit / 重定向 / npm install → never', () => {
    expect(v(classifyToolResult(term('git commit -m "x"')))).toEqual(['never', 'command', 'side-effect'])
    expect(v(classifyToolResult(term('npm test > out.txt')))).toEqual(['never', 'command', 'side-effect'])
    expect(v(classifyToolResult(term('npm install')))).toEqual(['never', 'command', 'side-effect'])
    expect(v(classifyToolResult(term('Remove-Item -Recurse lib')))).toEqual(['never', 'command', 'side-effect'])
  })

  it('截断：命令含 head/tail/wc，或结果自带截断标记 → never', () => {
    expect(v(classifyToolResult(term('head -n 20 big.log')))).toEqual(['never', 'command', 'truncated'])
    expect(v(classifyToolResult(term('npm test', big() + '\n... [truncated]')))).toEqual(['never', 'command', 'truncated'])
  })

  it('错误诊断：isError / 错误行 / 非零退出 / 失败计数 → never；0 errors 不误判', () => {
    expect(v(classifyToolResult(term('npm test', big('ok 11 - adds\n', 200) + '1 failed\n')))).toEqual(['never', 'command', 'error-output'])
    expect(v(classifyToolResult(term('npm test', big() + 'Error: boom\n')))).toEqual(['never', 'command', 'error-output'])
    expect(v(classifyToolResult(term('npm test', big() + 'exit code 1\n')))).toEqual(['never', 'command', 'error-output'])
    expect(classifyToolResult(term('npm test', big('ok 12 - adds\n', 200) + '0 errors\n')).verdict).toBe('cuttable')
  })

  it('语料/全文：代码围栏 / 编号行 / 源码行 → never', () => {
    expect(v(classifyToolResult(term('cat src/a.ts', '```ts\n' + big('const x = 1\n', 200) + '```\n')))).toEqual(['never', 'command', 'corpus'])
    expect(v(classifyToolResult(term('cat a.txt', big('ok\n', 800) + '\n' + Array.from({ length: 6 }, (_, i) => `${i + 1}\tline`).join('\n')))))
      .toEqual(['never', 'command', 'corpus'])
  })

  it('成功结论：测试/构建成功、计数、判定 → cuttable', () => {
    expect(v(classifyToolResult(term('npm test')))).toEqual(['cuttable', 'command', 'conclusion'])
    expect(v(classifyToolResult(term('tsc -b')))).toEqual(['cuttable', 'command', 'conclusion'])
  })

  it('run_code：扫程序源码副作用；纯计算 → cuttable；源码读不到 → never（不猜）', () => {
    const code = (source: string, resultText = big()): ToolDescriptor =>
      desc({ name: 'run_code', args: { code: source }, resultText })
    expect(v(classifyToolResult(code("require('fs').writeFileSync('a','b')")))).toEqual(['never', 'name', 'side-effect'])
    expect(v(classifyToolResult(code("require('child_process').execSync('git commit -m x')")))).toEqual(['never', 'name', 'side-effect'])
    expect(v(classifyToolResult(code('console.log(1 + 1)')))).toEqual(['cuttable', 'name', 'conclusion'])
    expect(v(classifyToolResult(desc({ name: 'run_code', args: null, resultText: big() })))).toEqual(['never', 'name', 'unknown'])
  })

  it('job_output：kind=read 但载荷是后台作业 stdout → 走形态阶段', () => {
    expect(v(classifyToolResult(desc({ name: 'job_output', kind: 'read', card: 'generic', args: { job_id: 'pwsh-1' }, resultText: big('gate: 552 tests passed\n') }))))
      .toEqual(['cuttable', 'name', 'conclusion'])
    expect(v(classifyToolResult(desc({ name: 'job_output', kind: 'read', args: { job_id: 'x' }, resultText: big() + 'FAIL 3 tests\n' }))))
      .toEqual(['never', 'name', 'error-output'])
  })

  it('确定性：同输入同判定（纯函数，无时钟/随机）', () => {
    const d = term('npm test')
    expect(classifyToolResult(d)).toEqual(classifyToolResult(d))
  })
})

/** 平台签名提取（N1 §3 交付物 1）：presentCall → kind/card；meta/args 直取；异常降级。 */
function makePortCtx(getTools?: () => ToolSignatureSource | undefined) {
  const listeners = new Map<string, ((...a: any[]) => unknown)[]>()
  const ctx = {
    on(name: string, listener: (...a: any[]) => unknown) {
      const arr = listeners.get(name) ?? []
      arr.push(listener)
      listeners.set(name, arr)
      return () => {
        const idx = arr.indexOf(listener)
        if (idx >= 0) arr.splice(idx, 1)
        return idx >= 0
      }
    },
  } as unknown as ShearToolPortContext
  return {
    getTools,
    ctx,
    async emit(name: string, ...args: unknown[]) {
      const out: unknown[] = []
      for (const l of [...(listeners.get(name) ?? [])]) out.push(await l(...args))
      return out
    },
  }
}
const text = (t: string): ContentBlock => ({ type: 'text', text: t })
function fakeExec(over: Partial<ToolExecution> = {}): ToolExecution {
  return {
    callId: 'c1',
    rootCallId: 'c1',
    token: Symbol('t') as ToolExecutionToken,
    name: 'pwsh',
    arguments: { command: 'npm test' },
    signal: new AbortController().signal,
    ...over,
  } as ToolExecution
}
function fakeResult(over: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
  return { isError: false, value: 'ok', content: [text('out')], ...over } as ToolExecutionResult
}

describe('N1 平台描述符（§3 交付物 1）', () => {
  it('presentCall 的 kind/card 落进视图；args/meta/resultBytes 直取', async () => {
    const fake = makePortCtx(() => ({
      get: () => ({ presentCall: () => ({ card: 'terminal' }) }),
    }))
    const seen: ToolResultView[] = []
    createShearToolPort(fake.ctx, { shapeEntry: () => undefined, attachNote: (view) => { seen.push(view); return undefined } }, undefined, fake.getTools)
    await fake.emit('tools/post-execute', fakeExec(), fakeResult({ meta: { exitCode: 0 } }), () => Promise.resolve(undefined))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ name: 'pwsh', card: 'terminal', args: { command: 'npm test' }, meta: { exitCode: 0 } })
    expect(seen[0]?.resultBytes).toBe(Buffer.byteLength('out', 'utf8'))
  })

  it('tools 缺失 / get 抛错 / presentCall 返回 undefined → 降级为无签名，不打断执行', async () => {
    for (const tools of [
      undefined,
      { get: () => { throw new Error('boom') } },
      { get: () => undefined },
      { get: () => ({ presentCall: () => undefined }) },
    ] as Array<ToolSignatureSource | undefined>) {
      const fake = makePortCtx(() => tools)
      const seen: ToolResultView[] = []
      createShearToolPort(fake.ctx, { shapeEntry: () => undefined, attachNote: (view) => { seen.push(view); return undefined } }, undefined, fake.getTools)
      await expect(fake.emit('tools/post-execute', fakeExec(), fakeResult(), () => Promise.resolve(undefined))).resolves.toBeDefined()
      expect(seen[0]?.kind).toBeUndefined()
      expect(seen[0]?.card).toBeUndefined()
    }
  })
})

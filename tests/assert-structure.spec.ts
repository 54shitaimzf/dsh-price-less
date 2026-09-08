/**
 * 结构断言引擎自测（P0 工单 §3.2）：负样本（防「永真断言」，每规则 ≥1、用例名含规则 id）、
 * 正样本、真实树集成、零位快照、确定性（双跑字节一致）。
 * 规则语义冻结（P0 §6-1）：负样本不过 = 修实现或修产品码，禁止删负样本/放宽正则。
 */
import { describe, expect, it } from 'vitest'
import { collectFiles, RULES, runRules } from '../scripts/assert-structure.mjs'
import type { Rule } from '../scripts/assert-structure.mjs'

const rule = (id: string): Rule => {
  const r = RULES.find((x) => x.id === id)
  if (!r) throw new Error(`rule ${id} not found`)
  return r
}
const check = (id: string, path: string, text: string, all?: Map<string, string>) =>
  rule(id).check({ path, text }, all ?? new Map())
const NO_ISSUES: never[] = []

describe('负样本（每规则 ≥1）', () => {
  it('M1：name 错误 / version 非语义化 → issue', () => {
    expect(check('M1', 'package.json', JSON.stringify({ name: 'other', version: '0.0.1' })).length).toBeGreaterThanOrEqual(1)
    expect(check('M1', 'package.json', JSON.stringify({ name: 'dsh-price-less', version: 'dev' })).length).toBeGreaterThanOrEqual(1)
  })
  it('M2：peerDep 缺键 / 硬编码精确版本 → issue', () => {
    expect(check('M2', 'package.json', JSON.stringify({ peerDependencies: { schemastery: '3.18.0' } })).length).toBeGreaterThanOrEqual(1)
    expect(check('M2', 'package.json', JSON.stringify({ peerDependencies: { '@deepseek-ai/cordis': '>=4 <5', '@deepseek-ai/dsh-settings': '>=0.1.3 <2', schemastery: '^3.18.0', extra: 'x' } }))).toEqual(NO_ISSUES)
  })
  it('M3：patch 指向错误 / 文件集缺 cordis.patch.yml / files 未收编 patch → issue', () => {
    expect(check('M3', 'package.json', JSON.stringify({ dsh: { bundle: { patch: './other.yml' } } })).length).toBeGreaterThanOrEqual(1)
    expect(check('M3', 'package.json', JSON.stringify({ dsh: { bundle: { patch: './cordis.patch.yml' } } }), new Map()).length).toBeGreaterThanOrEqual(1)
    expect(check('M3', 'package.json', JSON.stringify({ dsh: { bundle: { patch: './cordis.patch.yml' } }, files: ['lib'] }), new Map([['cordis.patch.yml', 'y']])).length).toBeGreaterThanOrEqual(1)
  })
  it('M4：platform 非 web / inject 缺项 / exports 缺 ./client → issue', () => {
    expect(check('M4', 'package.json', JSON.stringify({ dsh: { client: { platform: 'node', inject: ['react'] } } })).length).toBeGreaterThanOrEqual(1)
    expect(check('M4', 'package.json', JSON.stringify({ dsh: { client: { platform: 'web', inject: ['react', '@deepseek-ai/dsh-client-ui-slots'] } } })).length).toBeGreaterThanOrEqual(1)
  })
  it('M5：host 缺 Config 再导出 / client 缺 name → issue', () => {
    const host = "export const name = 'x'\nexport function apply() {}\n"
    expect(rule('M5').check({ path: 'src/index.ts', text: host }, new Map()).length).toBeGreaterThanOrEqual(1)
    const client = "export const inject = []\nexport function apply() {}\n"
    expect(rule('M5').check({ path: 'client/index.ts', text: client }, new Map()).length).toBeGreaterThanOrEqual(1)
  })
  it('S1：core 内 harness import（含 type-only）/ platform import → issue', () => {
    expect(check('S1', 'src/core/x.ts', "import type { X } from '@deepseek-ai/dsh-session'\n").length).toBeGreaterThanOrEqual(1)
    expect(check('S1', 'src/core/x.ts', "import y from 'cordis'\n").length).toBeGreaterThanOrEqual(1)
    expect(check('S1', 'src/core/x.ts', "import { pump } from '../platform/events.ts'\n").length).toBeGreaterThanOrEqual(1)
  })
  it('S2：.append( 出现在 history/logger 之外 → issue（surfaceOp 只读比较不算改史）', () => {
    expect(check('S2', 'src/foo.ts', "session.append('x', d)\n")).not.toEqual(NO_ISSUES)
    expect(check('S2', 'src/core/x.ts', 'log.append(x)\n')).not.toEqual(NO_ISSUES)
    expect(check('S2', 'src/platform/other.ts', 'session.append(x)\n')).not.toEqual(NO_ISSUES)
    expect(check('S2', 'src/domains/a.ts', "if (event.surfaceOp !== 'append') return\n")).toEqual(NO_ISSUES)
  })
  it('S3：context-economy/* 事件锚点窗口内无 ignorable → issue', () => {
    expect(check('S3', 'src/a.ts', "session.append('context-economy/task-boundary', d)\n")).not.toEqual(NO_ISSUES)
  })
  it('S4：client 反向 import host src → issue', () => {
    expect(check('S4', 'client/a.ts', "import x from '../src/index.ts'\n")).not.toEqual(NO_ISSUES)
  })
  it('S5：src/client 出现 setInterval( → issue', () => {
    expect(check('S5', 'src/a.ts', 'setInterval(tick, 1000)\n')).not.toEqual(NO_ISSUES)
  })
  it('D1：session/event 监听体 10 行内出现 await → issue', () => {
    const body = "ctx.on('session/event', (s, e) => {\n  const x = await tick()\n})"
    expect(check('D1', 'src/a.ts', body)).not.toEqual(NO_ISSUES)
  })
  it('D2：waterfall 注册（agent/pre-step / tools/execute）缺 return next( → issue', () => {
    expect(check('D2', 'src/a.ts', "ctx.on('agent/pre-step', (p) => p)\n")).not.toEqual(NO_ISSUES)
    expect(check('D2', 'src/a.ts', "ctx.on('tools/execute', (t) => t)\n")).not.toEqual(NO_ISSUES)
  })
  it('D3：ignorable 通道概念越出可删除单元 → issue（docs/12 §2）', () => {
    expect(check('D3', 'src/domains/a.ts', "emitFact(session, 'x', d)\n")).not.toEqual(NO_ISSUES)
    expect(check('D3', 'src/domains/a.ts', "import { emitFact } from '../platform/ignorable-channel.ts'\n")).not.toEqual(NO_ISSUES)
    expect(check('D3', 'src/core/a.ts', 'type X = keyof IgnorableSessionEventMap\n')).not.toEqual(NO_ISSUES)
    expect(check('D3', 'src/index.ts', 'const capable = SESSION_LOG_INTENT === 1\n')).not.toEqual(NO_ISSUES)
  })
  it('D4：storageDomain/defineDomain/domainTable 越出 platform/storage.ts 与 index.ts → issue', () => {
    expect(check('D4', 'src/domains/a.ts', "ctx.storageDomain.open({ name: 'x' })\n")).not.toEqual(NO_ISSUES)
    expect(check('D4', 'src/core/a.ts', "import { defineDomain } from '@deepseek-ai/dsh-storage-domain'\n")).not.toEqual(NO_ISSUES)
  })
  it('D5：skill 概念越出 platform/skills.ts 与 index.ts → issue（docs/10 §1 H13 + docs/11 §2）', () => {
    expect(check('D5', 'src/core/a.ts', "import type { SkillSummary } from '@deepseek-ai/dsh-skill'\n")).not.toEqual(NO_ISSUES)
    expect(check('D5', 'src/platform/events.ts', "ctx.on('skills/change', () => {})\n")).not.toEqual(NO_ISSUES)
  })
  it('D6：llm 服务概念越出 platform/llm.ts → issue（docs/10 §1 H12 + docs/12 §1 C2）', () => {
    expect(check('D6', 'src/domains/a.ts', "ctx.llm.stream({ purpose: 'x' })\n")).not.toEqual(NO_ISSUES)
    expect(check('D6', 'src/platform/events.ts', "import type { GenerateOptions } from '@deepseek-ai/dsh-llm'\n")).not.toEqual(NO_ISSUES)
  })
  it('D7：history 协议概念（含 compaction/summary）越出 platform/history.ts → issue（docs/10 §1 H4/H5 + docs/11 §2）', () => {
    expect(check('D7', 'src/domains/a.ts', "port.beginCompaction({ compactionId: CompactionId('c') })\n")).not.toEqual(NO_ISSUES)
    expect(check('D7', 'src/platform/events.ts', "session.append('compaction/start', d)\n")).not.toEqual(NO_ISSUES)
    expect(check('D7', 'src/core/a.ts', "import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'\n")).not.toEqual(NO_ISSUES)
    expect(check('D7', 'src/domains/a.ts', "session.append('compaction/summary', d)\n")).not.toEqual(NO_ISSUES)
  })
  it('D8：工具事件概念越出 platform/tools.ts → issue（docs/10 §1 H6 + docs/13 §3.9）', () => {
    expect(check('D8', 'src/domains/a.ts', "ctx.on('tools/post-execute', (e, r, next) => next())\n")).not.toEqual(NO_ISSUES)
    expect(check('D8', 'src/platform/events.ts', "import type { ToolExecution } from '@deepseek-ai/dsh-tools'\n")).not.toEqual(NO_ISSUES)
  })
  it('D10：core/shear 出现时钟/随机 → issue（确定性 fold，docs/05 + docs/11 §9）', () => {
    expect(check('D10', 'src/core/shear/tool.ts', 'const t = Date.now()\n')).not.toEqual(NO_ISSUES)
    expect(check('D10', 'src/core/shear/ledger.ts', 'const x = Math.random()\n')).not.toEqual(NO_ISSUES)
    expect(check('D10', 'src/core/shear/t0r.ts', 'const d = new Date()\n')).not.toEqual(NO_ISSUES)
  })
  it('D11：fs 服务概念越出 platform/files.ts → issue（docs/10 §1 H15 盘上取真收口）', () => {
    expect(check('D11', 'src/domains/a.ts', "const fs = ctx.get('fs')\n")).not.toEqual(NO_ISSUES)
    expect(check('D11', 'src/core/a.ts', "import type { FsTarget } from '@deepseek-ai/dsh-fs'\n")).not.toEqual(NO_ISSUES)
    expect(check('D11', 'src/platform/events.ts', 'await fs.readText(target)\n')).not.toEqual(NO_ISSUES)
    expect(rule('D11').check({ path: 'src/platform/files.ts', text: "ctx.get('fs'); FileSystem; FsTarget; readText(t)" }, new Map())).toEqual(NO_ISSUES)
    expect(check('D11', 'src/index.ts', "ctx.inject(['fs'], (fsCtx) => {})\n")).toEqual(NO_ISSUES)
  })
  it('D12：core/assemble 出现时钟/随机 → issue（装配器确定性，docs/11 §9）', () => {
    expect(check('D12', 'src/core/assemble/assemble.ts', 'const t = Date.now()\n')).not.toEqual(NO_ISSUES)
    expect(check('D12', 'src/core/assemble/chain.ts', 'const x = Math.random()\n')).not.toEqual(NO_ISSUES)
    expect(check('D12', 'src/core/assemble/ledger.ts', 'const d = new Date()\n')).not.toEqual(NO_ISSUES)
    expect(check('D12', 'src/core/assemble/types.ts', 'export const x = 1\n')).toEqual(NO_ISSUES)
  })
  it('D13：core/compress 出现时钟/随机 → issue（压缩调用确定性，docs/11 §9）', () => {
    expect(check('D13', 'src/core/compress/prompt.ts', 'const t = Date.now()\n')).not.toEqual(NO_ISSUES)
    expect(check('D13', 'src/core/compress/product.ts', 'const x = Math.random()\n')).not.toEqual(NO_ISSUES)
    expect(check('D13', 'src/core/compress/ledger.ts', 'const d = new Date()\n')).not.toEqual(NO_ISSUES)
    expect(check('D13', 'src/core/compress/types.ts', 'export const x = 1\n')).toEqual(NO_ISSUES)
  })
  it('D9：connection RPC 桥概念越出 platform/star-bridge.ts 与 index.ts → issue（docs/10 §1 H11 + docs/13 §3.11）', () => {
    expect(check('D9', 'src/domains/star.ts', "const connection = ctx.connection\n")).not.toEqual(NO_ISSUES)
    expect(check('D9', 'src/platform/events.ts', "type X = ConnectionRpcResult<unknown>\n")).not.toEqual(NO_ISSUES)
    expect(check('D9', 'src/platform/star-bridge.ts', "connection.rpc.handle('/context-economy', handler)\n")).toEqual(NO_ISSUES)
  })
})

describe('正样本（干净文件 → 0 issue）', () => {
  it('M1–M4：合规 package.json', () => {
    const pkg = JSON.stringify({
      name: 'dsh-price-less', version: '0.0.1',
      peerDependencies: { '@deepseek-ai/cordis': '>=4 <5', '@deepseek-ai/dsh-settings': '>=0.1.3 <2', schemastery: '^3.18.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: ['react', '@deepseek-ai/dsh-client-ui-slots'] } },
      exports: { './client': { default: './lib/client.js' } },
      files: ['lib', 'cordis.patch.yml'],
    })
    for (const id of ['M1', 'M2', 'M3', 'M4']) expect(check(id, 'package.json', pkg, new Map([['cordis.patch.yml', 'y']]))).toEqual(NO_ISSUES)
  })
  it('M5：host/client 各自完整导出面', () => {
    const host = "export const name = 'x'\nexport { Config } from './config.ts'\nexport function apply() {}\n"
    const client = "export const name = 'x'\nexport const inject = []\nexport function apply() {}\n"
    expect(rule('M5').check({ path: 'src/index.ts', text: host }, new Map())).toEqual(NO_ISSUES)
    expect(rule('M5').check({ path: 'client/index.ts', text: client }, new Map())).toEqual(NO_ISSUES)
  })
  it('S1–S5 + D1/D2：各自干净文件', () => {
    expect(check('S1', 'src/core/x.ts', "import { fold } from './fold.ts'\nexport type X = { a: number }\n")).toEqual(NO_ISSUES)
    expect(rule('S2').check({ path: 'src/platform/history.ts', text: 'session.append(x, { surfaceOp, sourceEventSeqs })' }, new Map())).toEqual(NO_ISSUES)
    expect(rule('S2').check({ path: 'src/platform/logger.ts', text: 'session.append(type, data)' }, new Map())).toEqual(NO_ISSUES)
    expect(check('S2', 'src/domains/a.ts', 'const total = count.append\n')).toEqual(NO_ISSUES)
    expect(check('S3', 'src/a.ts', "// ignorable 自定义事件\nsession.append('context-economy/task-boundary', d) // ignorable:true\n")).toEqual(NO_ISSUES)
    expect(check('S4', 'client/a.ts', "import { Card } from './Card.tsx'\n")).toEqual(NO_ISSUES)
    expect(check('S5', 'client/a.ts', 'setTimeout(tick, 1000)\n')).toEqual(NO_ISSUES)
    expect(check('D1', 'src/a.ts', "ctx.on('session/event', (s, e) => {\n  filter(e)\n})\n")).toEqual(NO_ISSUES)
    expect(check('D1', 'src/a.ts', 'export const x = 1\n')).toEqual(NO_ISSUES)
    expect(check('D2', 'src/a.ts', "ctx.on('agent/pre-step', (p, next) => next())\n// return next() 之上\n")).toEqual(NO_ISSUES)
    expect(check('D2', 'src/a.ts', 'export const x = 1\n')).toEqual(NO_ISSUES)
    expect(rule('D3').check({ path: 'src/platform/ignorable-channel.ts', text: 'setFactMirror(); const v = SESSION_LOG_INTENT; emitFact(s, t, d)' }, new Map())).toEqual(NO_ISSUES)
    expect(rule('D3').check({ path: 'src/platform/logger.ts', text: "import { emitFact, factModeStats } from './ignorable-channel.ts'" }, new Map())).toEqual(NO_ISSUES)
    expect(check('D3', 'src/platform/events.ts', 'export function createEventPump()\n')).toEqual(NO_ISSUES)
    expect(rule('D3').check({ path: 'src/domains/judge-facts.ts', text: 'IgnorableSessionEventMap; IgnorableSessionEventMap' }, new Map())).toEqual(NO_ISSUES)
    expect(rule('D3').check({ path: 'src/domains/optimize-facts.ts', text: 'IgnorableSessionEventMap' }, new Map())).toEqual(NO_ISSUES)
  })
  it('D4：storage 概念只许在 storage.ts 与 index.ts（docs/09 §1）', () => {
    expect(rule('D4').check({ path: 'src/platform/storage.ts', text: "defineDomain({ name: 'x' }); ctx.storageDomain" }, new Map())).toEqual(NO_ISSUES)
    expect(rule('D4').check({ path: 'src/index.ts', text: "ctx.inject(['storageDomain'], ...)" }, new Map())).toEqual(NO_ISSUES)
  })
  it('D5：skill 概念只许在 platform/skills.ts 与 index.ts（docs/10 §1 H13 + docs/11 §2）', () => {
    const skillFile = "import type { SkillSummary } from '@deepseek-ai/dsh-skill'\nctx.skills\n'skills/change'"
    expect(rule('D5').check({ path: 'src/platform/skills.ts', text: skillFile }, new Map())).toEqual(NO_ISSUES)
    expect(rule('D5').check({ path: 'src/index.ts', text: "ctx.skills via wiring" }, new Map())).toEqual(NO_ISSUES)
  })
  it('D6：llm 服务概念只许在 platform/llm.ts（docs/10 §1 H12 + docs/12 §1 C2）', () => {
    const llmFile = "ctx.llm; llm.stream; GenerateOptions; TokenUsage; StreamChunk"
    expect(rule('D6').check({ path: 'src/platform/llm.ts', text: llmFile }, new Map())).toEqual(NO_ISSUES)
    expect(rule('D6').check({ path: 'src/platform/events.ts', text: "import type { ContentBlock } from '@deepseek-ai/dsh-llm'" }, new Map())).toEqual(NO_ISSUES)
  })
  it('D7：history 协议概念只许在 platform/history.ts（docs/10 §1 H4/H5 + docs/11 §2）', () => {
    const historyFile = "import { CompactionId, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'\nsession.append('compaction/start', d)\nsession.append('compaction/prune', d)\nsession.append('compaction/summary', d)"
    expect(rule('D7').check({ path: 'src/platform/history.ts', text: historyFile }, new Map())).toEqual(NO_ISSUES)
  })
  it('D8：工具事件概念只许在 platform/tools.ts；ContentBlock 不拦（docs/10 §1 H6 + docs/13 §3.9）', () => {
    const toolFile = "ctx.on('tools/execute', ...); ctx.on('tools/post-execute', ...)\nPostToolDecision; ToolDispatchExecution; ToolExecution; ToolExecutionResult\nimport type {} from '@deepseek-ai/dsh-tools'"
    expect(rule('D8').check({ path: 'src/platform/tools.ts', text: toolFile }, new Map())).toEqual(NO_ISSUES)
    expect(check('D8', 'src/platform/events.ts', "import type { ContentBlock } from '@deepseek-ai/dsh-llm'\n")).toEqual(NO_ISSUES)
  })
  it('D10：core/shear 纯核无时钟/随机（确定性）', () => {
    expect(check('D10', 'src/core/shear/tool.ts', "export function foldToolShear(events, policy = DEFAULT_SHEAR_POLICY) { return { ops: [], decisions: [] } }\n")).toEqual(NO_ISSUES)
  })
  it('D13：core/compress 纯核无时钟/随机（确定性）', () => {
    expect(check('D13', 'src/core/compress/prompt.ts', "export function renderBoundaryPrompt(input) { return { prompt: '' } }\n")).toEqual(NO_ISSUES)
  })
  it('D9：connection RPC 桥概念只许在 platform/star-bridge.ts 与 index.ts 接线（docs/13 §3.11）', () => {
    const bridgeFile = "connection.rpc.handle('/context-economy', handler)\nimport type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection/src/rpc.ts'"
    expect(rule('D9').check({ path: 'src/platform/star-bridge.ts', text: bridgeFile }, new Map())).toEqual(NO_ISSUES)
    expect(rule('D9').check({ path: 'src/index.ts', text: "ctx.inject(['sessions'], () => {})\nconst connection = bridgeCtx.get('connection')" }, new Map())).toEqual(NO_ISSUES)
    expect(check('D9', 'src/platform/llm.ts', "export const x = 1\n")).toEqual(NO_ISSUES)
  })
})

describe('真实树集成', () => {
  it('collectFiles(仓库根) → runRules → ok === true（vacuous 允许）', () => {
    const result = runRules(collectFiles())
    expect(result.ok).toBe(true)
  })
  it('零位快照：真实树 rules 逐条等于冻结值（P0 立面 + P1 追加；漂移 = 断言面被动过，必须显式过工单）', () => {
    const result = runRules(collectFiles())
    expect(Object.fromEntries(Object.entries(result.rules).map(([id, r]) => [id, r.status]))).toEqual({
      M1: 'pass', M2: 'pass', M3: 'pass', M4: 'pass', M5: 'pass',
      S1: 'pass', S2: 'pass', S3: 'pass', S4: 'pass', S5: 'pass',
      D1: 'pass', D2: 'pass', D3: 'pass', D4: 'pass', D5: 'pass', D6: 'pass', D7: 'pass', D8: 'pass', D9: 'pass', D10: 'pass',
      D11: 'pass', D12: 'pass', D13: 'pass',
    })
  })
  it('确定性：真实树 runRules 跑两遍 JSON.stringify 逐字节相等', () => {
    expect(JSON.stringify(runRules(collectFiles()))).toBe(JSON.stringify(runRules(collectFiles())))
  })
})

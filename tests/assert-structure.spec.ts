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
    expect(check('M1', 'package.json', JSON.stringify({ name: '@dsh-external/dsh-context-economy', version: 'dev' })).length).toBeGreaterThanOrEqual(1)
  })
  it('M2：peerDep 缺键 / 硬编码精确版本 → issue', () => {
    expect(check('M2', 'package.json', JSON.stringify({ peerDependencies: { schemastery: '3.18.0' } })).length).toBeGreaterThanOrEqual(1)
    expect(check('M2', 'package.json', JSON.stringify({ peerDependencies: { '@deepseek-ai/cordis': '>=4 <5', '@deepseek-ai/dsh-settings': '>=0.1.3 <2', schemastery: '^3.18.0', extra: 'x' } }))).toEqual(NO_ISSUES)
  })
  it('M3：patch 指向错误 / 文件集缺 cordis.patch.yml → issue', () => {
    expect(check('M3', 'package.json', JSON.stringify({ dsh: { bundle: { patch: './other.yml' } } })).length).toBeGreaterThanOrEqual(1)
    expect(check('M3', 'package.json', JSON.stringify({ dsh: { bundle: { patch: './cordis.patch.yml' } } }), new Map()).length).toBeGreaterThanOrEqual(1)
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
  it('S2：src 非 history 文件出现改史关键词 → issue', () => {
    expect(check('S2', 'src/foo.ts', "session.append('x', d)\n")).not.toEqual(NO_ISSUES)
    expect(check('S2', 'src/foo.ts', 'const { surfaceOp } = ev\n')).not.toEqual(NO_ISSUES)
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
})

describe('正样本（干净文件 → 0 issue）', () => {
  it('M1–M4：合规 package.json', () => {
    const pkg = JSON.stringify({
      name: '@dsh-external/dsh-context-economy', version: '0.0.1',
      peerDependencies: { '@deepseek-ai/cordis': '>=4 <5', '@deepseek-ai/dsh-settings': '>=0.1.3 <2', schemastery: '^3.18.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: ['react', '@deepseek-ai/dsh-client-ui-slots'] } },
      exports: { './client': { default: './lib/client.js' } },
    })
    for (const id of ['M1', 'M2', 'M3', 'M4']) expect(check(id, 'package.json', pkg, new Map([['cordis.patch.yml', 'y']]))).toEqual(NO_ISSUES)
  })
  it('M5：host/client 各自完整导出面', () => {
    const host = "export const name = 'x'\nexport { Config } from './config.ts'\nexport function apply() {}\n"
    const client = "export const name = 'x'\nexport const inject = []\nexport function apply() {}\n"
    expect(rule('M5').check({ path: 'src/index.ts', text: host }, new Map())).toEqual(NO_ISSUES)
    expect(rule('M5').check({ path: 'client/index.ts', text: client }, new Map())).toEqual(NO_ISSUES)
  })
  it('S1–S5：各自干净文件', () => {
    expect(check('S1', 'src/core/x.ts', "import { fold } from './fold.ts'\nexport type X = { a: number }\n")).toEqual(NO_ISSUES)
    expect(rule('S2').check({ path: 'src/platform/history.ts', text: 'session.append(x, { surfaceOp, sourceEventSeqs })' }, new Map())).toEqual(NO_ISSUES)
    expect(check('S2', 'src/domains/a.ts', 'const total = count.append\n')).toEqual(NO_ISSUES)
    expect(check('S3', 'src/a.ts', "// ignorable 自定义事件\nsession.append('context-economy/task-boundary', d) // ignorable:true\n")).toEqual(NO_ISSUES)
    expect(check('S4', 'client/a.ts', "import { Card } from './Card.tsx'\n")).toEqual(NO_ISSUES)
    expect(check('S5', 'client/a.ts', 'setTimeout(tick, 1000)\n')).toEqual(NO_ISSUES)
  })
})

describe('真实树集成', () => {
  it('collectFiles(仓库根) → runRules → ok === true（vacuous 允许）', () => {
    const result = runRules(collectFiles())
    expect(result.ok).toBe(true)
  })
  it('零位快照：真实树 rules 逐条等于 P0 §3.2-4 冻结值（漂移 = 断言面被动过，必须显式过工单）', () => {
    const result = runRules(collectFiles())
    expect(Object.fromEntries(Object.entries(result.rules).map(([id, r]) => [id, r.status]))).toEqual({
      M1: 'pass', M2: 'pass', M3: 'pass', M4: 'pass', M5: 'pass',
      S1: 'vacuous', S2: 'pass', S3: 'pass', S4: 'pass', S5: 'pass',
    })
  })
  it('确定性：真实树 runRules 跑两遍 JSON.stringify 逐字节相等', () => {
    expect(JSON.stringify(runRules(collectFiles()))).toBe(JSON.stringify(runRules(collectFiles())))
  })
})

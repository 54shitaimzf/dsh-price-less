#!/usr/bin/env node
/**
 * P21b 验收（docs/implement/P21b-full-chain.md §5）。
 * ① 文件齐备；② 纯核面引用；③ 结构/缺陷修正标记；④ 四触发次序闭合表（边→边/边→压/压→边/压→压）；
 * ⑤ 四道缓存断言（10 §6）实跑；⑥ R4 出门门槛汇总（P15a–P21a 全部 verify 脚本）；
 * ⑦ spec 标记；⑧ 文档同步标记；⑨ 尺寸申报。
 * 纯回放：只读本地缓存 + 子进程跑既有 verify（无网络、无模型）。需先 build（import ../lib）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  COMPRESS_BOUNDARY_HEAD,
  COMPRESS_BOUNDARY_OUTPUT,
  COMPRESS_BOUNDARY_RULES,
  TAIL_CONSUME_OPS,
  appendArchiveEntry,
  emptyArchiveStore,
  planTailConsumption,
  renderBoundaryPrompt,
  renderRegionTranscript,
} from '../lib/core/compress/index.js'
import { DEFAULT_ASSEMBLE_POLICY, archiveChainAppendOnly, archiveChainShape, truncateArchiveArea } from '../lib/core/assemble/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checks = []
const failures = []
const check = (name, ok, detail = '') => {
  checks.push(name)
  if (ok) { console.log('PASS ' + name); return }
  failures.push(name)
  console.log('FAIL ' + name + (detail === '' ? '' : ' — ' + detail))
}
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return a.slice(0, i) }

// ① 文件齐备
const FILES = [
  'docs/implement/P21b-full-chain.md',
  'tests/full-chain-order.spec.ts', 'tests/cache-invariants.spec.ts',
]
const missing = FILES.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
check('文件齐备（工单 + 两个 CI 用例文件）', missing.length === 0, missing.join(','))

// ② 纯核面引用
check('四触发次序闭合表可导入（planTailConsumption + TAIL_CONSUME_OPS）',
  typeof planTailConsumption === 'function' && JSON.stringify(TAIL_CONSUME_OPS) === JSON.stringify({ checkpoint: 'continue', boundary: 'continue', material: 'fold' }))
check('档案链校验器可导入（archiveChainShape / archiveChainAppendOnly / truncateArchiveArea）',
  typeof archiveChainShape === 'function' && typeof archiveChainAppendOnly === 'function' && typeof truncateArchiveArea === 'function')

// ③ 结构 / 缺陷修正标记
const domainText = readText('src/domains/compaction.ts')
check('边界区间起点缺陷修正在位（起点须同时 seq < nextStartSeq）',
  /seq >= \(segment\.startSeq \?\? 0\) && seq < nextStartSeq/.test(domainText) && /多闭合段积压/.test(domainText))
const orderSpec = readText('tests/full-chain-order.spec.ts')
check('回归用例在位（积压多闭合段 → 逐次各压一个，rangeSkips = 0）',
  orderSpec.includes('积压多闭合段') && /rangeSkips\)\.toBe\(0\)/.test(orderSpec))
const cacheSpec = readText('tests/cache-invariants.spec.ts')
check('四道缓存断言用例在位（前缀 / 逐字节 / 模板前缀 / 只追加）',
  cacheSpec.includes('断言 1') && cacheSpec.includes('断言 2') && cacheSpec.includes('断言 3') && cacheSpec.includes('断言 4'))

// ④ 四触发次序闭合表
const chain = (kind) => [{ taskId: 't', kind, text: kind === 'checkpoint' ? 'C1' : 'D' }]
check('边→边：空链 + boundary → single / carry 0 / append boundary / 不折材料',
  JSON.stringify(planTailConsumption({ priorChain: [], layer: 'boundary' })) === JSON.stringify({ ok: true, form: 'single', carryCount: 0, appendKind: 'boundary', foldMaterial: false }))
check('边→压：boundary 链 + pressure → chain / carry 1 / append checkpoint / 折材料',
  JSON.stringify(planTailConsumption({ priorChain: chain('boundary'), layer: 'pressure' })) === JSON.stringify({ ok: true, form: 'chain', carryCount: 1, appendKind: 'checkpoint', foldMaterial: true }))
check('压→边：checkpoint 链 + boundary → chain / carry 1 / append boundary / 不折材料',
  JSON.stringify(planTailConsumption({ priorChain: chain('checkpoint'), layer: 'boundary' })) === JSON.stringify({ ok: true, form: 'chain', carryCount: 1, appendKind: 'boundary', foldMaterial: false }))
check('压→压：checkpoint 链 + pressure → chain / carry 1 / append checkpoint / 折材料',
  JSON.stringify(planTailConsumption({ priorChain: chain('checkpoint'), layer: 'pressure' })) === JSON.stringify({ ok: true, form: 'chain', carryCount: 1, appendKind: 'checkpoint', foldMaterial: true }))
check('非法链形态（跨 task）→ ok:false chain-invalid',
  JSON.stringify(planTailConsumption({ priorChain: [{ taskId: 'a', kind: 'checkpoint', text: 'C' }, { taskId: 'b', kind: 'boundary', text: 'D' }], layer: 'pressure' })) === JSON.stringify({ ok: false, reason: 'chain-invalid' }))

// ⑤ 四道缓存断言（纯函数实跑）
const events = [
  { type: 'user/message', seq: 0, time: 0, data: { content: [{ type: 'text', text: 'A' }] }, surfaceOp: 'append' },
  { type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'tool-call', toolCallId: 'c1', name: 'read', arguments: '{}' }] } }, surfaceOp: 'append' },
  { type: 'tool/result', seq: 2, time: 2, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '1: line' }] }] } }, surfaceOp: 'append' },
]
let prefixOk = true
for (let k = 0; k < events.length - 1; k++) {
  const prev = renderRegionTranscript(events, { startSeq: 0, endSeq: k })
  const next = renderRegionTranscript(events, { startSeq: 0, endSeq: k + 1 })
  if (!next.startsWith(prev)) prefixOk = false
}
check('断言 1：本轮请求 = 上轮请求 + 新增段（前缀性质）', prefixOk)
const entry = { taskId: 't', kind: 'boundary', text: 'S' }
check('断言 2：同版本逐字节一致（档案追加 / prompt 渲染双跑全等）',
  JSON.stringify(appendArchiveEntry(emptyArchiveStore('w'), entry).body) === JSON.stringify(appendArchiveEntry(emptyArchiveStore('w'), entry).body) &&
  renderBoundaryPrompt({ regionText: 'R', units: [] }).prompt === renderBoundaryPrompt({ regionText: 'R', units: [] }).prompt)
const template = [COMPRESS_BOUNDARY_HEAD, COMPRESS_BOUNDARY_RULES, COMPRESS_BOUNDARY_OUTPUT].join('\n\n')
const pa = renderBoundaryPrompt({ regionText: 'REGION-ALPHA'.repeat(8), units: [] })
const pb = renderBoundaryPrompt({ regionText: 'REGION-BETA'.repeat(8), units: [] })
check('断言 3：同 purpose 辅助调用共享模板前缀（实例正文不在前缀内）',
  commonPrefix(pa.prompt, pb.prompt).length >= template.length && !commonPrefix(pa.prompt, pb.prompt).includes('REGION-ALPHA'))
const e1 = { taskId: 't', kind: 'checkpoint', text: 'C1' }
const e2 = { taskId: 't', kind: 'boundary', text: 'D' }
const r1 = appendArchiveEntry(emptyArchiveStore('w'), e1)
const r2 = appendArchiveEntry(r1.body, e2)
const policy = { ...DEFAULT_ASSEMBLE_POLICY, archiveTokens: 45 }
const big = [entry, entry, entry].map((item, i) => ({ ...item, text: 'x'.repeat(60) + i }))
const trunc = truncateArchiveArea(big, policy)
check('断言 4：档案堆只追加（既有条目字节不变 + 硬帽整条截断 + 两形态可校验）',
  JSON.stringify(r2.body.entries[0]) === JSON.stringify(r1.body.entries[0]) &&
  archiveChainAppendOnly(r1.body.entries, r2.body.entries) && archiveChainShape(r2.body.entries).shape === 'chain' &&
  trunc.kept.length === 1 && trunc.truncated.count === 2 && JSON.stringify(trunc.kept[0]) === JSON.stringify(big[2]))

// ⑥ CI 用例实跑
let vitestOk = false
let vitestDetail = ''
try {
  const out = execSync('npx vitest run tests/cache-invariants.spec.ts tests/full-chain-order.spec.ts --pool=threads', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  vitestOk = /Tests\s+\d+ passed/.test(out) && !/failed/.test(out)
  vitestDetail = (out.match(/Tests\s+.*/) ?? [''])[0]
} catch (e) {
  vitestDetail = e instanceof Error ? e.message.slice(0, 200) : String(e)
}
check('CI 用例实跑：cache-invariants + full-chain-order 全过（gate 内）', vitestOk, vitestDetail)

// ⑦ R4 出门门槛汇总（子进程跑既有 verify）
const VERIFIES = ['verify-p15a', 'verify-p15b', 'verify-p16', 'verify-p17', 'verify-p18', 'verify-p19', 'verify-p20', 'verify-p21a']
const verifyResults = []
for (const name of VERIFIES) {
  try {
    const out = execSync('node scripts/' + name + '.mjs', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    verifyResults.push([name, /VERIFY PASS/.test(out), (out.match(/VERIFY PASS \([^)]*\)/) ?? [''])[0]])
  } catch (e) {
    const stdout = e && typeof e === 'object' && 'stdout' in e ? String(e.stdout ?? '') : ''
    verifyResults.push([name, false, stdout.split('\n').filter(Boolean).at(-1) ?? 'exit'])
  }
}
check('R4 出门门槛：P15a–P21a 全部 verify 脚本 PASS（' + VERIFIES.length + ' 个）',
  verifyResults.every(([, ok]) => ok), verifyResults.filter(([, ok]) => !ok).map(([name]) => name).join(','))
for (const [name, ok, detail] of verifyResults) console.log('  · ' + name + ' → ' + (ok ? 'PASS ' : 'FAIL ') + detail)

// ⑧ spec 标记
const specMarkers = [
  ['tests/full-chain-order.spec.ts', 'planTailConsumption'],
  ['tests/full-chain-order.spec.ts', '边→压'],
  ['tests/full-chain-order.spec.ts', '压→边'],
  ['tests/cache-invariants.spec.ts', 'renderRegionTranscript'],
  ['tests/cache-invariants.spec.ts', 'archiveChainAppendOnly'],
]
check('spec 标记齐全（四次序 + 四断言主面）', specMarkers.every(([rel, token]) => readText(rel).includes(token)))

// ⑨ 文档同步标记
const master = readText('docs/implement/00-master.md')
check('总纲 P21b 行 + 施工记录 + R4 关门声明在位',
  /\| P21b \|/.test(master) && /P21b 施工记录/.test(master) && /R4 关门/.test(master))
check('设计文档状态行同步（11 §8 R4 出门门槛勾选）',
  /P21b/.test(readText('docs/11-structure.md')) && /\[x\] .*恢复演练/.test(readText('docs/11-structure.md')))
check('AGENTS 现状 + 账本快照 §50 在位',
  /P21b/.test(readText('AGENTS.md')) && /§50/.test(readText('docs/ledger-history.md')))

// ⑩ 尺寸申报
const workorder = readText('docs/implement/P21b-full-chain.md')
check('工单含尺寸实测申报（§6.5）', /尺寸申报/.test(workorder) && workorder.includes('tests/'))

console.log('')
if (failures.length === 0) {
  console.log('P21b VERIFY PASS (' + checks.length + ' checks)')
  process.exit(0)
}
console.log('P21b VERIFY FAIL (' + failures.length + '/' + checks.length + ')')
for (const name of failures) console.log('  - ' + name)
process.exit(1)

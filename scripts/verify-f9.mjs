#!/usr/bin/env node
/**
 * F9 验收（F10 起契约 v3 修订：总分零指针 + 热尾指向档案 + 档案只存总分 + 错误不进热尾）。
 * ① 模块面可导入；② 宽松解析/归一化；③ 产物装配判据（总述/分步零指针/热尾/份额帽/配额丢弃）；
 * ④ 热尾事实载体（消息单元 + tool-call 转写 + Zipf + fact 子串）；⑤ 存储 v1→v2 + 单调守卫；
 * ⑥ 区间守卫回归标记；⑦ 产物体量对照（档案正文 vs 热尾分列）。
 * 纯回放：无网络、无模型；需先 build（import ../lib）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ASSEMBLE_POLICY,
  archiveChainMonotone,
  assembleArchive,
  foldAssembleInputs,
  foldFileChains,
  normalizeDigest,
  normalizeRoot,
  relativePath,
} from '../lib/core/assemble/index.js'
import {
  ARCHIVE_STORE_VERSION,
  appendArchiveEntry,
  emptyArchiveStore,
  isArchiveStoreVersion,
  readArchiveStore,
  scanFacts,
} from '../lib/core/compress/index.js'
import { flatDensity } from '../lib/core/meter/index.js'

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

const policy = (over = {}) => ({
  ...DEFAULT_ASSEMBLE_POLICY,
  density: flatDensity(1),
  hotTailTokens: 1000,
  pointerOverheadTokens: 0,
  minTruncatedChars: 5,
  ...over,
})
const unit = (id, seqStart, text, extra = {}) => ({
  id, kind: 'tool-pair', seqStart, seqEnd: seqStart + 1, text, tokens: text.length, ...extra,
})

// ① 模块面
check('F10 模块面可导入（paths / 装配 / 存储）',
  [normalizeRoot, relativePath, assembleArchive, normalizeDigest,
    archiveChainMonotone, isArchiveStoreVersion, readArchiveStore, appendArchiveEntry, scanFacts]
    .every((fn) => typeof fn === 'function'))

// ② 宽松解析 / 归一化（refs 机械剥离）
const repaired = normalizeDigest({ gist: 42, steps: [{ type: 'bogus', text: 'x' }, { type: 'plan', text: 'ok', refs: [0, 1, '2', 2] }, 'junk'] })
check('F10 宽松归一化：坏形状机械修复（未知 type→note / refs 剥离）',
  repaired.digest.gist === '' && repaired.digest.steps.length === 2
  && repaired.digest.steps[0].type === 'note' && repaired.digest.steps[1].refs === undefined
  && repaired.stepDrops === 1)

// ③ 产物装配判据
const regionTokens = 2000
const built = assembleArchive({
  units: [
    unit('big', 1, 'X'.repeat(4000), { isRunResult: true }),
    unit('verify', 5, 'run summary\n307 tests passed', { isVerification: true }),
    unit('file', 9, 'src line', { path: 'D:/proj/src/a.ts', version: 1 }),
    unit('file2', 13, 'src line 2', { path: 'D:/proj/src/a.ts', version: 1 }),
  ],
  root: 'D:/proj',
  rootKind: 'session',
  regionTokens,
  digest: {
    gist: '收敛上下文压缩产物结构',
    steps: [
      { type: 'plan', text: '先重写产物契约' },
      { type: 'verify', text: '再跑门禁确认' },
    ],
  },
  chains: foldFileChains([{ seq: 9, path: 'D:/proj/src/a.ts', kind: 'write', content: 'src line' }]),
  resolve: { file: 'src line', file2: 'src line 2' },
  hotTail: [
    { unitId: 'big' },
    { unitId: 'verify', fact: '307 tests passed' },
    { unitId: 'file', coord: { path: 'D:/proj/src/a.ts', version: 1, lineRange: { start: 1, end: 1 } } },
    { unitId: 'file2', coord: { path: 'D:/proj/src/a.ts', version: 1 } },
  ],
  policy: policy({ hotTailTokens: 10000 }),
})
const okBuilt = built.ok === true
check('F10 产物渲染：总述 + 分步（零指针）+ 热尾指向档案',
  okBuilt && built.result.rendered.includes('【总述】收敛上下文压缩产物结构')
  && built.result.rendered.includes('【计划】先重写产物契约')
  && !built.result.rendered.includes('(▸')
  && built.result.rendered.includes('【热尾｜档案 v1】')
  && !built.result.rendered.includes('[文件]') && !built.result.rendered.includes('【路径】')
  && built.result.hotTail.entries.length === 4
  && built.result.hotTail.archiveRef === 'v1')
check('F10 档案正文仅总分：零事实（路径 / 验证串不进档案）',
  okBuilt && built.result.digestText.includes('【总述】收敛上下文压缩产物结构')
  && !built.result.digestText.includes('src/a.ts')
  && !built.result.digestText.includes('307 tests passed')
  && built.result.digestPlan.factLeaks === 0)
const dirty = assembleArchive({
  units: [unit('a', 1, 'x')],
  digest: { gist: '改 D:/proj/src/a.ts 到 v2', steps: [] },
  hotTail: [{ unitId: 'a' }],
  policy: policy(),
})
check('F10 事实泄漏只记账不拒单（脏 gist → factLeaks > 0 且产物照常）',
  dirty.ok === true && dirty.result.digestPlan.factLeaks > 0)
check('F10c 份额帽：热尾预算落在 [minShare, maxShare] × 区间 内且未超支',
  okBuilt
  && built.result.hotTail.budgetTokens >= Math.ceil(regionTokens * DEFAULT_ASSEMBLE_POLICY.hotTailMinShare)
  && built.result.hotTail.budgetTokens <= Math.ceil(regionTokens * DEFAULT_ASSEMBLE_POLICY.hotTailMaxShare)
  && built.result.hotTail.tokens <= built.result.hotTail.budgetTokens)
check('F10c Zipf 分配：重要者多分（首条 > 次条 > 末条）',
  okBuilt && built.result.hotTail.entries[0].tokens > built.result.hotTail.entries[1].tokens
  && built.result.hotTail.entries[1].tokens > built.result.hotTail.entries[2].tokens)
const quota = assembleArchive({
  units: [unit('a', 1, 'A'.repeat(200))],
  hotTail: [{ unitId: 'a' }],
  policy: policy({ hotTailTokens: 10, minTruncatedChars: 20 }),
})
check('F10c 配额不足 → 丢弃（quotaDrops 计数；不再产空指针条目）',
  quota.ok === true && quota.result.hotTail.quotaDrops === 1 && quota.result.hotTail.entries.length === 0)
const errored = assembleArchive({
  units: [unit('e', 1, 'boom\n[exit code: 1]', { isError: true })],
  hotTail: [{ unitId: 'e' }],
  policy: policy(),
})
check('F10b 错误信息不进热尾（error 归因 + 零条目）',
  errored.ok === true && errored.result.hotTail.entries.length === 0
  && errored.result.hotTail.dropReasons.error === 1)
check('F10c fact 子串校验：命中并入内容；未命中丢弃计数',
  okBuilt && built.result.hotTail.entries[1].text.includes('307 tests passed')
  && built.result.hotTail.dropReasons.factReject === 0)

// ④ 消息单元 + tool-call 转写
const folded = foldAssembleInputs([
  { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '约束：不得改 X' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 1, time: 2, data: { message: { content: [{ type: 'text', text: '结论' }, { type: 'tool-call', toolCallId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' }] } } },
  { type: 'user/message', seq: 2, time: 3, data: { content: [{ type: 'text', text: 'C1' }], source: { kind: 'plugin', plugin: 'compact' } } },
])
check('F10c 消息单元：user/assistant 成单元（插件检查点排除）+ tool-call 块转写',
  folded.units.length === 2
  && folded.units[0].kind === 'message' && folded.units[0].text === '约束：不得改 X'
  && folded.units[1].text.includes('[tool-call] bash {"command":"npm test"}'))

// ⑤ 存储 v1→v2 + 单调守卫
const migrated = readArchiveStore({
  schemaVersion: 1, workspace: 'w',
  entries: [{ taskId: 't1', kind: 'boundary', text: '旧档案' }],
  cache: { k1: { key: 'k1', at: 1, layer: 'boundary', product: { mode: 'boundary', digest: { gist: '', steps: [] }, hotTail: [] } } },
}, 'w')
check('F10d 存储 v1→v2：条目保留 / 旧产物缓存丢弃',
  migrated.schemaVersion === ARCHIVE_STORE_VERSION && migrated.entries.length === 1
  && Object.keys(migrated.cache).length === 0 && isArchiveStoreVersion(1) && isArchiveStoreVersion(2))
const cp = (text) => ({ taskId: 't1', kind: 'checkpoint', text })
const bd = (text) => ({ taskId: 't1', kind: 'boundary', text })
check('F10d 单调追加守卫：截断+追加合法；改写幸存条目违规',
  archiveChainMonotone([cp('c1')], [cp('c1'), bd('d')])
  && archiveChainMonotone([cp('c1'), cp('c2')], [cp('c2'), bd('d')])
  && !archiveChainMonotone([cp('c1'), cp('c2')], [cp('c1'), cp('c2x'), bd('d')]))
const over = appendArchiveEntry(emptyArchiveStore('w'), { ...bd('x'.repeat(80)), layer: 'boundary', at: 1 }, { ...DEFAULT_ASSEMBLE_POLICY, density: flatDensity(1), archiveTokens: 30 })
check('F10d overCap 入账（单条超帽保最新 + 标记）', over.overCap === true && over.kept === 1)

// ⑥ 区间守卫回归标记
const domainText = readText('src/domains/compaction.ts')
check('F9a 区间守卫在位（两路径 surfaceNodes + balanceRange；缝越界跳过）',
  (domainText.match(/history\.balanceRange\(/g) ?? []).length >= 2
  && (domainText.match(/history\.surfaceNodes\(\)/g) ?? []).length >= 2
  && /cutSeq < replaceStart \|\| cutSeq > replaceEnd/.test(domainText))
check('F10 档案落盘只存总分（compaction 两处 append 用 digestText）',
  (domainText.match(/text: (outcome\.result|chosen!)\.digestText/g) ?? []).length === 2)

// ⑦ 产物体量对照（档案正文 vs 热尾分列）
const summaryTokens = okBuilt ? built.result.digestPlan.tokens : 0
const hotTailTokens = okBuilt ? built.result.hotTail.tokens : 0
const productTokens = okBuilt ? Math.ceil(built.result.rendered.length / 1.5) : 0
console.log('')
console.log('| 口径 | 真机缺陷产物 | F10 合成夹具 |')
console.log('|---|---|---|')
console.log('| 档案正文 est | 1,512 | ' + summaryTokens + ' |')
console.log('| 热尾 est | 6,697 | ' + hotTailTokens + ' |')
console.log('| 产物 est | 8,209 | ' + productTokens + ' |')
console.log('| 事实泄漏 | 未观测 | ' + (okBuilt ? built.result.digestPlan.factLeaks : 0) + ' |')
console.log('')
console.log('checks = ' + checks.length + ' / failures = ' + failures.length)
if (failures.length > 0) {
  console.log('FAILED: ' + failures.join(' | '))
  process.exit(1)
}
console.log('ok=true')

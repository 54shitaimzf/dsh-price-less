#!/usr/bin/env node
/**
 * P12 自动化验收（docs/implement/archive/P12-input.md §3.10）。
 * 轻量模式：一次完整 gate + P10/P8/P9 专项 grep + P12 专项扫描。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const fail = (msg) => { failures.push(msg); console.log('FAIL ' + msg) }
const note = (msg) => console.log(msg)
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', ...opts })
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const exists = (p) => fs.existsSync(path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) ? p : path.join(ROOT, p))
const count = (p) => { try { return read(p).split('\n').length - 1 } catch { return 0 } }

// 1. P10/P8/P9 专项门
const judge = read('src/core/judge.ts')
const units = read('src/core/units.ts')
const dossier = read('src/core/dossier.ts')
for (const name of ['matchL0Continue', 'judgeL1CacheKey', 'renderJudgePrompt', 'parseJudgeLlmOutput', 'foldJudgeLedger']) {
  if (!judge.includes(name)) fail('P10 missing ' + name)
}
if (!units.includes('foldSegmentState')) fail('P8 missing foldSegmentState')
for (const name of ['dossierStorageKey', 'appendDossierMessage', 'annotateDossier']) {
  if (!dossier.includes(name)) fail('P9 missing ' + name)
}

// 2. build（有 checkout 则构建；缺 checkout 记录 SKIP 继续）
const checkout = process.env.DSH_CHECKOUT || 'G:/deepseek-harness'
if (exists(path.join(checkout, 'packages'))) {
  const build = run('npm', ['run', 'build'], { env: { ...process.env, DSH_CHECKOUT: checkout } })
  if (build.status !== 0) fail('npm run build failed')
  else note('build ran with DSH_CHECKOUT=' + checkout)
} else {
  note('SKIP build (checkout missing)')
}

// 3. 一次完整门禁
for (const script of ['gate', 'typecheck:tests']) {
  const r = run('npm', ['run', script])
  if (r.status !== 0) fail('npm run ' + script + ' failed')
}

// 4. 断言确定性
const a1 = run('node', ['scripts/assert-structure.mjs', '--json'])
const a2 = run('node', ['scripts/assert-structure.mjs', '--json'])
if (a1.status !== 0 || a2.status !== 0) fail('assert-structure --json failed')
else if (a1.stdout !== a2.stdout) fail('assert-structure --json not byte-stable')

// 5. 反向扫描
const t0 = read('src/core/t0.ts')
const input = read('src/domains/input.ts')
const configText = read('src/config.ts')
for (const re of [/@deepseek-ai\//, /from\s+['"]cordis/, /platform\//, /ctx\./, /session\.append/, /context-economy\//]) {
  if (re.test(t0)) fail(`src/core/t0.ts contains forbidden ${re}`)
}
for (const re of [/session\.append/, /ctx\.on\('session\/event'/, /setInterval\(/, /fetch\(/, /http\.get/, /axios/]) {
  if (re.test(input)) fail(`src/domains/input.ts contains forbidden ${re}`)
}
if (/observe|discriminator\.mode/.test(configText)) fail('src/config.ts contains observe or discriminator.mode')

// 6. 正向扫描
const judgeFacts = read('src/domains/judge-facts.ts')
const fieldModel = read('client/field-model.ts')
const indexText = read('src/index.ts')
const inputSpec = read('tests/input.spec.ts')
const positive = [
  ['mountAutoDiscriminator in input', () => /mountAutoDiscriminator/.test(input)],
  ['readJudgeTable in input', () => /readJudgeTable/.test(input)],
  ['parseT0Command in input', () => /parseT0Command/.test(input)],
  ['judgeL1CacheKey in input', () => /judgeL1CacheKey/.test(input)],
  ['matchL0Continue in input', () => /matchL0Continue/.test(input)],
  ['renderJudgePrompt in input', () => /renderJudgePrompt/.test(input)],
  ['streamCeLlm in input', () => /streamCeLlm/.test(input)],
  ['emitCeFact in input', () => /emitCeFact/.test(input)],
  ['factsBySession in input', () => /factsBySession/.test(input)],
  ['recordFact in input', () => /recordFact/.test(input)],
  ['firstSeqBySession in input', () => /firstSeqBySession/.test(input)],
  ['JUDGE_RECORDED_FACT_TYPE in judge-facts', () => /JUDGE_RECORDED_FACT_TYPE/.test(judgeFacts)],
  ['JUDGE_ERROR_FACT_TYPE in judge-facts', () => /JUDGE_ERROR_FACT_TYPE/.test(judgeFacts)],
  ['JUDGE_VERDICT_FACT_TYPE in judge-facts', () => /JUDGE_VERDICT_FACT_TYPE/.test(judgeFacts)],
  ['IgnorableSessionEventMap in judge-facts', () => /IgnorableSessionEventMap/.test(judgeFacts)],
  ['auto z.boolean in config', () => /auto:\s*z\.boolean\(\)/.test(configText)],
  ['discriminator.auto in field-model', () => /discriminator\.auto/.test(fieldModel)],
  ['mountAutoDiscriminator in index', () => /mountAutoDiscriminator/.test(indexText)],
  ["ctx.inject(['llm'] in index", () => /ctx\.inject\(\['llm'\]/.test(indexText)],
  ["describe('auto discriminator in input.spec", () => /describe\('auto discriminator/.test(inputSpec)],
]
for (const [label, ok] of positive) if (!ok()) fail('missing positive: ' + label)

// 7. 事实声明双侧编译闸抽查
const idx = judgeFacts.indexOf('IgnorableSessionEventMap')
if (idx < 0 || !judgeFacts.slice(idx, idx + 500).includes('judge-recorded') || !judgeFacts.slice(idx, idx + 500).includes('judge-error') || !judgeFacts.slice(idx, idx + 500).includes('judge-verdict')) {
  fail('judge-facts declaration window incomplete')
}

// 8. lib 新鲜度检查
if (!exists('lib/index.js')) fail('lib/index.js missing')
else {
  const lib = read('lib/index.js')
  if (/export const inject = \['skills'\]/.test(lib)) fail('stale lib/index.js: hard-requires skills')
  if (!/ctx\.inject\(\['skills'\]/.test(lib)) fail('stale lib/index.js: missing dynamic ctx.inject([\'skills\'])')
  if (!/mountAutoDiscriminator|discriminator\.auto/.test(lib)) fail('stale lib/index.js: missing P12 symbols')
}

// 9. 行数预算/净增
const budgets = [
  ['src/core/t0.ts', 60],
  ['src/domains/judge-facts.ts', 120],
  ['src/domains/input.ts', 340],
  ['tests/input.spec.ts', 360],
  ['scripts/verify-p12.mjs', 160],
]
for (const [f, limit] of budgets) if (count(f) > limit) fail(`${f} lines ${count(f)} > ${limit}`)
for (const f of ['src/index.ts', 'src/platform/events.ts', 'src/config.ts', 'client/field-model.ts']) {
  const d = run('git', ['diff', '--numstat', '--', f])
  if (d.status === 0 && d.stdout.trim()) {
    const parts = d.stdout.trim().split(/\s+/)
    const added = Number(parts[0] ?? 0)
    const deleted = Number(parts[1] ?? 0)
    const net = added - deleted
    const limit = f === 'src/index.ts' ? 35 : f === 'src/platform/events.ts' ? 30 : f === 'src/config.ts' ? 15 : 20
    if (net > limit) fail(`${f} net +${net} > ${limit}`)
  }
}

if (failures.length === 0) {
  console.log('P12 VERIFY PASS')
  process.exit(0)
} else {
  console.log('P12 VERIFY FAIL')
  process.exit(1)
}

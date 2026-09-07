#!/usr/bin/env node
/**
 * P10 自动化验收（docs/implement/P10-judge.md §3.3）。
 * 轻量模式：一次完整 gate + P9 专项 grep + P10 专项扫描，不重跑 verify-p9 全量。
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
const count = (p) => read(p).split('\n').length - 1

// 1. P9 专项门（轻量）
const dossier = read('src/core/dossier.ts')
for (const name of ['dossierStorageKey', 'appendDossierMessage', 'backfillDossier', 'foldDossierLedger', 'isDossierShort']) {
  if (!dossier.includes(name)) fail('P9 missing ' + name)
}
if (!read('tests/dossier.spec.ts').includes("describe('dossier")) fail('P9 dossier spec missing describe')

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

// 4. 断言确定性（双跑 diff）
const a1 = run('node', ['scripts/assert-structure.mjs', '--json'])
const a2 = run('node', ['scripts/assert-structure.mjs', '--json'])
if (a1.status !== 0 || a2.status !== 0) fail('assert-structure --json failed')
else if (a1.stdout !== a2.stdout) fail('assert-structure --json not byte-stable')

// 5. core/judge.ts 反向扫描（期望 0 命中）
const judge = read('src/core/judge.ts')
for (const re of [/@deepseek-ai\//, /from\s+['"]cordis/, /platform\//, /ctx\./, /session\.append/, /setInterval\(/, /emitCeFact/, /fetch\(/, /http\.get/, /axios/]) {
  if (re.test(judge)) fail(`src/core/judge.ts contains forbidden ${re}`)
}

// 6. src/index.ts 零改动复查
const diff = run('git', ['diff', '--numstat', '--', 'src/index.ts'])
if (diff.status === 0 && diff.stdout.trim()) {
  const added = Number(diff.stdout.trim().split(/\s+/)[0] ?? 0)
  if (added !== 0) fail('src/index.ts must have zero net changes')
}

// 7. 正向扫描（期望 ≥1 命中）
const positive = [
  ['matchL0Continue in judge', () => /matchL0Continue/.test(judge)],
  ['judgeL1CacheKey in judge', () => /judgeL1CacheKey/.test(judge)],
  ['matchJudgeTable in judge', () => /matchJudgeTable/.test(judge)],
  ['renderJudgePrompt in judge', () => /renderJudgePrompt/.test(judge)],
  ['parseJudgeLlmOutput in judge', () => /parseJudgeLlmOutput/.test(judge)],
  ['foldJudgeLedger in judge', () => /foldJudgeLedger/.test(judge)],
  ['JUDGE_PROMPT_RULES_CLAUSES in judge', () => /JUDGE_PROMPT_RULES_CLAUSES/.test(judge)],
  ["describe('judge' in spec", () => /describe\('judge/.test(read('tests/judge.spec.ts'))],
  ['tests/judge.spec.ts in tsconfig.tests', () => read('tsconfig.tests.json').includes('tests/judge.spec.ts')],
]
for (const [label, ok] of positive) if (!ok()) fail('missing positive: ' + label)

// 8. datasets 同源抽查
const sameSource = run('node', ['--input-type=module', '-e', `
import fs from 'node:fs'
import { JUDGE_PROMPT_RULES_CLAUSES } from './src/core/judge.ts'
const p = fs.readFileSync('datasets/prompt-discriminator-v2.2.txt', 'utf8')
const s = p.slice(p.indexOf('先决排除：'), p.indexOf('\\n\\n<anchor>'))
if (JUDGE_PROMPT_RULES_CLAUSES !== s) process.exit(1)
`], { shell: false })
if (sameSource.status !== 0) fail('datasets same-source check failed')

// 9. lib 新鲜度检查
if (!exists('lib/index.js')) {
  fail('lib/index.js missing')
} else {
  const lib = read('lib/index.js')
  if (/export const inject = \['skills'\]/.test(lib)) fail('stale lib/index.js: hard-requires skills')
  if (!/ctx\.inject\(\['skills'\]/.test(lib)) fail('stale lib/index.js: missing dynamic ctx.inject([\'skills\'])')
}

// 10. 行数预算
const budgets = [
  ['src/core/judge.ts', 280],
  ['tests/judge.spec.ts', 300],
  ['scripts/verify-p10.mjs', 140],
]
for (const [f, limit] of budgets) if (count(f) > limit) fail(`${f} lines ${count(f)} > ${limit}`)

if (failures.length === 0) {
  console.log('P10 VERIFY PASS')
  process.exit(0)
} else {
  console.log('P10 VERIFY FAIL')
  process.exit(1)
}

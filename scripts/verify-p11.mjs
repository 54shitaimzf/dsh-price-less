#!/usr/bin/env node
/**
 * P11 自动化验收（docs/implement/P11-optimize.md §3.3）。
 * 轻量模式：一次完整 gate + P8/P9 专项 grep + P11 专项扫描，不重跑 verify-p8/p9/p10 全量。
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

// 1. P8/P9 专项门（轻量）
const prefix = read('src/core/prefix.ts')
const dossier = read('src/core/dossier.ts')
for (const name of ['renderStablePrefix', 'normalizeSkillCatalog']) if (!prefix.includes(name)) fail('P8 missing ' + name)
for (const name of ['isDossierShort', 'foldDossierLedger', 'backfillDossier']) if (!dossier.includes(name)) fail('P9 missing ' + name)
if (!read('tests/prefix.spec.ts').includes("describe('renderStablePrefix")) fail('P8 prefix spec missing describe')
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

// 5. core/optimize.ts 反向扫描（期望 0 命中）
const optimize = read('src/core/optimize.ts')
for (const re of [/@deepseek-ai\//, /from\s+['"]cordis/, /platform\//, /ctx\./, /session\.append/, /setInterval\(/, /emitCeFact/, /context-economy\//, /fetch\(/, /http\.get/, /axios/]) {
  if (re.test(optimize)) fail(`src/core/optimize.ts contains forbidden ${re}`)
}

// 6. src/index.ts 零改动复查
const diff = run('git', ['diff', '--numstat', '--', 'src/index.ts'])
if (diff.status === 0 && diff.stdout.trim()) {
  const added = Number(diff.stdout.trim().split(/\s+/)[0] ?? 0)
  if (added !== 0) fail('src/index.ts must have zero net changes')
}

// 7. 正向扫描（期望 ≥1 命中）
const positive = [
  ['renderOptimizePrompt in optimize', () => /renderOptimizePrompt/.test(optimize)],
  ['parseOptimizeOutput in optimize', () => /parseOptimizeOutput/.test(optimize)],
  ['foldOptimizeLedger in optimize', () => /foldOptimizeLedger/.test(optimize)],
  ['extractAuthorityCandidates in optimize', () => /extractAuthorityCandidates/.test(optimize)],
  ['checkAuthoritySpans in optimize', () => /checkAuthoritySpans/.test(optimize)],
  ['validateSkillName in optimize', () => /validateSkillName/.test(optimize)],
  ["describe('optimize' in spec", () => /describe\('optimize/.test(read('tests/optimize.spec.ts'))],
  ['tests/optimize.spec.ts in tsconfig.tests', () => read('tsconfig.tests.json').includes('tests/optimize.spec.ts')],
]
for (const [label, ok] of positive) if (!ok()) fail('missing positive: ' + label)

// 8. 行数预算
const budgets = [
  ['src/core/optimize.ts', 320],
  ['tests/optimize.spec.ts', 320],
  ['scripts/verify-p11.mjs', 140],
]
for (const [f, limit] of budgets) if (count(f) > limit) fail(`${f} lines ${count(f)} > ${limit}`)

if (failures.length === 0) {
  console.log('P11 VERIFY PASS')
  process.exit(0)
} else {
  console.log('P11 VERIFY FAIL')
  process.exit(1)
}

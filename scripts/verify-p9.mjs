#!/usr/bin/env node
/**
 * P9 自动化验收（docs/implement/P9-dossier.md §3.3）。
 * P8 收尾门 → build → gate/typecheck:tests → 断言确定性 → 纯核扫描 → 行数预算。
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

// 0. P8 收尾门（P9 未过 P8 不得开工）
const p8 = run('node', ['scripts/verify-p8.mjs'])
if (p8.status !== 0) fail('P8 verify gate failed')
else note('P8 verify gate passed')

// 1. build（有 checkout 则构建；缺 checkout 记录 SKIP 继续）
const checkout = process.env.DSH_CHECKOUT || 'G:/deepseek-harness'
if (exists(path.join(checkout, 'packages'))) {
  const build = run('npm', ['run', 'build'], { env: { ...process.env, DSH_CHECKOUT: checkout } })
  if (build.status !== 0) fail('npm run build failed')
  else note('build ran with DSH_CHECKOUT=' + checkout)
} else {
  note('SKIP build (checkout missing)')
}

// 2. 门禁
for (const script of ['gate', 'typecheck:tests']) {
  const r = run('npm', ['run', script])
  if (r.status !== 0) fail('npm run ' + script + ' failed')
}

// 3. 断言确定性（双跑 diff）
const a1 = run('node', ['scripts/assert-structure.mjs', '--json'])
const a2 = run('node', ['scripts/assert-structure.mjs', '--json'])
if (a1.status !== 0 || a2.status !== 0) fail('assert-structure --json failed')
else if (a1.stdout !== a2.stdout) fail('assert-structure --json not byte-stable')

// 4. 纯核/接线反向扫描（期望 0 命中）
const dossier = read('src/core/dossier.ts')
for (const re of [/@deepseek-ai\//, /from\s+['"]cordis/, /platform\//, /ctx\./, /session\.append/, /setInterval\(/, /emitCeFact/, /context-economy\//]) {
  if (re.test(dossier)) fail(`src/core/dossier.ts contains forbidden ${re}`)
}
const index = read('src/index.ts')
if (/skills\/change/.test(index)) fail('src/index.ts directly references skills/change')
if (/export const inject = \['skills'\]/.test(index)) fail('src/index.ts must not hard-require skills as root inject')

// 5. 正向扫描（期望 ≥1 命中）
const positive = [
  ['dossierStorageKey in dossier', () => /dossierStorageKey/.test(dossier)],
  ['appendDossierMessage in dossier', () => /appendDossierMessage/.test(dossier)],
  ['backfillDossier in dossier', () => /backfillDossier/.test(dossier)],
  ['foldDossierLedger in dossier', () => /foldDossierLedger/.test(dossier)],
  ['dossier describe in spec', () => /describe\('dossier/.test(read('tests/dossier.spec.ts'))],
  ['ctx.inject skills in index', () => /ctx\.inject\(\['skills'\]/.test(index)],
]
if (exists('lib/index.js')) {
  const lib = read('lib/index.js')
  positive.push(['ctx.inject skills in lib', () => /ctx\.inject\(\['skills'\]/.test(lib)])
  if (/export const inject = \['skills'\]/.test(lib)) fail('stale lib/index.js: hard-requires skills')
} else {
  fail('lib/index.js missing')
}
for (const [label, ok] of positive) if (!ok()) fail('missing positive: ' + label)

// 6. 行数预算
const budgets = [
  ['src/core/dossier.ts', 200],
  ['tests/dossier.spec.ts', 240],
  ['scripts/verify-p9.mjs', 120],
]
for (const [f, limit] of budgets) if (count(f) > limit) fail(`${f} lines ${count(f)} > ${limit}`)

if (failures.length === 0) {
  console.log('P9 VERIFY PASS')
  process.exit(0)
} else {
  console.log('P9 VERIFY FAIL')
  process.exit(1)
}

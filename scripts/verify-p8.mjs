#!/usr/bin/env node
/**
 * P8 自动化验收（docs/implement/P8-units-prefix.md §3.8）。
 * build（有 checkout）→ gate/typecheck:tests → 断言确定性 → 纯核/接线扫描 → 行数预算。
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

// 1. build（DSH_CHECKOUT 探测；缺 checkout → SKIP）
const checkout = process.env.DSH_CHECKOUT || 'G:/deepseek-harness'
if (exists(path.join(checkout, 'packages'))) {
  const build = run('npm', ['run', 'build'], { env: { ...process.env, DSH_CHECKOUT: checkout } })
  if (build.status !== 0) fail('npm run build failed')
  note('build ran with DSH_CHECKOUT=' + checkout)
} else {
  note('SKIP build: DSH_CHECKOUT not found (' + checkout + ')')
}

// 2. 门禁
for (const script of ['gate', 'typecheck:tests']) {
  const r = run('npm', ['run', script])
  if (r.status !== 0) fail('npm run ' + script + ' failed')
}

// 3. 断言确定性
const a1 = run('node', ['scripts/assert-structure.mjs', '--json'])
const a2 = run('node', ['scripts/assert-structure.mjs', '--json'])
if (a1.status !== 0 || a2.status !== 0) fail('assert-structure --json failed')
else if (a1.stdout !== a2.stdout) fail('assert-structure --json output not byte-stable')

// 4. 纯核与接线反向扫描（期望 0 命中）
const coreFiles = ['src/core/units.ts', 'src/core/prefix.ts']
const coreForbidden = [/@deepseek-ai\//, /from\s+['"]cordis/, /platform\//, /ctx\./, /session\.append/, /setInterval\(/, /emitCeFact/]
for (const f of coreFiles) {
  for (const re of coreForbidden) if (re.test(read(f))) fail(`${f} contains forbidden ${re}`)
}
if (/skills\/change/.test(read('src/index.ts'))) fail('src/index.ts directly references skills/change')

// 5. 正向扫描（期望 ≥1 命中）
const positive = [
  ['foldSegmentState in units', () => /foldSegmentState/.test(read('src/core/units.ts'))],
  ['foldSegmentState in fold', () => /foldSegmentState/.test(read('src/core/ledger/fold.ts'))],
  ['renderStablePrefix in prefix', () => /renderStablePrefix/.test(read('src/core/prefix.ts'))],
  ['renderStablePrefix in prefix.spec', () => /renderStablePrefix/.test(read('tests/prefix.spec.ts'))],
  ['watchSkillCatalog in index', () => /watchSkillCatalog/.test(read('src/index.ts'))],
  ['projectFrameStorageKey in index', () => /projectFrameStorageKey/.test(read('src/index.ts'))],
]
for (const [label, ok] of positive) if (!ok()) fail('missing positive: ' + label)

// 6. 行数预算
const budgets = [
  ['src/core/units.ts', 150], ['src/core/prefix.ts', 180],
  ['tests/units.spec.ts', 220], ['tests/prefix.spec.ts', 220],
  ['tests/prefix-wiring.spec.ts', 240], ['scripts/verify-p8.mjs', 120],
]
for (const [f, limit] of budgets) if (count(f) > limit) fail(`${f} lines ${count(f)} > ${limit}`)
const diff = run('git', ['diff', '--numstat', '--', 'src/index.ts'])
if (diff.status === 0 && diff.stdout.trim()) {
  const added = Number(diff.stdout.trim().split(/\s+/)[0] ?? 0)
  if (added > 60) fail(`src/index.ts net additions ${added} > 60`)
  note('src/index.ts net additions: ' + added)
}

// 7. 测试名抽查
const nameChecks = [
  ['tests/units.spec.ts', "describe('foldSegmentState"],
  ['tests/prefix.spec.ts', "describe('renderStablePrefix"],
  ['tests/prefix-wiring.spec.ts', "describe('prefix wiring"],
]
for (const [f, needle] of nameChecks) if (!read(f).includes(needle)) fail(`${f} missing ${needle}`)

if (failures.length === 0) {
  console.log('P8 VERIFY PASS')
  process.exit(0)
} else {
  console.log('P8 VERIFY FAIL')
  process.exit(1)
}

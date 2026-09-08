#!/usr/bin/env node
/**
 * P6 自动化验收（docs/implement/archive/P6-history.md §4）。
 * 只跑命令/扫描，不替代测试；全绿输出 P6 VERIFY PASS。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`) }
const note = (msg) => console.log(msg)
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', ...opts })
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const exists = (p) => fs.existsSync(path.join(ROOT, p))

// P6.1 补正：build 先于 gate（干净环境依赖 junction 先行，build.sh 补齐；checkout 缺失仍 SKIP）。
const checkout = process.env.DSH_CHECKOUT || 'G:/deepseek-harness'
if (fs.existsSync(path.join(checkout, 'packages'))) {
  const build = run('npm', ['run', 'build'], { env: { ...process.env, DSH_CHECKOUT: checkout } })
  if (build.status !== 0) fail('npm run build failed')
  note(`build ran with DSH_CHECKOUT=${checkout}`)
} else {
  note(`SKIP build: DSH_CHECKOUT not found (${checkout})`)
}

const gate = run('npm', ['run', 'gate'])
if (gate.status !== 0) fail('npm run gate failed')
const t = run('npm', ['run', 'typecheck:tests'])
if (t.status !== 0) fail('npm run typecheck:tests failed')

const a1 = run('node', ['scripts/assert-structure.mjs', '--json'])
const a2 = run('node', ['scripts/assert-structure.mjs', '--json'])
if (a1.status !== 0 || a2.status !== 0) fail('assert-structure --json failed')
else if (a1.stdout !== a2.stdout) fail('assert-structure --json output not byte-stable')
else {
  const parsed = JSON.parse(a1.stdout)
  if (parsed.rules?.D7?.status !== 'pass') fail('D7 status not pass in assert-structure --json')
}

const historyText = read('src/platform/history.ts')
const required = [
  'export function createHistoryPort',
  'replaceSurface',
  'beginCompaction',
  'endCompaction',
  'recordPrune',
  'assertNoActiveCompaction',
  'balanceRange',
  'toolPairingBalancedBefore',
  'toolPairingBalancedAfter',
]
for (const token of required) if (!historyText.includes(token)) fail(`src/platform/history.ts missing token: ${token}`)

const forbidden = [
  /from\s+['"]\.\.\/core/,
  /setInterval\s*\(/,
  /fetch\s*\(/,
  /http\.get/,
  /axios/,
  /readFile/,
  /watchFile/,
]
for (const re of forbidden) if (re.test(historyText)) fail(`src/platform/history.ts forbidden pattern: ${re}`)

const pkg = JSON.parse(read('package.json'))
for (const dep of ['@deepseek-ai/dsh-compaction', '@deepseek-ai/dsh-commands']) {
  const v = pkg.peerDependencies?.[dep]
  if (typeof v !== 'string' || !/[<^~>=]/.test(v)) fail(`package.json missing range peerDependency ${dep}`)
}
const buildSh = read('scripts/build.sh')
for (const dep of ['@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-compaction']) {
  if (!buildSh.includes(`link_pkg ${dep}`)) fail(`scripts/build.sh missing link_pkg ${dep}`)
}

const budgets = {
  'src/platform/history.ts': 280,
  'tests/history.spec.ts': 260,
  'scripts/verify-p6.mjs': 140,
}
for (const [file, limit] of Object.entries(budgets)) {
  const lines = exists(file) ? read(file).trimEnd().split('\n').length : 0
  if (lines > limit) fail(`${file} exceeds line budget (${lines} > ${limit})`)
}

if (!read('scripts/assert-structure.mjs').includes("id: 'D7'")) fail('assert-structure.mjs missing D7')
if (!read('tests/assert-structure.spec.ts').includes("D7: 'pass'")) fail('assert-structure.spec.ts missing D7 snapshot')

if (failures.length > 0) {
  console.log('P6 VERIFY FAIL')
  process.exit(1)
}
console.log('P6 VERIFY PASS')

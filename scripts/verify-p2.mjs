#!/usr/bin/env node
/**
 * P2 自动化验收（docs/implement/P2-ledger-base.md §3.6）。
 * 只跑命令/扫描，不替代测试；全绿输出 P2 VERIFY PASS。
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
const read = (p) => fs.readFileSync(p, 'utf8')
const coreDir = path.join(ROOT, 'src/core/ledger')
const coreFiles = fs.readdirSync(coreDir).filter((f) => f.endsWith('.ts')).map((f) => path.join(coreDir, f))
const testFile = path.join(ROOT, 'tests/ledger-fold.spec.ts')

const gate = run('npm', ['run', 'gate'])
if (gate.status !== 0) fail('npm run gate failed')

const checkout = process.env.DSH_CHECKOUT || 'G:/deepseek-harness'
if (fs.existsSync(path.join(checkout, 'packages'))) {
  const build = run('npm', ['run', 'build'], { env: { ...process.env, DSH_CHECKOUT: checkout } })
  if (build.status !== 0) fail('npm run build failed')
} else {
  note(`SKIP build: DSH_CHECKOUT not found (${checkout})`)
}

const a1 = run('node', ['scripts/assert-structure.mjs', '--json'])
const a2 = run('node', ['scripts/assert-structure.mjs', '--json'])
if (a1.status !== 0 || a2.status !== 0) fail('assert-structure failed')
else if (a1.stdout !== a2.stdout) fail('assert-structure output not byte-stable')

const checkNoHit = (label, files, re) => {
  for (const f of files) if (re.test(read(f))) fail(`${label}: ${path.relative(ROOT, f)}`)
}
checkNoHit('harness import', coreFiles, /from\s+['"]@deepseek-ai\//)
checkNoHit('cordis import', coreFiles, /from\s+['"]cordis/)
checkNoHit('platform import', coreFiles, /from\s+['"][^'"]*platform/)
const networkRe = new RegExp(`${'fetch'}\\s*\\(|${'http'}\\.${'get'}|${'ax'}${'ios'}`)
checkNoHit('network', [...coreFiles, testFile], networkRe)
checkNoHit('timer', coreFiles, /setInterval\s*\(/)

for (const f of coreFiles) {
  const lines = read(f).split('\n')
  lines.forEach((line, i) => {
    if (!line.includes('context-economy/')) return
    const allow = f.endsWith('facts.ts') && (/FACT_TYPE_PREFIX = 'context-economy\/'/.test(line) || /TASK_BOUNDARY_FACT_TYPE = 'context-economy\/task-boundary'/.test(line))
    if (!allow) fail(`context-economy outside facts.ts whitelist: ${path.relative(ROOT, f)}:${i + 1}`)
  })
}

const budgets = { 'types.ts': 90, 'facts.ts': 80, 'fold.ts': 180, 'index.ts': 10 }
for (const f of coreFiles) {
  const name = path.basename(f)
  const lines = read(f).trimEnd().split('\n').length
  if (lines > (budgets[name] ?? Infinity)) fail(`${name} exceeds line budget (${lines} > ${budgets[name]})`)
}
const ownLines = read(new URL(import.meta.url)).trimEnd().split('\n').length
if (ownLines > 100) fail(`scripts/verify-p2.mjs exceeds line budget (${ownLines} > 100)`)

if (failures.length > 0) {
  console.log('P2 VERIFY FAIL')
  process.exit(1)
}
console.log('P2 VERIFY PASS')

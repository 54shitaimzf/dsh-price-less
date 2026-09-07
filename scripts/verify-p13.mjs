#!/usr/bin/env node
/**
 * P13 自动化验收（docs/implement/P13-commands.md §3.8）。
 * 轻量模式：一次完整 gate + P12/P8/P9 专项 grep + P13 专项扫描。
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

// 1. P12/P8/P9 专项门
const t0 = read('src/core/t0.ts')
const prefix = read('src/core/prefix.ts')
const facts = read('src/core/ledger/facts.ts')
const llm = read('src/platform/llm.ts')
const input = read('src/domains/input.ts')
for (const name of ['parseT0Command']) if (!t0.includes(name)) fail('P8/P12 missing ' + name)
for (const name of ['createProjectFrame', 'projectFrameStorageKey']) if (!prefix.includes(name)) fail('P8 missing ' + name)
for (const name of ['TASK_BOUNDARY_FACT_TYPE', 'factsFromSessionEvents']) if (!facts.includes(name)) fail('P8 missing ' + name)
if (!llm.includes('streamCeLlm') || !llm.includes('context-economy-init')) fail('P5/llm purpose missing')
if (!input.includes('mountAutoDiscriminator')) fail('P12 missing mountAutoDiscriminator')

// 2. build
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
const init = read('src/core/init.ts')
const commands = read('src/domains/commands.ts')
const taskFacts = read('src/domains/task-facts.ts')
for (const re of [/@deepseek-ai\//, /from\s+['"]cordis/, /platform\//, /ctx\./, /session\.append/, /context-economy\//, /fetch\(/, /http\.get/, /axios/]) {
  if (re.test(init)) fail(`src/core/init.ts contains forbidden ${re}`)
}
for (const re of [/session\.append/, /ctx\.on\('session\/event'/, /setInterval\(/, /fetch\(/, /http\.get/, /axios/]) {
  if (re.test(commands)) fail(`src/domains/commands.ts contains forbidden ${re}`)
}
for (const re of [/emitCeFact\(/, /session\.append/]) {
  if (re.test(taskFacts)) fail(`src/domains/task-facts.ts contains forbidden ${re}`)
}

// 6. 正向扫描
const indexText = read('src/index.ts')
const commandsSpec = read('tests/commands.spec.ts')
const positive = [
  ['mountCommandFace in commands', () => /mountCommandFace/.test(commands)],
  ['parseT0Command in commands', () => /parseT0Command/.test(commands)],
  ['TASK_BOUNDARY_FACT_TYPE in commands', () => /TASK_BOUNDARY_FACT_TYPE/.test(commands)],
  ['foldSegmentState in commands', () => /foldSegmentState/.test(commands)],
  ['createProjectFrame in commands', () => /createProjectFrame/.test(commands)],
  ['projectFrameStorageKey in commands', () => /projectFrameStorageKey/.test(commands)],
  ['streamCeLlm in commands', () => /streamCeLlm/.test(commands)],
  ['listSkillCatalog in commands', () => /listSkillCatalog/.test(commands)],
  ['commands.register in commands', () => /commands\.register/.test(commands)],
  ['task-boundary in SessionEventMap window', () => /interface SessionEventMap[\s\S]*context-economy\/task-boundary/.test(taskFacts)],
  ['task-boundary in IgnorableSessionEventMap window', () => /interface IgnorableSessionEventMap[\s\S]*context-economy\/task-boundary/.test(taskFacts)],
  ['renderInitPrompt in init', () => /renderInitPrompt/.test(init)],
  ['parseInitOutput in init', () => /parseInitOutput/.test(init)],
  ['context-economy-init in llm', () => /context-economy-init/.test(llm)],
  ['mountCommandFace in index', () => /mountCommandFace/.test(indexText)],
  ["ctx.inject(['commands'] in index", () => /ctx\.inject\(\['commands'\]/.test(indexText)],
  ['command face describe in spec', () => /describe\('command face/.test(commandsSpec) || /describe\('init/.test(commandsSpec)],
  ['commands.spec in tsconfig.tests', () => read('tsconfig.tests.json').includes('tests/commands.spec.ts')],
]
for (const [label, ok] of positive) if (!ok()) fail('missing positive: ' + label)

// 7. lib 新鲜度
if (!exists('lib/index.js')) fail('lib/index.js missing')
else {
  const lib = read('lib/index.js')
  if (/export const inject = \['commands'\]/.test(lib)) fail('stale lib/index.js: hard-requires commands')
  if (!/mountCommandFace|context-economy-init/.test(lib)) fail('stale lib/index.js: missing P13 symbols')
}

// 8. 行数预算/净增
const budgets = [
  ['src/domains/task-facts.ts', 80],
  ['src/core/init.ts', 160],
  ['src/domains/commands.ts', 340],
  ['tests/commands.spec.ts', 360],
  ['scripts/verify-p13.mjs', 160],
]
for (const [f, limit] of budgets) if (count(f) > limit) fail(`${f} lines ${count(f)} > ${limit}`)
for (const f of ['src/index.ts', 'src/platform/llm.ts', 'tests/llm-purpose.spec.ts']) {
  const d = run('git', ['diff', '--numstat', '--', f])
  if (d.status === 0 && d.stdout.trim()) {
    const parts = d.stdout.trim().split(/\s+/)
    const added = Number(parts[0] ?? 0)
    const deleted = Number(parts[1] ?? 0)
    const net = added - deleted
    const limit = f === 'src/index.ts' ? 40 : f === 'src/platform/llm.ts' ? 5 : 5
    if (net > limit) fail(`${f} net +${net} > ${limit}`)
  }
}

if (failures.length === 0) {
  console.log('P13 VERIFY PASS')
  process.exit(0)
} else {
  console.log('P13 VERIFY FAIL')
  process.exit(1)
}

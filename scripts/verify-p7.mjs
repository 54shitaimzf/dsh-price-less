#!/usr/bin/env node
/**
 * P7 自动化验收（docs/implement/P7-tools.md §3.3；agent 自动化验收入口）。
 * build（有 checkout）→ 五段门禁 → 断言确定性 + D8 → 反向扫描 → 端口纯净 → 行数预算。
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
const exists = (p) => fs.existsSync(path.join(ROOT, p))

const srcFiles = []
const walk = (abs) => {
  for (const name of fs.readdirSync(abs).sort()) {
    if (name === 'node_modules' || name === 'lib' || name.startsWith('.')) continue
    const p = path.join(abs, name)
    if (fs.statSync(p).isDirectory()) walk(p)
    else if (p.endsWith('.ts')) srcFiles.push(path.relative(ROOT, p).split(path.sep).join('/'))
  }
}
walk(path.join(ROOT, 'src'))

// 1. build（DSH_CHECKOUT 探测；缺 checkout → SKIP）
const checkout = process.env.DSH_CHECKOUT || 'G:/deepseek-harness'
if (fs.existsSync(path.join(checkout, 'packages'))) {
  const build = run('npm', ['run', 'build'], { env: { ...process.env, DSH_CHECKOUT: checkout } })
  if (build.status !== 0) fail('npm run build failed')
  note('build ran with DSH_CHECKOUT=' + checkout)
} else {
  note('SKIP build: DSH_CHECKOUT not found (' + checkout + ')')
}

// 2. 五段门禁
for (const script of ['typecheck', 'typecheck:client', 'typecheck:tests', 'test', 'assert']) {
  const r = run('npm', ['run', script])
  if (r.status !== 0) fail('npm run ' + script + ' failed')
}

// 3. 断言确定性 + D8
const a1 = run('node', ['scripts/assert-structure.mjs', '--json'])
const a2 = run('node', ['scripts/assert-structure.mjs', '--json'])
if (a1.status !== 0 || a2.status !== 0) fail('assert-structure --json failed')
else if (a1.stdout !== a2.stdout) fail('assert-structure --json output not byte-stable')
else {
  const parsed = JSON.parse(a1.stdout)
  if (parsed.rules?.D8?.status !== 'pass') fail('D8 status not pass in assert-structure --json')
}

// 4. D8 反向扫描（同 D8 正则）：命中集合恰为 ['src/platform/tools.ts']
const d8Re = /(tools\/execute|tools\/post-execute|PostToolDecision|ToolDispatchExecution|ToolExecutionResult|\bToolExecution\b|@deepseek-ai\/dsh-tools)/
const d8Hits = srcFiles.filter((f) => d8Re.test(read(f)))
if (JSON.stringify(d8Hits.sort()) !== JSON.stringify(['src/platform/tools.ts'])) fail('D8 scan hit files ' + JSON.stringify(d8Hits))

// 5. D6 基线不回归（as GenerateOptions 单点）+ 零会话写入
const castHits = srcFiles.filter((f) => read(f).includes('as GenerateOptions'))
if (JSON.stringify(castHits) !== JSON.stringify(['src/platform/llm.ts'])) fail('cast point must be only src/platform/llm.ts, got ' + JSON.stringify(castHits))
if (read('src/platform/tools.ts').includes('session.append')) fail('src/platform/tools.ts writes session (zero session writes required)')

// 6. 端口纯净扫描（tools.ts 期望 0 命中）
const toolsText = read('src/platform/tools.ts')
const forbidden = [/\.append\(/, /setInterval\(/, /fetch\(/, /http\.get/, /axios/, /readFile/, /watchFile/, /chokidar/, /from\s+['"]\.\.\/core/, /@deepseek-ai\/dsh-session/, /@deepseek-ai\/dsh-storage-domain/]
for (const re of forbidden) if (re.test(toolsText)) fail('src/platform/tools.ts forbidden pattern: ' + re)

// 7. 行数预算
const budgets = { 'src/platform/tools.ts': 200, 'tests/tools.spec.ts': 180, 'scripts/verify-p7.mjs': 100 }
for (const [file, limit] of Object.entries(budgets)) {
  const lines = exists(file) ? read(file).trimEnd().split('\n').length : 0
  if (lines > limit) fail(file + ' exceeds line budget (' + lines + ' > ' + limit + ')')
}

if (failures.length > 0) {
  console.log('P7 VERIFY FAIL')
  process.exit(1)
}
console.log('P7 VERIFY PASS')

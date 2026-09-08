#!/usr/bin/env node
/**
 * P5 自动化验收（docs/implement/archive/P5-llm.md §3.3）。
 * 只跑命令/扫描，不替代测试；全绿输出 P5 VERIFY PASS。
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

const pkg = JSON.parse(read('package.json'))
const llmPeer = pkg.peerDependencies?.['@deepseek-ai/dsh-llm']
if (typeof llmPeer !== 'string' || !/[<^~>=]/.test(llmPeer)) fail('package.json missing range peerDependency @deepseek-ai/dsh-llm')
if (!read('scripts/build.sh').includes('link_pkg @deepseek-ai/dsh-llm packages/llm/llm')) fail('scripts/build.sh missing dsh-llm link')

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
const castHits = srcFiles.filter((f) => read(f).includes('as GenerateOptions'))
if (JSON.stringify(castHits) !== JSON.stringify(['src/platform/llm.ts'])) fail(`cast point must be only src/platform/llm.ts, got ${JSON.stringify(castHits)}`)

const checkout = process.env.DSH_CHECKOUT || 'G:/deepseek-harness'
if (fs.existsSync(path.join(checkout, 'packages'))) {
  const build = run('npm', ['run', 'build'], { env: { ...process.env, DSH_CHECKOUT: checkout } })
  if (build.status !== 0) fail('npm run build failed')
  note(`build ran with DSH_CHECKOUT=${checkout}`)
} else {
  note(`SKIP build: DSH_CHECKOUT not found (${checkout})`)
}

for (const script of ['typecheck', 'typecheck:client', 'typecheck:tests', 'test', 'assert']) {
  const r = run('npm', ['run', script])
  if (r.status !== 0) fail(`npm run ${script} failed`)
}

const a1 = run('node', ['scripts/assert-structure.mjs', '--json'])
const a2 = run('node', ['scripts/assert-structure.mjs', '--json'])
if (a1.status !== 0 || a2.status !== 0) fail('assert-structure --json failed')
else if (a1.stdout !== a2.stdout) fail('assert-structure --json output not byte-stable')
else {
  const parsed = JSON.parse(a1.stdout)
  if (parsed.rules?.D6?.status !== 'pass') fail('D6 status not pass in assert-structure --json')
}

const llmRe = /(ctx\.llm|llm\/stream|llm\.stream|\bGenerateOptions\b|\bTokenUsage\b|\bStreamChunk\b|\bLlmRuntime\b)/
const llmHits = srcFiles.filter((f) => llmRe.test(read(f)))
if (JSON.stringify(llmHits.sort()) !== JSON.stringify(['src/platform/llm.ts'])) fail(`D6 scan hit files ${JSON.stringify(llmHits)}`)

const llmText = read('src/platform/llm.ts')
const forbidden = [/\.append\(/, /setInterval\(/, /fetch\(/, /http\.get/, /axios/, /readFile/, /watchFile/, /chokidar/, /from\s+['"]\.\.\/core/, /@deepseek-ai\/dsh-session/, /@deepseek-ai\/dsh-storage-domain/]
for (const re of forbidden) if (re.test(llmText)) fail(`src/platform/llm.ts forbidden pattern: ${re}`)

const budgets = { 'src/platform/llm.ts': 200, 'tests/llm-purpose.spec.ts': 180, 'scripts/verify-p5.mjs': 120 }
for (const [file, limit] of Object.entries(budgets)) {
  const lines = exists(file) ? read(file).trimEnd().split('\n').length : 0
  if (lines > limit) fail(`${file} exceeds line budget (${lines} > ${limit})`)
}

if (!read('tests/assert-structure.spec.ts').includes("D6: 'pass'")) fail('tests/assert-structure.spec.ts missing D6 snapshot')
if (!read('scripts/assert-structure.mjs').includes("id: 'D6'")) fail('scripts/assert-structure.mjs missing D6 rule')

if (failures.length > 0) {
  console.log('P5 VERIFY FAIL')
  process.exit(1)
}
console.log('P5 VERIFY PASS')

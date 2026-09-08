#!/usr/bin/env node
/**
 * P4 自动化验收（docs/implement/archive/P4-skills.md §3.3）。
 * 只跑命令/扫描，不替代测试；全绿输出 P4 VERIFY PASS。
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

const a1 = run('node', ['scripts/assert-structure.mjs', '--json'])
const a2 = run('node', ['scripts/assert-structure.mjs', '--json'])
if (a1.status !== 0 || a2.status !== 0) fail('assert-structure failed')
else if (a1.stdout !== a2.stdout) fail('assert-structure output not byte-stable')

const skillsText = read('src/platform/skills.ts')
const forbidden = [/fetch\s*\(/, /http\.get/, /axios/, /setInterval\s*\(/, /\.append\(/, /readFile/, /watchFile/, /readdir/, /chokidar/, /from\s+['"]@deepseek-ai\/dsh-storage/, /from\s+['"]\.\.\/core/, /from\s+['"]\.\/storage\.ts/]
for (const re of forbidden) if (re.test(skillsText)) fail(`src/platform/skills.ts forbidden pattern: ${re}`)

const scanCore = (dir) => {
  const walk = (abs) => {
    for (const name of fs.readdirSync(abs).sort()) {
      if (name === 'node_modules' || name === 'lib' || name.startsWith('.')) continue
      const p = path.join(abs, name)
      if (fs.statSync(p).isDirectory()) walk(p)
      else if (/\.ts$/.test(name) && /@deepseek-ai\/dsh-skill|ctx\.skills|skills\/change|SkillSummary|SkillDefinition/.test(fs.readFileSync(p, 'utf8'))) {
        fail(`src/core skill concept: ${path.relative(ROOT, p)}`)
      }
    }
  }
  walk(path.join(ROOT, dir))
}
scanCore('src/core')

const budgets = {
  'src/platform/skills.ts': 220,
  'tests/skills.spec.ts': 200,
  'scripts/verify-p4.mjs': 110,
}
for (const [file, limit] of Object.entries(budgets)) {
  const lines = exists(file) ? read(file).trimEnd().split('\n').length : 0
  if (lines > limit) fail(`${file} exceeds line budget (${lines} > ${limit})`)
}

if (!read('scripts/assert-structure.mjs').includes("id: 'D5'")) fail('assert-structure.mjs missing D5')
if (!read('tests/assert-structure.spec.ts').includes("D5: 'pass'")) fail('assert-structure.spec.ts missing D5 snapshot')

if (failures.length > 0) {
  console.log('P4 VERIFY FAIL')
  process.exit(1)
}
console.log('P4 VERIFY PASS')

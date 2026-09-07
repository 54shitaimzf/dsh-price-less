#!/usr/bin/env node
/**
 * P6.1 自动化验收（docs/implement/P6.1-wrapup.md §3.3；agent 自动化验收入口）。
 * 先跑 P5.1/P6 基线，再做本单专项断言；全绿输出 P6.1 VERIFY PASS。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`) }
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', ...opts })
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const exists = (p) => fs.existsSync(path.join(ROOT, p))

// 1. P5.1 基线（含 verify-p5 → build/五段门禁 + 专项断言）
const v51 = run('node', ['scripts/verify-p5.1.mjs'])
if (v51.status !== 0) fail('verify-p5.1 failed (P5.1 baseline)')
// 2. P6 基线（含修序后的 build-first 流程）
const v6 = run('node', ['scripts/verify-p6.mjs'])
if (v6.status !== 0) fail('verify-p6 failed (P6 baseline)')

// 3. 专项断言（Node 读文件）
const v6Text = read('scripts/verify-p6.mjs')
const buildIdx = v6Text.indexOf("const build = run('npm', ['run', 'build']")
const gateIdx = v6Text.indexOf("const gate = run('npm', ['run', 'gate']")
if (buildIdx === -1 || gateIdx === -1) fail('verify-p6.mjs missing build/gate run blocks')
else if (buildIdx > gateIdx) fail('verify-p6.mjs build block must precede gate block (build-first)')

const spec13 = read('docs/13-harness-plugin-spec.md')
for (const token of ['### 3.8', 'dsh-compaction', 'toolPairingBalancedBefore', 'CompactionId']) {
  if (!spec13.includes(token)) fail(`docs/13-harness-plugin-spec.md missing ${token}`)
}
if (!read('scripts/assert-structure.mjs').includes('compaction\\/summary')) fail('assert-structure.mjs D7 regex missing compaction\\/summary')
if (!exists('tests/history-real-session.spec.ts')) fail('tests/history-real-session.spec.ts missing')

const llmText = read('src/platform/llm.ts')
if (!llmText.includes('AsyncGenerator<StreamChunk, void, unknown>')) fail('src/platform/llm.ts missing AsyncGenerator return type')
if (!llmText.includes('llm usage receipt callback failed (contained)')) fail('src/platform/llm.ts missing contained warn text')

// 4. 行数预算
const budgets = {
  'src/platform/llm.ts': 160,
  'tests/llm-stream-robustness.spec.ts': 80,
  'tests/history-real-session.spec.ts': 90,
  'scripts/verify-p5.1.mjs': 90,
  'scripts/verify-p6.1.mjs': 100,
}
for (const [file, limit] of Object.entries(budgets)) {
  const lines = exists(file) ? read(file).trimEnd().split('\n').length : 0
  if (lines > limit) fail(`${file} exceeds line budget (${lines} > ${limit})`)
}

if (failures.length > 0) {
  console.log('P6.1 VERIFY FAIL')
  process.exit(1)
}
console.log('P6.1 VERIFY PASS')

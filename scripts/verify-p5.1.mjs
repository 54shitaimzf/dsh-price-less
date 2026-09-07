#!/usr/bin/env node
/**
 * P5.1 自动化验收（docs/implement/P6.1-wrapup.md §3.1 + P5.1-llm-hardening.md §3.3）。
 * 只跑命令/扫描，不替代测试；全绿输出 P5.1 VERIFY PASS。
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

// P5 基线（含 build/五段门禁/确定性/D6 扫描/预算；不回归）
const base = run('node', ['scripts/verify-p5.mjs'])
if (base.status !== 0) fail('verify-p5 failed (P5 baseline regression)')

const llmText = read('src/platform/llm.ts')
if (!llmText.includes('AsyncGenerator<StreamChunk, void, unknown>')) fail('src/platform/llm.ts missing AsyncGenerator return type')
if (!llmText.includes('hooks?.onUsage?.(')) fail('src/platform/llm.ts missing onUsage call')
if (!llmText.includes('context-economy: llm usage receipt callback failed (contained)')) fail('src/platform/llm.ts missing contained warn text')
if (!read('tsconfig.tests.json').includes('tests/llm-stream-robustness.spec.ts')) fail('tsconfig.tests.json missing new spec include')
const wiring = read('docs/10-wiring.md')
for (const token of ['H10', 'H12', 'H13', 'storage.ts', 'skills.ts']) {
  if (!wiring.includes(token)) fail(`docs/10-wiring.md missing status-line token ${token}`)
}
const spec13 = read('docs/13-harness-plugin-spec.md')
if (!spec13.includes('AsyncGenerator')) fail('docs/13 §3.5 missing AsyncGenerator fact')
if (!spec13.includes('llm usage receipt callback failed (contained)')) fail('docs/13 §3.5 missing onUsage throw semantics')

const budgets = { 'src/platform/llm.ts': 160, 'tests/llm-stream-robustness.spec.ts': 80, 'scripts/verify-p5.1.mjs': 90 }
for (const [file, limit] of Object.entries(budgets)) {
  const lines = exists(file) ? read(file).trimEnd().split('\n').length : 0
  if (lines > limit) fail(`${file} exceeds line budget (${lines} > ${limit})`)
}

if (failures.length > 0) {
  console.log('P5.1 VERIFY FAIL')
  process.exit(1)
}
console.log('P5.1 VERIFY PASS')

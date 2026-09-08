#!/usr/bin/env node
/**
 * P14a 自动化验收（docs/implement/archive/P14a-star-button-ui.md §3.8）。
 * 轻量模式：一次完整 gate + P14a 专项 grep + 反向扫描 + 构建（缺 checkout 记 SKIP）。
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

// 1. build.sh 依赖链接断言
const buildSh = read('scripts/build.sh')
for (const name of ['dsh-client-ui-conversation', 'dsh-client-ui-session']) {
  if (!buildSh.includes(name)) fail(`scripts/build.sh missing link ${name}`)
}

// 2. 正向扫描
const indexText = read('client/index.ts')
if (!/conversation\.input\.right/.test(indexText)) fail('client/index.ts missing conversation.input.right registration')
if (!/StarButton/.test(indexText)) fail('client/index.ts missing StarButton')
if (!/context-economy-star/.test(indexText)) fail('client/index.ts missing star slot id')
if (!/dsh-client-ui-conversation\/client/.test(indexText)) fail('client/index.ts missing conversation type-only import')

// 3. 构建（checkout 可用则跑，否则 SKIP）
const checkout = process.env.DSH_CHECKOUT || (process.platform === 'win32' ? 'G:/deepseek-harness' : '/g/deepseek-harness')
if (exists(path.join(checkout, 'packages'))) {
  const build = run('npm', ['run', 'build'], { env: { ...process.env, DSH_CHECKOUT: checkout } })
  if (build.status !== 0) fail('npm run build failed')
  else note('build ran with DSH_CHECKOUT=' + checkout)
} else {
  note('SKIP build (checkout missing)')
}

// 4. 完整门禁
for (const script of ['typecheck:client', 'typecheck', 'typecheck:tests', 'test', 'assert']) {
  const r = run('npm', ['run', script])
  if (r.status !== 0) fail('npm run ' + script + ' failed')
}

// 5. client/star/* 反向扫描（禁止 host/存储/LLM/事实穿透）
const starDir = path.join(ROOT, 'client/star')
for (const file of fs.existsSync(starDir) ? fs.readdirSync(starDir) : []) {
  if (!/\.(ts|tsx)$/.test(file)) continue
  const text = read(path.join('client/star', file))
  for (const re of [/from '\.\.\/src\//, /from '\.\.\/\.\.\/src\//, /emitCeFact/, /context-economy\//, /streamCeLlm/, /putEntity/, /@deepseek-ai\/dsh-storage/, /session\.append/]) {
    if (re.test(text)) fail(`client/star/${file} contains forbidden ${re}`)
  }
}

// 6. 行数预算
const budgets = [
  ['client/star/star-types.ts', 120],
  ['client/star/star-model.ts', 200],
  ['client/star/star-bridge.ts', 100],
  ['client/star/StarButton.tsx', 260],
  ['tests/star-model.spec.ts', 220],
  ['scripts/verify-p14a.mjs', 160],
]
for (const [f, limit] of budgets) if (count(f) > limit) fail(`${f} lines ${count(f)} > ${limit}`)

// 7. client/index.ts 净增 ≤60
const diff = run('git', ['diff', '--numstat', '--', 'client/index.ts'])
if (diff.status === 0 && diff.stdout.trim()) {
  const parts = diff.stdout.trim().split(/\s+/)
  const net = Number(parts[0] ?? 0) - Number(parts[1] ?? 0)
  if (net > 60) fail(`client/index.ts net +${net} > 60`)
}

if (failures.length === 0) {
  console.log('P14a VERIFY PASS')
  process.exit(0)
} else {
  console.log('P14a VERIFY FAIL')
  process.exit(1)
}

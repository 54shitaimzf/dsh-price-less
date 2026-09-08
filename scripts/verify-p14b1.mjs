#!/usr/bin/env node
/**
 * P14b1 自动化验收（docs/implement/P14b1-star-host-service.md §3.7/§5）。
 * 轻量模式：正向契约 grep + 反向扫描 + 完整 gate + 断言确定性 + 构建 + lib 新鲜度 + 行数预算。
 * 注：§5 的 "grep connection client/" 按语义执行——client 侧禁止的是 RPC 桥概念与 diff，
 * P14a 既有 inject 'connection' / 'connection/reset' 不算（P14b1 client 零改动以 git 断言）。
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
const abs = (p) => (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) ? p : path.join(ROOT, p))
const read = (p) => fs.readFileSync(abs(p), 'utf8')
const exists = (p) => fs.existsSync(abs(p))
const count = (p) => { try { return read(p).split('\n').length - 1 } catch { return 0 } }
const listFiles = (dir) => fs.readdirSync(abs(dir)).filter((n) => /\.(ts|tsx)$/.test(n)).map((n) => dir + '/' + n)

// 0. 依赖面：build.sh 链接行 + peerDep 范围写法
if (!/link_pkg @deepseek-ai\/dsh-client-connection packages\/client\/connection/.test(read('scripts/build.sh'))) fail('build.sh missing dsh-client-connection link')
const pkg = JSON.parse(read('package.json'))
const peer = pkg.peerDependencies?.['@deepseek-ai/dsh-client-connection']
if (typeof peer !== 'string' || !/[<^~>=]/.test(peer)) fail('peerDependencies.@deepseek-ai/dsh-client-connection missing or not a range')

// 1. 正向契约
const bridge = read('src/platform/star-bridge.ts')
const star = read('src/domains/star.ts')
const facts = read('src/domains/optimize-facts.ts')
const indexText = read('src/index.ts')
const positive = [
  ["channel '/context-economy'", () => /STAR_BRIDGE_CHANNEL = '\/context-economy'/.test(bridge)],
  ["endpoint 'star.preview'", () => /STAR_PREVIEW_ENDPOINT = 'star\.preview'/.test(bridge)],
  ["endpoint 'star.apply'", () => /STAR_APPLY_ENDPOINT = 'star\.apply'/.test(bridge)],
  ['registerStarBridge', () => /registerStarBridge/.test(bridge)],
  ['mountStarHost', () => /mountStarHost/.test(star)],
  ['foldOptimizeRunFacts', () => /foldOptimizeRunFacts/.test(facts)],
  ['optimize-run in SessionEventMap window', () => /interface SessionEventMap[\s\S]*context-economy\/optimize-run/.test(facts)],
  ['optimize-run in IgnorableSessionEventMap window', () => /interface IgnorableSessionEventMap[\s\S]*context-economy\/optimize-run/.test(facts)],
  ['judgeTable shape fields', () => ['version', 'aspects', 'fileSignatures', 'keywords'].every((k) => star.includes(k))],
  ['index wiring (mount + register + manualOptimize)', () => /mountStarHost/.test(indexText) && /registerStarBridge/.test(indexText) && /manualOptimize/.test(indexText)],
  ['D9 rule present', () => /id: 'D9'/.test(read('scripts/assert-structure.mjs'))],
  ['star-host.spec in tsconfig.tests', () => read('tsconfig.tests.json').includes('tests/star-host.spec.ts')],
  ['star-host.spec >= 13 cases', () => (read('tests/star-host.spec.ts').match(/\n  it\(/g) ?? []).length >= 13],
]
for (const [label, ok] of positive) if (!ok()) fail('missing positive: ' + label)

// 2. 反向扫描
for (const re of [/\.append\(/, /session\/event/, /ctx\./, /setInterval\(/, /fetch\(/, /http\.get/, /axios/]) {
  if (re.test(star)) fail('src/domains/star.ts contains forbidden ' + re)
}
for (const line of star.split('\n')) {
  if (line.includes('@deepseek-ai/dsh-session') && !line.trimStart().startsWith('import type')) fail('src/domains/star.ts has runtime dsh-session import')
}
if (/from\s+['"]\.\.\/domains\//.test(bridge)) fail('src/platform/star-bridge.ts must not import domains (layering)')
for (const dir of ['src/core']) {
  for (const rel of fs.readdirSync(abs(dir))) {
    const full = dir + '/' + rel
    if (!/\.ts$/.test(rel)) continue
    const text = read(full)
    if (/from\s+['"]@deepseek-ai\//.test(text) || /from\s+['"]cordis/.test(text) || /from\s+['"][^'"]*platform/.test(text)) fail('core harness import in ' + full)
  }
}
const clientText = [...listFiles('client'), ...listFiles('client/star'), read('client/index.ts')].join('\n')
for (const re of [/rpc\.call/, /StarConnectionFace/, /star\.preview/, /star\.apply/, /@deepseek-ai\/dsh-client-connection/]) {
  if (re.test(clientText)) fail('client contains RPC bridge concept ' + re)
}
const clientDiff = run('git', ['diff', '--numstat', '--', 'client'])
if (clientDiff.status === 0 && clientDiff.stdout.trim() !== '') fail('client/ must have zero diff in P14b1')

// 3. 完整门禁
for (const script of ['gate', 'typecheck:tests']) {
  const r = run('npm', ['run', script])
  if (r.status !== 0) fail('npm run ' + script + ' failed')
}

// 4. 断言确定性 + D9
const a1 = run('node', ['scripts/assert-structure.mjs', '--json'])
const a2 = run('node', ['scripts/assert-structure.mjs', '--json'])
if (a1.status !== 0 || a2.status !== 0) fail('assert-structure --json failed')
else {
  if (a1.stdout !== a2.stdout) fail('assert-structure --json not byte-stable')
  const parsed = JSON.parse(a1.stdout)
  if (parsed.rules?.D9?.status !== 'pass') fail('D9 status != pass')
}

// 5. 构建（优先 Git bash；WSL bash 会因 CRLF 失败）
const checkout = process.env.DSH_CHECKOUT || 'G:/deepseek-harness'
const gitBash = 'C:/Program Files/Git/bin/bash.exe'
const build = exists(gitBash)
  ? run(gitBash, ['scripts/build.sh'], { shell: false, env: { ...process.env, DSH_CHECKOUT: checkout } })
  : run('npm', ['run', 'build'], { env: { ...process.env, DSH_CHECKOUT: checkout } })
if (build.status !== 0) fail('build failed: ' + String(build.stderr ?? '').slice(-300))
else note('build ran (' + (exists(gitBash) ? 'git bash' : 'npm run build') + ', checkout=' + checkout + ')')

// 6. lib 新鲜度
try {
  if (!read('lib/platform/star-bridge.js').includes('star.preview')) fail('stale lib/platform/star-bridge.js')
  if (!read('lib/domains/star.js').includes('mountStarHost')) fail('stale lib/domains/star.js')
  if (!read('lib/domains/optimize-facts.js').includes('optimize-run')) fail('stale lib/domains/optimize-facts.js')
  if (!exists('lib/types/platform/star-bridge.d.ts')) fail('lib/types/platform/star-bridge.d.ts missing')
} catch (e) { fail('lib freshness check failed: ' + String(e)) }

// 7. 行数预算 + 净增预算
for (const [file, limit] of [
  ['src/platform/star-bridge.ts', 170], ['src/domains/star.ts', 280], ['src/domains/optimize-facts.ts', 130],
  ['tests/star-host.spec.ts', 380], ['scripts/verify-p14b1.mjs', 190],
]) if (count(file) > limit) fail(file + ' lines ' + count(file) + ' > ' + limit)
for (const [file, limit] of [['src/index.ts', 45], ['src/domains/commands.ts', 15]]) {
  const d = run('git', ['diff', '--numstat', '--', file])
  if (d.status === 0 && d.stdout.trim()) {
    const [added, deleted] = d.stdout.trim().split(/\s+/)
    const net = Number(added ?? 0) - Number(deleted ?? 0)
    if (net > limit) fail(file + ' net +' + net + ' > ' + limit)
  }
}

if (failures.length === 0) {
  console.log('P14b1 VERIFY PASS')
  process.exit(0)
} else {
  console.log('P14b1 VERIFY FAIL')
  process.exit(1)
}

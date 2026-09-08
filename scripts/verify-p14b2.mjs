#!/usr/bin/env node
/**
 * P14b2 自动化验收（docs/implement/P14b2-star-live-bridge.md §3.6/§5）。
 * 前序门 → 两侧常量比对 → client 反向扫描 → gate → build → 隔离 home 冒烟 → 行数预算。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const fail = (msg) => { failures.push(msg); console.log('FAIL ' + msg) }
const note = (msg) => console.log(msg)
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', ...opts })
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const exists = (p) => fs.existsSync(path.isAbsolute(p) ? p : path.join(ROOT, p))
const count = (p) => { try { return read(p).split('\n').length - 1 } catch { return 0 } }
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const DSH = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'

// 0. 前序门（P14b1 产物）
for (const f of ['lib/platform/star-bridge.js', 'lib/domains/star.js', 'lib/domains/optimize-facts.js']) {
  if (!exists(f)) fail('missing P14b1 artifact ' + f)
}

// 1. 两侧契约常量逐字比对
const hostBridge = read('src/platform/star-bridge.ts')
const protocol = read('client/star/star-protocol.ts')
const constOf = (text, name) => (text.match(new RegExp(name + "\\s*=\\s*'([^']+)'")) ?? [])[1]
for (const [name, expected] of [
  ['STAR_BRIDGE_CHANNEL', '/context-economy'], ['STAR_PREVIEW_ENDPOINT', 'star.preview'], ['STAR_APPLY_ENDPOINT', 'star.apply'],
]) {
  const host = constOf(hostBridge, name)
  const client = constOf(protocol, name)
  if (host !== client || host !== expected) fail('constant drift ' + name + ': host=' + host + ' client=' + client + ' expected=' + expected)
}

// 2. client 反向扫描 + 接线断言
const starFiles = fs.readdirSync(path.join(ROOT, 'client/star')).filter((n) => /\.(ts|tsx)$/.test(n))
const starText = starFiles.map((n) => read('client/star/' + n)).join('\n')
for (const re of [/from\s+['"][^'"]*\.\.\/src\//, /context-economy\//, /emitCeFact/, /putEntity/, /session\.append/, /streamCeLlm/, /@deepseek-ai\/dsh-client-connection/]) {
  if (re.test(starText)) fail('client/star contains forbidden ' + re)
}
const clientIndex = read('client/index.ts')
if (/createMockStarBridge/.test(clientIndex)) fail('client/index.ts still uses createMockStarBridge')
if (!/createHostStarBridge/.test(clientIndex)) fail('client/index.ts missing createHostStarBridge')
if (!/isStarPreviewData/.test(protocol) || !/isStarApplyValue/.test(protocol)) fail('star-protocol.ts missing shape guards')

// 3. 完整门禁
for (const script of ['gate', 'typecheck:tests']) {
  const r = run('npm', ['run', script])
  if (r.status !== 0) fail('npm run ' + script + ' failed')
}

// 4. 构建（Git bash 优先；WSL bash 会因 CRLF 失败）
const checkout = process.env.DSH_CHECKOUT || 'G:/deepseek-harness'
const gitBash = 'C:/Program Files/Git/bin/bash.exe'
const build = exists(gitBash)
  ? run(gitBash, ['scripts/build.sh'], { shell: false, env: { ...process.env, DSH_CHECKOUT: checkout } })
  : run('npm', ['run', 'build'], { env: { ...process.env, DSH_CHECKOUT: checkout } })
if (build.status !== 0) fail('build failed: ' + String(build.stderr ?? '').slice(-300))
else note('build ran (checkout=' + checkout + ')')

// 5. 隔离 home 自动冒烟（零用户环境影响）
async function smoke() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-p14b2-'))
  const env = { ...process.env, DSH_HOME: home }
  const plugin = ROOT.replaceAll('\\', '/')
  let child
  try {
    const add = run(DSH, ['plugin', '--profile', 'web', 'add', plugin], { env })
    if (add.status !== 0) return fail('smoke: plugin add failed: ' + String(add.stderr).slice(-200))
    const dump = run(DSH, ['--profile', 'web', '--dump-config'], { env })
    if (dump.status !== 0 || !String(dump.stdout).includes('dsh-price-less')) return fail('smoke: dump-config missing dsh-price-less')
    const logFile = path.join(home, 'web.log')
    const fd = fs.openSync(logFile, 'a')
    const startedAt = Date.now()
    child = spawn(DSH, ['web', '--port', '0', '--no-open'], { env, stdio: ['ignore', fd, fd], shell: process.platform === 'win32' })
    let url
    const deadline = startedAt + 60_000
    while (Date.now() < deadline) {
      url = (fs.readFileSync(logFile, 'utf8').match(/dsh web: (http:\/\/[^\s]+)/) ?? [])[1]
      if (url !== undefined) break
      sleep(500)
    }
    if (url === undefined) return fail('smoke: web server did not print a URL within 60s')
    note('smoke: booted ' + url.replace(/token=.*/, 'token=***'))
    const response = await fetch(new URL('/context-economy/star.preview', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'star.preview', payload: { sessionId: 'x', prompt: 'y' } }),
    })
    if (response.status !== 401 && response.status !== 403) {
      fail('smoke: unauthenticated star.preview expected 401/403, got ' + response.status)
    } else note('smoke: /context-economy route registered (status ' + response.status + ')')
    const diag = path.join(ROOT, 'logs', 'context-economy.log')
    if (!fs.existsSync(diag)) fail('smoke: plugin diag log missing')
    else {
      const fresh = fs.readFileSync(diag, 'utf8').trim().split('\n').slice(-8)
        .some((line) => { try { return line.includes('context-economy: applying') && Date.parse(JSON.parse(line).ts) >= startedAt - 10_000 } catch { return false } })
      if (!fresh) fail('smoke: no fresh "applying" line in plugin diag log')
      else note('smoke: plugin applying line observed')
    }
  } finally {
    if (child !== undefined) {
      if (process.platform === 'win32') run('taskkill', ['/pid', String(child.pid), '/T', '/F'])
      else child.kill('SIGTERM')
      sleep(1000)
    }
    fs.rmSync(home, { recursive: true, force: true })
  }
}
await smoke()
if (!exists('client/star/star-protocol.ts')) fail('star-protocol.ts missing')

// 6. 行数/净增预算
for (const [file, limit] of [
  ['client/star/star-protocol.ts', 70], ['tests/star-transport.spec.ts', 260], ['scripts/verify-p14b2.mjs', 170],
]) if (count(file) > limit) fail(file + ' lines ' + count(file) + ' > ' + limit)
const net = run('git', ['diff', '--numstat', '--', 'client/star/star-bridge.ts'])
if (net.status === 0 && net.stdout.trim()) {
  const [added, deleted] = net.stdout.trim().split(/\s+/)
  const delta = Number(added ?? 0) - Number(deleted ?? 0)
  if (delta > 90) fail('client/star/star-bridge.ts net +' + delta + ' > 90')
}
const indexNet = run('git', ['diff', '--numstat', '--', 'client/index.ts'])
if (indexNet.status === 0 && indexNet.stdout.trim()) {
  const [added, deleted] = indexNet.stdout.trim().split(/\s+/)
  const delta = Number(added ?? 0) - Number(deleted ?? 0)
  if (delta > 6) fail('client/index.ts net +' + delta + ' > 6')
}

if (failures.length === 0) {
  console.log('P14b2 VERIFY PASS')
  process.exit(0)
} else {
  console.log('P14b2 VERIFY FAIL')
  process.exit(1)
}

#!/usr/bin/env node
/**
 * 通道回环探针（**跑在构建产物 `lib/` 上，不是 `src/`**）。
 *
 * 存在理由：`docs/14 §4` 第 4 条声称 `npm run smoke:lib` 覆盖 harness 接触面
 * （`SESSION_LOG_INTENT` / `SESSION_FORMAT_VERSION` / 端点常量 / replace / 通道→`emitted`），
 * 但 `scripts/smoke-lib.mjs` 里这些**零匹配**——实际 24 项全是 U8–U13 插件侧回归。
 * 于是「升级后必跑」的那道闸**并没有在测通道**，ignorable 透传是否闭合只能靠人肉。
 * 本脚本补上这一闸：探测 + 真 Session 回环 + 存储契约正反证。
 *
 * 用法：node scripts/probe-channel.mjs      （退出码 0 = 通道闭合；1 = 未闭合/降级）
 * 何时跑：换 harness 基线后、重启宿主前、以及任何怀疑事实轨降级的时刻。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

const req = createRequire(import.meta.url)
const load = (spec) => import(pathToFileURL(req.resolve(spec)).href)

if (!existsSync('lib/platform/ignorable-channel.js')) {
  console.error('probe-channel: lib/ 不存在——先跑 build.sh')
  process.exit(1)
}

const lines = []
const ok = (name, cond, extra = '') => {
  lines.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`)
  return cond
}
let healthy = true
const check = (...args) => { healthy = ok(...args) && healthy }

let sessionPkg
try {
  sessionPkg = req.resolve('@deepseek-ai/dsh-session')
} catch (e) {
  console.error(`probe-channel: 无法解析 @deepseek-ai/dsh-session（junction 缺失？）：${e.message}`)
  process.exit(1)
}
console.log(`resolved dsh-session: ${sessionPkg}`)

const ch = await import(pathToFileURL('lib/platform/ignorable-channel.js').href)

// ① 能力探测：补丁版导出 SESSION_LOG_INTENT = 1
check('探测：SESSION_LOG_INTENT === 1', ch.ignorableChannelAvailable() === true)

if (!ch.ignorableChannelAvailable()) {
  console.log(lines.join('\n'))
  console.log('\nRESULT: FAIL —— 通道不可用，事实轨降级为 KV 镜像（宿主 lib 未含 ignorable 补丁）')
  process.exit(1)
}

const { Context } = await load('@deepseek-ai/cordis')
const { default: SessionStore } = await load('@deepseek-ai/dsh-session')
const { validateStoredEvents } = await load('@deepseek-ai/dsh-session-persistence')

const ctx = new Context()
await ctx.plugin(SessionStore)
const session = ctx.sessions.create()

// ② 发射路由：必须走 append（emitted），不是镜像
const before = ch.factModeStats()
const mode = ch.emitFact(session, 'context-economy/test-probe', { probe: 'channel-probe' })
const after = ch.factModeStats()
check('发射路由 = emitted（非 mirrored/blocked）', mode === 'emitted', mode)
check('计数 emitted +1', after.emitted === before.emitted + 1, `${before.emitted}->${after.emitted}`)

// ③ 落进日志尾、且带 ignorable:true（否则会话会被砖）
const ev = session.snapshotEvents().at(-1)
check('日志尾事件类型正确', ev?.type === 'context-economy/test-probe', ev?.type)
check('日志尾事件带 ignorable:true', ev?.ignorable === true, String(ev?.ignorable))

// ④ 存储契约放行 = 会话可重载
check('v3 存储契约放行（会话可重载）', validateStoredEvents({ id: session.header.id, version: 3 }, [ev]).length === 1)

// ⑤ 反证：同样的未知类型不带 ignorable → 契约拒读整条日志（fail-closed 缺口真实存在）
let threw = false
try {
  validateStoredEvents({ id: session.header.id, version: 3 }, [{ type: 'context-economy/test-probe', seq: 0, time: 1, data: {} }])
} catch { threw = true }
check('反证：无 ignorable 的未知类型被拒读', threw)

console.log(lines.join('\n'))
console.log(healthy ? '\nRESULT: ALL PASS（事实轨走会话日志真源）' : '\nRESULT: FAIL')
process.exit(healthy ? 0 : 1)

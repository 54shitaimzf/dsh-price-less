#!/usr/bin/env node
/**
 * U17 取代路线的**构建产物级探针**：把"用本插件取代原生压缩"的四个前提在**真构建产物**上验一遍。
 *
 * 为什么需要它（与 `probe:channel` 同一条理由）：`src/` 层 vitest 全绿也照样漏构建/链接/解析漂移，
 * 而这条路线的前提有四个都不在 src 层：
 * ① preset 行 `dsh-price-less/provider` 必须能**经包 exports 解析**（名写错 = 挂载期才炸）；
 * ② provider 与 `command-compact` 必须拿到**同一个** `CompactionEngine` 模块实例
 *    （跨 realpath 的双实例会让 `ManualCompactionError instanceof` 失效 ⇒ 人类只看到裸错误）；
 * ③ 组内注册的 `compaction` **不得泄漏**到根 realm（`agent-presets/src/mount.ts` 的 leakedServices 会拒绝挂载）；
 * ④ host 平面发布的 `contextEconomy` 必须能从 **isolate 组内**解析到（缝的另一半）。
 *
 * 用法：`npm run probe:provider`（需先 `npm run build`）。只读：不写会话、不碰 ~/.dsh 的任何状态。
 * 输出确定性：无时间戳、无 ANSI。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const results = []
const check = (label, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  [${detail}]`}`)
}

// ① 静态面：preset 的 compaction 组里必须是我们的 provider 行，且不再有 compaction-basic。
const presetPath = path.join(ROOT, 'presets', 'price-less', 'agent.cordis.yml')
const preset = readFileSync(presetPath, 'utf8')
check('preset 组内挂 provider 行', preset.includes("name: 'dsh-price-less/provider'"))
check('preset 组内已无 compaction-basic', !preset.includes('@deepseek-ai/dsh-compaction-basic'))
check('preset 保留 command-compact', preset.includes("name: '@deepseek-ai/dsh-command-compact'"))

// ② 构建产物面：默认导出 = CompactionEngine 子类，且与探针自己 import 的是**同一模块实例**。
const { CompactionEngine, ManualCompactionError } = await import('@deepseek-ai/dsh-compaction')
const { Context } = await import('@deepseek-ai/cordis')
const built = path.join(ROOT, 'lib', 'platform', 'provider-entry.js')
const { default: Engine } = await import(new URL(`file:///${built.replaceAll('\\', '/')}`).href)
check('lib 里 provider 默认导出是 CompactionEngine 子类', Engine.prototype instanceof CompactionEngine)

// ③/④ 运行时面：复刻 preset 的 isolate 组（cordis:group 的 isolate 就是 `ctx.isolate(name)`）。
const root = new Context()
let hostCalls = 0
root.provide('contextEconomy', {
  compactNow: async () => {
    hostCalls++
    return {
      ok: true,
      result: {
        compactionId: 'ce-compact-boundary-task-1-0-3',
        startSeq: 4,
        summarySeq: 5,
        endSeq: 6,
        summaryText: 'R',
        shadowedRange: { start: 0, end: 3 },
        shadowedSeqs: [0, 1, 2, 3],
        shadowedTokenCount: 4242,
      },
    }
  },
})
const group = root.isolate('compaction').isolate('toolResultPruner')
new Engine(group)
check('组内解析到本插件 provider', group.compaction instanceof Engine)
check('根 realm 无 compaction（leakedServices 前提）', root.compaction === undefined)

const agent = { session: {}, options: {}, runMaintenance: (task) => task(new AbortController().signal) }
const signal = new AbortController().signal
const mapped = await group.compaction.compactNow(agent, signal, 'cmd-1')
check('host 面从 isolate 组内被解析到（缝）', hostCalls === 1, `calls=${hostCalls}`)
check(
  '官方 CompactionResult 8 字段映射',
  mapped !== null && String(mapped.compactionId) === 'ce-compact-boundary-task-1-0-3'
  && mapped.startSeq === 4 && mapped.summarySeq === 5 && mapped.endSeq === 6
  && mapped.summary[0]?.text === 'R' && mapped.shadowedSeqs.length === 4
  && mapped.shadowedRange.start === 0 && mapped.shadowedTokenCount === 4242
  && mapped.sourceCommandId === 'cmd-1',
)
check('自动触发 decline（不双触发）',
  await group.compaction.compactIfNeeded(agent, 'pressure', signal) === null && hostCalls === 1)
const busy = await group.compaction
  .compactNow({ ...agent, runMaintenance: () => { throw new Error('agent is active') } }, signal)
  .catch((error) => error)
check('非空闲 → ManualCompactionError(busy)',
  busy instanceof ManualCompactionError && busy.code === 'busy')
const refused = await group.compaction
  .compactRegion(0, 3, { session: {}, options: {} })
  .catch((error) => error)
check('compactRegion 明确拒绝（不改史）', refused instanceof Error && /not implemented/.test(refused.message))

const failed = results.filter((ok) => !ok).length
console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${results.length} checks)`)
process.exit(failed === 0 ? 0 : 1)

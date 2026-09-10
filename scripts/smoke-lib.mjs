/**
 * U8–U13 落地后的 **lib 级冒烟**（跑在构建产物 lib/ 上，不是 src）。
 * **常驻**（`npm run smoke:lib`，升级后必跑；读数记入 docs/ledger-history.md §82/§83）。
 *
 * ⚠️ 覆盖面仅限**插件侧回归**（U8–U13）。**harness 接触面不在本脚本内**——
 * `SESSION_LOG_INTENT` / `SESSION_FORMAT_VERSION` / 端点常量 / replace / 通道→`emitted`
 * 一项都没有（`docs/14 §4` 曾误称有，已于 2026-09-11 改正）。通道回环请跑
 * **`npm run probe:channel`**（`scripts/probe-channel.mjs`）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { resolveJudgeModel, CE_JUDGE_NO_ROUTE } from '../lib/domains/input.js'
import { resolveInitModel } from '../lib/domains/commands.js'
import { CE_LLM_TIMEOUT_CODE, CE_LLM_TIMEOUT_MS, streamCeLlm } from '../lib/platform/llm.js'
import { foldFileChains } from '../lib/core/assemble/chain.js'
import { segmentForSeq } from '../lib/core/restore/rebuild.js'
import { isPressureMaterial } from '../lib/core/compress/pressure.js'
import { LOG_COMMAND_RE } from '../lib/core/shear/tool.js'
import { RETRY_BUDGET, isTransientCompressFailure } from '../lib/domains/compaction.js'
import { foldJudgeLedger } from '../lib/core/judge.js'
import { createEventPump } from '../lib/platform/events.js'
import { resolveConfig } from '../lib/config.js'

const results = []
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const check = (name, ok, detail) => results.push({ name, ok, detail: String(detail) })

// ——— U8：无内置默认模型 ———
const cfg = resolveConfig({})
check('U8 resolveJudgeModel 无配置无会话模型 → undefined', resolveJudgeModel(cfg) === undefined, resolveJudgeModel(cfg))
check('U8 跟随会话模型', JSON.stringify(resolveJudgeModel(cfg, { provider: 'p', model: 'm' })) === '{"provider":"p","model":"m"}', resolveJudgeModel(cfg, { provider: 'p', model: 'm' }))
check('U8 resolveInitModel 无兜底', resolveInitModel(cfg) === undefined, resolveInitModel(cfg))
check('U8 无路由事实码', CE_JUDGE_NO_ROUTE === 'CE_JUDGE_NO_ROUTE', CE_JUDGE_NO_ROUTE)
check('U8 硬编码档已从 lib 消失', !JSON.stringify(resolveConfig({})).includes('expires-on-0910'), 'ok')

// ——— U10：流硬超时 ———
const hangSvc = { stream: () => (async function* () { await new Promise(() => {}) })() }
const t0 = Date.now()
const chunks = []
for await (const chunk of streamCeLlm({ llm: hangSvc }, { provider: 'p', model: 'm' }, { timeoutMs: 30 })) chunks.push(chunk)
const elapsed = Date.now() - t0
check('U10 永不结束的流被硬超时打断', chunks.length === 1 && chunks[0].reason?.failure?.code === CE_LLM_TIMEOUT_CODE, JSON.stringify(chunks))
check('U10 超时 1s 内返回', elapsed < 1000, `${elapsed}ms`)
check('U10 调用点预算常量', CE_LLM_TIMEOUT_MS.judge === 60000 && CE_LLM_TIMEOUT_MS.compaction === 180000, JSON.stringify(CE_LLM_TIMEOUT_MS))

// ——— U9：重试预算 / 段锚 / transient ———
check('U9 RETRY_BUDGET = 2', RETRY_BUDGET === 2, RETRY_BUDGET)
check('U9 shrink/storage/txn-* 皆 transient',
  isTransientCompressFailure({ outcome: 'skipped', reason: 'shrink' })
  && isTransientCompressFailure({ outcome: 'skipped', reason: 'storage' })
  && isTransientCompressFailure({ outcome: 'skipped', reason: 'txn-COMPACTION_ACTIVE_ORPHAN_CLOSED' })
  && !isTransientCompressFailure({ outcome: 'skipped', reason: 'range-empty' }),
  'ok')

// ——— U12.3：段区间两端闭 ———
const segs = [
  { taskId: 'task-1', startSeq: 0, endSeq: 9, closed: true, switchReason: 'verdict-new-task' },
  { taskId: 'task-2', startSeq: 10, endSeq: null, closed: false, switchReason: 'verdict-new-task' },
]
check('U12.3 verdict 边界端 seq 归前段', segmentForSeq(segs, 9)?.taskId === 'task-1', segmentForSeq(segs, 9)?.taskId)
check('U12.3 anchor 归后段', segmentForSeq(segs, 10)?.taskId === 'task-2', segmentForSeq(segs, 10)?.taskId)

// ——— U11.3 / U11.5 ———
const ev = (seq, type, data, extra = {}) => ({ seq, type, time: seq, data, ...extra })
check('U11.3 插件 notice 不是折叠材料',
  isPressureMaterial(ev(1, 'user/message', { content: [{ type: 'text', text: 'N' }], source: { kind: 'plugin', plugin: 'context-economy', form: 'notice' } })) === false,
  'ok')
check('U11.3 普通用户消息仍是材料',
  isPressureMaterial(ev(2, 'user/message', { content: [{ type: 'text', text: 'U' }], source: { kind: 'user' } })) === true,
  'ok')
check('U11.5 `npm run build` 是过程日志', LOG_COMMAND_RE.test('npm run build') === true, 'ok')
check('U11.5 `npm run my-script` 仍认', LOG_COMMAND_RE.test('npm run my-custom-script') === true, 'ok')
check('U11.5 `node run.py` 不认', LOG_COMMAND_RE.test('node run.py') === false, 'ok')
check('U11.5 `python run.py` 不认', LOG_COMMAND_RE.test('python run.py') === false, 'ok')

// ——— U13.3：逐字替换语义 ———
const lines10 = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n')
const delWithNl = foldFileChains([{ seq: 1, path: 'a.ts', kind: 'write', content: lines10 }, { seq: 2, path: 'a.ts', kind: 'edit', oldString: 'l3\n', newString: '' }]).get('a.ts')
check('U13.3 删除带换行 → 行数 10→9', delWithNl.versions[1].lineCount === 9, delWithNl.versions[1].lineCount)
const midEdit = foldFileChains([
  { seq: 1, path: 'b.ts', kind: 'write', content: 'const a = foo(1)\nconst b = 2' },
  { seq: 2, path: 'b.ts', kind: 'edit', oldString: 'foo(1)', newString: 'bar(1)' },
  { seq: 3, path: 'b.ts', kind: 'edit', oldString: 'const b = 2', newString: 'const b = 3' },
]).get('b.ts')
check('U13.3 行中间部分替换逐字生效', midEdit.versions[1].content[0] === 'const a = bar(1)', midEdit.versions[1].content[0])
check('U13.3 后续 edit 仍可定位（链未断）', midEdit.broken === false, midEdit.broken)

// ——— U13.4：未知 class 不产 NaN ———
const ledger = foldJudgeLedger([
  { seq: 1, time: 1, trigger: 'llm', decision: 'continue', class: 'action' },
  { seq: 2, time: 2, trigger: 'llm', decision: 'continue', class: 'bogus' },
])
check('U13.4 未知 class 不进分布', JSON.stringify(ledger.judgeVerdictDist) === '{"action":1,"pureQ":0,"verifyQ":0}', JSON.stringify(ledger.judgeVerdictDist))

// ——— U13.5：drain 分批 ———
{
  const listeners = new Map()
  const ctx = {
    on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn) },
  }
  const pump = createEventPump(ctx, { info() {}, warn() {}, error() {} })
  const seen = []
  let reentered = false
  pump.on('metrics/session-event', (payload) => {
    seen.push(payload.event.seq)
    if (!reentered) {
      reentered = true
      for (const n of [100, 101, 102]) pump.publish('metrics/session-event', { session: {}, event: { type: 'step/start', seq: n } })
    }
  })
  for (const fn of listeners.get('session/event')) fn({ header: {} }, { type: 'step/start', seq: 1, time: 1, data: {} })
  await new Promise((r) => setTimeout(r, 0))
  check('U13.5 自馈事件走下一轮且不丢', JSON.stringify(seen) === '[1,100,101,102]', JSON.stringify(seen))
  check('U13.5 派发计数与队列归零', pump.stats().dispatched === 4 && pump.stats().depth === 0, JSON.stringify(pump.stats()))
  pump.dispose()
}

// ——— U17④：压缩进度事实——宿主事实名 ↔ 客户端渲染面的**跨半边契约** ———
// 客户端不许 import 宿主源码（S4），两侧靠同一字面耦合 ⇒ 漂移是**静默**的（进度条永不出现，
// 无任何报错）。此处在产物层钉死：宿主 lib 的常量 === 客户端 bundle 里的字面。
{
  const { COMPACT_PROGRESS_FACT_TYPE } = await import('../lib/domains/compaction-facts.js')
  const clientBundle = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  check('U17④ 宿主进度事实名', COMPACT_PROGRESS_FACT_TYPE === 'context-economy/compact-progress', COMPACT_PROGRESS_FACT_TYPE)
  check('U17④ 客户端字面与宿主一致（静默漂移守卫）', clientBundle.includes(COMPACT_PROGRESS_FACT_TYPE), 'lib/client.js')
  check('U17④ 进度条槽位真的打进 bundle', clientBundle.includes('conversation.input.dock'), 'lib/client.js')
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  [${r.detail}]`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exit(1)

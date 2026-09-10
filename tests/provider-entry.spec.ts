/**
 * U17 取代路线：薄 provider（`ctx.compaction` 的本插件实现）的合同测试。
 *
 * 三件事必须被机械证明，否则整条路线只是"看起来对"：
 * ① **注册域**：provider 在 preset 的 `isolate: {compaction: true}` 组内注册 `compaction`，
 *    **不**泄漏到根 realm（`agent-presets/src/mount.ts` 的 `leakedServices` 会拒绝根 realm 泄漏的
 *    行，服务必须是组内私有的）；
 * ② **缝**：host 平面发布的 `contextEconomy`（**未被 isolate 列名**）从组内解析得到——
 *    这是"host 平面实现不被解析、必须走 preset 授权"（§87 §6）的另一半；
 * ③ **官方契约**：`compactNow` 用 `runMaintenance` 取得轮间独占、把域产物映射成 8 个必填字段、
 *    "没得压"回 `null`、真失败抛分类明确的 `ManualCompactionError`。
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction'
import { CONTEXT_ECONOMY_SERVICE, type CompactionHostFace } from '../src/platform/compaction-port.ts'
import { PriceLessCompactionEngine } from '../src/platform/provider-entry.ts'

/** 域侧产物样本（字段与官方 `CompactionResult` 逐一同形，见 platform/compaction-port.ts）。 */
const PRODUCT = {
  compactionId: 'ce-compact-boundary-task-1-0-3',
  startSeq: 4,
  summarySeq: 5,
  endSeq: 6,
  summaryText: 'R',
  shadowedRange: { start: 0, end: 3 },
  shadowedSeqs: [0, 1, 2, 3],
  shadowedTokenCount: 4242,
} as const

const SIGNAL = new AbortController().signal

function agentOf(
  runMaintenance: ManualCompactAgentContext['runMaintenance'] = (task) => task(new AbortController().signal),
): ManualCompactAgentContext {
  return { session: {} as never, options: {}, runMaintenance }
}

/** host 面替身：记录调用次数并回放给定结局。 */
function hostOf(outcome: Awaited<ReturnType<CompactionHostFace['compactNow']>>): {
  face: CompactionHostFace
  calls: number
} {
  const state = { calls: 0 }
  return {
    face: {
      compactNow: async () => {
        state.calls++
        return outcome
      },
    },
    get calls() { return state.calls },
  } as { face: CompactionHostFace; calls: number }
}

describe('U17 provider：注册域与 isolate 缝（§87 §6 的另一半）', () => {
  it('组内注册 compaction 且**不**泄漏到根 realm；组内能解析 host 平面的 contextEconomy', async () => {
    const root = new Context()
    const host = hostOf({ ok: true, result: PRODUCT })
    root.provide(CONTEXT_ECONOMY_SERVICE, host.face)
    // 复刻 preset 的 isolate 组：只隔离那两个列名服务（presets/standard/agent.cordis.yml:138-143）。
    const group = root.isolate('compaction').isolate('toolResultPruner')
    // 实例本身不再直接使用：下面一律经**组内解析到的服务**调用，identity 由 instanceof 表述。
    void new PriceLessCompactionEngine(group)

    // 组内解析得到本 provider（`command-compact` 就在同一个组里，这是取代能生效的全部理由）。
    // 用 `toBeInstanceOf` 而非 `toBe`：cordis 读服务返回的是该实例的**服务代理**
    // （同 harness 的 `compaction/tests/compaction.spec.ts:99`），身份用 instanceof 表达。
    expect(group.compaction).toBeInstanceOf(PriceLessCompactionEngine)
    // 根 realm **取不到**：agent-presets 的 leakedServices 因此不会拒绝本行
    expect(root.compaction).toBeUndefined()

    // 经**组内解析到的那一个**服务调用（而不是手里的 engine 变量）：行为上证明组内那一个
    // 就是我们注册的实例，且它经 host 面回到了 host 平面。
    const result = await group.compaction.compactNow(agentOf(), SIGNAL, undefined)
    expect(host.calls).toBe(1)
    expect(result?.compactionId).toBe(PRODUCT.compactionId)
  })
})

describe('U17 provider：官方结果契约映射（8 个必填字段）', () => {
  it('compactNow 在 runMaintenance 内落刀，且逐字段映射 + sourceCommandId 透传', async () => {
    const ctx = new Context()
    const host = hostOf({ ok: true, result: PRODUCT })
    ctx.provide(CONTEXT_ECONOMY_SERVICE, host.face)
    const engine = new PriceLessCompactionEngine(ctx)
    const runMaintenance = vi.fn((task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal))

    const result = await engine.compactNow(agentOf(runMaintenance), SIGNAL, 'cmd-1' as never)

    // 轮间独占：手工压缩必须在 runMaintenance 里发生（turn:null 的轮间括号由它保证）
    expect(runMaintenance).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      compactionId: PRODUCT.compactionId,
      sourceCommandId: 'cmd-1',
      startSeq: 4,
      summarySeq: 5,
      endSeq: 6,
      summary: [{ type: 'text', text: 'R' }],
      shadowedRange: { start: 0, end: 3 },
      shadowedSeqs: [0, 1, 2, 3],
      shadowedTokenCount: 4242,
    })
  })

  it('自动触发一律 decline（返回 null，绝不与 host 平面的自动路径双触发）', async () => {
    const ctx = new Context()
    const host = hostOf({ ok: true, result: PRODUCT })
    ctx.provide(CONTEXT_ECONOMY_SERVICE, host.face)
    const engine = new PriceLessCompactionEngine(ctx)
    expect(await engine.compactIfNeeded({ session: {} as never, options: {} }, 'pressure', SIGNAL)).toBeNull()
    expect(await engine.compactIfNeeded({ session: {} as never, options: {} }, 'context-overflow', SIGNAL)).toBeNull()
    // decline 不等于委派：host 面一次都没被碰
    expect(host.calls).toBe(0)
  })
})

describe('U17 provider：失败分类（人话由 command-compact 按分类渲染）', () => {
  it('"没得压"回 null（契约允许的正常结局，不是错误）', async () => {
    const ctx = new Context()
    ctx.provide(CONTEXT_ECONOMY_SERVICE, hostOf({ ok: false, reason: 'range-empty' }).face)
    const engine = new PriceLessCompactionEngine(ctx)
    expect(await engine.compactNow(agentOf(), SIGNAL)).toBeNull()
  })

  it('真失败抛分类明确的 ManualCompactionError（并入 cause 的可读原因）', async () => {
    const cases: Array<[string, string]> = [
      ['shrink', 'summary'],
      ['llm-unavailable', 'summary'],
      ['txn-conflict', 'commit'],
      ['storage', 'persistence'],
      ['chain-invalid', 'changed'],
      ['domain-unavailable', 'changed'],
      ['disposed', 'busy'],
    ]
    for (const [reason, code] of cases) {
      const ctx = new Context()
      ctx.provide(CONTEXT_ECONOMY_SERVICE, hostOf({ ok: false, reason }).face)
      const engine = new PriceLessCompactionEngine(ctx)
      const error = await engine.compactNow(agentOf(), SIGNAL).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ManualCompactionError)
      expect((error as ManualCompactionError).code).toBe(code)
      expect((error as ManualCompactionError).message).toContain(reason)
    }
  })

  it('agent 非空闲（runMaintenance 同步抛）→ busy', async () => {
    const ctx = new Context()
    ctx.provide(CONTEXT_ECONOMY_SERVICE, hostOf({ ok: true, result: PRODUCT }).face)
    const engine = new PriceLessCompactionEngine(ctx)
    const error = await engine.compactNow(agentOf(() => {
      throw new Error('agent is active')
    }), SIGNAL).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ManualCompactionError)
    expect((error as ManualCompactionError).code).toBe('busy')
  })

  it('host 面缺失 → busy（挂载期另有 inactiveRows 报 "waiting for contextEconomy"）', async () => {
    const engine = new PriceLessCompactionEngine(new Context())
    const error = await engine.compactNow(agentOf(), SIGNAL).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ManualCompactionError)
    expect((error as ManualCompactionError).code).toBe('busy')
  })

  it('已中止的信号原样抛出（契约：aborted request preserves its exact abort reason）', async () => {
    const ctx = new Context()
    ctx.provide(CONTEXT_ECONOMY_SERVICE, hostOf({ ok: true, result: PRODUCT }).face)
    const engine = new PriceLessCompactionEngine(ctx)
    const controller = new AbortController()
    const reason = new Error('cancelled by user')
    controller.abort(reason)
    await expect(engine.compactNow(agentOf(), controller.signal)).rejects.toBe(reason)
  })
})

describe('U17 provider：compactRegion 明确拒绝', () => {
  it('无强制区间入口 → 响亮失败（不改史的失败才朝用户数据安全侧）', async () => {
    const engine = new PriceLessCompactionEngine(new Context())
    await expect(engine.compactRegion(0 as never, 3 as never, { session: {} as never, options: {} }))
      .rejects.toThrow(/compactRegion is not implemented/)
  })
})

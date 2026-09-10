/**
 * P20a 压力路径纯核单测（docs/implement/archive/P20-pressure-and-fuse.md §5；docs/04 §3/§5/§7）。
 * 触发阈值（绝对设计值为主 + 比例 fallback）/ 断路器 / 检查点渲染 / 续传拼接 /
 * 折叠区材料转写（含被遮蔽原文）/ pressure-fired fold / 同输入同账。
 */
import { describe, expect, it } from 'vitest'
import { expectedReplaceOp } from './replace-op.ts'
import {
  PRESSURE_CHAIN_LIMIT,
  PRESSURE_EMERGENCY_LIMIT,
  PRESSURE_FIRED_FACT_TYPE,
  PRESSURE_RATIO,
  composePressureArchive,
  foldMaterialTokens,
  foldPressureFires,
  isPressureMaterial,
  pressureBreakerTripped,
  pressureChainDepth,
  pressureThreshold,
  renderCheckpoint,
  renderFoldMaterialTranscript,
  shouldFirePressure,
} from '../src/core/compress/index.ts'
import type { LedgerSessionEvent } from '../src/core/ledger/types.ts'

const ev = (seq: number, type: string, data: unknown, surfaceOp?: unknown): LedgerSessionEvent =>
  ({ seq, type, time: seq, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) }) as LedgerSessionEvent

const text = (value: string) => ({ type: 'text', text: value })

const SAMPLE: LedgerSessionEvent[] = [
  ev(0, 'user/message', { content: [text('head')], source: { kind: 'user' } }, 'append'),
  ev(1, 'assistant/message', { message: { content: [text('mid')] } }, 'append'),
  ev(2, 'tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [text('tail')] }] } }, 'append'),
  ev(3, 'compaction/start', { compactionId: 'x', turn: 1 }),
  ev(4, 'user/message', { content: [text('C1')], source: { kind: 'plugin', plugin: 'compact' } }, expectedReplaceOp(0, 2)),
  ev(5, 'context-economy/compress-run', { at: 1 }),
  // U11.3：本插件自己的 notice（source.kind='plugin'，plugin 名**不是** compact）——旧实现只认
  // plugin==='compact'，于是这条被当成原文材料再折一遍（双份摘要 + foldedTokens 虚高）。
  ev(6, 'user/message', {
    content: [text('NOTICE: 已压缩 task-1')],
    source: { kind: 'plugin', plugin: 'context-economy', form: 'notice', summary: '已压缩 task-1' },
  }, 'append'),
]

describe('P20a 压力纯核：阈值与断路器', () => {
  it('触发阈值优先级：主模型窗口比例 → 假定窗口比例 → 绝对安全网（P20c 默认 0.35）', () => {
    expect(PRESSURE_RATIO).toBe(0.35)
    // ① 窗口已知：比例 × 窗口
    expect(pressureThreshold({ contextWindow: 128000, pressureRatio: 0.35, domainTokens: 125000, thresholdTokens: 100000 })).toBe(44800)
    // ② 窗口未知：比例 × 假定窗口（domainTokens）
    expect(pressureThreshold({ pressureRatio: 0.35, domainTokens: 125000, thresholdTokens: 100000 })).toBe(43750)
    // ③ 比例不可用：绝对安全网
    expect(pressureThreshold({ thresholdTokens: 100000, domainTokens: 125000 })).toBe(100000)
    expect(pressureThreshold({ pressureRatio: 0, thresholdTokens: 100000 })).toBe(100000)
    // ④ 全不可用
    expect(pressureThreshold({})).toBeUndefined()
    expect(pressureThreshold({ contextWindow: Number.NaN, domainTokens: Number.NaN, thresholdTokens: Number.NaN })).toBeUndefined()
  })

  it('shouldFirePressure：达阈触发；坏计量/无阈值不触发', () => {
    expect(shouldFirePressure({ wireTokens: 44800, contextWindow: 128000, pressureRatio: 0.35 })).toBe(true)
    expect(shouldFirePressure({ wireTokens: 44799, contextWindow: 128000, pressureRatio: 0.35 })).toBe(false)
    expect(shouldFirePressure({ wireTokens: 43750, pressureRatio: 0.35, domainTokens: 125000 })).toBe(true)
    expect(shouldFirePressure({ wireTokens: 100000, thresholdTokens: 100000 })).toBe(true)
    expect(shouldFirePressure({ wireTokens: 99999, thresholdTokens: 100000 })).toBe(false)
    expect(shouldFirePressure({ wireTokens: Number.NaN, thresholdTokens: 1 })).toBe(false)
    expect(shouldFirePressure({ wireTokens: 10 })).toBe(false)
  })

  it('链深 = 检查点条目数；常规上限 3、紧急折叠硬上限 6', () => {
    expect(pressureChainDepth([])).toBe(0)
    expect(pressureChainDepth([{ taskId: 't', kind: 'checkpoint', text: 'a' }])).toBe(1)
    expect(pressureBreakerTripped(PRESSURE_CHAIN_LIMIT - 1)).toBe(false)
    expect(pressureBreakerTripped(PRESSURE_CHAIN_LIMIT)).toBe(true)
    expect(PRESSURE_EMERGENCY_LIMIT).toBe(PRESSURE_CHAIN_LIMIT + 3)
  })
})

describe('P20a 压力纯核：检查点渲染与续传拼接', () => {
  const checkpoint = { progress: 'P', currentState: 'S', nextStep: 'N', liveConstraints: ['  ', 'C-a', 'C-b'] }

  it('检查点渲染：字段序固定 + 空约束省略 + 空白约束剔除 + 字节稳定', () => {
    const rendered = renderCheckpoint(checkpoint)
    expect(rendered).toBe('进度：P\n当前状态：S\n下一步：N\n仍生效的约束：\n- C-a\n- C-b')
    expect(renderCheckpoint(checkpoint)).toBe(rendered)
    expect(renderCheckpoint({ ...checkpoint, liveConstraints: [] })).not.toContain('约束')
  })

  it('续传拼接 = 旧检查点链 + 新检查点 + 保留区逐字（空块省略）', () => {
    const out = composePressureArchive({
      priorChain: [{ taskId: 't', kind: 'checkpoint', text: 'C1' }, { taskId: 't', kind: 'checkpoint', text: 'C2' }],
      checkpointText: 'C3',
      retainedText: 'R3',
    })
    expect(out).toBe('C1\n\nC2\n\nC3\n\nR3')
    expect(composePressureArchive({ priorChain: [], checkpointText: 'C', retainedText: '' })).toBe('C')
  })
})

describe('P20a 压力纯核：折叠区材料转写', () => {
  it('材料判据：四类可读材料；压缩协议/事实/检查点节点剔除', () => {
    expect(isPressureMaterial(SAMPLE[0]!)).toBe(true)
    expect(isPressureMaterial(SAMPLE[1]!)).toBe(true)
    expect(isPressureMaterial(SAMPLE[2]!)).toBe(true)
    expect(isPressureMaterial(SAMPLE[3]!)).toBe(false)
    expect(isPressureMaterial(SAMPLE[4]!)).toBe(false)
    expect(isPressureMaterial(SAMPLE[5]!)).toBe(false)
    // U11.3：**一切** plugin 源消息（含本插件 notice）都不是任务材料
    expect(isPressureMaterial(SAMPLE[6]!)).toBe(false)
  })

  it('折叠区 = 上次缝之后的原始材料（被遮蔽原文重新可见，检查点节点不重复入料）', () => {
    const transcript = renderFoldMaterialTranscript(SAMPLE, { startSeq: 0, endSeq: 6 })
    expect(transcript).toContain('head')
    expect(transcript).toContain('mid')
    expect(transcript).toContain('tail')
    expect(transcript).not.toContain('C1')
    expect(transcript).not.toContain('NOTICE')
    expect(transcript).not.toContain('compaction/start')
    expect(foldMaterialTokens(SAMPLE, { startSeq: 0, endSeq: 6 })).toBeGreaterThan(0)
  })
})

describe('P20a 压力纯核：pressure-fired 账本', () => {
  const fact = (data: Record<string, unknown>, seq: number) => ({ type: PRESSURE_FIRED_FACT_TYPE, seq, time: seq, data })

  it('四字段 fold：fired 次数/触发 wire/最大链深/断路器次数', () => {
    const ledger = foldPressureFires([
      fact({ at: 1, wireTokens: 120000, thresholdTokens: 100000, outcome: 'fired', chainDepth: 0 }, 1),
      fact({ at: 2, wireTokens: 130000, thresholdTokens: 100000, outcome: 'fired', chainDepth: 1, emergency: true }, 2),
      fact({ at: 3, wireTokens: 0, thresholdTokens: 100000, outcome: 'breaker', chainDepth: 3 }, 3),
      fact({ at: 4, wireTokens: 0, thresholdTokens: 100000, outcome: 'skip', reason: 'no-units', chainDepth: 0 }, 4),
      { type: PRESSURE_FIRED_FACT_TYPE, seq: 5, time: 5, data: null },
      { type: 'other/fact', seq: 6, time: 6, data: {} },
    ])
    expect(ledger.pressureFireCount).toBe(2)
    expect(ledger.pressureTriggerWireTokens).toBe(250000)
    expect(ledger.pressureChainDepth).toBe(3)
    expect(ledger.pressureBreakerTrips).toBe(1)
    expect(ledger.skips).toBe(1)
    expect(ledger.emergencies).toBe(1)
  })

  it('同输入同账（双跑逐字节一致）', () => {
    const facts = [fact({ at: 1, wireTokens: 1, thresholdTokens: 1, outcome: 'fired', chainDepth: 0 }, 1)]
    expect(JSON.stringify(foldPressureFires(facts))).toBe(JSON.stringify(foldPressureFires(facts)))
  })
})

/**
 * P16a 对话剪切纯核单测（docs/03 §3/§7；工单 §5）——纯 fixture 回放，零 harness/IO。
 * 覆盖：run 分段与边界、吸收证明、结论三档、观察窗、指令词黑名单、结论预算、确定性双跑。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RUN_POLICY,
  RUN_CLASS_FACT_TYPE,
  extractVerifyEvidence,
  foldRunShear,
  isNeutralConclusion,
  salientTokens,
  type RunEvent,
  type RunPolicy,
} from '../src/core/shear/run.ts'
import { JUDGE_RECORDED_FACT_TYPE } from '../src/domains/judge-facts.ts'

const u = (seq: number, text: string): RunEvent => ({ kind: 'user-message', seq, time: seq, text })
const a = (seq: number, text: string): RunEvent => ({ kind: 'assistant-message', seq, time: seq, text })
const t = (seq: number, text: string): RunEvent => ({ kind: 'tool-result', seq, time: seq, text })
const v = (seq: number, anchorSeq: number, klass: 'action' | 'pureQ' | 'verifyQ', decision: 'continue' | 'new-task' = 'continue'): RunEvent =>
  ({ kind: 'verdict', seq, time: seq, anchorSeq, decision, klass })
const plan = (seq: number, items: { startSeq: number; endSeq: number; note: string }[]): RunEvent => ({ kind: 'star-plan', seq, time: seq, items })

describe('foldRunShear（对话 run 状态机）', () => {
  it('短 run（≤2 对）+ 动作吸收证明 → 机械摘句落刀', () => {
    const events = [
      u(1, '为什么要用 A？'), v(2, 1, 'pureQ'), a(3, '因为 B 更稳。'),
      u(4, '那 C 呢？'), v(5, 4, 'pureQ'), a(6, 'C 也可以，但慢。'),
      u(7, '开始改吧'), v(8, 7, 'action'),
    ]
    const planOut = foldRunShear(events)
    expect(planOut.ops).toHaveLength(1)
    const op = planOut.ops[0]!
    expect(op).toMatchObject({ key: 'run|1', startSeq: 1, endSeq: 6, runClass: 'pureQ', pairs: 2, conclusionTier: 'mechanical-quote' })
    expect(op.conclusion).toBe('已吸收：关于「为什么要用 A？」的 2 轮问答，结论：C 也可以，但慢。（用户已确认理解）')
    expect(planOut.backlogDepth).toBe(0)
    expect(planOut.decisions[0]).toMatchObject({ runKey: '1..6', decision: 'cut', reason: 'absorbed' })
  })

  it('长 run（> 短 run 上限）无星标注记 → hold long-run-needs-star（零 LLM 调用）', () => {
    const events = [
      u(1, 'Q1'), v(2, 1, 'pureQ'), a(3, 'A1'),
      u(4, 'Q2'), v(5, 4, 'pureQ'), a(6, 'A2'),
      u(7, 'Q3'), v(8, 7, 'pureQ'), a(9, 'A3'),
      u(10, '动手'), v(11, 10, 'action'),
    ]
    const out = foldRunShear(events)
    expect(out.ops).toHaveLength(0)
    expect(out.decisions).toEqual([{ runKey: '1..9', decision: 'hold', reason: 'long-run-needs-star' }])
  })

  it('验证 run → 判决提取（退出码机械）', () => {
    const events = [
      u(1, '跑一下测试'), v(2, 1, 'verifyQ'), t(3, 'ok\n[exit code: 0]\ndone'), a(4, '通过了'),
      u(5, '继续改'), v(6, 5, 'action'),
    ]
    const out = foldRunShear(events)
    expect(out.ops).toHaveLength(1)
    expect(out.ops[0]!.conclusionTier).toBe('verdict-extract')
    expect(out.ops[0]!.conclusion).toBe('已验证：跑一下测试，依据：[exit code: 0]（用户已确认理解）')
  })

  it('验证 run 无机械证据 → hold verify-no-evidence', () => {
    const events = [
      u(1, '确认没坏'), v(2, 1, 'verifyQ'), a(3, '看起来没问题'),
      u(4, '好的继续'), v(5, 4, 'action'),
    ]
    expect(foldRunShear(events).decisions).toEqual([{ runKey: '1..3', decision: 'hold', reason: 'verify-no-evidence' }])
  })

  it('验证类前向观察窗命中指纹 → hold verify-dependency-window', () => {
    const events = [
      u(1, '跑一下 gate 测试'), v(2, 1, 'verifyQ'), t(3, 'gate 全绿\n[exit code: 0]'), a(4, '通过'),
      u(5, '那 gate 的 D10 断言呢？'), v(6, 5, 'action'),
    ]
    expect(foldRunShear(events).decisions).toEqual([{ runKey: '1..4', decision: 'hold', reason: 'verify-dependency-window' }])
  })

  it('星标剪切清单覆盖长 run → star-note 落刀（选坐标不造坐标）', () => {
    const events = [
      u(1, 'Q1'), v(2, 1, 'pureQ'), a(3, 'A1'),
      u(4, 'Q2'), v(5, 4, 'pureQ'), a(6, 'A2'),
      u(7, 'Q3'), v(8, 7, 'pureQ'), a(9, 'A3'),
      plan(10, [{ startSeq: 1, endSeq: 9, note: '三轮讨论结论是 A' }]),
    ]
    const out = foldRunShear(events)
    expect(out.ops).toHaveLength(1)
    expect(out.ops[0]!.conclusionTier).toBe('star-note')
    expect(out.ops[0]!.conclusion).toBe('已吸收：关于「Q1」的 3 轮问答，结论：三轮讨论结论是 A（用户已确认理解）')
  })

  it('异类切换 = 边界：pureQ 串与 verifyQ 串分列，各自无证明 → 积压', () => {
    const events = [
      u(1, 'Q1'), v(2, 1, 'pureQ'), a(3, 'A1'),
      u(4, '验证下'), v(5, 4, 'verifyQ'), a(6, '好'),
    ]
    const out = foldRunShear(events)
    expect(out.ops).toHaveLength(0)
    expect(out.records.map((r) => r.key)).toEqual(['1..3', '4..6'])
    expect(out.backlogDepth).toBe(2)
    expect(out.decisions.every((d) => d.reason === 'await-absorb-proof')).toBe(true)
  })

  it('new-task 判决 = 机械边界（不开新 run）', () => {
    const events = [
      u(1, 'Q1'), v(2, 1, 'pureQ'), a(3, 'A1'),
      u(4, '换个任务'), v(5, 4, 'pureQ', 'new-task'), a(6, '好'),
    ]
    const out = foldRunShear(events)
    expect(out.ops).toHaveLength(0)
    expect(out.records.map((r) => r.key)).toEqual(['1..3'])
    expect(out.backlogDepth).toBe(1)
  })

  it('答案未交付不能剪，也不计积压', () => {
    const events = [u(1, 'Q1'), v(2, 1, 'pureQ')]
    const out = foldRunShear(events)
    expect(out.ops).toHaveLength(0)
    expect(out.backlogDepth).toBe(0)
    expect(out.decisions).toEqual([{ runKey: '1..1', decision: 'keep', reason: 'answer-not-delivered' }])
  })

  it('结论体命中指令词 → hold conclusion-not-neutral（引用内原话不参与判定）', () => {
    const events = [
      u(1, '需要改哪里？'), v(2, 1, 'pureQ'), a(3, '请务必先改 A。'),
      u(4, '动手'), v(5, 4, 'action'),
    ]
    expect(foldRunShear(events).decisions).toEqual([{ runKey: '1..3', decision: 'hold', reason: 'conclusion-not-neutral' }])
  })

  it('结论句预算：截断安全且包装完整', () => {
    const long = '结论' + '字'.repeat(400) + '。'
    const events = [
      u(1, 'Q1'), v(2, 1, 'pureQ'), a(3, long),
      u(4, '动手'), v(5, 4, 'action'),
    ]
    const op = foldRunShear(events).ops[0]!
    expect(op.conclusion.length).toBeLessThanOrEqual(DEFAULT_RUN_POLICY.conclusionMaxChars)
    expect(op.conclusion.endsWith('（用户已确认理解）')).toBe(true)
    expect(op.conclusion).toContain('已吸收：关于「Q1」的 1 轮问答，结论：')
  })

  it('同输入双跑逐字相等，输入不被 mutate', () => {
    const events = [
      u(1, 'Q1'), v(2, 1, 'pureQ'), a(3, 'A1'), u(4, '动手'), v(5, 4, 'action'),
    ]
    const snapshot = JSON.stringify(events)
    const first = JSON.stringify(foldRunShear(events))
    const second = JSON.stringify(foldRunShear(events))
    expect(second).toBe(first)
    expect(JSON.stringify(events)).toBe(snapshot)
  })

  it('无分类输入 → 全 keep（失败默认保留，零成本）', () => {
    const out = foldRunShear([u(1, 'Q1'), a(2, 'A1'), u(3, 'Q2'), a(4, 'A2')])
    expect(out.ops).toHaveLength(0)
    expect(out.records).toHaveLength(0)
    expect(out.backlogDepth).toBe(0)
  })

  it('策略可注入：shortRunMaxPairs 收紧后短 run 也 hold', () => {
    const strict: RunPolicy = { ...DEFAULT_RUN_POLICY, shortRunMaxPairs: 0 }
    const events = [u(1, 'Q1'), v(2, 1, 'pureQ'), a(3, 'A1'), u(4, '动手'), v(5, 4, 'action')]
    expect(foldRunShear(events, strict).decisions[0]).toMatchObject({ decision: 'hold', reason: 'long-run-needs-star' })
  })
})

describe('run 纯核工具函数', () => {
  it('salientTokens：只取 ≥4 字符 ASCII 标识/路径/数值，小写去重', () => {
    expect(salientTokens('改 src/core/shear/run.ts 的 RUN_POLICY_VERSION，共 3 处 a b')).toEqual([
      'src/core/shear/run.ts', 'run_policy_version',
    ])
  })

  it('extractVerifyEvidence：退出码 / 测试计数 / PASS-FAIL 三路', () => {
    expect(extractVerifyEvidence('x\n[exit code: 2]\ny')).toBe('[exit code: 2]')
    expect(extractVerifyEvidence('307 tests passed')).toBe('307 tests passed')
    expect(extractVerifyEvidence('全部 PASS')).toBe('全部 PASS')
    expect(extractVerifyEvidence('没有可提取的判决')).toBeUndefined()
  })

  it('isNeutralConclusion：换行/空串/指令词一律不中立', () => {
    expect(isNeutralConclusion('已吸收：结论是 A（用户已确认理解）')).toBe(true)
    expect(isNeutralConclusion('结论：请改 A')).toBe(false)
    expect(isNeutralConclusion('第一行\n第二行')).toBe(false)
    expect(isNeutralConclusion('   ')).toBe(false)
  })

  it('分类事实名与判别域常量同源（跨层字符串漂移守卫）', () => {
    expect(RUN_CLASS_FACT_TYPE).toBe(JUDGE_RECORDED_FACT_TYPE)
  })
})

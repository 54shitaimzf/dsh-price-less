/**
 * P15a 工具剪切纯核测试（docs/implement/archive/P15a-shear-tool-core.md §5；docs/03 §7 协议级断言）。
 * 九组：谓词与三级回退 / T-entry / T-loop / T-note / T0 / T0-R / 配对与边界搭车 / 确定性 / P15b 接线缝。
 * 纯核测试：零 cordis 运行时、零 IO、零模型。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIFECYCLE,
  DEFAULT_SHEAR_POLICY,
  SHEAR_POLICY_VERSION,
  admitEntry,
  admitLoop,
  admitNote,
  assertPairing,
  SHEAR_NOTE_TEMPLATE,
  SHEAR_NOTE_TEMPLATE_VERSION,
  buildLoopStub,
  buildSupersededStub,
  foldToolShear,
  genericCutEligible,
  indentLevelOf,
  isBoundaryRideCandidate,
  isDeclarationTable,
  noteEligible,
  parseNoteMarker,
  parseReadEnvelope,
  pathOfCall,
  repairReadAfterWrite,
  resolveLifecycle,
  shapeEntryContent,
  textOfContentBlocks,
  toolCategory,
  utf8ByteLength,
  type ShearEvent,
} from '../src/core/shear/index.ts'

const call = (seq: number, time: number, callId: string, name: string, args: Record<string, unknown>): ShearEvent => ({
  kind: 'tool-call',
  call: { seq, time, callId, name, argsText: JSON.stringify(args) },
})
const result = (seq: number, time: number, callId: string, text: string): ShearEvent => ({
  kind: 'tool-result',
  result: { seq, time, callId, text },
})
const assistant = (seq: number, time: number, text: string): ShearEvent => ({ kind: 'assistant-message', seq, time, text })
const user = (seq: number, time: number, text: string): ShearEvent => ({ kind: 'user-message', seq, time, text })
const bigLog = (lines: number): string => Array.from({ length: lines }, (_, i) => `line ${i + 1}: ${'x'.repeat(40)}`).join('\n')
const readText = ['1: const a = 1', '2: export const x = 2', '3: export const y = 3', '4: const b = 4'].join('\n')
const readCall = call(1, 10, 'r1', 'read', { file_path: 'src/index.ts' })
const readResult = result(2, 11, 'r1', readText)

describe('P15a §1 谓词与三级回退', () => {
  it('类别启发式覆盖 read/write/search/cmd/other', () => {
    expect(toolCategory('read')).toBe('read')
    expect(toolCategory('edit')).toBe('write')
    expect(toolCategory('write')).toBe('write')
    expect(toolCategory('grep')).toBe('search')
    expect(toolCategory('pwsh')).toBe('cmd')
    expect(toolCategory('mystery')).toBe('other')
  })
  it('referenceKeys/rederiveCost/supersededBy/referencedBy 为纯谓词', () => {
    const read = { seq: 1, time: 10, callId: 'c1', name: 'read', argsText: JSON.stringify({ file_path: 'src/a.ts' }) }
    const edit = { seq: 2, time: 20, callId: 'c2', name: 'edit', argsText: JSON.stringify({ file_path: 'src/a.ts' }) }
    expect(DEFAULT_LIFECYCLE.referenceKeys(read)).toContain('src/a.ts')
    expect(DEFAULT_LIFECYCLE.rederiveCost(read)).toBe('cheap')
    expect(DEFAULT_LIFECYCLE.rederiveCost(edit)).toBe('expensive')
    expect(DEFAULT_LIFECYCLE.supersededBy(read, edit)).toBe(true)
    expect(DEFAULT_LIFECYCLE.supersededBy(edit, read)).toBe(false)
    expect(DEFAULT_LIFECYCLE.referencedBy(read, user(3, 30, '再看 src/a.ts'))).toBe(true)
    expect(DEFAULT_LIFECYCLE.referencedBy(read, user(4, 40, '无关'))).toBe(false)
  })
  it('三级回退：自带策略优先，缺省回落类别启发式；通用体积年龄规则为大而久', () => {
    const read = { seq: 1, time: 0, callId: 'c1', name: 'read', argsText: '{}' }
    const declared = { ...DEFAULT_LIFECYCLE, rederiveCost: () => 'trivial' as const }
    expect(resolveLifecycle(declared).rederiveCost(read)).toBe('trivial')
    expect(resolveLifecycle().rederiveCost(read)).toBe('cheap')
    expect(genericCutEligible(20_000, 700_000)).toBe(true)
    expect(genericCutEligible(20_000, 1_000)).toBe(false)
    expect(pathOfCall(read)).toBeUndefined()
  })
  it('策略初值集中且版本化（docs/03 §8）', () => {
    expect(SHEAR_POLICY_VERSION).toBe(1)
    expect(DEFAULT_SHEAR_POLICY).toEqual({ version: 1, noteMinBytes: 8192, loopMaxConclusionChars: 120, t0rMaxSegments: 4, t0rMaxIndent: 1 })
  })
})

describe('P15a §2 T-entry 写时整形', () => {
  it('cmd 成功长输出 → 保首尾 + 中性省略标记（零转写、无插件标签）', () => {
    const shaped = shapeEntryContent({ seq: 1, time: 0, callId: 'c1', name: 'bash', argsText: '{}' }, bigLog(20))
    expect(shaped).toBeDefined()
    expect(shaped).toContain('line 1:')
    expect(shaped).toContain('line 20:')
    expect(shaped).toContain('省略')
    expect(shaped).not.toContain('T-entry')
    const admission = admitEntry({ seq: 1, time: 0, callId: 'c1', name: 'bash', argsText: '{}' }, bigLog(20))
    expect(admission.decision).toBe('cut')
    expect(admission.op?.kind).toBe('shape-entry')
  })
  it('失败 → 保错因；read 类与短输出 → 不动刀', () => {
    const failed = ['$ build', ...Array.from({ length: 10 }, (_, i) => `noise ${i}`), 'ERROR: boom', '[exit code: 1]'].join('\n')
    const shaped = shapeEntryContent({ seq: 1, time: 0, callId: 'c1', name: 'pwsh', argsText: '{}' }, failed)
    expect(shaped).toContain('ERROR: boom')
    expect(shaped).toContain('[exit code: 1]')
    expect(shapeEntryContent({ seq: 1, time: 0, callId: 'c2', name: 'read', argsText: '{}' }, bigLog(20))).toBeUndefined()
    expect(shapeEntryContent({ seq: 1, time: 0, callId: 'c3', name: 'bash', argsText: '{}' }, 'ok\n')).toBeUndefined()
  })
})

describe('P15a §3 T-loop 占位替换', () => {
  it('cmd + 极短结论 → stub 占位（保配对）；read 类排除；结论过长 → 不动刀', () => {
    const cmd = { seq: 1, time: 0, callId: 'c1', name: 'bash', argsText: '{}' }
    expect(admitLoop(cmd, '退出码 0').op?.kind).toBe('stub-replace')
    expect(buildLoopStub('退出码 0')).toContain('退出码 0')
    expect(admitLoop({ ...cmd, name: 'read' }, '短').reason).toBe('loop-category')
    expect(admitLoop(cmd, 'x'.repeat(200)).reason).toBe('loop-conclusion-too-long')
    expect(admitLoop(cmd, '   ').reason).toBe('loop-empty-conclusion')
  })
})

describe('P15a §4 T-note 注记协商', () => {
  const cmd = { seq: 1, time: 0, callId: 'c1', name: 'bash', argsText: '{}' }
  const big = 'x'.repeat(DEFAULT_SHEAR_POLICY.noteMinBytes + 1)
  it('无标记 / 坏标记 / 超时三路注入 → 全部默认保留', () => {
    expect(admitNote(cmd, big, '就是一段普通叙述').decision).toBe('keep')
    expect(admitNote(cmd, big, 'CUT-OK:').decision).toBe('keep')
    expect(admitNote(cmd, big, 'CUT-OK: 有结论', { timedOut: true }).reason).toBe('note-timeout')
  })
  it('准入闸：体积阈值 / 非 read / 非问答', () => {
    expect(admitNote(cmd, 'small', 'CUT-OK: 结论').reason).toBe('note-below-threshold')
    expect(admitNote({ ...cmd, name: 'read' }, big, 'CUT-OK: 结论').reason).toBe('note-read-excluded')
    expect(admitNote({ ...cmd, name: 'ask_user' }, big, 'CUT-OK: 结论').reason).toBe('note-qa-excluded')
  })
  it('CUT-OK → 剪（结论落叙述位）；CUT-HOLD / 结论超长 → hold', () => {
    const cut = admitNote(cmd, big, '叙述尾部 CUT-OK: 测试全绿，无回归')
    expect(cut.decision).toBe('cut')
    expect(cut.op).toEqual({ kind: 'note-cut', callId: 'c1', conclusion: '测试全绿，无回归' })
    expect(admitNote(cmd, big, 'CUT-HOLD: 还在用').decision).toBe('hold')
    expect(admitNote(cmd, big, `CUT-OK: ${'y'.repeat(200)}`).decision).toBe('hold')
    expect(parseNoteMarker('CUT-OK：全角冒号也可')).toEqual({ kind: 'cut', conclusion: '全角冒号也可' })
  })
})

describe('P15a §5 T0 超越与 T0-R 三硬规则', () => {
  it('读信封解析/渲染与声明表判据', () => {
    expect(parseReadEnvelope(readText)).toHaveLength(4)
    expect(isDeclarationTable('src/index.ts', 0)).toBe(true)
    expect(isDeclarationTable('src/index.ts', 2)).toBe(false)
    expect(isDeclarationTable('src/foo.ts', 0)).toBe(false)
    expect(indentLevelOf('    const x = 1')).toBe(2)
  })
  it('T0：同路径写超越 → 旧读整剪；异路径 / 逆序 → 不动刀', () => {
    const plan = foldToolShear([readCall, readResult, call(3, 20, 'w1', 'write', { file_path: 'src/index.ts', content: 'x' })])
    expect(plan.ops).toEqual([{ kind: 't0-supersede', callId: 'r1', writeCallId: 'w1', path: 'src/index.ts' }])
    const other = foldToolShear([readCall, readResult, call(3, 20, 'w1', 'write', { file_path: 'src/other.ts', content: 'x' })])
    expect(other.ops).toHaveLength(0)
    const reversed = foldToolShear([call(3, 20, 'w1', 'write', { file_path: 'src/index.ts' }), readCall, readResult])
    expect(reversed.ops).toHaveLength(0)
  })
  it('T0-R：声明表读后写 → 行号信封 + edited 锚；streak 内原位刷新（v1 → v2）', () => {
    const plan = foldToolShear([
      readCall,
      readResult,
      call(3, 20, 'e1', 'edit', { file_path: 'src/index.ts', old_string: 'export const x = 2', new_string: 'export const x = 9\nexport const z = 0' }),
      call(4, 30, 'e2', 'edit', { file_path: 'src/index.ts', old_string: 'export const z = 0', new_string: 'export const z = 1' }),
    ])
    expect(plan.ops.map((op) => op.kind)).toEqual(['t0r-repair', 't0r-repair'])
    const first = plan.ops[0]
    if (first.kind !== 't0r-repair') throw new Error('expected t0r-repair')
    expect(first.anchor).toBe('(edited: src/index.ts, v1, 2-3)')
    expect(first.envelope).toContain('2: export const x = 9')
    expect(first.envelope).toContain('edited')
    expect(first.segments[0]?.lines).toEqual(['export const x = 9', 'export const z = 0'])
    expect(plan.ops[1]?.kind === 't0r-repair' && plan.ops[1].version).toBe(2)
  })
  it('三硬规则：跨事件（用户轮打断 streak）→ 冻结后退回普通 T0；跨行对齐 → 不动刀', () => {
    const broken = foldToolShear([
      readCall,
      readResult,
      call(3, 20, 'e1', 'edit', { file_path: 'src/index.ts', old_string: 'export const x = 2', new_string: 'export const x = 9' }),
      user(4, 25, '先停一下'),
      call(5, 30, 'e2', 'edit', { file_path: 'src/index.ts', old_string: 'export const y = 3', new_string: 'export const y = 4' }),
    ])
    expect(broken.ops.map((op) => op.kind)).toEqual(['t0r-repair', 't0-supersede'])
    const misaligned = foldToolShear([readCall, readResult, call(3, 20, 'e1', 'edit', { file_path: 'src/index.ts', old_string: 'export const x = 2\nexport const y', new_string: 'z' })])
    expect(misaligned.ops).toHaveLength(0)
    expect(misaligned.decisions.some((d) => d.reason === 't0r-fallback-keep')).toBe(true)
  })
  it('段数超限（replace_all 多 hunk）→ 放弃机制，不动刀', () => {
    const many = ['1: a', '2: dup', '3: dup', '4: dup', '5: dup', '6: dup'].join('\n')
    const repair = repairReadAfterWrite(parseReadEnvelope(many), { oldString: 'dup', newString: 'hit', replaceAll: true }, 'src/index.ts', 1)
    expect(repair).toBeUndefined()
  })
})

describe('P15a §6 配对与边界搭车', () => {
  it('配对完整性：孤儿调用 → 拒绝该 op', () => {
    const events = [call(1, 10, 'r1', 'read', { file_path: 'src/index.ts' }), result(2, 11, 'r1', readText)]
    expect(assertPairing({ kind: 't0-supersede', callId: 'r1', writeCallId: 'w1', path: 'src/index.ts' }, events)).toBe(true)
    expect(assertPairing({ kind: 't0-supersede', callId: 'ghost', writeCallId: 'w1', path: 'src/index.ts' }, events)).toBe(false)
  })
  it('hold = T-boundary 搭车候选；cut/keep 不是', () => {
    expect(isBoundaryRideCandidate({ tier: 'T-note', decision: 'hold', reason: 'note-hold' })).toBe(true)
    expect(isBoundaryRideCandidate({ tier: 'T0', decision: 'cut', reason: 't0-supersede' })).toBe(false)
  })
})

describe('P15a §7 确定性', () => {
  const events: ShearEvent[] = [
    readCall,
    readResult,
    call(3, 20, 'e1', 'edit', { file_path: 'src/index.ts', old_string: 'export const x = 2', new_string: 'export const x = 9' }),
    call(4, 30, 'b1', 'bash', { command: 'npm test' }),
    result(5, 31, 'b1', bigLog(20)),
    assistant(6, 32, '测试全绿。'),
  ]
  it('同输入双跑逐字节一致，且输入不被 mutate', () => {
    const snapshot = JSON.stringify(events)
    const a = foldToolShear(events)
    const b = foldToolShear(events)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(events)).toBe(snapshot)
    expect(a.ops.map((op) => op.kind)).toEqual(['t0r-repair', 'shape-entry'])
  })
  it('utf8ByteLength 按 UTF-8 计字节（非字符串长度）', () => {
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('中文')).toBe(6)
    expect(utf8ByteLength('😀')).toBe(4)
  })
})

describe('P15b 接线缝（纯核可选参数与模板）', () => {
  it('noteEligible：体积阈值 / 非 read / 非问答', () => {
    const cmd = { seq: 1, time: 10, callId: 'c1', name: 'bash', argsText: '{}' }
    expect(noteEligible(cmd, bigLog(400))).toBe(true)
    expect(noteEligible(cmd, 'small')).toBe(false)
    expect(noteEligible({ ...cmd, name: 'read' }, bigLog(400))).toBe(false)
    expect(noteEligible({ ...cmd, name: 'ask_user' }, bigLog(400))).toBe(false)
  })
  it('textOfContentBlocks：拼接 text 块、忽略非 text 块', () => {
    expect(textOfContentBlocks([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(textOfContentBlocks([])).toBe('')
  })
  it('buildSupersededStub 逐字含路径（零转写）', () => {
    expect(buildSupersededStub('src/index.ts')).toContain('src/index.ts')
  })
  it('SHEAR_NOTE_TEMPLATE：版本 1、含 CUT-OK/CUT-HOLD 契约、可被 parseNoteMarker 解析', () => {
    expect(SHEAR_NOTE_TEMPLATE_VERSION).toBe(1)
    expect(SHEAR_NOTE_TEMPLATE).toContain('CUT-OK:')
    expect(SHEAR_NOTE_TEMPLATE).toContain('CUT-HOLD:')
    expect(parseNoteMarker('CUT-OK: 结论')).toEqual({ kind: 'cut', conclusion: '结论' })
  })
  it('entryShaped 选项：已整形调用跳过 T-note/T-loop（防双重剪）', () => {
    const events: ShearEvent[] = [call(1, 10, 'b1', 'bash', { command: 'npm test' }), result(2, 11, 'b1', 'a\nb\nc\nd\ne'), assistant(3, 12, '测试全绿。')]
    expect(foldToolShear(events).ops.map((op) => op.kind)).toEqual(['stub-replace'])
    expect(foldToolShear(events, DEFAULT_SHEAR_POLICY, { entryShaped: new Set(['b1']) }).ops).toHaveLength(0)
  })
  it('lifecycles 选项：工具自声明 supersededBy 可覆盖类别启发式', () => {
    const events: ShearEvent[] = [readCall, readResult, call(3, 20, 'w1', 'write', { file_path: 'src/index.ts', content: 'x' })]
    expect(foldToolShear(events).ops.map((op) => op.kind)).toEqual(['t0-supersede'])
    const frozen = { ...DEFAULT_LIFECYCLE, supersededBy: () => false }
    expect(foldToolShear(events, DEFAULT_SHEAR_POLICY, { lifecycles: { write: frozen } }).ops).toHaveLength(0)
  })
})

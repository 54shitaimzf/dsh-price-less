/**
 * 工具剪切纯核：谓词、四档准入与确定性 fold（docs/03 §2/§2.1/§2.2/§2.3；P15a）。
 * 纯函数：T-entry 整形、T0 超越、T0-R 修复（T-note 协商与 T-loop 思考后截断均已退役）。
 * core 零 harness/platform import；不抛错，失败一律默认保留（协商不成不动刀，零重试）。
 * 平面: L0（无模型/IO/状态）｜回退链步数: 3（自带策略 → 类别启发式 → 通用体积年龄规则）
 * 审查清单: 不 import harness/platform（S1）；不写 KV/日志/事实；不改史（执行归 P15b）；
 *           内容零转写（只保原文行 + 中性省略/结论），不带插件内部标签（带外原则）。
 * 度量: shearDecision{cut|hold|keep} / toolPruneByClass / shearNoteAttached（入账归 P15b）。
 */
import {
  DEFAULT_SHEAR_POLICY,
  type RederiveCost,
  type ShearDecision,
  type ShearDecisionRecord,
  type ShearEvent,
  type ShearOp,
  type ShearPlan,
  type ShearPolicy,
  type ShearToolCall,
  type ShearToolCategory,
  type ToolContextLifecycle,
} from './types.ts'
import {
  editArgsOf,
  indentLevelOf,
  isDeclarationTable,
  parseReadEnvelope,
  repairReadAfterWrite,
  type ReadEnvelopeLine,
} from './t0r.ts'

const READ_TOOLS = new Set(['read', 'read_file', 'read_multiple_files'])
const WRITE_TOOLS = new Set(['edit', 'write', 'str_replace_editor', 'apply_patch'])
const SEARCH_TOOLS = new Set(['grep', 'glob', 'search', 'find'])
const CMD_TOOLS = new Set(['bash', 'pwsh', 'run', 'shell', 'terminal', 'exec'])

export const ENTRY_KEEP_HEAD = 2
export const ENTRY_KEEP_TAIL = 2
export const ENTRY_MIN_LINES = 8
export const ENTRY_MAX_ERROR_LINES = 8
export const ENTRY_FAILURE_RE = /\[exit code: [1-9]\d*\]|\b(?:error|failed|failure|exception|traceback|fatal)\b/i
export const GENERIC_CUT_MIN_BYTES = 16_384
export const GENERIC_CUT_MIN_AGE_MS = 600_000
/** W1 列表识别（docs/03 §2.1）：列表载荷 = 名字集合，保头尾会丢名字 → T-entry 一律不整形。 */
export const LISTING_COMMAND_RE = /(?:^\s*|[\n|;&("']\s*)(?:get-childitem|gci|ls|dir|tree|fd|find)\b|\brg\b[^\n]{0,60}--files/i

export function toolCategory(name: string): ShearToolCategory {
  if (READ_TOOLS.has(name)) return 'read'
  if (WRITE_TOOLS.has(name)) return 'write'
  if (SEARCH_TOOLS.has(name)) return 'search'
  if (CMD_TOOLS.has(name)) return 'cmd'
  return 'other'
}

/** 列表类命令参数扫描（args 优先，argsText 兜底；纯函数、无 IO）。 */
function listingCommandIn(call: ShearToolCall, args?: unknown): boolean {
  const values: string[] = []
  if (typeof args === 'object' && args !== null) {
    for (const key of ['command', 'cmd', 'script', 'args']) {
      const value = (args as Record<string, unknown>)[key]
      if (typeof value === 'string') values.push(value)
      else if (Array.isArray(value)) values.push(value.filter((item): item is string => typeof item === 'string').join(' '))
    }
  }
  if (call.argsText !== '') values.push(call.argsText)
  return values.some((value) => LISTING_COMMAND_RE.test(value))
}

/**
 * W1：列表类 cmd 结果识别（**只认命令名**，不做文本启发——文本启发会把普通日志误判为列表）。
 * 方向性：漏判只损失一次整形收益，误判会白丢收益；两者都不丢内容（失败方向 = 保留）。
 */
export function looksLikeListing(call: ShearToolCall, resultText: string, args?: unknown): boolean {
  if (toolCategory(call.name) !== 'cmd') return false
  if (resultText.split('\n').length <= ENTRY_MIN_LINES) return false
  return listingCommandIn(call, args)
}

export function parseToolArgs(call: ShearToolCall): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(call.argsText)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export function pathOfCall(call: ShearToolCall): string | undefined {
  const args = parseToolArgs(call)
  if (args === undefined) return undefined
  if (typeof args.file_path === 'string') return args.file_path
  return typeof args.path === 'string' ? args.path : undefined
}

export function isEditCall(call: ShearToolCall): boolean {
  return call.name === 'edit' || call.name === 'str_replace_editor'
}

function referenceKeysOf(call: ShearToolCall): readonly string[] {
  const keys: string[] = []
  const path = pathOfCall(call)
  if (path !== undefined) keys.push(path)
  const args = parseToolArgs(call)
  const query = typeof args?.query === 'string' ? args.query : typeof args?.pattern === 'string' ? args.pattern : undefined
  if (query !== undefined && query.length > 1) keys.push(query)
  if (typeof args?.command === 'string' && args.command.length > 1) keys.push(args.command)
  return keys
}

function rederiveCostOf(call: ShearToolCall): RederiveCost {
  const category = toolCategory(call.name)
  return category === 'read' || category === 'search' ? 'cheap' : 'expensive'
}

function supersededByOf(call: ShearToolCall, later: ShearToolCall): boolean {
  const path = pathOfCall(call)
  if (path === undefined || later.time <= call.time || !WRITE_TOOLS.has(later.name)) return false
  return pathOfCall(later) === path
}

function referencedByOf(call: ShearToolCall, later: ShearEvent): boolean {
  const keys = referenceKeysOf(call)
  if (keys.length === 0) return false
  if (later.kind === 'user-message' || later.kind === 'assistant-message') {
    const lower = later.text.toLowerCase()
    return keys.some((key) => lower.includes(key.toLowerCase()))
  }
  if (later.kind === 'tool-call') {
    const path = pathOfCall(call)
    if (path !== undefined && pathOfCall(later.call) === path) return true
    const lower = later.call.argsText.toLowerCase()
    return keys.some((key) => lower.includes(key.toLowerCase()))
  }
  return false
}

/** 默认生命周期 = 类别启发式（三级回退第二级）；自带策略由调用侧传入覆盖。 */
export const DEFAULT_LIFECYCLE: ToolContextLifecycle = {
  referenceKeys: referenceKeysOf,
  rederiveCost: rederiveCostOf,
  supersededBy: supersededByOf,
  referencedBy: referencedByOf,
}

export function resolveLifecycle(declared?: ToolContextLifecycle): ToolContextLifecycle {
  return declared ?? DEFAULT_LIFECYCLE
}

/** 三级回退第三级：大而久的结果才允许机械剪。 */
export function genericCutEligible(resultBytes: number, ageMs: number): boolean {
  return resultBytes >= GENERIC_CUT_MIN_BYTES && ageMs >= GENERIC_CUT_MIN_AGE_MS
}

export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4
  }
  return bytes
}

/** 拼接 content 块中的 text（非 text 块忽略）；供叙述/结果文本提取复用。 */
export function textOfContentBlocks(blocks: readonly { readonly type?: string; readonly text?: string }[]): string {
  let text = ''
  for (const block of blocks) if (block.type === 'text' && typeof block.text === 'string') text += block.text
  return text
}

export interface Admission {
  readonly decision: ShearDecision
  readonly reason: string
  readonly op?: ShearOp
}

/** T-entry 写时整形（落账前，断裂成本 0）：cmd 类成功保首尾、失败保错因；只保原文行 + 中性省略标记。 */
export function shapeEntryContent(call: ShearToolCall, resultText: string, args?: unknown): string | undefined {
  if (toolCategory(call.name) !== 'cmd' || resultText === '') return undefined
  const lines = resultText.split('\n')
  if (lines.length <= ENTRY_MIN_LINES) return undefined
  // W1：列表载荷 = 名字集合，保头尾会丢名字 → 不整形（记 entry-skip-listing）。
  if (looksLikeListing(call, resultText, args)) return undefined
  const keep: number[] = []
  if (ENTRY_FAILURE_RE.test(resultText)) {
    keep.push(0)
    let hits = 0
    for (let i = 1; i < lines.length && hits < ENTRY_MAX_ERROR_LINES; i++) {
      if (!ENTRY_FAILURE_RE.test(lines[i] as string)) continue
      keep.push(i)
      hits++
    }
    keep.push(lines.length - 1)
  } else {
    for (let i = 0; i < Math.min(ENTRY_KEEP_HEAD, lines.length); i++) keep.push(i)
    for (let i = Math.max(0, lines.length - ENTRY_KEEP_TAIL); i < lines.length; i++) keep.push(i)
  }
  const unique = [...new Set(keep)].sort((a, b) => a - b)
  if (unique.length >= lines.length) return undefined
  const out: string[] = []
  let previous = -1
  for (const index of unique) {
    if (previous >= 0 && index > previous + 1) out.push(`… (省略 ${index - previous - 1} 行)`)
    out.push(lines[index] as string)
    previous = index
  }
  const shaped = out.join('\n')
  return shaped.length < resultText.length ? shaped : undefined
}

export function admitEntry(call: ShearToolCall, resultText: string, args?: unknown): Admission {
  const shaped = shapeEntryContent(call, resultText, args)
  if (shaped === undefined) return { decision: 'keep', reason: 'entry-keep' }
  return { decision: 'cut', reason: 'entry-shaped', op: { kind: 'shape-entry', callId: call.callId, content: shaped } }
}

/** T0 stub（纯痕迹；盘上在场 = 写即新真相，路径逐字保留，零转写）。 */
export function buildSupersededStub(path: string): string {
  return `（已剪除：${path} 的旧读取——该文件此后已被写入，盘上内容为准。）`
}

/** 配对纪律：op 指向的调用必须有对应结果（孤儿调用 → 拒绝该 op）。 */
export function assertPairing(op: ShearOp, events: readonly ShearEvent[]): boolean {
  const callId = op.kind === 't0r-repair' ? op.readCallId : op.callId
  let hasCall = false
  let hasResult = false
  for (const event of events) {
    if (event.kind === 'tool-call' && event.call.callId === callId) hasCall = true
    if (event.kind === 'tool-result' && event.result.callId === callId) hasResult = true
  }
  return hasCall && hasResult
}

/** 老调用对唯一合法去处 = T-boundary 搭车（hold 语义）；只判不执行（执行归 P19）。 */
export function isBoundaryRideCandidate(record: ShearDecisionRecord): boolean {
  return record.decision === 'hold'
}

/** fold 可选项（P15b 接线缝；全部可选，缺省 = P15a 行为逐字节一致）。 */
export interface FoldToolShearOptions {
  /** 生命周期谓词覆盖（三级回退第一级）；缺省 = 内置类别启发式。 */
  readonly lifecycles?: Readonly<Record<string, ToolContextLifecycle>>
}

interface ReadState {
  readonly call: ShearToolCall
  resultText?: string
  window: ReadEnvelopeLine[]
  version: number
  frozen: boolean
  repaired: boolean
  cut: boolean
}

/**
 * 单遍确定性 fold：事件保序、输入不 mutate、无时钟/随机。
 * T-entry 在结果到达时整形；T0/T0-R 在同路径写到达时裁决
 * （streak 原位刷新；异质操作冻结摘抄 → 后续编辑退普通 T0）。
 */
export function foldToolShear(events: readonly ShearEvent[], policy: ShearPolicy = DEFAULT_SHEAR_POLICY, options: FoldToolShearOptions = {}): ShearPlan {
  const ops: ShearOp[] = []
  const decisions: ShearDecisionRecord[] = []
  const callsById = new Map<string, ShearToolCall>()
  const readsByPath = new Map<string, ReadState[]>()
  let streakPath: string | undefined
  const record = (tier: ShearDecisionRecord['tier'], decision: ShearDecision, reason: string, callId?: string): void => {
    decisions.push(callId === undefined ? { tier, decision, reason } : { tier, decision, reason, callId })
  }
  const freezeRepaired = (): void => {
    for (const states of readsByPath.values()) for (const state of states) if (state.repaired) state.frozen = true
  }
  const cutPlainT0 = (state: ReadState, writeCallId: string): void => {
    ops.push({ kind: 't0-supersede', callId: state.call.callId, writeCallId, path: pathOfCall(state.call) ?? '' })
    record('T0', 'cut', 't0-supersede', state.call.callId)
    state.cut = true
  }

  for (const event of events) {
    if (event.kind === 'user-message') {
      freezeRepaired()
      streakPath = undefined
      continue
    }
    if (event.kind === 'tool-result') {
      const result = event.result
      const call = callsById.get(result.callId)
      if (call === undefined) continue
      const path = pathOfCall(call)
      const states = path === undefined ? undefined : readsByPath.get(path)
      const state = states?.find((item) => item.call.callId === call.callId)
      if (state !== undefined) {
        state.resultText = result.text
        state.window = parseReadEnvelope(result.text)
      }
      const shaped = shapeEntryContent(call, result.text)
      if (shaped !== undefined) {
        ops.push({ kind: 'shape-entry', callId: call.callId, content: shaped })
        record('T-entry', 'cut', 'entry-shaped', call.callId)
      } else if (looksLikeListing(call, result.text)) {
        // W1：列表跳过可观测（keep 相由 domains/shear.ts 发射 shear-decision 事实）。
        record('T-entry', 'keep', 'entry-skip-listing', call.callId)
      }
      continue
    }
    if (event.kind === 'assistant-message') {
      // T-loop（工具思考后截断）已退役（账本 §72）：叙述消息不再触发任何落刀。
      // streak 只被异质操作（其他文件）或用户轮打断——assistant 叙述不算打断
      // （真实事件序 = assistant(含 tool-call) → tool/call → tool/result，若在此重置 streak，
      //  T0-R 永远不可达）。
      continue
    }
    const call = event.call
    callsById.set(call.callId, call)
    const path = pathOfCall(call)
    if (toolCategory(call.name) === 'read' && path !== undefined) {
      const states = readsByPath.get(path) ?? []
      states.push({ call, window: [], version: 0, frozen: false, repaired: false, cut: false })
      readsByPath.set(path, states)
      streakPath = path
      continue
    }
    if (WRITE_TOOLS.has(call.name) && path !== undefined) {
      const lifecycle = resolveLifecycle(options.lifecycles?.[call.name])
      const states = readsByPath.get(path) ?? []
      const superseded = states.filter((state) => state.resultText !== undefined && !state.cut && lifecycle.supersededBy(state.call, call))
      const target = superseded[superseded.length - 1]
      for (const state of superseded) if (state !== target) cutPlainT0(state, call.callId)
      if (target !== undefined) {
        const edit = isEditCall(call) ? editArgsOf(call) : undefined
        const indent = edit === undefined ? Number.POSITIVE_INFINITY : indentLevelOf((edit.oldString.split('\n')[0] ?? ''))
        const streakIntact = streakPath === path && !target.frozen && target.window.length > 0
        if (edit !== undefined && isDeclarationTable(path, indent, policy) && streakIntact) {
          target.version += 1
          const repair = repairReadAfterWrite(target.window, edit, path, target.version, policy)
          if (repair !== undefined) {
            ops.push({ kind: 't0r-repair', readCallId: target.call.callId, writeCallId: call.callId, path, version: target.version, segments: repair.segments, windowLines: target.window.length, anchor: repair.anchor, envelope: repair.envelope })
            target.window = [...repair.window]
            target.repaired = true
            record('T0-R', 'cut', 't0r-repair', target.call.callId)
          } else {
            record('T0-R', 'keep', 't0r-fallback-keep', target.call.callId)
          }
        } else {
          cutPlainT0(target, call.callId)
        }
      }
      if (states.every((state) => state.cut)) readsByPath.delete(path)
      streakPath = path
      continue
    }
    freezeRepaired()
    streakPath = path
  }
  return { ops, decisions }
}

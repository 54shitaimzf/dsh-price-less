/**
 * 事实层与热尾装配（docs/04 §2 预算三环 + 双通道取真 + 地板填充 + 位置兜底；P17a）。
 * P17c 修正：HT 软门前置（坏形状不抛错）+ clipped 计数修复 + 兜底按 policy cpt + 追加式链续传。
 * 纯函数：从会话事件 fold 单元清单与文件操作，再按申报序贪心累加、到 10K 即停，
 * 渲染序 = transcript 序（字节稳定）。三环 fatal 口径：仅 digest schema 违例 fatal，
 * 坏坐标/超预算/申报缺失一律机械降级（失败默认保留，绝不抛错）。
 *
 * 模块: core 边界装配纯核（事实层 + 热尾）
 * 平面: L0（确定性装配；模型只产坐标与排序，本层零模型、零 IO）
 * 回退链步数: 2（坐标无效丢弃 → 位置兜底反向累加；再不成 = 空热尾，档案只剩摘要）
 * 审查清单: 不 import harness/platform（S1）；不读盘（盘上取真由 P17b 端口注入）；无时钟随机（D12）。
 * 度量: hotTail* / digest* 字段经 assemble-run 事实入账（fold 见 ledger.ts）。
 */
import { estimateTokens, extractTextFromToolResult } from '../ledger/fold.ts'
import { tokensToChars } from '../meter/estimate.ts'
import type { LedgerSessionEvent } from '../ledger/types.ts'
import { toolCategory } from '../shear/tool.ts'
import { archiveChainShape } from './archive.ts'
import { foldFileChains, remapFileCoord, type FileChain, type FileOp } from './chain.ts'
import { gateHotTailDecls } from './gate.ts'
import { buildPathTable, pathRef, relativePath, renderPathTable, EMPTY_PATH_TABLE, type PathTable, type RootKind } from './paths.ts'
import { messageTextOf } from '../compress/region.ts'
import { scanFactTexts } from '../compress/fact-leak.ts'
import {
  DEFAULT_ASSEMBLE_POLICY,
  DIGEST_STEP_TYPES,
  HOT_TAIL_TRUNCATION_MARKER,
  type ArchiveEntry,
  type AssembleLayer,
  type AssembleOutcome,
  type AssemblePolicy,
  type AssembleResult,
  type AssembleUnit,
  type DigestPlan,
  type DigestStep,
  type DigestStepType,
  type FileCoord,
  type HotTailDecl,
  type HotTailDropReason,
  type HotTailSelection,
  type HotTailSource,
  type HotTailStopReason,
  type LineRange,
  type TaskDigest,
} from './types.ts'

/** 验证类结果判据（地板填充用；与剪切层判决提取目的不同，故本地声明）。 */
export const VERIFY_LINE_RE =
  /\b\d+\s+(?:tests?|specs?|checks?)\b|\bpass(?:ed)?\b|\bok\b|\[exit code: 0\]|全部通过|测试通过|构建成功|✓/i
/** 失败/错误行判据（逐字摘抄，错误串被转述即失去可搜索性）。 */
export const ERROR_LINE_RE =
  /\[exit code: [1-9]\d*\]|\b(?:error|failed|failure|exception|traceback|fatal)\b|✗|FAIL\b/i

export interface AssembleInputs {
  readonly units: readonly AssembleUnit[]
  readonly ops: readonly FileOp[]
  readonly chains: ReadonlyMap<string, FileChain>
}

export interface AssembleInput {
  readonly units: readonly AssembleUnit[]
  readonly chains?: ReadonlyMap<string, FileChain>
  readonly digest?: TaskDigest
  /** 申报（重要性降序）；缺失/空 = 位置兜底。 */
  readonly hotTail?: readonly HotTailDecl[]
  /** 已存在的压力检查点链（04 §3 机制 A 续传；只接受 empty|prefix，否则 schema fatal）。 */
  readonly priorChain?: readonly ArchiveEntry[]
  /** 单元 ID → 取真文本（通道 A = 盘上行窗口；通道 B 缺省用单元原文）。 */
  readonly resolve?: Readonly<Record<string, string>>
  /** 盘上当前行数：`null` = 文件不存在（丢弃）。 */
  readonly currentLineCounts?: Readonly<Record<string, number | null>>
  readonly layer?: AssembleLayer
  /** 被压区间体量（估算 token；热尾份额帽的分母；缺省 = 无份额帽，只用绝对预算）。 */
  readonly regionTokens?: number
  /** 渲染根（会话工作区；F9e 相对路径基准）。 */
  readonly root?: string
  readonly rootKind?: RootKind
  readonly policy?: AssemblePolicy
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function parseArgs(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return recordOf(parsed)
  } catch {
    return undefined
  }
}

function pathOfArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (args === undefined) return undefined
  if (typeof args.file_path === 'string') return args.file_path
  return typeof args.path === 'string' ? args.path : undefined
}

/** 插件/官方压缩检查点消息（source.kind = 'plugin'）不是任务材料，不进单元清单。 */
function isPluginMessage(data: unknown): boolean {
  const root = recordOf(data)
  if (root === undefined) return false
  const message = recordOf(root.message) ?? root
  const source = recordOf(message?.source)
  return source?.kind === 'plugin'
}

function callIdOfResult(data: unknown): string | undefined {
  const root = recordOf(data)
  if (root === undefined) return undefined
  const message = recordOf(root.message) ?? root
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content) || content.length === 0) return undefined
  const block = recordOf(content[0])
  return typeof block?.toolCallId === 'string' ? block.toolCallId : undefined
}

/** read 结果 meta → 行窗口（原生 read presentationMeta 形状；坏形状 = undefined）。 */
export function readWindowOf(meta: unknown): { path: string; offset: number; lines: string[]; totalLines: number } | undefined {
  const root = recordOf(meta)
  if (root === undefined) return undefined
  const path = root.path
  const offset = root.offset
  const totalLines = root.totalLines
  const lines = root.lines
  if (typeof path !== 'string' || typeof offset !== 'number' || typeof totalLines !== 'number' || !Array.isArray(lines)) return undefined
  if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(totalLines) || totalLines < 0) return undefined
  const out: string[] = []
  for (const line of lines) {
    const item = recordOf(line)
    if (item === undefined || typeof item.text !== 'string') return undefined
    out.push(item.text)
  }
  return { path, offset, lines: out, totalLines }
}

/**
 * 会话事件 → 单元清单 + 文件操作（tool 对 = 一个单元，配对永不拆分；read 窗口/写路径与版本挂单元）。
 * 同输入同输出；不 mutate 输入。
 */
export function foldAssembleInputs(events: readonly LedgerSessionEvent[]): AssembleInputs {
  const ops: FileOp[] = []
  const units: AssembleUnit[] = []
  const calls = new Map<string, { seq: number; name: string; args: Record<string, unknown> | undefined }>()

  for (const event of events) {
    const data = recordOf(event.data)
    if (event.type === 'tool/call') {
      const callId = typeof data?.callId === 'string' ? data.callId : ''
      const name = typeof data?.name === 'string' ? data.name : ''
      const args = parseArgs(typeof data?.arguments === 'string' ? data.arguments : '')
      if (callId !== '') calls.set(callId, { seq: event.seq, name, args })
      const path = pathOfArgs(args)
      if (path !== undefined) {
        if (name === 'write' && typeof args?.content === 'string') {
          ops.push({ seq: event.seq, path, kind: 'write', content: args.content })
        } else if ((name === 'edit' || name === 'str_replace_editor') && typeof args?.old_string === 'string' && typeof args?.new_string === 'string') {
          ops.push({
            seq: event.seq,
            path,
            kind: 'edit',
            oldString: args.old_string,
            newString: args.new_string,
            ...(args.replace_all === true ? { replaceAll: true } : {}),
          })
        }
      }
      continue
    }
    // F9c：user/assistant 消息也是任务材料（用户约束、引号内文本、结论）——可被热尾逐字携带。
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      if (isPluginMessage(event.data)) continue
      const text = messageTextOf(event.data)
      if (text.trim() === '') continue
      units.push({
        id: `seq-${event.seq}`,
        kind: 'message',
        seqStart: event.seq,
        seqEnd: event.seq,
        text,
        tokens: estimateTokens(text),
      })
      continue
    }
    if (event.type !== 'tool/result') continue
    const callId = callIdOfResult(data)
    const call = callId === undefined ? undefined : calls.get(callId)
    const text = extractTextFromToolResult(data)
    const name = call?.name ?? ''
    const path = pathOfArgs(call?.args)
    const window = readWindowOf(data?.meta)
    if (window !== undefined) {
      ops.push({ seq: event.seq, path: window.path, kind: 'read', offset: window.offset, lines: window.lines, totalLines: window.totalLines })
    }
    const errorIdentity = data?.error !== undefined && data?.error !== null
    units.push({
      id: callId ?? `seq-${event.seq}`,
      kind: 'tool-pair',
      seqStart: call?.seq ?? event.seq,
      seqEnd: event.seq,
      ...(name === '' ? {} : { name }),
      ...(path === undefined && window === undefined ? {} : { path: path ?? window?.path }),
      text,
      tokens: estimateTokens(text),
      ...(toolCategory(name) === 'cmd' ? { isRunResult: true } : {}),
      ...(VERIFY_LINE_RE.test(text) ? { isVerification: true } : {}),
      ...(errorIdentity || ERROR_LINE_RE.test(text) ? { isError: true } : {}),
    })
  }

  const chains = foldFileChains(ops)
  const withVersions = units.map((unit): AssembleUnit => {
    if (unit.path === undefined) return unit
    const chain = chains.get(unit.path)
    if (chain === undefined) return unit
    let version: number | undefined
    for (const item of chain.versions) {
      if (item.seq <= unit.seqEnd) version = item.version
      else break
    }
    return version === undefined ? unit : { ...unit, version }
  })
  return { units: withVersions, ops, chains }
}

/** 机械归一化（F9 宽松口径）：坏形状一律修复为可渲染产物；只有非对象 = 空摘要。 */
export function normalizeDigest(
  value: unknown,
  policy: AssemblePolicy = DEFAULT_ASSEMBLE_POLICY,
): { digest: TaskDigest; refDrops: number; stepDrops: number } {
  const root = recordOf(value)
  if (root === undefined) return { digest: { gist: '', steps: [] }, refDrops: 0, stepDrops: 0 }
  const gist = typeof root.gist === 'string' ? root.gist.trim() : ''
  const rawSteps = Array.isArray(root.steps) ? root.steps : []
  const steps: DigestStep[] = []
  let refDrops = 0
  let stepDrops = 0
  for (const raw of rawSteps) {
    const item = recordOf(raw)
    if (item === undefined || typeof item.text !== 'string' || item.text.trim() === '') { stepDrops++; continue }
    const type: DigestStepType = typeof item.type === 'string' && (DIGEST_STEP_TYPES as readonly string[]).includes(item.type)
      ? (item.type as DigestStepType)
      : 'note'
    const refs: number[] = []
    if (Array.isArray(item.refs)) {
      for (const ref of item.refs) {
        const n = typeof ref === 'number' ? ref : typeof ref === 'string' && /^\d+$/.test(ref) ? Number(ref) : Number.NaN
        if (!Number.isInteger(n) || n < 1 || refs.includes(n)) { refDrops++; continue }
        refs.push(n)
      }
    }
    const kept = refs.slice(0, Math.max(0, policy.maxStepRefs))
    refDrops += refs.length - kept.length
    steps.push({ type, text: item.text.trim(), refs: kept })
  }
  return { digest: { gist, steps }, refDrops, stepDrops }
}

/** 分步类型标签（渲染面；schema 词汇与标签解耦）。 */
const STEP_LABELS: Record<DigestStepType, string> = {
  plan: '计划', impl: '实现', verify: '验证', decide: '决策', note: '备注',
}
const GIST_LABEL = '【总述】'
const HOT_TAIL_LABEL = '【热尾】'
const REF_PREFIX = '▸'
const ELLIPSIS = '…'

function truncateChars(text: string, max: number, marker: string): string {
  if (max <= 0 || text.length <= max) return text
  return text.slice(0, Math.max(1, max - marker.length)) + marker
}

type RawSelection = Omit<HotTailSelection, 'rank' | 'pointer' | 'pointerOnly'> & { readonly pointerOnly?: boolean }

/** 指针行（机械渲染；F9e：相对化 + 短 ID 表）。 */
export function pointerOf(selection: RawSelection, root?: string, table: PathTable = EMPTY_PATH_TABLE): string {
  const coord = selection.coord
  if (coord !== undefined) {
    const range = coord.lineRange === undefined ? '' : `:${coord.lineRange.start}-${coord.lineRange.end}`
    return `[文件] ${pathRef(coord.path, root, table)}@v${coord.version}${range}`
  }
  if (selection.source === 'fact') return '[摘抄] （无坐标）'
  return `[历史] 会话 ${selection.seqStart}-${selection.seqEnd}`
}

/**
 * 产物渲染（F9：总述 → 分步（带 ▸n 引用）→ 热尾（1 指针 : 1 内容）；字节稳定）。
 * 摘要硬帽：超限从**最后一条分步**起整条丢弃（机械；不重写）；引用只认 [1..entries.length]。
 */
export function renderProduct(
  digest: TaskDigest,
  entries: readonly HotTailSelection[],
  policy: AssemblePolicy = DEFAULT_ASSEMBLE_POLICY,
  pathTable: PathTable = EMPTY_PATH_TABLE,
): { text: string; plan: DigestPlan } {
  const gist = truncateChars(digest.gist, policy.gistMaxChars, ELLIPSIS)
  const lines: string[] = []
  const refsByStep: number[][] = []
  let refDrops = 0
  for (const step of digest.steps) {
    const text = truncateChars(step.text, policy.stepMaxChars, ELLIPSIS)
    const refs: number[] = []
    for (const n of step.refs) {
      if (!Number.isInteger(n) || n < 1 || n > entries.length) { refDrops++; continue }
      refs.push(n)
    }
    lines.push(`【${STEP_LABELS[step.type]}】${text}`)
    refsByStep.push(refs)
  }
  // 摘要硬帽：整条丢尾（引用随其分步一起丢）。
  while (lines.length > 0 && estimateTokens(lines.join('\n'), policy.density) > policy.digestMaxTokens) {
    const droppedRefs = refsByStep.pop() ?? []
    refDrops += droppedRefs.length
    lines.pop()
  }
  const renderedSteps = lines.map((line, index) => {
    const refs = refsByStep[index] ?? []
    return refs.length === 0 ? line : `${line} (${refs.map((n) => REF_PREFIX + n).join(',')})`
  })
  const head = [gist === '' ? '' : `${GIST_LABEL}${gist}`, ...renderedSteps, renderPathTable(pathTable)]
    .filter((part) => part !== '')
    .join('\n')
  const body = entries
    .map((entry) => `${REF_PREFIX}${entry.rank} ${entry.pointer}${entry.text === '' ? '' : `\n${entry.text}`}`)
    .join('\n')
  const text = [head, entries.length === 0 ? '' : `${HOT_TAIL_LABEL}\n${body}`].filter((part) => part !== '').join('\n\n')
  const referenced = new Set<number>()
  for (const refs of refsByStep) for (const n of refs) referenced.add(n)
  const scan = scanFactTexts([gist, ...digest.steps.slice(0, lines.length).map((step) => step.text)])
  return {
    text,
    plan: {
      bytes: new TextEncoder().encode(head).length,
      gistBytes: new TextEncoder().encode(gist).length,
      stepCount: lines.length,
      stepTokens: estimateTokens(renderedSteps.join('\n'), policy.density),
      refCount: referenced.size,
      refDrops,
      factLeaks: scan.total,
      tokens: estimateTokens(text, policy.density),
    },
  }
}

/** 单元清单（压缩器输入尾部机械追加；ID·名称·路径版本·粗标体量，供模型选坐标）。F9e：路径相对化。 */
export function renderUnitList(units: readonly AssembleUnit[], root?: string): string {
  return units
    .map((unit) => {
      const name = unit.name === undefined ? '' : ` ${unit.name}`
      const where = unit.path === undefined
        ? ''
        : ` ${relativePath(unit.path, root)}${unit.version === undefined ? '' : `@v${unit.version}`}`
      return `[${unit.id}]${name}${where} ~${unit.tokens}t`
    })
    .join('\n')
}

/** 逐字摘抄匹配行（末次优先；≤ limit 条，保序）。 */
export function pickVerbatimLines(text: string, re: RegExp, limit: number): string[] {
  const lines = text.split('\n').filter((line) => line.trim() !== '' && re.test(line))
  return lines.slice(Math.max(0, lines.length - limit))
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length
}

function resolveSelection(
  decl: HotTailDecl,
  unit: AssembleUnit,
  input: AssembleInput,
  policy: AssemblePolicy,
): { selection: RawSelection } | { dropped: 'remap' | 'fetch' } {
  if (decl.coord === undefined) {
    return {
      selection: {
        unitId: unit.id,
        tier: 'model',
        seqStart: unit.seqStart,
        seqEnd: unit.seqEnd,
        source: 'span',
        text: unit.text,
        tokens: estimateTokens(unit.text, policy.density),
      },
    }
  }
  const coord: FileCoord = decl.coord
  const chain = input.chains?.get(coord.path)
  const current = input.currentLineCounts === undefined ? undefined : input.currentLineCounts[coord.path]
  const remap = remapFileCoord(chain, coord, current)
  if (!remap.ok) return { dropped: 'remap' }
  const text = input.resolve?.[unit.id]
  if (text === undefined) {
    // 盘上取真缺失但模型给了逐字摘抄 → 降级为仅摘抄条目（事实不丢；仍可定位）。
    if (decl.fact !== undefined && decl.fact !== '' && unit.text.includes(decl.fact)) {
      return {
        selection: {
          unitId: unit.id,
          tier: 'model',
          seqStart: unit.seqStart,
          seqEnd: unit.seqEnd,
          source: 'fact',
          coord,
          text: decl.fact,
          tokens: estimateTokens(decl.fact, policy.density),
        },
      }
    }
    return { dropped: 'fetch' }
  }
  return {
    selection: {
      unitId: unit.id,
      tier: 'model',
      seqStart: unit.seqStart,
      seqEnd: unit.seqEnd,
      source: 'file',
      coord,
      text,
      tokens: estimateTokens(text, policy.density),
      ...(remap.clipped ? { clipped: true } : {}),
    },
  }
}

/**
 * 装配（贪心停机 + 单单元尾截断 + 地板填充 + 位置兜底；装配序 = 申报序）。
 * F9：摘要 = 总述 + 分步（带 ▸n 引用）；热尾 = 1 指针 : 1 内容（事实载体）。
 */
export function assembleArchive(input: AssembleInput): AssembleOutcome {
  const policy = input.policy ?? DEFAULT_ASSEMBLE_POLICY
  const layer: AssembleLayer = input.layer ?? 'boundary'
  const units = input.units ?? []
  const prior = input.priorChain ?? []
  const priorShape = archiveChainShape(prior)
  if (priorShape.shape !== 'empty' && priorShape.shape !== 'prefix') return { ok: false, reason: 'digest-schema' }
  // F9 宽松口径：摘要坏形状一律机械修复；唯一 fatal 仍是续传链形态（上面）。
  const normalized = normalizeDigest(input.digest, policy)
  const effective = normalized.digest
  if (units.length === 0 && effective.gist === '' && effective.steps.length === 0) return { ok: false, reason: 'no-units' }

  const byId = new Map<string, AssembleUnit>()
  for (const unit of units) if (!byId.has(unit.id)) byId.set(unit.id, unit)

  // F9 预算：绝对帽 + 份额帽（≤ maxShare × 区间，防产物 ≥ 被压区间被缩水校验打回）。
  const regionTokens = input.regionTokens ?? 0
  const digestHead = effective.gist === '' && effective.steps.length === 0
    ? ''
    : `${effective.gist}\n${effective.steps.map((step) => step.text).join('\n')}`
  const digestEstimate = digestHead === '' ? 0 : estimateTokens(digestHead, policy.density)
  const shareCap = regionTokens > 0
    ? Math.max(Math.ceil(regionTokens * policy.hotTailMinShare), Math.ceil(regionTokens * policy.hotTailMaxShare) - digestEstimate)
    : policy.hotTailTokens
  const budget = Math.max(0, Math.min(policy.hotTailTokens, shareCap))
  const selections: RawSelection[] = []
  const picked = new Set<string>()
  let used = 0
  let clipped = 0
  let truncated = 0
  let stopReason: HotTailStopReason = 'list-end'
  let source: HotTailSource = 'model'
  let floorFilled = false
  const dropReasons: Record<HotTailDropReason, number> = { badDecl: 0, unknownUnit: 0, remap: 0, fetch: 0, dup: 0, factReject: 0 }
  const rawDecls: readonly unknown[] = Array.isArray(input.hotTail) ? input.hotTail : []
  const gated = gateHotTailDecls(rawDecls, units)
  for (const reject of gated.rejected) {
    if (reject.reason === 'bad-decl') dropReasons.badDecl++
    else dropReasons.unknownUnit++
  }
  const declared = gated.accepted

  const push = (selection: RawSelection): void => {
    selections.push(selection)
    picked.add(selection.unitId)
    used += selection.tokens
    if (selection.clipped === true) clipped++
  }

  const positionalFallback = (): void => {
    source = 'positional-fallback'
    stopReason = 'list-end'
    for (let i = units.length - 1; i >= 0; i--) {
      const unit = units[i] as AssembleUnit
      const tokens = estimateTokens(unit.text, policy.density)
      if (used + tokens > budget) { stopReason = 'budget'; break }
      push({ unitId: unit.id, tier: 'fallback', seqStart: unit.seqStart, seqEnd: unit.seqEnd, source: 'span', text: unit.text, tokens })
      if (used >= budget) { stopReason = 'budget'; break }
    }
  }

  if (declared.length === 0) {
    positionalFallback()
  } else {
    // 第一趟：解析申报（去重 / 重映射 / fact 子串校验）→ 候选序 = 申报序。
    const candidates: RawSelection[] = []
    for (const decl of declared) {
      const unit = byId.get(decl.unitId)
      if (unit === undefined) { dropReasons.unknownUnit++; continue }
      if (picked.has(decl.unitId)) { dropReasons.dup++; continue }
      const resolved = resolveSelection(decl, unit, input, policy)
      if ('dropped' in resolved) { dropReasons[resolved.dropped]++; continue }
      let selection = resolved.selection
      // fact = 逐字摘抄；必须是该单元原文的子串（防自造事实），否则丢弃 + 计数。
      if (decl.fact !== undefined && decl.fact !== '' && !selection.text.includes(decl.fact)) {
        if (unit.text.includes(decl.fact)) {
          const text = selection.text === '' ? decl.fact : `${selection.text}\n${decl.fact}`
          selection = { ...selection, text, tokens: estimateTokens(text, policy.density) }
        } else {
          dropReasons.factReject++
        }
      }
      picked.add(selection.unitId)
      candidates.push(selection)
    }
    // 第二趟：Zipf 权重分配（w_i = 1/i，重要者多分），未用配额向后 carry-over；
    // 配额不足以放最小内容 → 仅指针降级（仍保留定位价值）。
    const overhead = policy.pointerOverheadTokens * candidates.length
    const allocatable = Math.max(0, budget - overhead)
    const weights = candidates.map((_, index) => 1 / (index + 1))
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
    let carry = 0
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index] as RawSelection
      const quota = Math.floor((allocatable * (weights[index] as number)) / totalWeight) + carry
      if (candidate.tokens <= quota) {
        push(candidate)
        carry = quota - candidate.tokens
        continue
      }
      const chars = tokensToChars(candidate.text, quota, policy.density) - HOT_TAIL_TRUNCATION_MARKER.length
      if (chars >= policy.minTruncatedChars) {
        const text = `${candidate.text.slice(0, chars)}${HOT_TAIL_TRUNCATION_MARKER}`
        push({ ...candidate, text, tokens: estimateTokens(text, policy.density), truncated: true })
        truncated++
      } else {
        push({ ...candidate, text: '', tokens: 0, pointerOnly: true })
      }
      carry = 0
    }
    if (candidates.length === 0 && dropReasons.remap + dropReasons.fetch === declared.length) positionalFallback()
  }

  // 地板填充（04 §2）：模型申报装填停机后，run 结果类目未覆盖且预算有余。
  if (source === 'model' && used < budget) {
    const coveredRun = selections.some((selection) => byId.get(selection.unitId)?.isRunResult === true)
    if (!coveredRun) {
      const fill = (predicate: (unit: AssembleUnit) => boolean, re: RegExp, limit: number): void => {
        for (let i = units.length - 1; i >= 0; i--) {
          const unit = units[i] as AssembleUnit
          if (picked.has(unit.id) || !predicate(unit)) continue
          const text = pickVerbatimLines(unit.text, re, limit).join('\n')
          if (text === '') continue
          const selection: RawSelection = {
            unitId: unit.id,
            tier: 'floor',
            seqStart: unit.seqStart,
            seqEnd: unit.seqEnd,
            source: 'span',
            text,
            tokens: estimateTokens(text, policy.density),
          }
          if (used + selection.tokens > budget) return
          push(selection)
          floorFilled = true
          return
        }
      }
      fill((unit) => unit.isVerification === true, VERIFY_LINE_RE, policy.floorVerifyLines)
      fill((unit) => unit.isError === true, ERROR_LINE_RE, policy.floorErrorLines)
    }
  }

  // 装配序 = 申报序（F9：▸n = 数组下标 + 1，摘要引用与指针同源）。
  const coordPaths = selections
    .map((selection) => selection.coord?.path)
    .filter((path): path is string => typeof path === 'string')
  const pathTable = buildPathTable(coordPaths, input.root)
  let pathBytesSaved = 0
  for (const path of coordPaths) {
    const before = bytesOf(path)
    const after = bytesOf(pathRef(path, input.root, pathTable))
    if (before > after) pathBytesSaved += before - after
  }
  const entries: HotTailSelection[] = selections.map((selection, index) => ({
    ...selection,
    rank: index + 1,
    pointer: pointerOf(selection, input.root, pathTable),
    ...(selection.pointerOnly === true ? { pointerOnly: true } : {}),
  }))
  const product = renderProduct(effective, entries, policy, pathTable)
  const dropped = dropReasons.badDecl + dropReasons.unknownUnit + dropReasons.remap + dropReasons.fetch + dropReasons.dup + dropReasons.factReject
  const result: AssembleResult = {
    layer,
    digest: effective,
    digestPlan: { ...product.plan, refDrops: normalized.refDrops + product.plan.refDrops },
    hotTail: {
      entries,
      stopReason,
      source,
      floorFilled,
      declaredUnits: rawDecls.length,
      dropped,
      dropReasons: { ...dropReasons },
      clipped,
      truncated,
      pointerOnly: selections.filter((selection) => selection.pointerOnly === true).length,
      tokens: used,
      budgetTokens: budget,
    },
    pathBytesSaved,
    pathTableEntries: pathTable.entries.length,
    ...(input.root === undefined ? {} : { root: input.root }),
    ...(input.rootKind === undefined ? {} : { rootKind: input.rootKind }),
    archiveForm: { form: prior.length === 0 ? 'single' : 'chain', checkpointCount: prior.length },
    unitCount: units.length,
    rendered: [...prior.map((entry) => entry.text), product.text].filter((part) => part !== '').join('\n\n'),
  }
  return { ok: true, result }
}

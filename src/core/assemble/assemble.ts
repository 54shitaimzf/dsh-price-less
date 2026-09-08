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
import type { LedgerSessionEvent } from '../ledger/types.ts'
import { toolCategory } from '../shear/tool.ts'
import { archiveChainShape } from './archive.ts'
import { foldFileChains, remapFileCoord, type FileChain, type FileOp } from './chain.ts'
import { gateHotTailDecls } from './gate.ts'
import {
  DEFAULT_ASSEMBLE_POLICY,
  DIGEST_BLOCK_ORDER,
  HOT_TAIL_TRUNCATION_MARKER,
  type ArchiveEntry,
  type AssembleLayer,
  type AssembleOutcome,
  type AssemblePolicy,
  type AssembleResult,
  type AssembleUnit,
  type DigestBlock,
  type DigestBlockType,
  type DigestCoord,
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

/** 结构校验（三环 fatal 之一）：坏形状 = undefined（调用方 fail-lazy 保留）。 */
export function validateDigest(value: unknown): TaskDigest | undefined {
  const root = recordOf(value)
  if (root === undefined) return undefined
  const rawBlocks = root.blocks
  const rawCoords = root.coords
  if (!Array.isArray(rawBlocks) || !Array.isArray(rawCoords)) return undefined
  const blocks: DigestBlock[] = []
  for (const raw of rawBlocks) {
    const item = recordOf(raw)
    if (item === undefined || typeof item.type !== 'string' || typeof item.text !== 'string') return undefined
    if (!(DIGEST_BLOCK_ORDER as readonly string[]).includes(item.type)) return undefined
    blocks.push({ type: item.type as DigestBlockType, text: item.text })
  }
  const coords: DigestCoord[] = []
  for (const raw of rawCoords) {
    const item = recordOf(raw)
    if (item === undefined || typeof item.path !== 'string' || item.path === '') return undefined
    if (typeof item.version !== 'number' || !Number.isInteger(item.version) || item.version < 1) return undefined
    let lineRange: LineRange | undefined
    if (item.lineRange !== undefined) {
      const range = recordOf(item.lineRange)
      if (range === undefined || typeof range.start !== 'number' || typeof range.end !== 'number') return undefined
      if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start) return undefined
      lineRange = { start: range.start, end: range.end }
    }
    if (item.symbol !== undefined && typeof item.symbol !== 'string') return undefined
    coords.push({
      path: item.path,
      version: item.version,
      ...(lineRange === undefined ? {} : { lineRange }),
      ...(typeof item.symbol === 'string' ? { symbol: item.symbol } : {}),
    })
  }
  return { blocks, coords }
}

/** 渲染顺序（F5a：结论先行 = 总→分；与 schema 校验序 DIGEST_BLOCK_ORDER 解耦）。 */
const DIGEST_RENDER_ORDER: readonly DigestBlockType[] = ['wrap', 'plan', 'impl', 'verify']
/** 类型标签（F5a：渲染面显式标出块类型；产物 schema 与校验序不变）。 */
const DIGEST_LABELS: Record<DigestBlockType, string> = {
  plan: '【计划】', impl: '【实现】', verify: '【验证】', wrap: '【结论】',
}

/** 类型化摘要渲染（F5a：结论先行 + 类型标签；坐标层随后逐行；字节稳定）。 */
export function renderDigest(digest: TaskDigest): string {
  const parts: string[] = []
  for (const type of DIGEST_RENDER_ORDER) {
    for (const block of digest.blocks) {
      if (block.type !== type) continue
      const text = block.text.trim()
      if (text !== '') parts.push(`${DIGEST_LABELS[type]}${text}`)
    }
  }
  const coords = digest.coords.map((coord) => {
    const range = coord.lineRange === undefined ? '' : `:${coord.lineRange.start}-${coord.lineRange.end}`
    const symbol = coord.symbol === undefined ? '' : ` ${coord.symbol}`
    return `${coord.path}@v${coord.version}${range}${symbol}`
  })
  const head = parts.join('\n\n')
  const tail = coords.join('\n')
  if (head === '') return tail
  return tail === '' ? head : `${head}\n\n${tail}`
}

/** 单元清单（压缩器输入尾部机械追加；ID·名称·路径版本·粗标体量，供模型选坐标）。 */
export function renderUnitList(units: readonly AssembleUnit[]): string {
  return units
    .map((unit) => {
      const name = unit.name === undefined ? '' : ` ${unit.name}`
      const where = unit.path === undefined ? '' : ` ${unit.path}${unit.version === undefined ? '' : `@v${unit.version}`}`
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
): { selection: HotTailSelection } | { dropped: 'remap' | 'fetch' } {
  if (decl.coord === undefined) {
    return {
      selection: {
        unitId: unit.id,
        tier: 'model',
        seqStart: unit.seqStart,
        seqEnd: unit.seqEnd,
        source: 'span',
        text: unit.text,
        tokens: estimateTokens(unit.text, policy.charsPerToken),
      },
    }
  }
  const coord: FileCoord = decl.coord
  const chain = input.chains?.get(coord.path)
  const current = input.currentLineCounts === undefined ? undefined : input.currentLineCounts[coord.path]
  const remap = remapFileCoord(chain, coord, current)
  if (!remap.ok) return { dropped: 'remap' }
  const text = input.resolve?.[unit.id]
  if (text === undefined) return { dropped: 'fetch' }
  return {
    selection: {
      unitId: unit.id,
      tier: 'model',
      seqStart: unit.seqStart,
      seqEnd: unit.seqEnd,
      source: 'file',
      coord,
      text,
      tokens: estimateTokens(text, policy.charsPerToken),
      ...(remap.clipped ? { clipped: true } : {}),
    },
  }
}

/**
 * 装配（贪心停机 + 单单元尾截断 + 地板填充 + 位置兜底；装配序 = transcript 序）。
 */
export function assembleArchive(input: AssembleInput): AssembleOutcome {
  const policy = input.policy ?? DEFAULT_ASSEMBLE_POLICY
  const layer: AssembleLayer = input.layer ?? 'boundary'
  const units = input.units ?? []
  const prior = input.priorChain ?? []
  const priorShape = archiveChainShape(prior)
  if (priorShape.shape !== 'empty' && priorShape.shape !== 'prefix') return { ok: false, reason: 'digest-schema' }
  let digest: TaskDigest | undefined
  if (input.digest !== undefined) {
    digest = validateDigest(input.digest)
    if (digest === undefined) return { ok: false, reason: 'digest-schema' }
  }
  const empty: TaskDigest = { blocks: [], coords: [] }
  const effective = digest ?? empty
  if (units.length === 0 && effective.blocks.length === 0 && effective.coords.length === 0) return { ok: false, reason: 'no-units' }

  const byId = new Map<string, AssembleUnit>()
  for (const unit of units) if (!byId.has(unit.id)) byId.set(unit.id, unit)

  const budget = policy.hotTailTokens
  const selections: HotTailSelection[] = []
  const picked = new Set<string>()
  let used = 0
  let clipped = 0
  let truncated = 0
  let stopReason: HotTailStopReason = 'list-end'
  let source: HotTailSource = 'model'
  let floorFilled = false
  const dropReasons: Record<HotTailDropReason, number> = { badDecl: 0, unknownUnit: 0, remap: 0, fetch: 0 }
  const rawDecls: readonly unknown[] = Array.isArray(input.hotTail) ? input.hotTail : []
  const gated = gateHotTailDecls(rawDecls, units)
  for (const reject of gated.rejected) {
    if (reject.reason === 'bad-decl') dropReasons.badDecl++
    else dropReasons.unknownUnit++
  }
  const declared = gated.accepted

  const push = (selection: HotTailSelection): void => {
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
      const tokens = estimateTokens(unit.text, policy.charsPerToken)
      if (used + tokens > budget) { stopReason = 'budget'; break }
      push({ unitId: unit.id, tier: 'fallback', seqStart: unit.seqStart, seqEnd: unit.seqEnd, source: 'span', text: unit.text, tokens })
      if (used >= budget) { stopReason = 'budget'; break }
    }
  }

  if (declared.length === 0) {
    positionalFallback()
  } else {
    for (const decl of declared) {
      const unit = byId.get(decl.unitId)
      if (unit === undefined) { dropReasons.unknownUnit++; continue }
      const resolved = resolveSelection(decl, unit, input, policy)
      if ('dropped' in resolved) { dropReasons[resolved.dropped]++; continue }
      const selection = resolved.selection
      if (used + selection.tokens > budget) {
        if (selections.length === 0) {
          const remaining = budget - used
          const chars = Math.floor(remaining * policy.charsPerToken) - HOT_TAIL_TRUNCATION_MARKER.length
          if (chars >= policy.minTruncatedChars) {
            const text = `${selection.text.slice(0, chars)}${HOT_TAIL_TRUNCATION_MARKER}`
            push({ ...selection, text, tokens: estimateTokens(text, policy.charsPerToken), truncated: true })
            truncated++
          }
        }
        stopReason = 'budget'
        break
      }
      push(selection)
      if (used >= budget) { stopReason = 'budget'; break }
    }
    if (selections.length === 0 && dropReasons.remap + dropReasons.fetch === declared.length) positionalFallback()
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
          const selection: HotTailSelection = {
            unitId: unit.id,
            tier: 'floor',
            seqStart: unit.seqStart,
            seqEnd: unit.seqEnd,
            source: 'span',
            text,
            tokens: estimateTokens(text, policy.charsPerToken),
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

  const ordered = selections.slice().sort((a, b) => a.seqStart - b.seqStart || a.unitId.localeCompare(b.unitId))
  const digestText = renderDigest(effective)
  const hotText = ordered.map((selection) => selection.text).join('\n\n')
  const rendered = [...prior.map((entry) => entry.text), digestText, hotText].filter((part) => part !== '').join('\n\n')
  const dropped = dropReasons.badDecl + dropReasons.unknownUnit + dropReasons.remap + dropReasons.fetch
  const result: AssembleResult = {
    layer,
    digest: effective,
    digestBytes: bytesOf(digestText),
    digestEntryCount: effective.blocks.length + effective.coords.length,
    hotTail: {
      selections: ordered,
      stopReason,
      source,
      floorFilled,
      declaredUnits: rawDecls.length,
      dropped,
      dropReasons: { ...dropReasons },
      clipped,
      truncated,
      tokens: used,
      budgetTokens: budget,
    },
    archiveForm: { form: prior.length === 0 ? 'single' : 'chain', checkpointCount: prior.length },
    unitCount: units.length,
    rendered,
  }
  return { ok: true, result }
}

/** 档案文本（事实层 + 热尾；P19 注入面）。 */
export function renderArchive(result: AssembleResult): string {
  return result.rendered
}

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
import { scanLocatable } from './locatable.ts'
import { relativePath, type RootKind } from './paths.ts'
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

/**
 * 插件源消息（`source.kind = 'plugin'`：本插件 notice 与官方 compact checkpoint 同判）不是任务材料。
 * 压缩域端点候选同样排除（U1：产物节点 seq 高、位置早，seq 谓词会被它骗到区间起点）。
 */
export function isPluginSourceEvent(data: unknown): boolean {
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
      if (isPluginSourceEvent(event.data)) continue
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

/**
 * 机械归一化（F9 宽松口径）：坏形状一律修复为可渲染产物；只有非对象 = 空摘要。
 * F10：分步零指针（refs 退役）——模型即使夹带 refs 也被机械剥离。
 */
export function normalizeDigest(value: unknown): { digest: TaskDigest; stepDrops: number } {
  const root = recordOf(value)
  if (root === undefined) return { digest: { gist: '', steps: [] }, stepDrops: 0 }
  const gist = typeof root.gist === 'string' ? root.gist.trim() : ''
  const rawSteps = Array.isArray(root.steps) ? root.steps : []
  const steps: DigestStep[] = []
  let stepDrops = 0
  for (const raw of rawSteps) {
    const item = recordOf(raw)
    if (item === undefined || typeof item.text !== 'string' || item.text.trim() === '') { stepDrops++; continue }
    const type: DigestStepType = typeof item.type === 'string' && (DIGEST_STEP_TYPES as readonly string[]).includes(item.type)
      ? (item.type as DigestStepType)
      : 'note'
    steps.push({ type, text: item.text.trim() })
  }
  return { digest: { gist, steps }, stepDrops }
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

type RawSelection = Omit<HotTailSelection, 'rank'>

/** 热尾档案引用（F10：热尾指向档案；`vN` = 本 task 边界档案版本，从 prior 链长机械推出）。 */
export function archiveRefOf(priorChainLength: number): string {
  return `v${priorChainLength + 1}`
}

/**
 * 摘要头渲染（F10 契约；U11.1 抽为**单一事实源**）：gist 截断 → 分步逐条截断 → 摘要硬帽整条丢尾。
 *
 * 为什么必须共用：热尾预算的份额帽要扣掉摘要头体量（`hotTailMaxShare × 区间 − digestEstimate`）。
 * 旧实现用**未截断**原文估算——长总述/长分步被严重高估，份额帽被压到 `hotTailMinShare`(0.05) 下限，
 * 热尾被无谓砍掉（真机表现：产物比预期小得多）。截断规则只许在这里写一次。
 */
function renderDigestHead(
  digest: TaskDigest,
  policy: AssemblePolicy,
): { gist: string; lines: string[]; digestText: string; tokens: number } {
  const gist = truncateChars(digest.gist, policy.gistMaxChars, ELLIPSIS)
  const lines: string[] = []
  for (const step of digest.steps) {
    lines.push(`【${STEP_LABELS[step.type]}】${truncateChars(step.text, policy.stepMaxChars, ELLIPSIS)}`)
  }
  // 摘要硬帽：整条丢尾。
  while (lines.length > 0 && estimateTokens(lines.join('\n'), policy.density) > policy.digestMaxTokens) {
    lines.pop()
  }
  const digestText = [gist === '' ? '' : `${GIST_LABEL}${gist}`, ...lines].filter((part) => part !== '').join('\n')
  return { gist, lines, digestText, tokens: digestText === '' ? 0 : estimateTokens(digestText, policy.density) }
}

/**
 * 产物渲染（F10：总述 → 分步（零指针）→ 热尾（头指档案 + ▸n 内容）；字节稳定）。
 * 摘要硬帽：超限从**最后一条分步**起整条丢弃（机械；不重写）。
 * `digestText` = 档案落盘正文（仅总分，零事实、零热尾）；`text` = 替换入上下文全文。
 */
export function renderProduct(
  digest: TaskDigest,
  entries: readonly HotTailSelection[],
  policy: AssemblePolicy = DEFAULT_ASSEMBLE_POLICY,
  archiveRef = 'v1',
): { text: string; digestText: string; plan: DigestPlan } {
  const { gist, lines, digestText } = renderDigestHead(digest, policy)
  const body = entries
    .map(
      (entry) =>
        `${REF_PREFIX}${entry.rank}${entry.locator === undefined ? '' : ` [${entry.locator}]`}${entry.text === '' ? '' : ` ${entry.text}`}`,
    )
    .join('\n')
  const text = [digestText, entries.length === 0 ? '' : `【热尾｜档案 ${archiveRef}】\n${body}`]
    .filter((part) => part !== '')
    .join('\n\n')
  const scan = scanFactTexts([gist, ...digest.steps.slice(0, lines.length).map((step) => step.text)])
  return {
    text,
    digestText,
    plan: {
      bytes: new TextEncoder().encode(digestText).length,
      gistBytes: new TextEncoder().encode(gist).length,
      stepCount: lines.length,
      stepTokens: estimateTokens(lines.join('\n'), policy.density),
      factLeaks: scan.total,
      // 摘要头体量（gist + 分步）；产物总量 = 本值 + 热尾内容 + 指针开销。
      tokens: estimateTokens(digestText, policy.density),
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

/** 定位标注渲染（v4）：相对路径 + 版本 + 行区间（单行省略右端）。 */
function locatorOf(coord: FileCoord, root: string | undefined): string {
  const range =
    coord.lineRange === undefined
      ? ''
      : coord.lineRange.start === coord.lineRange.end
        ? `:${coord.lineRange.start}`
        : `:${coord.lineRange.start}-${coord.lineRange.end}`
  return `${relativePath(coord.path, root)}@v${coord.version}${range}`
}

/** v4：内容自带搜索键则不标注；否则需要定位标注。 */
function locatorIfNeeded(text: string, coord: FileCoord, root: string | undefined): string | undefined {
  return scanLocatable(text).locatable ? undefined : locatorOf(coord, root)
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
      const locator = locatorIfNeeded(decl.fact, coord, input.root)
      return {
        selection: {
          unitId: unit.id,
          tier: 'model',
          seqStart: unit.seqStart,
          seqEnd: unit.seqEnd,
          source: 'fact',
          coord,
          ...(locator === undefined ? {} : { locator }),
          text: decl.fact,
          tokens: estimateTokens(decl.fact, policy.density),
        },
      }
    }
    return { dropped: 'fetch' }
  }
  const locator = locatorIfNeeded(text, coord, input.root)
  return {
    selection: {
      unitId: unit.id,
      tier: 'model',
      seqStart: unit.seqStart,
      seqEnd: unit.seqEnd,
      source: 'file',
      coord,
      ...(locator === undefined ? {} : { locator }),
      text,
      tokens: estimateTokens(text, policy.density),
      ...(remap.clipped ? { clipped: true } : {}),
    },
  }
}

/**
 * 装配（贪心停机 + 单单元尾截断 + 地板填充 + 位置兜底；装配序 = 申报序）。
 * F10：摘要 = 总述 + 分步（零指针）；热尾 = 头指档案 vN + ▸n 内容（事实载体；错误信息不进）。
 */
export function assembleArchive(input: AssembleInput): AssembleOutcome {
  const policy = input.policy ?? DEFAULT_ASSEMBLE_POLICY
  const layer: AssembleLayer = input.layer ?? 'boundary'
  const units = input.units ?? []
  const prior = input.priorChain ?? []
  const priorShape = archiveChainShape(prior)
  if (priorShape.shape !== 'empty' && priorShape.shape !== 'prefix') return { ok: false, reason: 'digest-schema' }
  // F9 宽松口径：摘要坏形状一律机械修复；唯一 fatal 仍是续传链形态（上面）。
  const normalized = normalizeDigest(input.digest)
  const effective = normalized.digest
  if (units.length === 0 && effective.gist === '' && effective.steps.length === 0) return { ok: false, reason: 'no-units' }

  const byId = new Map<string, AssembleUnit>()
  for (const unit of units) if (!byId.has(unit.id)) byId.set(unit.id, unit)

  // F9 预算：绝对帽 + 份额帽（≤ maxShare × 区间，防产物 ≥ 被压区间被缩水校验打回）。
  // U11.1：摘要头体量按**截断后**文本估算（与 renderProduct 同一渲染函数），否则份额帽被虚高压缩。
  const regionTokens = input.regionTokens ?? 0
  const digestEstimate = renderDigestHead(effective, policy).tokens
  const shareCap = regionTokens > 0
    ? Math.max(Math.ceil(regionTokens * policy.hotTailMinShare), Math.ceil(regionTokens * policy.hotTailMaxShare) - digestEstimate)
    : policy.hotTailTokens
  const budget = Math.max(0, Math.min(policy.hotTailTokens, shareCap))
  const selections: RawSelection[] = []
  const picked = new Set<string>()
  let used = 0
  let clipped = 0
  let truncated = 0
  let quotaDrops = 0
  let stopReason: HotTailStopReason = 'list-end'
  let source: HotTailSource = 'model'
  let floorFilled = false
  const dropReasons: Record<HotTailDropReason, number> = { badDecl: 0, unknownUnit: 0, remap: 0, fetch: 0, dup: 0, factReject: 0, error: 0 }
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
      if (unit.isError === true) continue
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
      if (unit.isError === true) { dropReasons.error++; continue }
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
    // 配额不足以放最小内容 → 丢弃（F10：热尾无内容 = 无定位价值；计 quotaDrops）。
    // U13.2：locator 开销**不预先从预算里扣**——候选趟按无 overhead 分配，装填后按**幸存**条目
    //   结算；超出份额帽从**末位**撤标注（撤标注只损失定位、不丢内容 = 安全方向）。
    //   旧实现按**候选**数白扣 `40 × 候选数`（含最终被丢弃的条目）→ 预算被虚减。
    const weights = candidates.map((_, index) => 1 / (index + 1))
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
    let carry = 0
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index] as RawSelection
      const quota = Math.floor((budget * (weights[index] as number)) / totalWeight) + carry
      if (candidate.tokens <= quota) {
        push(candidate)
        carry = quota - candidate.tokens
        continue
      }
      // U13.1：截断后**重估并收口 ≤ 配额**——两桶密度非线性，按配额反推的字符数并不保证
      //   `estimate(截断文本) ≤ 配额`；旧实现只切不算，截断条目可超配额 → 总量越过份额帽
      //   → 缩水校验把整单打回（白付一次调用）。
      let chars = tokensToChars(candidate.text, quota, policy.density) - HOT_TAIL_TRUNCATION_MARKER.length
      let text = ''
      let tokens = 0
      for (let attempt = 0; attempt < 3; attempt++) {
        if (chars < policy.minTruncatedChars) break
        text = `${candidate.text.slice(0, chars)}${HOT_TAIL_TRUNCATION_MARKER}`
        tokens = estimateTokens(text, policy.density)
        if (tokens <= quota) break
        chars -= Math.max(1, tokensToChars(candidate.text, tokens - quota, policy.density))
      }
      if (text !== '' && chars >= policy.minTruncatedChars && tokens <= quota) {
        push({ ...candidate, text, tokens, truncated: true })
        truncated++
      } else {
        quotaDrops++
      }
      carry = 0
    }
    // U13.2：按幸存条目结算 locator 开销，超帽从末位撤标注。
    let overhead = 0
    for (const selection of selections) if (selection.locator !== undefined) overhead += policy.pointerOverheadTokens
    for (let index = selections.length - 1; index >= 0 && used + overhead > budget; index--) {
      const selection = selections[index] as RawSelection
      if (selection.locator === undefined) continue
      overhead -= policy.pointerOverheadTokens
      selections[index] = { ...selection, locator: undefined }
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
      // F10：错误信息不进热尾（错误行地板退役；错误单元申报在候选趟直接丢弃）。
      fill((unit) => unit.isVerification === true, VERIFY_LINE_RE, policy.floorVerifyLines)
    }
  }

  // 装配序 = 申报序（F10：▸n = 数组下标 + 1；档案引用 = 本 task 边界档案版本）。
  const archiveRef = archiveRefOf(prior.length)
  const entries: HotTailSelection[] = selections.map((selection, index) => ({ ...selection, rank: index + 1 }))
  const located = entries.filter((entry) => entry.locator !== undefined).length
  const unlocated = entries.filter((entry) => entry.locator === undefined && !scanLocatable(entry.text).locatable).length
  const product = renderProduct(effective, entries, policy, archiveRef)
  const dropped = dropReasons.badDecl + dropReasons.unknownUnit + dropReasons.remap + dropReasons.fetch
    + dropReasons.dup + dropReasons.factReject + dropReasons.error
  const result: AssembleResult = {
    layer,
    digest: effective,
    digestPlan: product.plan,
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
      quotaDrops,
      archiveRef,
      located,
      unlocated,
      tokens: used,
      budgetTokens: budget,
    },
    ...(input.root === undefined ? {} : { root: input.root }),
    ...(input.rootKind === undefined ? {} : { rootKind: input.rootKind }),
    archiveForm: { form: prior.length === 0 ? 'single' : 'chain', checkpointCount: prior.length },
    unitCount: units.length,
    digestText: product.digestText,
    rendered: [...prior.map((entry) => entry.text), product.text].filter((part) => part !== '').join('\n\n'),
  }
  return { ok: true, result }
}

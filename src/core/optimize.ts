/**
 * 星标断面纯核（docs/02 §4 / docs/07 §0.5 / docs/11 §2 core/optimize.ts）。
 * 纯函数：输入栈装配与预算钳制、断面 prompt v1 渲染、候选 span、四道机械闸、
 * 双通道行级容错解析、断面族度量 fold。core 零 harness/platform import；不抛错。
 */
import { DOSSIER_CLASSES, isTrivialMessage, type DossierBody, type DossierClass, type DossierMessage } from './dossier.ts'
import { estimateTokens } from './ledger/fold.ts'
import { normalizeSkillCatalog, renderStablePrefix, type ProjectFrameBody, type SkillCatalogSnapshot } from './prefix.ts'

// —— 常量与门控（P14c：产品层不再受「历史消息太短」门控；唯一门控 = 本次提示词极短） ——
export const OPTIMIZE_PROMPT_VERSION = 2

/**
 * ★ 唯一门控（P14c §3）：本次提示词极短 → 零调用短路、不产出。
 * 与 client 禁用判据同口径（client 侧常量镜像见 client/star/star-model.ts）。
 */
export const isTrivialOptimizePrompt = isTrivialMessage
export const OPTIMIZE_INPUT_TOKEN_BUDGET = 24_000
export const OPTIMIZE_PROMPT_MAX_CHARS = 4_000
export const OPTIMIZE_CONCLUSION_MAX_CHARS = 40
export const OPTIMIZE_MAX_VERDICT_LINES = 200
export const OPTIMIZE_MAX_CANDIDATE_SPANS = 40
/** 候选事实文本上限（约束从句可能很长，截断只影响展示与包含性检查）。 */
export const OPTIMIZE_CANDIDATE_MAX_CHARS = 120
export const OPTIMIZE_PROMPT_HEAD = `你是提示词优化断面。基于稳定前缀、卷宗、当前 prompt、候选权威段与技能目录，输出优化后的提示词正文与行式裁决。

产品段就是用户将要直接发送的提示词本身——自然成文，按公认的优秀结构组织：
1. 结构融入行文，禁止分节标题与标签：不许出现"关键路径锚定：""约束与验收：""探索豁免声明"这类字样，也不许出现"原样保留用户提示词""以下为优化后提示词"这类元注释或自我说明。
2. 顺序自然：先说要做什么与达到什么，再说交付物与验收标准，再说约束与禁止项，最后给执行路径（只引用技能目录中真实存在的技能名；步骤条件化，若 A 不存在则走 B；已钉死的路径声明不再试错搜索）。
3. 关键事实逐字保真：路径、版本号与数值、约束与合规词句、被 KEEP 勾选的候选权威段——一字不改、不省略。
4. 其余文字大胆重写：删冗余、并重复、口语改精确指令、重排顺序；不复述原文，不解释改动。
5. 篇幅以讲清楚为限，通常比原文更短。

候选权威段规则：只能从候选权威段中按编号选择 KEEP；裁决行只使用输入中已存在的消息 seq、技能名与候选编号。`
export const OPTIMIZE_PROMPT_OUTPUT = `输出格式（严格两段，不要额外内容）：
[PRODUCT]

[VERDICTS]
每行一条裁决，仅允许：
CLASS <seq> <action|pureQ|verifyQ>
BOUNDARY <seq>
SHEAR <startSeq>..<endSeq> 已吸收：<note>
SKILL <name>
KEEP <spanIndex>
ASPECT <text>
FILE <signature>
KEYWORD <keyword>`

// —— 输入栈装配与 prompt 渲染 ——
export interface OptimizeInput { projectFrame: ProjectFrameBody | undefined; dossier: DossierBody; prompt: string; catalog: SkillCatalogSnapshot | undefined }
export interface OptimizeRender { version: number; prompt: string; ctxTokens: number; truncatedDossierCount: number; historyCount: number }
export type OptimizeAssembled = { prefixText: string; dossierMessages: DossierMessage[]; promptText: string; ctxTokens: number; truncatedDossierCount: number; historyCount: number }

function dossierText(messages: readonly DossierMessage[]): string { return messages.map((m) => m.text).join('\n') }

export function clampOptimizePrompt(prompt: string, maxChars: number = OPTIMIZE_PROMPT_MAX_CHARS): string {
  if (prompt.length <= maxChars) return prompt
  return `${prompt.slice(0, 3000)}\n…[prompt truncated]…\n${prompt.slice(-1000)}`
}

export function assembleOptimizeInput(input: OptimizeInput): OptimizeAssembled {
  const prefixText = input.projectFrame ? renderStablePrefix(input.projectFrame) : '(无项目帧)'
  const promptText = clampOptimizePrompt(input.prompt)
  let dossierMessages = input.dossier.messages.slice()
  const originalCount = dossierMessages.length
  while (dossierMessages.length > 0 && estimateTokens(prefixText + dossierText(dossierMessages) + promptText) > OPTIMIZE_INPUT_TOKEN_BUDGET) {
    dossierMessages = dossierMessages.slice(1)
  }
  const ctxTokens = estimateTokens(`${prefixText}\n${dossierText(dossierMessages)}\n${promptText}`)
  return {
    prefixText, dossierMessages, promptText, ctxTokens,
    truncatedDossierCount: originalCount - dossierMessages.length, historyCount: originalCount,
  }
}

function renderSkillCatalog(catalog: SkillCatalogSnapshot | undefined): string {
  if (catalog === undefined || catalog.complete === false) return '(目录不可用)'
  const skills = normalizeSkillCatalog(catalog).skills
  return skills.length === 0 ? '(无)' : skills.map((s) => s.whenToUse === undefined ? `- ${s.name}: ${s.description}` : `- ${s.name}: ${s.description} (whenToUse: ${s.whenToUse})`).join('\n')
}

export function renderOptimizePrompt(input: OptimizeInput): OptimizeRender {
  const a = assembleOptimizeInput(input)
  const candidates = extractAuthorityCandidates(input.prompt)
  const dossierLines = a.dossierMessages.map((m) => `<msg seq="${m.seq}">${m.text}</msg>`)
  if (a.truncatedDossierCount > 0) dossierLines.unshift(`…[dossier truncated: ${a.truncatedDossierCount} earlier messages omitted]…`)
  const dossierSection = `[卷宗]\n${dossierLines.join('\n') || '(空)'}`
  const promptSection = `[当前 prompt]\n${a.promptText}`
  const candidateSection = `[候选权威段]\n${candidates.length === 0 ? '(无)' : candidates.map((c) => `${c.index}. ${c.text}`).join('\n')}`
  const skillSection = `[技能目录]\n${renderSkillCatalog(input.catalog)}`
  const prompt = [OPTIMIZE_PROMPT_HEAD, `[稳定前缀]\n${a.prefixText}`, dossierSection, promptSection, candidateSection, skillSection, OPTIMIZE_PROMPT_OUTPUT].join('\n\n')
  return {
    version: OPTIMIZE_PROMPT_VERSION, prompt, ctxTokens: a.ctxTokens,
    truncatedDossierCount: a.truncatedDossierCount, historyCount: a.historyCount,
  }
}

// —— 候选权威段与四道机械闸（P14d §1：事实级预抽，不再按行切分） ——
/**
 * 候选权威段：按**事实类型**机械预抽——路径/引号文本/版本数值为必保
 * （mandatory：与模型 KEEP 取并集后做包含性检查），约束从句为可保（模型按 KEEP 选择）。
 * 旧实现按行切分：单行 prompt 退化为「整条原文 = 唯一候选」，KEEP 即结构性锁死改写。
 */
export interface AuthorityCandidate { index: number; text: string; mandatory?: boolean }

/** 路径/文件引用/章节锚（必保）：src/a.ts、docs/02-discriminator.md、C:\x\y.md、a.ts:12-14、§4、P14c。 */
const CANDIDATE_PATH_RE = /(?:[A-Za-z]:)?(?:[A-Za-z0-9_@.-]+[\\/])+[A-Za-z0-9_@.-]+(?::\d+(?:-\d+)?)?|\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|mjs|cjs|json|jsonl|md|ya?ml|txt|log|sh|ps1|py|go|rs|java|c|cc|cpp|h|hpp|css|html|toml|ini|cfg|png|jpe?g|svg|zstd)(?::\d+(?:-\d+)?)?|§\s*\d+(?:\.\d+)*|\bP\d+[a-z]?\b/g
/** 引号内文本（必保）：用户明确引用即不可丢。 */
const CANDIDATE_QUOTED_RE = /[「『“"]([^」』”"\n]{2,80})[」』”"]/g
/** 版本号/小数/百分比/日期/带单位数值（必保）。 */
const CANDIDATE_NUMBER_RE = /\bv?\d+\.\d+(?:\.\d+)*\b|\b\d[\d_,]*(?:\.\d+)?%|\d{4}-\d{2}-\d{2}|\b\d[\d_,]*\s?(?:K|M|ms|tokens?|倍|条|次|个|字符)/g
/** 约束/合规从句关键词（可保，模型选择）。 */
const CANDIDATE_CONSTRAINT_KEYWORD_RE = /必须|不得|禁止|务必|至少|最多|不超过|不许|不要|只能|需要|要求|注意/
/** 约束从句长度上限：过长即交给改写，不作为逐字候选（避免 KEEP 整段原文）。 */
export const OPTIMIZE_CONSTRAINT_CLAUSE_MAX_CHARS = 60

function pushMatches(prompt: string, re: RegExp, mandatory: boolean, found: Array<{ text: string; mandatory: boolean; at: number }>): void {
  const rx = new RegExp(re.source, re.flags)
  let match: RegExpExecArray | null
  while ((match = rx.exec(prompt)) !== null) {
    const text = (match[1] ?? match[0]).trim()
    if (text.length > 0) found.push({ text: text.slice(0, OPTIMIZE_CANDIDATE_MAX_CHARS), mandatory, at: match.index })
    if (match.index === rx.lastIndex) rx.lastIndex++
  }
}

export function extractAuthorityCandidates(prompt: string): AuthorityCandidate[] {
  const found: Array<{ text: string; mandatory: boolean; at: number }> = []
  pushMatches(prompt, CANDIDATE_PATH_RE, true, found)
  pushMatches(prompt, CANDIDATE_QUOTED_RE, true, found)
  pushMatches(prompt, CANDIDATE_NUMBER_RE, true, found)
  for (const clause of prompt.split(/[。；！？，,;!\n]/)) {
    const text = clause.trim()
    if (text.length === 0 || text.length > OPTIMIZE_CONSTRAINT_CLAUSE_MAX_CHARS) continue
    if (!CANDIDATE_CONSTRAINT_KEYWORD_RE.test(text)) continue
    found.push({ text, mandatory: false, at: prompt.indexOf(text) })
  }
  const seen = new Set<string>()
  const out: AuthorityCandidate[] = []
  for (const item of found.sort((a, b) => a.at - b.at)) {
    if (seen.has(item.text)) continue
    seen.add(item.text)
    out.push({ index: out.length + 1, text: item.text, mandatory: item.mandatory })
    if (out.length >= OPTIMIZE_MAX_CANDIDATE_SPANS) break
  }
  return out
}

/** 必保候选编号（机械强制，不依赖模型是否勾选 KEEP）。 */
export function mandatoryCandidateIndexes(candidates: readonly AuthorityCandidate[]): number[] {
  return candidates.filter((candidate) => candidate.mandatory === true).map((candidate) => candidate.index)
}

// —— 产品元注释机械剥离（P14d §2） ——
export interface ProductStripResult { product: string | null; stripped: number }

/** 元注释行判据（窄口径）：只认「对自己行为的说明」，不碰用户可能接受的正文结构。 */
function isProductMetaLine(line: string): boolean {
  if (line.length > 40) return false
  if (/^原样保留(?:用户)?(?:的)?(?:原)?(?:提示词|prompt|原文)/i.test(line)) return true
  if (/^以下(?:是|为)?(?:优化后的?)?(?:提示词|prompt|内容|结果)\s*[:：]?$/.test(line)) return true
  if (/^优化后(?:的)?(?:提示词|prompt|版本)?\s*[:：]?$/.test(line)) return true
  if (/^(?:提示词|说明|备注|注|注意|前言|总结)\s*[:：]\s*$/.test(line)) return true
  return false
}

/** 只剥离产品**开头连续**的元注释行；剥空则整体回退原文（失败默认保留）。 */
export function stripProductMeta(product: string | null): ProductStripResult {
  if (product === null) return { product: null, stripped: 0 }
  const lines = product.split('\n')
  let cut = 0
  let stripped = 0
  while (cut < lines.length) {
    const line = lines[cut]!.trim()
    if (line.length === 0) { cut++; continue }
    if (!isProductMetaLine(line)) break
    cut++
    stripped++
  }
  if (stripped === 0) return { product, stripped: 0 }
  const rest = lines.slice(cut).join('\n').trim()
  if (rest.length === 0) return { product, stripped: 0 }
  return { product: rest, stripped }
}

export function validateSkillName(name: string, catalog: SkillCatalogSnapshot | undefined): boolean {
  if (catalog === undefined || catalog.complete === false) return false
  return normalizeSkillCatalog(catalog).skills.some((s) => s.name === name)
}

export interface AuthorityCheck { missing: AuthorityCandidate[]; kept: number[] }

export function checkAuthoritySpans(product: string, candidates: AuthorityCandidate[], keptIndexes: number[]): AuthorityCheck {
  const seen = new Set<number>()
  const kept: number[] = []
  const missing: AuthorityCandidate[] = []
  for (const index of keptIndexes) {
    if (seen.has(index)) continue
    seen.add(index)
    const candidate = candidates.find((c) => c.index === index)
    if (candidate === undefined) continue
    kept.push(index)
    if (!product.includes(candidate.text)) missing.push(candidate)
  }
  return { missing, kept }
}

// —— 双通道解析（行级容错） ——
export type OptimizeVerdict =
  | { kind: 'class'; seq: number; class: DossierClass }
  | { kind: 'boundary'; seq: number }
  | { kind: 'shear'; startSeq: number; endSeq: number; note: string }
  | { kind: 'skill'; name: string }
  | { kind: 'keep'; spanIndex: number }
  | { kind: 'aspect'; text: string }
  | { kind: 'file'; signature: string }
  | { kind: 'keyword'; keyword: string }

export interface OptimizeParseResult {
  product: string | null
  verdicts: OptimizeVerdict[]
  droppedLines: number
  skillNames: string[]
  shearItems: Array<{ startSeq: number; endSeq: number; note: string }>
  backfillVerdicts: Partial<Record<number, DossierClass>>
  judgeTable: { aspects: string[]; fileSignatures: string[]; keywords: string[] }
  keptSpanIndexes: number[]
}

function hasSeq(dossier: DossierBody, seq: number): boolean { return dossier.messages.some((m) => m.seq === seq) }

function parseClassLine(rest: string, dossier: DossierBody): OptimizeVerdict | null {
  const m = rest.trim().match(/^(\d+)\s+(\S+)$/)
  if (m === null) return null
  const seq = Number(m[1])
  const klass = m[2] as DossierClass
  if (!hasSeq(dossier, seq) || !(DOSSIER_CLASSES as readonly string[]).includes(klass)) return null
  return { kind: 'class', seq, class: klass }
}

function parseBoundaryLine(rest: string, dossier: DossierBody): OptimizeVerdict | null {
  const m = rest.trim().match(/^(\d+)$/)
  if (m === null || !hasSeq(dossier, Number(m[1]))) return null
  return { kind: 'boundary', seq: Number(m[1]) }
}

function parseShearLine(rest: string, dossier: DossierBody): { verdict: OptimizeVerdict; shear: { startSeq: number; endSeq: number; note: string } } | null {
  const m = rest.match(/^(\d+)\.\.(\d+)\s+已吸收：([\s\S]*)$/)
  if (m === null) return null
  const startSeq = Number(m[1])
  const endSeq = Number(m[2])
  if (!hasSeq(dossier, startSeq) || !hasSeq(dossier, endSeq) || startSeq > endSeq) return null
  const note = m[3].trim()
  if (note.length === 0) return null
  const shear = { startSeq, endSeq, note: note.slice(0, OPTIMIZE_CONCLUSION_MAX_CHARS) }
  return { verdict: { kind: 'shear', startSeq, endSeq, note }, shear }
}

function parseKeepLine(rest: string, candidates: AuthorityCandidate[] | undefined): OptimizeVerdict | null {
  const m = rest.trim().match(/^(\d+)$/)
  if (m === null) return null
  const spanIndex = Number(m[1])
  if (candidates === undefined || !candidates.some((c) => c.index === spanIndex)) return null
  return { kind: 'keep', spanIndex }
}

function parseTextLine(kind: 'aspect' | 'file' | 'keyword', rest: string, maxChars: number): OptimizeVerdict | null {
  const text = rest.trim().slice(0, maxChars)
  if (text.length === 0) return null
  if (kind === 'aspect') return { kind, text }
  if (kind === 'file') return { kind, signature: text }
  return { kind, keyword: text }
}

export function parseOptimizeOutput(raw: string, dossier: DossierBody, catalog: SkillCatalogSnapshot | undefined, candidates: AuthorityCandidate[] = []): OptimizeParseResult {
  const productStart = raw.indexOf('[PRODUCT]')
  const verdictStart = raw.indexOf('[VERDICTS]')
  let product: string | null = null
  if (productStart !== -1 && verdictStart !== -1 && verdictStart > productStart) {
    const text = raw.slice(productStart + '[PRODUCT]'.length, verdictStart).trim()
    if (text.length > 0) product = text
  }
  const verdicts: OptimizeVerdict[] = []
  const skillNames: string[] = []
  const shearItems: Array<{ startSeq: number; endSeq: number; note: string }> = []
  const backfillVerdicts: Partial<Record<number, DossierClass>> = {}
  const judgeTable = { aspects: [] as string[], fileSignatures: [] as string[], keywords: [] as string[] }
  const keptSpanIndexes: number[] = []
  let droppedLines = 0
  if (verdictStart !== -1) {
    const lines = raw.slice(verdictStart + '[VERDICTS]'.length).split('\n')
    let parsedLines = 0
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue
      if (parsedLines >= OPTIMIZE_MAX_VERDICT_LINES) { droppedLines++; continue }
      parsedLines++
      let parsed: OptimizeVerdict | null = null
      let shear: { startSeq: number; endSeq: number; note: string } | null = null
      if (trimmed.startsWith('CLASS ')) parsed = parseClassLine(trimmed.slice(6), dossier)
      else if (trimmed.startsWith('BOUNDARY ')) parsed = parseBoundaryLine(trimmed.slice(9), dossier)
      else if (trimmed.startsWith('SHEAR ')) {
        const r = parseShearLine(trimmed.slice(6), dossier)
        if (r !== null) { parsed = r.verdict; shear = r.shear }
      } else if (trimmed.startsWith('SKILL ')) {
        const name = trimmed.slice(6).trim()
        if (name.length > 0 && validateSkillName(name, catalog)) parsed = { kind: 'skill', name }
      } else if (trimmed.startsWith('KEEP ')) parsed = parseKeepLine(trimmed.slice(5), candidates)
      else if (trimmed.startsWith('ASPECT ')) parsed = parseTextLine('aspect', trimmed.slice(7), 80)
      else if (trimmed.startsWith('FILE ')) parsed = parseTextLine('file', trimmed.slice(5), 200)
      else if (trimmed.startsWith('KEYWORD ')) parsed = parseTextLine('keyword', trimmed.slice(8), 80)
      if (parsed === null) { droppedLines++; continue }
      verdicts.push(parsed)
      if (parsed.kind === 'class') backfillVerdicts[parsed.seq] = parsed.class
      else if (parsed.kind === 'skill') skillNames.push(parsed.name)
      else if (parsed.kind === 'shear' && shear !== null) shearItems.push(shear)
      else if (parsed.kind === 'keep') keptSpanIndexes.push(parsed.spanIndex)
      else if (parsed.kind === 'aspect') judgeTable.aspects.push(parsed.text)
      else if (parsed.kind === 'file') judgeTable.fileSignatures.push(parsed.signature)
      else if (parsed.kind === 'keyword') judgeTable.keywords.push(parsed.keyword)
    }
  }
  return { product, verdicts, droppedLines, skillNames, shearItems, backfillVerdicts, judgeTable, keptSpanIndexes }
}

// —— 断面族度量 fold（度量先行） ——
export interface OptimizeLlmUsage { inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
export interface OptimizeRecord { time: number; short: boolean; ctxTokens: number; llmUsage?: OptimizeLlmUsage; backfillCount: number; backfillConflicts: number; shearPairs: number; shearTokens: number; metaStrippedLines?: number }
export interface OptimizeLedger {
  optimizeCount: number
  optimizePromptTokens: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }
  verdictBackfill: { count: number; conflicts: number }
  shearAtStar: { pairs: number; tokens: number }
  /** P14d：产品开头被机械剥离的元注释行总数（prompt v2 的效果读数）。 */
  metaStrippedLines: number
}

export function foldOptimizeLedger(records: OptimizeRecord[]): OptimizeLedger {
  const optimizePromptTokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  let backfillCount = 0
  let backfillConflicts = 0
  let shearPairs = 0
  let shearTokens = 0
  let metaStrippedLines = 0
  for (const record of records) {
    if (record.llmUsage !== undefined) {
      optimizePromptTokens.inputTokens += record.llmUsage.inputTokens ?? 0
      optimizePromptTokens.outputTokens += record.llmUsage.outputTokens ?? 0
      optimizePromptTokens.totalTokens += record.llmUsage.totalTokens ?? 0
      optimizePromptTokens.cacheReadTokens += record.llmUsage.cacheReadTokens ?? 0
      optimizePromptTokens.cacheWriteTokens += record.llmUsage.cacheWriteTokens ?? 0
      optimizePromptTokens.reasoningTokens += record.llmUsage.reasoningTokens ?? 0
    }
    backfillCount += record.backfillCount
    backfillConflicts += record.backfillConflicts
    shearPairs += record.shearPairs
    shearTokens += record.shearTokens
    metaStrippedLines += record.metaStrippedLines ?? 0
  }
  return { optimizeCount: records.length, optimizePromptTokens, verdictBackfill: { count: backfillCount, conflicts: backfillConflicts }, shearAtStar: { pairs: shearPairs, tokens: shearTokens }, metaStrippedLines }
}

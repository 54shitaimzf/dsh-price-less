/**
 * 星标断面纯核（docs/02 §4 / docs/07 §0.5 / docs/11 §2 core/optimize.ts）。
 * 纯函数：输入栈装配与预算钳制、断面 prompt v1 渲染、候选 span、四道机械闸、
 * 双通道行级容错解析、断面族度量 fold。core 零 harness/platform import；不抛错。
 */
import { DOSSIER_CLASSES, isDossierShort, type DossierBody, type DossierClass, type DossierMessage } from './dossier.ts'
import { estimateTokens } from './ledger/fold.ts'
import { normalizeSkillCatalog, renderStablePrefix, type ProjectFrameBody, type SkillCatalogSnapshot } from './prefix.ts'

// —— 常量与门控 ——
export const OPTIMIZE_PROMPT_VERSION = 1
export const OPTIMIZE_GATE_DEFAULTS = { minMessages: 2, minTextLength: 10 }
export const OPTIMIZE_INPUT_TOKEN_BUDGET = 24_000
export const OPTIMIZE_PROMPT_MAX_CHARS = 4_000
export const OPTIMIZE_CONCLUSION_MAX_CHARS = 40
export const OPTIMIZE_MAX_VERDICT_LINES = 200
export const OPTIMIZE_MAX_CANDIDATE_SPANS = 40
export const OPTIMIZE_PROMPT_HEAD = `你是上下文优化断面。请基于稳定前缀、卷宗、当前 prompt、候选权威段与技能目录，输出优化后的产品与行式裁决。

内容四件：
1. 意图不变：保留用户原文的路径/数值/约束/合规词句；被 KEEP 勾选的候选权威段必须逐字出现在产品中。
2. 约束与验收前置：显式列出完成标准与验证方式。
3. 复杂操作路径固定化：只引用技能目录中真实存在的技能名，步骤条件化（若 A 不存在则走 B）。
4. 探索豁免声明：已钉死路径不再试错搜索。

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
export interface OptimizeRender { version: number; prompt: string; short: boolean; ctxTokens: number; truncatedDossierCount: number }
export type OptimizeAssembled = { prefixText: string; dossierMessages: DossierMessage[]; promptText: string; ctxTokens: number; truncatedDossierCount: number; short: boolean }

function dossierText(messages: readonly DossierMessage[]): string { return messages.map((m) => m.text).join('\n') }

export function clampOptimizePrompt(prompt: string, maxChars: number = OPTIMIZE_PROMPT_MAX_CHARS): string {
  if (prompt.length <= maxChars) return prompt
  return `${prompt.slice(0, 3000)}\n…[prompt truncated]…\n${prompt.slice(-1000)}`
}

export function assembleOptimizeInput(input: OptimizeInput): OptimizeAssembled {
  const short = isDossierShort(input.dossier, OPTIMIZE_GATE_DEFAULTS)
  const prefixText = input.projectFrame ? renderStablePrefix(input.projectFrame) : '(无项目帧)'
  const promptText = clampOptimizePrompt(input.prompt)
  let dossierMessages = input.dossier.messages.slice()
  let truncatedDossierCount = 0
  if (!short) {
    const originalCount = dossierMessages.length
    while (dossierMessages.length > 0 && estimateTokens(prefixText + dossierText(dossierMessages) + promptText) > OPTIMIZE_INPUT_TOKEN_BUDGET) {
      dossierMessages = dossierMessages.slice(1)
    }
    truncatedDossierCount = originalCount - dossierMessages.length
  }
  const ctxTokens = estimateTokens(`${prefixText}\n${dossierText(dossierMessages)}\n${promptText}`)
  return { prefixText, dossierMessages, promptText, ctxTokens, truncatedDossierCount, short }
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
  const outputSection = a.short ? `[PRODUCT]\n(空)\n\n[VERDICTS]\n${OPTIMIZE_PROMPT_OUTPUT}` : OPTIMIZE_PROMPT_OUTPUT
  const prompt = [OPTIMIZE_PROMPT_HEAD, `[稳定前缀]\n${a.prefixText}`, dossierSection, promptSection, candidateSection, skillSection, outputSection].join('\n\n')
  return { version: OPTIMIZE_PROMPT_VERSION, prompt, short: a.short, ctxTokens: a.ctxTokens, truncatedDossierCount: a.truncatedDossierCount }
}

// —— 候选 span 与四道机械闸 ——
export interface AuthorityCandidate { index: number; text: string }

export function extractAuthorityCandidates(prompt: string): AuthorityCandidate[] {
  return prompt.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).slice(0, OPTIMIZE_MAX_CANDIDATE_SPANS).map((text, i) => ({ index: i + 1, text }))
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
export interface OptimizeRecord { time: number; short: boolean; ctxTokens: number; llmUsage?: OptimizeLlmUsage; backfillCount: number; backfillConflicts: number; shearPairs: number; shearTokens: number }
export interface OptimizeLedger {
  optimizeCount: number
  optimizePromptTokens: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }
  verdictBackfill: { count: number; conflicts: number }
  shearAtStar: { pairs: number; tokens: number }
}

export function foldOptimizeLedger(records: OptimizeRecord[]): OptimizeLedger {
  const optimizePromptTokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  let backfillCount = 0
  let backfillConflicts = 0
  let shearPairs = 0
  let shearTokens = 0
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
  }
  return { optimizeCount: records.length, optimizePromptTokens, verdictBackfill: { count: backfillCount, conflicts: backfillConflicts }, shearAtStar: { pairs: shearPairs, tokens: shearTokens } }
}

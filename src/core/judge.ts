/**
 * 判据与对表纯核（docs/02 §3 / docs/07 §0.5 / docs/11 §2 core/judge.ts）。
 * 纯函数：L0 延续词表、L1 精确缓存键、对表层谓词、judge prompt v3 渲染与 fail-lazy 解析、
 * 判别族度量 fold。core 零 harness/platform import；不抛错，异常边界交给调用侧 fail-lazy。
 */
import { DOSSIER_CLASSES, foldDossierLedger, type DossierBody, type DossierClass } from './dossier.ts'
import type { JudgeVerdictFactData } from './units.ts'

// —— 判据 prompt v3（版本化；规则分句与 datasets/prompt-discriminator-v2.2.txt 同源） ——
export const JUDGE_PROMPT_VERSION = 3
export const JUDGE_PROMPT_HEAD = '你是会话任务边界判别器。用户消息是任务边界的唯一来源。对 <target> 判定相对任务上下文是否开启新任务。'
export const JUDGE_PROMPT_CONTEXT = '任务上下文 = <dossier> 中按序排列的全部用户消息（不含 <target>）。<dossier> 中最近一条用户消息是任务的最新进展，为主要参照；更早消息是背景。\n- 以下先决排除（任一命中即判 continue，不再往下检查）。'
export const JUDGE_PROMPT_RULES_CLAUSES = `先决排除：
1) 言说层：target 是追问/澄清/报错/汇报/粘贴工具输出或日志/讲解/质询/观点交流/方案设计/评估标准/方法或规则讨论/根因讨论。这类内容是当前工作的言说层，与讨论对象是否变化无关。
2) 收尾层：同一任务的收口/清理残余与过期内容/更新文档/审计/复盘。
3) 无法确定。

以上均不命中才进入以下检查（命中任一 = new_task）：
4) 宣布/承诺/命令链：target 含发起性语句（"我打算"/"我希望你先"/"接下来需要你"/"交给你N个任务"/"先给我创建"/"咱们测试一下"/"准备做"/"开始做"/"现在动手"/"再来一次并"等）且带明确实操目标（做/创建/测试/落地/实现/重构/审查/验证/嵌入等）——这是用户发动新工作的信号，即使句中也包含讨论或说明。只有"打算/想"而无具体目标动作的不算。
5) 换意图：target 用户要做的事（目标产物/命令/决定）与任务上下文不同，不是同一件事的推进。注意：讨论、讲解、方案、评估标准、观点、方法属于言说层（已排除），其话题变化不算换意图。
6) 换对象：target 针对的工作对象（文件/项目/产物/工具/代码库）变化；测试或审查的对象主题变化也算对象变化（如从测判别器准确率转为测embedding性能）。讨论中被提及的概念对象不算工作对象。
7) 换域：领域/项目/主题域真实变化（如从缓存机制跳到文件治理）。
8) 换形态：任务上下文内一直是言说推进（讨论/理解/咨询/建议），target 首次出现实操动词（挑选/跑/判定/init/创建/落地/训练/验证/审查/写代码/建项等），即"说→做"。注意：上下文已有实操（找/搜/写/测），target 继续实操属于执行链内的子步骤，不是换形态。
9) 中止重开：否定整个任务目标 + 明确新命令；方案细节的否定与迭代属于同一任务的讨论，不算。

否则 = continue，包括：同一工作进行、细化、推进、对工作本身的讨论等。`
export const JUDGE_PROMPT_OUTPUT = '输出（仅 JSON，无其他文本）：\n{"decision":"new_task"|"continue","class":"action"|"pureQ"|"verifyQ"}'

// —— L0 延续词表（冻结口径；同源文件 scripts/attic/phase_a_l0.mjs 已于 2026-09 清理，原内容保留在 git 历史） ——
export const L0_CONTINUE_WORDS: readonly string[] = [
  '继续', '继续吧', '继续继续', '好的', '好的好的', '好', '好哦', '好呀', '好吧', '行', '行吧', '嗯', '嗯嗯',
  '对', '对的', '是的', '没错', '确实', '明白了', '明白', '知道了', '可以', '可以了', '没问题', '收到', '好滴',
  '谢谢', '然后呢', '还有', '接着', '接着吧', '继续做', '接着做', '继续说', '继续搞', '来吧', '请继续',
  'ok', 'okay', 'yes', 'yep', 'yeah', 'sure', 'great', 'nice', 'gotit', 'understood', 'thanks', 'thanks!',
  'continue', 'goon', 'alright', 'fine', 'right', 'indeed', 'good', 'perfect', 'done', 'works', 'ok!',
  'k', 'kk', 'ok.', 'yes.', 'sure.', 'thanks.', 'right.', 'great.', 'nice.', 'perfect.',
]

const L0_STRIP_RE = /[\s\u3000！？。，、；：""''（）《》【】!?.,;:()\[\]{}~\-—_…]/gu

export function stripL0Text(text: string): string {
  return text.replace(L0_STRIP_RE, '').toLowerCase()
}

export function matchL0Continue(text: string): boolean {
  const s = stripL0Text(text)
  if (s.length === 0) return false
  return L0_CONTINUE_WORDS.includes(s)
}

// —— L1 精确缓存键 ——
function freezeValue(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(freezeValue).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return '{' + Object.keys(obj).sort()
      .map((k) => JSON.stringify(k) + ':' + freezeValue(obj[k]))
      .join(',') + '}'
  }
  return JSON.stringify(value) ?? String(value)
}

export function freezeJudgeConfig(value: unknown): string {
  return freezeValue(value)
}

export interface JudgeL1Scope {
  sessionId: string
  seq: number
  text: string
  configFingerprint: string
}

export function judgeL1CacheKey(scope: JudgeL1Scope, promptVersion?: number): string {
  return JSON.stringify(['judge-l1', promptVersion ?? JUDGE_PROMPT_VERSION, scope.sessionId, scope.seq, scope.configFingerprint, scope.text])
}

// —— 对表层 ——
export const JUDGE_TABLE_VERSION = 1

export interface JudgeTable {
  version: number
  aspects: string[]
  fileSignatures: string[]
  keywords: string[]
}

export interface JudgeTableMatch {
  hit: boolean
  reason?: 'file-signature' | 'keyword'
}

export function createEmptyJudgeTable(): JudgeTable {
  return { version: JUDGE_TABLE_VERSION, aspects: [], fileSignatures: [], keywords: [] }
}

export function matchJudgeTable(text: string, table: JudgeTable | undefined): JudgeTableMatch {
  if (!table || table.version < 1) return { hit: false }
  const lower = text.toLowerCase()
  const keyword = table.keywords.some((k) => lower.includes(k.toLowerCase()))
  const fileSignature = table.fileSignatures.some((s) => lower.includes(s.toLowerCase()))
  if (keyword && fileSignature) return { hit: true, reason: 'file-signature' }
  if (keyword) return { hit: true, reason: 'keyword' }
  if (fileSignature) return { hit: true, reason: 'file-signature' }
  return { hit: false }
}

// —— LLM 主路径：prompt 渲染 + fail-lazy 解析 ——
export type JudgeDecision = 'continue' | 'new-task'

export interface JudgeTarget {
  seq: number
  text: string
}

export interface JudgePrompt {
  version: number
  prompt: string
  ctxTokens: number
  targetSeq: number
}

export function renderJudgePrompt(dossier: DossierBody, target: JudgeTarget): JudgePrompt {
  const ctxMessages = dossier.messages.filter((m) => target.seq === undefined || m.seq < target.seq)
  const ctxBody: DossierBody = { ...dossier, messages: ctxMessages, annotations: dossier.annotations }
  const ctxTokens = foldDossierLedger(ctxBody).ctxTokens
  const messages = ctxMessages.map((m) => `<msg seq="${m.seq}">${m.text}</msg>`).join('\n') || '(空)'
  const prompt = `${JUDGE_PROMPT_HEAD}

${JUDGE_PROMPT_CONTEXT}

${JUDGE_PROMPT_RULES_CLAUSES}

<dossier>
${messages}
</dossier>

<target>${target.text}</target>

${JUDGE_PROMPT_OUTPUT}`
  return { version: JUDGE_PROMPT_VERSION, prompt, ctxTokens, targetSeq: target.seq }
}

export interface JudgeLlmOutput {
  decision: JudgeDecision
  class: DossierClass
}

export function parseJudgeLlmOutput(raw: string): JudgeLlmOutput | null {
  let text = raw.trim()
  if (text.startsWith('```')) {
    const firstNewline = text.indexOf('\n')
    if (firstNewline === -1) return null
    text = text.slice(firstNewline + 1)
    if (text.endsWith('```')) text = text.slice(0, -3)
    text = text.trim()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const decision = obj.decision
  const klass = obj.class
  if (decision !== 'continue' && decision !== 'new_task') return null
  if (typeof klass !== 'string' || !(DOSSIER_CLASSES as readonly string[]).includes(klass)) return null
  return { decision: decision === 'new_task' ? 'new-task' : 'continue', class: klass as DossierClass }
}

export const FAIL_LAZY_JUDGE_DECISION: JudgeDecision = 'continue'

export function toJudgeVerdictFactData(decision: JudgeDecision, anchorSeq: number, taskId?: string): JudgeVerdictFactData {
  if (decision === 'new-task') {
    return taskId === undefined ? { verdict: decision, anchorSeq } : { verdict: decision, anchorSeq, taskId }
  }
  return { verdict: decision, anchorSeq }
}

// —— 判别族度量 fold（度量先行） ——
export type JudgeTrigger = 't0' | 'l0-continue' | 'l1-cache' | 'table' | 'llm' | 'error-fallback'

export interface JudgeLlmUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface JudgeErrorInfo {
  code: string
  message: string
}

export interface JudgeRecord {
  seq: number
  time: number
  trigger: JudgeTrigger
  decision: JudgeDecision
  class?: DossierClass
  latencyMs?: number
  ctxTokens?: number
  llmUsage?: JudgeLlmUsage
  error?: JudgeErrorInfo
}

export interface JudgeLedger {
  judgeCount: number
  judgeErrorRate: number
  judgeCacheHitRate: number
  judgeLatencyMs: number
  l0CaptureRate: number
  tableHitRate: number
  judgeLLMUsage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
  }
  judgeCtxTokens: number
  judgeVerdictDist: Record<DossierClass, number>
}

export function foldJudgeLedger(records: JudgeRecord[]): JudgeLedger {
  const judgeCount = records.length
  let errorCount = 0
  let cacheHitCount = 0
  let l0Count = 0
  let tableCount = 0
  let llmCount = 0
  let latencySum = 0
  let latencyCount = 0
  let ctxTokens = 0
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  const verdictDist: Record<DossierClass, number> = { action: 0, pureQ: 0, verifyQ: 0 }

  for (const record of records) {
    if (record.error !== undefined || record.trigger === 'error-fallback') errorCount++
    if (record.trigger === 'l1-cache') cacheHitCount++
    if (record.trigger === 'l0-continue') l0Count++
    if (record.trigger === 'table') tableCount++
    if (record.trigger === 'llm') llmCount++
    if (record.latencyMs !== undefined) {
      latencySum += record.latencyMs
      latencyCount++
    }
    if (record.ctxTokens !== undefined) ctxTokens += record.ctxTokens
    if (record.llmUsage !== undefined) {
      usage.inputTokens += record.llmUsage.inputTokens ?? 0
      usage.outputTokens += record.llmUsage.outputTokens ?? 0
      usage.totalTokens += record.llmUsage.totalTokens ?? 0
      usage.cacheReadTokens += record.llmUsage.cacheReadTokens ?? 0
      usage.cacheWriteTokens += record.llmUsage.cacheWriteTokens ?? 0
      usage.reasoningTokens += record.llmUsage.reasoningTokens ?? 0
    }
    if (record.class !== undefined) verdictDist[record.class]++
  }

  return {
    judgeCount,
    judgeErrorRate: judgeCount === 0 ? 0 : errorCount / judgeCount,
    judgeCacheHitRate: judgeCount === 0 ? 0 : cacheHitCount / judgeCount,
    judgeLatencyMs: latencyCount === 0 ? 0 : latencySum / latencyCount,
    l0CaptureRate: judgeCount === 0 ? 0 : l0Count / judgeCount,
    tableHitRate: tableCount + llmCount === 0 ? 0 : tableCount / Math.max(1, tableCount + llmCount),
    judgeLLMUsage: usage,
    judgeCtxTokens: ctxTokens,
    judgeVerdictDist: verdictDist,
  }
}

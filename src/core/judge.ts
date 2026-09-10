/**
 * 判据与对表纯核（docs/02 §3 / docs/07 §0.5 / docs/11 §2 core/judge.ts）。
 * 纯函数：极短消息判据、L1 精确缓存键（重复投递护栏）、对表层保守打分谓词、judge prompt v5
 * 渲染与 fail-lazy 解析、判别族度量 fold。core 零 harness/platform import；不抛错，异常边界交给调用侧 fail-lazy。
 */
import { DOSSIER_CLASSES, foldDossierLedger, type DossierBody, type DossierClass } from './dossier.ts'
import type { JudgeVerdictFactData } from './units.ts'

// —— 判据 prompt v5（版本化；规则分句与 datasets/prompt-discriminator-v2.4.txt 同源） ——
// v4 修订：task 定义居中（同一工作对象/同类目标持续改进）+ 言说层限定为"当前对象" +
// 换对象覆盖"针对新对象的评价/咨询/方案"（真机 2026-09-09：换话题的单句提问被规则 1 吞掉 → 漏边界）。
// v5 修订（2026-09-10 用户裁定）：**粒度从"任选层级"收敛为功能/模块级**。v4 的对象枚举
//（文件/模块/项目/产物）是**并列**的，模型只要挑"项目"这一层，整仓一天的工作就天然是"同一对象"；
// "或同类目标"是第二个并列洞、"上下文特点相近"是第三个——三个洞叠加，粒度只能往粗处收敛。
// 真机实测（session-6ef03ab9，150 条用户消息）只产出 2 条 new-task，且全部落在事件窗外 → 边界压缩
// 从未触发。v5 三处收紧：① 定义改功能/模块锚，删去"或同类目标"；② 规则 6 的合格对象去掉"项目/代码库"
// 并写明"仓库名/项目名/产品名不是工作对象"；③ 新增**粒度自检**（必须给 target 起一个功能级名字，
// 名字不同即换对象；"这个插件""这个项目"判不合格）。代价（用户已确认接受）：闭合 task 变多 →
// compress 调用次数上涨，换到"边界压缩真的会发生"。
export const JUDGE_PROMPT_VERSION = 5
export const JUDGE_PROMPT_HEAD = '你是会话任务边界判别器。用户消息是任务边界的唯一来源。对 <target> 判定相对任务上下文是否开启新任务。'
export const JUDGE_PROMPT_CONTEXT = `任务定义：task = 围绕**同一个功能 / 模块 / 产物**持续改进的努力。粒度必须落到**可命名的那一个功能点**上（如"边界压缩的触发链""星标断面""剪切的安全剪点""某个报错""某个配置项"），不是整仓、整项目、整类工作。同一仓库 / 同一插件 / 同一领域里换做另一个功能或模块 = 新 task；同一功能点内的不同过程类型（构建/审查/验证/清理/讨论…）是子task，不是任务边界。
粒度自检：先给 target 要做的事起一个**功能级**的名字（"在改哪个功能""在修哪个模块"）。若这个名字与任务上下文当前的名字不同 → 换对象 = new_task；只有指名**同一个功能点**才是同一 task。"这个插件""这个项目""这个仓库""这部分工作"这类名字**太粗，不合格**，必须继续往细里命名。
任务上下文 = <dossier> 中按序排列的全部用户消息（不含 <target>）。<dossier> 中最近一条用户消息是任务的最新进展，为主要参照；更早消息是背景。
- 以下先决排除（任一命中即判 continue，不再往下检查）。`
export const JUDGE_PROMPT_RULES_CLAUSES = `先决排除：
1) 同对象言说层：target 是关于**当前功能 / 模块 / 目标**的追问/澄清/报错/汇报/粘贴工具输出或日志/讲解/质询/观点交流/方案设计/评估标准/方法或规则讨论/根因讨论。这类内容是当前工作的言说层。
2) 收尾层：同一任务的收口/清理残余与过期内容/更新文档/审计/复盘。
3) 无法确定。

以上均不命中才进入以下检查（命中任一 = new_task）：
4) 宣布/承诺/命令链：target 含发起性语句（"我打算"/"我希望你先"/"接下来需要你"/"交给你N个任务"/"先给我创建"/"咱们测试一下"/"准备做"/"开始做"/"现在动手"/"再来一次并"等）且带明确实操目标（做/创建/测试/落地/实现/重构/审查/验证/嵌入等）——这是用户发动新工作的信号，即使句中也包含讨论或说明。只有"打算/想"而无具体目标动作的不算。
5) 换意图：target 用户要做的事（目标产物/命令/决定）与任务上下文不同，不是同一件事的推进。**同一仓库 / 同一插件内推进另一件功能上的事 = 换意图。** 注意：针对**同一个功能 / 模块 / 目标**的讨论、讲解、方案、评估标准、观点、方法属于言说层（已排除），其话题变化不算换意图。
6) 换对象：target 针对的工作对象（功能/模块/产物/文件/工具）变化。**仓库名、项目名、产品名不是工作对象（太粗），不得据此判同一 task；同一仓库内从一个功能 / 模块切到另一个功能 / 模块 = 换对象。** **言说层（评价/咨询/讨论/方案）若针对的是新的工作对象，同样算换对象**；测试或审查的对象主题变化也算对象变化（如从测判别器准确率转为测embedding性能）。讨论中被提及的概念对象不算工作对象。
7) 换域：领域/项目/主题域真实变化（如从缓存机制跳到文件治理）。
8) 换形态：任务上下文内一直是言说推进（讨论/理解/咨询/建议），target 首次出现实操动词（挑选/跑/判定/init/创建/落地/训练/验证/审查/写代码/建项等），即"说→做"。注意：上下文已有实操（找/搜/写/测），target 继续实操属于执行链内的子步骤，不是换形态。
9) 中止重开：否定整个任务目标 + 明确新命令；方案细节的否定与迭代属于同一任务的讨论，不算。

否则 = continue，包括：**同一个功能 / 模块**的进行、细化、推进、对同一功能或模块的讨论、同一 task 内不同过程类型的分流（子task）等。**不得**以"都在同一个仓库 / 同一个插件 / 同一类工作"为由判 continue。`
export const JUDGE_PROMPT_OUTPUT = '输出（仅 JSON，无其他文本）：\n{"decision":"new_task"|"continue","class":"action"|"pureQ"|"verifyQ"}'

// —— 极短消息判据：见 core/dossier.ts ——
// 原 L0 延续词表（整句 = 延续词）已删除：真实数据 356 次自动判别仅命中 2 次（0.6%），
// 158 条历史用户消息命中 1 条（0.7%）——省不下调用即为负资产（docs/implement/archive/P14c §1）。
// 「是不是延续」是语义判断，归 LLM 主路径；机械层只做**查表**（见下方对表层）。

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
  /** 命中强度：文件签名 2 分、每个不同关键词 1 分（最多计 2 个）。 */
  score: number
}

/** 命中门槛（保守：宁可多花一次 LLM，也不静默漏切边界）。 */
export const JUDGE_TABLE_HIT_SCORE = 2
export const JUDGE_TABLE_SIGNATURE_SCORE = 2
export const JUDGE_TABLE_SPECIFIC_KEYWORD_SCORE = 2
export const JUDGE_TABLE_GENERIC_KEYWORD_SCORE = 1
/** 短于该长度的关键词不参与匹配（单字符关键词会到处命中）。 */
export const JUDGE_TABLE_MIN_KEYWORD_CHARS = 2

/**
 * 关键词命中强度：**具体**关键词（≥4 字符，或 ≥3 字符的标识符——含数字/分隔符，如 `p14b`/`star.ts`）记 2 分；
 * **泛**关键词（2–3 字符中文词，如"插件""优化"）记 1 分。
 * 理由：泛词共现是巧合高发区；路径与具体词才是"高度吻合"。单条泛词永不短路。
 */
export function judgeKeywordScore(keyword: string): number {
  const key = keyword.trim()
  if (key.length >= 4) return JUDGE_TABLE_SPECIFIC_KEYWORD_SCORE
  if (key.length >= 3 && /[0-9]|[-_.]/.test(key)) return JUDGE_TABLE_SPECIFIC_KEYWORD_SCORE
  return JUDGE_TABLE_GENERIC_KEYWORD_SCORE
}

export function createEmptyJudgeTable(): JudgeTable {
  return { version: JUDGE_TABLE_VERSION, aspects: [], fileSignatures: [], keywords: [] }
}

/**
 * 对表层保守打分（P14c §2）：
 * 文件签名 2 分；具体关键词 2 分；泛关键词 1 分；**总分 ≥ 2 才机械判延续**。
 * 即：一条路径或一个具体词足以短路；两条泛词共现也可；单条泛词一律出表走 LLM。
 * 方向性理由：机械误判"延续"是无声错误（边界漏切且无复核），多问一次模型只是多花一次钱。
 * 实测（354 条真实判别记录）：本口径命中 7.9%、精确率 96.4%；旧宽松口径命中 9.0%、精确率 93.8%。
 */
export function matchJudgeTable(text: string, table: JudgeTable | undefined): JudgeTableMatch {
  if (!table || table.version < 1) return { hit: false, score: 0 }
  const lower = text.toLowerCase()
  const signature = table.fileSignatures.some(
    (s) => s.trim().length >= JUDGE_TABLE_MIN_KEYWORD_CHARS && lower.includes(s.trim().toLowerCase()),
  )
  let score = 0
  for (const raw of table.keywords) {
    const key = raw.trim().toLowerCase()
    if (key.length < JUDGE_TABLE_MIN_KEYWORD_CHARS) continue
    if (lower.includes(key)) score += judgeKeywordScore(key)
  }
  if (signature) score += JUDGE_TABLE_SIGNATURE_SCORE
  if (score < JUDGE_TABLE_HIT_SCORE) return { hit: false, score }
  return { hit: true, reason: signature ? 'file-signature' : 'keyword', score }
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
/** `l0-continue` 为历史口径：P14c 起不再产生，但既有账本事实仍须可 fold（ledger-history 只增不改）。 */
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

/**
 * 对表影子记账（P14c §2 修订）：对表层**只算不拦**——命中照常走 LLM 主路径，
 * 只把"机械本会怎么判"记下来，用真机数据实时量它的精确率。
 * `hit && decision === 'new-task'` = 一次**本会漏掉的边界**（影子假阳性）。
 */
export interface JudgeTableShadow {
  hit: boolean
  score: number
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
  tableShadow?: JudgeTableShadow
  /** P14f：设置里请求的推理档与实发档（缺省 = 跟随模型默认，两字段都不落）。 */
  requestedEffort?: string
  sentEffort?: string
}

export interface JudgeLedger {
  judgeCount: number
  judgeErrorRate: number
  judgeCacheHitRate: number
  judgeLatencyMs: number
  /** 历史口径：P14c 起恒为 0（L0 已删除）；保留以回放旧账本。 */
  l0CaptureRate: number
  /** 对表**实际短路**率（P14c 起恒为 0：对表只算不拦）；保留以回放旧账本。 */
  tableHitRate: number
  /** 对表影子：本会命中的条数（分母 = `llmCount`）。 */
  tableShadowHitCount: number
  /** 对表影子假阳性：本会命中但 LLM 判 new-task —— 本会漏掉的边界数。 */
  tableShadowMissedBoundaryCount: number
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
  let tableShadowHitCount = 0
  let tableShadowMissedBoundaryCount = 0
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
    if (record.tableShadow?.hit === true) {
      tableShadowHitCount++
      if (record.decision === 'new-task') tableShadowMissedBoundaryCount++
    }
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
    // U13.4：class 白名单过滤——重放的历史事实可能带未知/坏 class（旧实现直接累加未知键
    // 得到 NaN，污染整条账本口径）。口径源 = DOSSIER_CLASSES 单一事实源。
    if (record.class !== undefined && (DOSSIER_CLASSES as readonly string[]).includes(record.class)) {
      verdictDist[record.class]++
    }
  }

  return {
    judgeCount,
    judgeErrorRate: judgeCount === 0 ? 0 : errorCount / judgeCount,
    judgeCacheHitRate: judgeCount === 0 ? 0 : cacheHitCount / judgeCount,
    judgeLatencyMs: latencyCount === 0 ? 0 : latencySum / latencyCount,
    tableShadowHitCount,
    tableShadowMissedBoundaryCount,
    l0CaptureRate: judgeCount === 0 ? 0 : l0Count / judgeCount,
    tableHitRate: tableCount + llmCount === 0 ? 0 : tableCount / Math.max(1, tableCount + llmCount),
    judgeLLMUsage: usage,
    judgeCtxTokens: ctxTokens,
    judgeVerdictDist: verdictDist,
  }
}

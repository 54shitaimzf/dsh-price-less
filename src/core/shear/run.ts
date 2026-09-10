/**
 * 对话剪切纯核：run 状态机 + 吸收证明 + 结论三档（docs/03 §3；P16a）。
 * 输入 = 会话序事件（用户/叙述/工具结果 + judge-recorded 分类 + 星标剪切清单），输出 = run 冲刷 op 与裁决。
 * run = 一段最大连续的理解类（pureQ）或验证类（verifyQ）交换串；边界 = 动作类消息 / 星标 / 未分类 / new-task。
 * 触发 = 吸收证明（动作到达 = 用户开始动手；星标 = 用户明确动作）；长 run 无星标注记 = hold（零新增 LLM 调用）。
 * 纯函数：无模型、无 IO、无时钟/随机；不抛错，任何不确定一律 hold/keep（失败默认保留）。
 *
 * 模块: core 对话剪切纯核（零 harness/platform import）
 * 平面: L0（确定性状态机 + 机械摘句；语义分类来自判别器事实，本核不产语义）
 * 回退链步数: 3（结论三档 → 无依据 hold → 无分类 keep）
 * 审查清单: 不 import harness/platform（S1）；无时钟/随机（D10）；不写事实、不改史、不读盘；
 *           带外原则（判定与范围只在插件侧派生，结论句为中立叙述体，无插件标签）。
 * 度量: shearDecision / cutEvents{question} / questionBacklogDepth / cutMisfireDetected（入账归 P16b）。
 */

/** 分类词汇与判别器同源（docs/01 §3.5 三分类；本核只消费，不产出）。 */
export type RunClass = 'action' | 'pureQ' | 'verifyQ'
/** run 类别 = 可剪的两类。 */
export type RunKind = 'pureQ' | 'verifyQ'
/** 结论三档（docs/03 §3）：机械摘句 / 判决提取 / 星标注记。 */
export type RunConclusionTier = 'mechanical-quote' | 'verdict-extract' | 'star-note'

export const RUN_POLICY_VERSION = 1

/** 对话剪切阈值（docs/03 §8 初值；实现后按 07 账本真机观测微调，不做对照实验）。 */
export interface RunPolicy {
  readonly version: number
  /** 短 run 上限（≤ 此对数 = 机械摘句，零 LLM）。 */
  readonly shortRunMaxPairs: number
  /** 验证类前向观察窗（后续 K 条事件零引用才剪；docs/03 §3 验证类处置）。 */
  readonly observationWindow: number
  /** 结论句预算（截断安全；包装词不计入预算内截断）。 */
  readonly conclusionMaxChars: number
  /** 「关于 X」标签上限。 */
  readonly questionLabelMaxChars: number
  /** 指纹 token 最短长度（误剪检出与观察窗共用）。 */
  readonly salientTokenMinChars: number
}

export const DEFAULT_RUN_POLICY: RunPolicy = {
  version: RUN_POLICY_VERSION,
  shortRunMaxPairs: 2,
  observationWindow: 4,
  conclusionMaxChars: 160,
  questionLabelMaxChars: 60,
  salientTokenMinChars: 4,
}

/**
 * 分类输入事实名 = `context-economy/judge-recorded`（载荷含 {seq, decision, class?}）。
 * core 只读字符串常量，不 import domains；跨层一致由 `tests/shear-ledger.spec.ts` 断言守住。
 */
export const RUN_CLASS_FACT_TYPE = 'context-economy/judge-recorded' // ignorable

/** 结论句指令词黑名单（中立叙述体；命中即 hold，零重试——docs/03 §3 三道闸③）。 */
export const RUN_INSTRUCTION_WORDS: readonly string[] = [
  '必须', '请', '不要', '禁止', '需要', '你应该', '下一步', '待办', '务必', '记得', '建议你',
]

/** 纯核输入事件（会话序；分类与星标清单来自事实，同序参与重折）。 */
export type RunEvent =
  | { readonly kind: 'user-message'; readonly seq: number; readonly time: number; readonly text: string }
  | { readonly kind: 'assistant-message'; readonly seq: number; readonly time: number; readonly text: string }
  | { readonly kind: 'tool-result'; readonly seq: number; readonly time: number; readonly text: string }
  | {
      readonly kind: 'verdict'
      readonly seq: number
      readonly time: number
      /** 被判定用户消息 seq（judge-recorded.seq）。 */
      readonly anchorSeq: number
      readonly decision: 'new-task' | 'continue'
      readonly klass?: RunClass
    }
  | { readonly kind: 'star-plan'; readonly seq: number; readonly time: number; readonly items: readonly RunPlanItem[] }

/** 星标断面行协议条目（选坐标不造坐标：坐标与结论都来自模型行记录）。 */
export interface RunPlanItem {
  readonly startSeq: number
  readonly endSeq: number
  readonly note: string
}

export interface RunOp {
  readonly kind: 'run-flush'
  /** 幂等键：run|<startSeq>（U2：不含 endSeq，防冲刷后增长的残余被二次落刀）。 */
  readonly key: string
  readonly startSeq: number
  readonly endSeq: number
  readonly runClass: RunKind
  readonly pairs: number
  readonly conclusion: string
  readonly conclusionTier: RunConclusionTier
}

export interface RunDecisionRecord {
  readonly runKey: string
  readonly decision: 'cut' | 'hold' | 'keep'
  readonly reason: string
}

export interface RunRecord {
  readonly key: string
  readonly startSeq: number
  readonly endSeq: number
  readonly runClass: RunKind
  readonly pairs: number
  readonly decision: 'cut' | 'hold' | 'keep'
  readonly reason: string
  readonly conclusion?: string
  readonly conclusionTier?: RunConclusionTier
  /** 问题 + 结论的指纹 token（误剪检出原料；小写去重）。 */
  readonly salient: readonly string[]
}

export interface RunPlan {
  readonly ops: readonly RunOp[]
  readonly decisions: readonly RunDecisionRecord[]
  readonly records: readonly RunRecord[]
  /** 未被吸收证明覆盖且答案已交付的 run 数（07 字段 questionBacklogDepth）。 */
  readonly backlogDepth: number
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** 首句规则摘录：首行内取到首个句末标点（含）或首行全长。 */
function firstSentence(text: string): string {
  const line = firstLine(text)
  const match = /^[^。！？.!?]{1,400}[。！？.!?]/.exec(line)
  return match === null ? line : match[0]
}

function clampChars(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  return max === 1 ? '…' : `${text.slice(0, max - 1)}…`
}

/** 指纹 token：≥ minChars 的 ASCII 标识/路径/数值（小写去重，序稳定）。 */
export function salientTokens(text: string, policy: RunPolicy = DEFAULT_RUN_POLICY): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const rx = /[A-Za-z0-9_][A-Za-z0-9_./\\-]*/g
  let match: RegExpExecArray | null
  while ((match = rx.exec(text)) !== null) {
    const token = match[0].toLowerCase()
    if (token.length < policy.salientTokenMinChars) continue
    if (seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

/** 验证判决提取（退出码 / 测试模式机械；docs/03 §3 结论三档③）。 */
export function extractVerifyEvidence(text: string, maxChars = 80): string | undefined {
  const patterns: readonly RegExp[] = [
    /\[exit code: \d+\]/,
    /\b\d+\s+(?:passed|failed|passing|failing)\b/i,
    /\b\d+\s+(?:tests?|specs?|checks?)\b/i,
    /\b(?:PASS|FAIL|OK|ERROR|SUCCESS|FAILURE)\b/,
    /exit code \d+/i,
    /\btests?\s+\d+\b/i,
  ]
  for (const pattern of patterns) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || !pattern.test(trimmed)) continue
      return clampChars(trimmed, maxChars)
    }
  }
  return undefined
}

/** 中立性检查：无换行、无指令词（docs/03 §3 三道闸③）。 */
export function isNeutralConclusion(text: string): boolean {
  if (text.includes('\n') || text.trim() === '') return false
  return !RUN_INSTRUCTION_WORDS.some((word) => text.includes(word))
}

interface RunDraft {
  klass: RunKind
  startSeq: number
  lastUserSeq: number
  pairs: number
  questionText: string
}

interface Closing {
  draft: RunDraft
  endSeq: number
  proof: 'action' | 'star' | 'none'
  note?: string
}

function buildConclusion(
  draft: RunDraft,
  policy: RunPolicy,
  body: string,
  tier: RunConclusionTier,
): string | undefined {
  const label = clampChars(normalizeText(firstLine(draft.questionText)), policy.questionLabelMaxChars)
  if (label === '') return undefined
  const wrapper = tier === 'verdict-extract'
    ? `已验证：${label}，依据：${body}（用户已确认理解）`
    : `已吸收：关于「${label}」的 ${draft.pairs} 轮问答，结论：${body}（用户已确认理解）`
  const overhead = wrapper.length - body.length
  const budget = policy.conclusionMaxChars - overhead
  if (budget <= 0) return undefined
  const clamped = clampChars(body, budget)
  if (clamped === '') return undefined
  const text = tier === 'verdict-extract'
    ? `已验证：${label}，依据：${clamped}（用户已确认理解）`
    : `已吸收：关于「${label}」的 ${draft.pairs} 轮问答，结论：${clamped}（用户已确认理解）`
  // 中立性只审包装 + 结论体；「…」内是用户原话引用，不参与指令词判定（引用不是指令）。
  return isNeutralConclusion(text.replace(/「[^」]*」/g, '「」')) ? text : undefined
}

/**
 * run 状态机 fold（docs/03 §3）：分类 → 分段 → 吸收证明 → 结论三档 → 裁决。
 * @param events 会话序事件（未排序也可；本核内部稳定排序）。
 * @param policy 阈值（docs/03 §8 初值）。
 */
export function foldRunShear(events: readonly RunEvent[], policy: RunPolicy = DEFAULT_RUN_POLICY): RunPlan {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.seq - b.event.seq || a.index - b.index)
    .map((entry) => entry.event)

  const verdictBySeq = new Map<number, { decision: 'new-task' | 'continue'; klass?: RunClass }>()
  const planItems: RunPlanItem[] = []
  for (const event of ordered) {
    if (event.kind === 'verdict') verdictBySeq.set(event.anchorSeq, { decision: event.decision, ...(event.klass === undefined ? {} : { klass: event.klass }) })
    else if (event.kind === 'star-plan') planItems.push(...event.items)
  }

  const users = ordered.filter((event): event is Extract<RunEvent, { kind: 'user-message' }> => event.kind === 'user-message')
  const records: RunRecord[] = []
  const ops: RunOp[] = []
  const decisions: RunDecisionRecord[] = []
  let backlogDepth = 0

  /** run 止点 = 边界前最后一条消息类事件（用户/叙述/工具结果；事实不是表面节点）。 */
  const isMessageEvent = (event: RunEvent): boolean => event.kind === 'user-message' || event.kind === 'assistant-message' || event.kind === 'tool-result'
  const lastSeqOf = (before: number): number => {
    let last = -1
    for (const event of ordered) if (isMessageEvent(event) && event.seq < before && event.seq > last) last = event.seq
    return last
  }

  const close = (closing: Closing): void => {
    const { draft } = closing
    // U2：幂等键只锚 startSeq——冲刷后 run 长出残余消息时新折叠产出更大 endSeq 的同源 run，
    // 含 endSeq 的键会被当成新 run 二次落刀（残余未吸收即被重复结论替换 = 内容丢失）。
    const key = `run|${draft.startSeq}`
    const runKey = `${draft.startSeq}..${closing.endSeq}`
    const inRun = ordered.filter((event) => event.seq >= draft.startSeq && event.seq <= closing.endSeq)
    const answerDelivered = inRun.some((event) => event.kind === 'assistant-message' && event.seq > draft.lastUserSeq)
    if (closing.endSeq <= draft.lastUserSeq || !answerDelivered) {
      // 答案未交付不能剪（docs/03 §3 run 状态机）；也不计入积压（还没成为可剪候选）。
      records.push({ key: runKey, startSeq: draft.startSeq, endSeq: closing.endSeq, runClass: draft.klass, pairs: draft.pairs, decision: 'keep', reason: 'answer-not-delivered', salient: [] })
      decisions.push({ runKey, decision: 'keep', reason: 'answer-not-delivered' })
      return
    }
    const questionTokens = salientTokens(draft.questionText, policy)
    const keepRun = (reason: string): void => {
      records.push({ key: runKey, startSeq: draft.startSeq, endSeq: closing.endSeq, runClass: draft.klass, pairs: draft.pairs, decision: 'hold', reason, salient: questionTokens })
      decisions.push({ runKey, decision: 'hold', reason })
    }
    if (closing.proof === 'none') {
      backlogDepth++
      keepRun('await-absorb-proof')
      return
    }
    if (draft.klass === 'verifyQ') {
      // U11.6：观察窗按**消息类事件**计量（旧实现把 verdict/star-plan 等非消息事件也占掉窗口额度，
      // 真消息被挤出去 → verify 依赖检测漏判）。
      const window = ordered.filter((event) => event.seq > closing.endSeq && isMessageEvent(event)).slice(0, policy.observationWindow)
      const windowText = window.map((event) => (event.kind === 'user-message' || event.kind === 'assistant-message' ? event.text : '')).join(' ')
      const windowTokens = new Set(salientTokens(windowText, policy))
      if (questionTokens.some((token) => windowTokens.has(token))) {
        keepRun('verify-dependency-window')
        return
      }
    }
    let tier: RunConclusionTier
    let body: string | undefined
    if (closing.proof === 'star' && closing.note !== undefined) {
      tier = 'star-note'
      body = normalizeText(closing.note)
    } else if (draft.klass === 'verifyQ') {
      tier = 'verdict-extract'
      for (const event of inRun) {
        if (event.kind !== 'tool-result') continue
        const evidence = extractVerifyEvidence(event.text)
        if (evidence !== undefined) { body = evidence; break }
      }
      if (body === undefined) { keepRun('verify-no-evidence'); return }
    } else {
      if (draft.pairs > policy.shortRunMaxPairs) { keepRun('long-run-needs-star'); return }
      tier = 'mechanical-quote'
      for (let index = inRun.length - 1; index >= 0; index--) {
        const event = inRun[index]!
        if (event.kind === 'assistant-message' && event.seq > draft.lastUserSeq) { body = normalizeText(firstSentence(event.text)); break }
      }
      if (body === undefined || body === '') { keepRun('answer-empty'); return }
    }
    if (normalizeText(body) === '') { keepRun('conclusion-empty'); return }
    const conclusion = buildConclusion(draft, policy, body, tier)
    if (conclusion === undefined) { keepRun('conclusion-not-neutral'); return }
    const conclusionTokens = salientTokens(conclusion, policy)
    const salient = [...new Set([...questionTokens, ...conclusionTokens])]
    records.push({ key: runKey, startSeq: draft.startSeq, endSeq: closing.endSeq, runClass: draft.klass, pairs: draft.pairs, decision: 'cut', reason: 'absorbed', conclusion, conclusionTier: tier, salient })
    decisions.push({ runKey, decision: 'cut', reason: 'absorbed' })
    ops.push({
      kind: 'run-flush', key, startSeq: draft.startSeq, endSeq: closing.endSeq,
      runClass: draft.klass, pairs: draft.pairs, conclusion, conclusionTier: tier,
    })
  }

  let current: RunDraft | undefined
  for (const user of users) {
    const verdict = verdictBySeq.get(user.seq)
    const cls = verdict?.klass
    const isAction = cls === 'action'
    const isRunClass = cls === 'pureQ' || cls === 'verifyQ'
    const isNewTask = verdict?.decision === 'new-task'
    if (current !== undefined && (!isRunClass || current.klass !== cls || isNewTask)) {
      const endSeq = lastSeqOf(user.seq)
      const covered = planItems.find((item) => item.startSeq <= current!.startSeq && item.endSeq >= current!.lastUserSeq)
      close({
        draft: current,
        endSeq,
        proof: isAction ? 'action' : covered !== undefined ? 'star' : 'none',
        ...(covered === undefined ? {} : { note: covered.note }),
      })
      current = undefined
    }
    if (!isRunClass || isNewTask) continue
    if (current === undefined) {
      current = { klass: cls, startSeq: user.seq, lastUserSeq: user.seq, pairs: 1, questionText: user.text }
    } else {
      current.lastUserSeq = user.seq
      current.pairs++
    }
  }
  if (current !== undefined) {
    let endSeq = current.lastUserSeq
    for (const event of ordered) if (isMessageEvent(event) && event.seq > endSeq) endSeq = event.seq
    const covered = planItems.find((item) => item.startSeq <= current!.startSeq && item.endSeq >= current!.lastUserSeq)
    close({
      draft: current,
      endSeq,
      proof: covered === undefined ? 'none' : 'star',
      ...(covered === undefined ? {} : { note: covered.note }),
    })
  }

  return { ops, decisions, records, backlogDepth }
}

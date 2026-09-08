/**
 * Token 估算纯核（对齐 harness packages/llm/token-meter/src/estimate.ts 的结构模型；docs/04 §5、docs/07 §5）。
 * 与 DSH 原生的唯一差异：把单一 `CHARS_PER_TOKEN=4` 换成**两桶字符密度**——CJK 与其余分别计价，
 * 因为同一段文本里中文约 0.67 token/字、英文/代码约 0.34 token/字（实测 2.9 字符/token）。
 * 结构对齐：BLOCK_OVERHEAD / ROLE_OVERHEAD 与块级递归计价（text/reasoning/tool-call/tool-result/结构价）。
 *
 * 模块: core token 估算纯核（DSH 对齐 + 两桶密度）
 * 平面: L0（确定性机械计量；零模型、零 IO）
 * 回退链步数: 2（密度非法 → 回默认密度；空文本 → 0）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D13）；不读盘、不写事实、不改史。
 * 度量: 体积类字段同源（07 §5）；标定对账 = 估算值 vs 真实 usage（compress-run / judge-recorded）。
 */

/** 字符密度（chars per token）：同一段文本按 CJK / 其余两桶分别折算。 */
export interface TokenDensity {
  /** CJK 字符/token（0.67 token/字；实测标定 1.5）。 */
  readonly cjk: number
  /** 其余字符/token（英文、代码、路径、JSON；实测标定 2.9）。 */
  readonly other: number
}

/** 标定密度（2026-09-09 真机对账：region 136,477 字 → 真实 53,532 token，误差 0%）。 */
export const DEFAULT_TOKEN_DENSITY: TokenDensity = { cjk: 1.5, other: 2.9 }

/** 与 DSH token-meter 同值的块结构开销（JSON framing + type tag）。 */
export const BLOCK_OVERHEAD = 4

/** 与 DSH token-meter 同值的角色 framing 开销。 */
export const ROLE_OVERHEAD = 4

/** 单桶密度（迁移/测试用：等价旧的 charsPerToken 标量）。 */
export function flatDensity(charsPerToken: number): TokenDensity {
  const value = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : DEFAULT_TOKEN_DENSITY.other
  return { cjk: value, other: value }
}

function densityOf(density: TokenDensity | undefined): TokenDensity {
  const d = density ?? DEFAULT_TOKEN_DENSITY
  const cjk = Number.isFinite(d.cjk) && d.cjk > 0 ? d.cjk : DEFAULT_TOKEN_DENSITY.cjk
  const other = Number.isFinite(d.other) && d.other > 0 ? d.other : DEFAULT_TOKEN_DENSITY.other
  return cjk === d.cjk && other === d.other ? d : { cjk, other }
}

function isCjkCodePoint(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x11ff) // Hangul Jamo
    || (cp >= 0x2e80 && cp <= 0x2eff) // CJK Radicals Supplement
    || (cp >= 0x3000 && cp <= 0x303f) // CJK Symbols and Punctuation
    || (cp >= 0x3040 && cp <= 0x30ff) // Hiragana + Katakana
    || (cp >= 0x3130 && cp <= 0x318f) // Hangul Compatibility Jamo
    || (cp >= 0x3400 && cp <= 0x4dbf) // CJK Unified Ideographs Extension A
    || (cp >= 0x4e00 && cp <= 0x9fff) // CJK Unified Ideographs
    || (cp >= 0xa960 && cp <= 0xa97f) // Hangul Jamo Extended-A
    || (cp >= 0xac00 && cp <= 0xd7af) // Hangul Syllables
    || (cp >= 0xf900 && cp <= 0xfaff) // CJK Compatibility Ideographs
    || (cp >= 0xff00 && cp <= 0xffef) // Halfwidth and Fullwidth Forms
    || (cp >= 0x20000 && cp <= 0x2fa1f) // CJK Unified Ideographs Extension B–F
    || (cp >= 0x30000 && cp <= 0x3134f) // CJK Unified Ideographs Extension G
}

/** 字符分桶（code point 计数；坏输入 → 全零）。 */
export function classifyChars(text: string): { chars: number; cjk: number; other: number } {
  let chars = 0
  let cjk = 0
  for (const ch of text) {
    chars++
    if (isCjkCodePoint(ch.codePointAt(0) as number)) cjk++
  }
  return { chars, cjk, other: chars - cjk }
}

/** 文本 token 估算（两桶密度；空文本 = 0，非空至少 1）。 */
export function estimateTokens(text: string, density?: TokenDensity): number {
  if (text === "") return 0
  const d = densityOf(density)
  const buckets = classifyChars(text)
  return Math.max(1, Math.ceil(buckets.cjk / d.cjk + buckets.other / d.other))
}

/** token → 字符的局部线性反解（截断取字符数用；空文本/零 token = 0）。 */
export function tokensToChars(text: string, tokens: number, density?: TokenDensity): number {
  if (!(tokens > 0) || text === "") return 0
  const estimated = estimateTokens(text, density)
  if (estimated <= 0) return 0
  return Math.min(text.length, Math.max(0, Math.floor((tokens * text.length) / estimated)))
}

/** 块形状（DSH ContentBlock 的结构性重声明；零 harness import）。 */
export interface EstimateBlock {
  readonly type: string
  readonly text?: string
  readonly name?: string
  readonly arguments?: string
  readonly content?: readonly EstimateBlock[]
}

/** 结构性 JSON 价（DSH estimateStructuralBlock 同形）。 */
export function estimateStructuralBlockTokens(block: EstimateBlock, density?: TokenDensity): number {
  return BLOCK_OVERHEAD + estimateTokens(JSON.stringify(block), density)
}

/** 单块价（DSH estimateContent 的逐分支同形）。 */
export function estimateBlockTokens(block: EstimateBlock, density?: TokenDensity): number {
  switch (block.type) {
    case "text":
    case "reasoning":
      return estimateTokens(block.text ?? "", density) + BLOCK_OVERHEAD
    case "tool-call":
      return estimateTokens(block.name ?? "", density) + estimateTokens(block.arguments ?? "", density) + BLOCK_OVERHEAD
    case "tool-result":
      return estimateContentTokens(block.content ?? [], density) + BLOCK_OVERHEAD
    default:
      return estimateStructuralBlockTokens(block, density)
  }
}

/** 内容块递归价（DSH estimateContent 同形）。 */
export function estimateContentTokens(blocks: readonly EstimateBlock[], density?: TokenDensity): number {
  let tokens = 0
  for (const block of blocks) tokens += estimateBlockTokens(block, density)
  return tokens
}

/** 单条消息价（DSH estimateMessage 同形）。 */
export function estimateMessageTokens(message: { readonly content: readonly EstimateBlock[] }, density?: TokenDensity): number {
  return estimateContentTokens(message.content, density) + ROLE_OVERHEAD
}

/** 消息列表价（纯文本消息面：逐条 text 价 + ROLE_OVERHEAD）。 */
export function estimateMessagesTokens(messages: readonly { readonly text: string }[], density?: TokenDensity): number {
  let tokens = 0
  for (const message of messages) tokens += estimateTokens(message.text, density) + ROLE_OVERHEAD
  return tokens
}

/** 标定比（估算值 vs 真实 usage；无样本 = null）。 */
export function calibrationRatio(estimated: number, actual: number): number | null {
  if (!(estimated > 0) || !(actual > 0)) return null
  return actual / estimated
}

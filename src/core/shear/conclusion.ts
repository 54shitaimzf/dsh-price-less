/**
 * N2 结论契约与协商模板 v2（docs/implement/N2-conclusion-contract.md；docs/03 §2.1；docs/05 §1 字节稳定）。
 * 三件套 = 结论 + 关键事实逐字 + 重取句柄；本模块只做「模板渲染 / 标记解析 / 事实抽取 / 保真校验」，
 * 不挂注记（N3）、不动刀（N4）。模板零动态拼接 → 同输入逐字节相同（缓存前缀稳定的前提）。
 *
 * 模块: core 纯核（零 harness/platform import；无时钟、无随机、无 IO）
 * 平面: L0（确定性规则：固定模板 + 逐段解析 + 正则抽事实）
 * 回退链步数: 0（失败方向由调用方统一处理：无标记 / 解析失败 / 缺件 / 缺事实 → 一律 hold）
 * 审查清单: 不 import harness/platform（S1）；无 Date/Math.random（D10）；不改史、不发事实
 * 度量: parsed.marker / complete / verify.missing 由 N3 影子模式入账
 */

/** 契约版本（模板变更必须 bump；N3 账本按版本分组统计）。 */
export const SHEAR_CONCLUSION_VERSION = 2

/**
 * 协商注记 v2（字节稳定常量，模板在前、零实例参数）。
 * v1 模板（`types.ts:SHEAR_NOTE_TEMPLATE`）保留供历史回放，不再新增使用。
 */
export const SHEAR_CONCLUSION_TEMPLATE =
  '（协商：本结果较长。若已用完，请在本次回复最后一行写 CUT-OK: 结论｜事实｜重取；若仍需原文，写 CUT-HOLD: 原因。）'

/** 模型可见注记（= 模板；保留函数形态便于 N3 接线与版本断言）。 */
export function negotiationNote(): string {
  return SHEAR_CONCLUSION_TEMPLATE
}

/** 标记：ok = 可剪自证；hold = 需要原文；none = 无标记（等价 hold）。 */
export type ConclusionMarker = 'ok' | 'hold' | 'none'

export interface ParsedConclusion {
  readonly marker: ConclusionMarker
  readonly conclusion?: string
  readonly facts: readonly string[]
  readonly handle?: string
  /** 三件套齐全（结论 + ≥1 条事实 + 重取句柄）。 */
  readonly complete: boolean
  /** 命中行原文（账本可审计）。 */
  readonly raw?: string
  /** CUT-HOLD 的原因（若有）。 */
  readonly reason?: string
}

/** 事实上限：超过时只校验前 12 条（N2 §6 已知保守面）。 */
export const KEY_FACT_LIMIT = 12

const MARKER_RE = /^[-*>*\s]*CUT-(OK|HOLD)\s*[:：]\s*/i
const LABEL_RE = /^(结论|事实|重取)\s*[：:]?\s*([\s\S]*)$/

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? ''
    if (line !== '') return line
  }
  return undefined
}

/**
 * 解析模型回复的最后一条非空行（N2 §5）：
 * 容忍前导 `-*` / 全角冒号 / ASCII `|`；无标记 / 空回复 → `none`。
 */
export function parseConclusion(replyText: string): ParsedConclusion {
  if (typeof replyText !== 'string' || replyText === '') return { marker: 'none', facts: [], complete: false }
  const raw = lastNonEmptyLine(replyText)
  if (raw === undefined) return { marker: 'none', facts: [], complete: false }
  const hit = MARKER_RE.exec(raw)
  if (hit === null) return { marker: 'none', facts: [], complete: false, raw }
  const body = raw.slice(hit[0].length).trim()
  if (hit[1]?.toUpperCase() === 'HOLD') {
    return { marker: 'hold', facts: [], complete: false, raw, ...(body === '' ? {} : { reason: body }) }
  }

  const parts = body.split(/[｜|]/).map((s) => s.trim()).filter((s) => s !== '')
  let conclusion: string | undefined
  let handle: string | undefined
  const facts: string[] = []
  let labeled = false
  for (const part of parts) {
    const label = LABEL_RE.exec(part)
    if (label === null) continue
    labeled = true
    const value = (label[2] ?? '').trim()
    if (label[1] === '结论') conclusion = value
    else if (label[1] === '重取') handle = value
    else for (const fact of value.split(/[；;]/)) { const f = fact.trim(); if (f !== '') facts.push(f) }
  }
  if (!labeled) {
    // 容错：无标签时按位置取（结论 / 事实 / 重取）。
    conclusion = parts[0]
    if (parts[1] !== undefined) for (const fact of parts[1].split(/[；;]/)) { const f = fact.trim(); if (f !== '') facts.push(f) }
    handle = parts[2]
  }
  const complete = conclusion !== undefined && conclusion !== '' && facts.length > 0 && handle !== undefined && handle !== ''
  return {
    marker: 'ok',
    facts,
    complete,
    raw,
    ...(conclusion === undefined ? {} : { conclusion }),
    ...(handle === undefined ? {} : { handle }),
  }
}

const PATH_RE = /[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|mjs|cjs|json|md|sh|yml|yaml|py|css|html|toml)\b/g
const VERSION_RE = /\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/g
const NUMBER_UNIT_RE = /\b\d+(?:\.\d+)?\s*(?:ms|s|KB|MB|GB|tests?|files?|lines?|tokens?|%)\b/gi
const QUOTED_RE = /"([^"\n]{2,80})"|'([^'\n]{2,80})'|`([^`\n]{2,80})`/g

/** 分类上限（N2 探针实测标定）：构建日志里路径最多，若不设类上限会瞬间占满总额，挤掉结论数字。 */
const KEY_FACT_CLASS_CAP = { number: 6, version: 2, quoted: 2, path: 4 } as const

/** 抽关键事实（N2 §6）：带单位数值 → 版本 → 校验值引号 → 路径；去重保序，类上限 + 总上限 12。 */
export function extractKeyFacts(text: string): readonly string[] {
  if (typeof text !== 'string' || text === '') return []
  const out: string[] = []
  const seen = new Set<string>()
  const counts = { number: 0, version: 0, quoted: 0, path: 0 }
  const push = (value: string, cls: keyof typeof counts): void => {
    if (counts[cls] >= KEY_FACT_CLASS_CAP[cls]) return
    const fact = value.trim()
    if (fact.length < 2) return
    const key = fact.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    counts[cls]++
    out.push(fact)
  }
  for (const m of text.matchAll(NUMBER_UNIT_RE)) push(m[0].replace(/\s+/g, ' '), 'number')
  for (const m of text.matchAll(VERSION_RE)) push(m[0], 'version')
  // 引号内文字只收「校验值形态」：纯十六进制哈希 / 全大写判定词。短字符串字面量与含空白的
  // 人类句子一律丢弃——N2 探针实测前者占首 12 条事实的 69%，后者是构建日志噪声。
  for (const m of text.matchAll(QUOTED_RE)) {
    const quoted = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (/^[0-9a-f]{7,}$/i.test(quoted) || /^[A-Z_]{3,}$/.test(quoted)) push(quoted, 'quoted')
  }
  for (const m of text.matchAll(PATH_RE)) push(m[0], 'path')
  return out.slice(0, KEY_FACT_LIMIT)
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** 保真校验（N2 §6）：原文抽出的每条事实都必须出现在结论 + 事实 + 重取全文里；缺一 → ok:false。 */
export function verifyConclusion(original: string, parsed: ParsedConclusion): { ok: boolean; missing: readonly string[] } {
  if (parsed.marker !== 'ok') return { ok: false, missing: [] }
  const haystack = normalize([parsed.conclusion ?? '', parsed.facts.join('；'), parsed.handle ?? ''].join(' '))
  const missing: string[] = []
  for (const fact of extractKeyFacts(original)) {
    const needle = normalize(fact)
    if (needle !== '' && !haystack.includes(needle)) missing.push(fact)
  }
  return { ok: missing.length === 0, missing }
}

/** N3 影子模式一步到位：解析 + 保真校验（只读，返回可入账三元组）。 */
export function judgeConclusion(original: string, replyText: string): { parsed: ParsedConclusion; verify: { ok: boolean; missing: readonly string[] } } {
  const parsed = parseConclusion(replyText)
  return { parsed, verify: verifyConclusion(original, parsed) }
}

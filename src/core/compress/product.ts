/**
 * 压缩产物解析与 schema 校验（docs/04 §2 三环 fatal 口径 / §3 压力两校验；P18）。
 * 只输出 JSON；机械剥离围栏 + 平衡抽取；boundary = validateDigest + gateHotTailDecls（HT 软门）；
 * pressure = validateCheckpoint + validateCutPoint（单元存在 + 缝不切工具对）。
 * **永不抛错**：仅解析失败 / schema 违例 = fatal；坏热尾申报只降级计数（失败默认保留）。
 *
 * 模块: core 压缩调用纯核（产物校验）
 * 平面: L0（确定性机械校验；零模型、零 IO）
 * 回退链步数: 1（解析/校验失败 → ok:false；调用侧 fail-lazy 保留原上下文）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D13）；不读盘、不写事实、不改史。
 * 度量: dropped{badDecl,unknownUnit} 入压缩调用事实；fatal 计数入账本自持位。
 */
import { normalizeDigest } from '../assemble/assemble.ts'
import { gateHotTailDecls } from '../assemble/gate.ts'
import type { AssembleUnit, HotTailDropCounts } from '../assemble/types.ts'
import type { CompressCheckpoint, CompressMode, CompressParseResult, CutPointDecl } from './types.ts'

const ZERO_DROPS: HotTailDropCounts = { badDecl: 0, unknownUnit: 0, remap: 0, fetch: 0, dup: 0, factReject: 0, error: 0 }

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 机械剥离成对代码围栏（仅首尾；其余字节原样——格式噪声不得杀死一次有效压缩）。 */
export function stripProductFences(raw: string): string {
  const text = raw.trim()
  const match = /^\`\`\`[^\n]*\n([\s\S]*?)\n?\`\`\`$/.exec(text)
  return match ? (match[1] as string).trim() : text
}

/** 首个 `{` → 平衡末 `}` 的机械抽取（不解析语义；字符串内的括号不计数）。 */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/** 产物对象抽取：先按整串解析（围栏剥离后），失败再按平衡子串抽取；均失败 = undefined。 */
export function parseProductObject(raw: string): Record<string, unknown> | undefined {
  const text = stripProductFences(raw)
  for (const candidate of [text, extractJsonObject(text)]) {
    if (candidate === undefined || candidate === '') continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      const record = recordOf(parsed)
      if (record !== undefined) return record
    } catch {
      continue
    }
  }
  return undefined
}

/** 进行时检查点形状校验：字段齐备且为串/串数组；坏形状 = undefined（调用侧 fatal）。 */
export function validateCheckpoint(value: unknown): CompressCheckpoint | undefined {
  const root = recordOf(value)
  if (root === undefined) return undefined
  const { progress, currentState, nextStep } = root
  if (typeof progress !== 'string' || typeof currentState !== 'string' || typeof nextStep !== 'string') return undefined
  const raw = root.liveConstraints
  if (!Array.isArray(raw)) return undefined
  const liveConstraints: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return undefined
    liveConstraints.push(item)
  }
  return { progress, currentState, nextStep, liveConstraints }
}

/** 缝两校验（04 §3）：单元存在 + 不切工具对；任一不满足 = schema 违例。 */
export function validateCutPoint(
  value: unknown,
  units: readonly AssembleUnit[],
): { ok: true; cutPoint: CutPointDecl } | { ok: false; reason: 'unknown-unit' | 'pair-split' | 'schema' } {
  const unitId = recordOf(value)?.unitId
  if (typeof unitId !== 'string' || unitId === '') return { ok: false, reason: 'schema' }
  const unit = units.find((item) => item.id === unitId)
  if (unit === undefined) return { ok: false, reason: 'unknown-unit' }
  for (const other of units) {
    if (other === unit || other.kind !== 'tool-pair') continue
    const headInside = unit.seqStart > other.seqStart && unit.seqStart <= other.seqEnd
    const tailInside = unit.seqEnd > other.seqStart && unit.seqEnd <= other.seqEnd
    if (headInside || tailInside) return { ok: false, reason: 'pair-split' }
  }
  return { ok: true, cutPoint: { unitId } }
}

/**
 * 产物解析（两模式）：raw 文本 + 单元清单 → 已校验产物 或 fatal 原因。
 * boundary：digest 坏形状 = schema；hotTail 缺失 = ok + 空申报（装配器回退位置法，不 fatal）。
 */
export function parseCompressProduct(
  raw: string,
  mode: CompressMode,
  units: readonly AssembleUnit[],
): CompressParseResult {
  const root = parseProductObject(raw)
  if (root === undefined) return { ok: false, reason: 'parse' }

  if (mode === 'pressure') {
    const checkpoint = validateCheckpoint(root.checkpoint)
    if (checkpoint === undefined) return { ok: false, reason: 'schema' }
    const cut = validateCutPoint(root.cutPoint, units)
    if (!cut.ok) return { ok: false, reason: 'schema' }
    return { ok: true, product: { mode: 'pressure', checkpoint, cutPoint: cut.cutPoint }, dropped: { ...ZERO_DROPS } }
  }

  // F9 宽松口径：摘要坏形状 = 机械修复（不 fatal）；只有非 JSON 对象才是硬失败（parse）。
  // 产物形状 v2 = 顶层 {gist, steps, hotTail}；兼容旧 {digest:{...}} 形状（版本号已使缓存失效）。
  const digestSource = root.gist !== undefined || root.steps !== undefined ? root : root.digest
  const digest = normalizeDigest(digestSource).digest
  const rawDecls = root.hotTail
  const gated = gateHotTailDecls(Array.isArray(rawDecls) ? rawDecls : [], units)
  let badDecl = 0
  let unknownUnit = 0
  for (const reject of gated.rejected) {
    if (reject.reason === 'bad-decl') badDecl++
    else unknownUnit++
  }
  const dropped: HotTailDropCounts = { ...ZERO_DROPS, badDecl, unknownUnit }
  return { ok: true, product: { mode: 'boundary', digest, hotTail: gated.accepted }, dropped }
}

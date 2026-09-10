/**
 * HT 软门（docs/04 §2 门禁组：坐标可解析性机械校验，只降级不拒压；P17c）。
 * 纯函数：申报形状非法 / 单元缺失 → 拒绝 + 计数，**永不抛错**；是 `remapFileCoord` 的前置守卫
 * （后者假定 `coord.version` 可读）。坏坐标不产生 fatal（三环口径）。
 *
 * 模块: core 边界装配纯核（申报门禁）
 * 平面: L0（确定性机械校验；零模型、零 IO）
 * 回退链步数: 1（拒绝 → 该项丢弃 + 计数；其余申报照常；全缺 → 位置兜底）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D12）；不读盘、不写事实、不改史。
 * 度量: 拒绝数入 HotTailPlan.dropReasons{badDecl,unknownUnit}（07 hotTail* 同源）。
 */
import type { AssembleUnit, HotTailDecl } from './types.ts'

export type HotTailRejectReason = 'bad-decl' | 'unknown-unit'

export interface HotTailReject {
  readonly reason: HotTailRejectReason
  readonly unitId?: string
}

export interface HotTailGateResult {
  readonly accepted: readonly HotTailDecl[]
  readonly rejected: readonly HotTailReject[]
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/** 成对包装符（一层；只剥两端同对者）。 */
const WRAPPER_PAIRS: readonly (readonly [string, string])[] = [
  ['[', ']'], ['<', '>'], ['(', ')'], ['{', '}'], ['"', '"'], ["'", "'"], ['`', '`'],
]

/**
 * U15 unitId 归一化：清单行渲染成 `[id] 名称 路径@vN ~Nt`，模型常把包裹符号一起抄回
 * （真机 `session-ed9fe428` 边界压缩：10 条热尾申报 100% 因 `[seq-1268]` 判 unknown-unit
 * 被拒 → 热尾整体退化为位置兜底，产物 95% 是原文切片）。
 * 口径：先 trim，再剥**一层**成对包裹；只剥两端成对者（单元 ID 不含这些字符，无误伤）。
 * 归一化只影响比对与产出的 `unitId`，不改变"ID 必须真实存在"这一硬要求。
 */
export function normalizeUnitId(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= 2) return trimmed
  for (const [open, close] of WRAPPER_PAIRS) {
    if (trimmed.startsWith(open) && trimmed.endsWith(close)) return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/** 申报形状校验：坏形状 = undefined（调用方丢弃 + 计数；额外字段被剥离，防模型夹带）。 */
export function validateHotTailDecl(value: unknown): HotTailDecl | undefined {
  const root = recordOf(value)
  if (root === undefined) return undefined
  const rawUnitId = root.unitId
  if (typeof rawUnitId !== 'string' || rawUnitId === '') return undefined
  const unitId = normalizeUnitId(rawUnitId)
  if (unitId === '') return undefined
  const fact = typeof root.fact === 'string' && root.fact.trim() !== '' ? root.fact : undefined
  const withFact = fact === undefined ? {} : { fact }
  if (root.coord === undefined) return { unitId, ...withFact }
  const coord = recordOf(root.coord)
  if (coord === undefined) return undefined
  const path = coord.path
  if (typeof path !== 'string' || path === '') return undefined
  if (!isPositiveInt(coord.version)) return undefined
  let lineRange: { start: number; end: number } | undefined
  if (coord.lineRange !== undefined) {
    const range = recordOf(coord.lineRange)
    if (range === undefined || !isPositiveInt(range.start) || !isPositiveInt(range.end) || range.end < range.start) return undefined
    lineRange = { start: range.start, end: range.end }
  }
  return { unitId, ...withFact, coord: { path, version: coord.version, ...(lineRange === undefined ? {} : { lineRange }) } }
}

/** 门禁（保持申报序）：形状非法 → bad-decl；ID 不在单元清单 → unknown-unit；其余接受。 */
export function gateHotTailDecls(decls: unknown, units: readonly AssembleUnit[]): HotTailGateResult {
  const accepted: HotTailDecl[] = []
  const rejected: HotTailReject[] = []
  if (!Array.isArray(decls)) return { accepted, rejected }
  const known = new Set<string>()
  for (const unit of units) known.add(unit.id)
  for (const raw of decls) {
    const decl = validateHotTailDecl(raw)
    if (decl === undefined) {
      const unitId = recordOf(raw)?.unitId
      rejected.push({ reason: 'bad-decl', ...(typeof unitId === 'string' && unitId !== '' ? { unitId } : {}) })
      continue
    }
    if (!known.has(decl.unitId)) { rejected.push({ reason: 'unknown-unit', unitId: decl.unitId }); continue }
    accepted.push(decl)
  }
  return { accepted, rejected }
}

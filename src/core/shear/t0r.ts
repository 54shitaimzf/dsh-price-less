/**
 * T0-R 读件修复纯核（docs/03 §2.2；P15a）。
 * 纯函数：声明表判据、读信封解析/渲染、逐 hunk 修复组装、三硬规则的状态语义。
 * core 零 harness/platform import；不抛错，失败默认保留（不动刀或退 T0，零重试）。
 *
 * 模块: core 工具剪切纯核（T0-R 面）
 * 平面: L0（路径模式 + 缩进深度 + 整行对齐，零 LLM、零内容解析）
 * 回退链步数: 1（对齐歧义 / oldText 不在读窗 / 段数超限 → 不动刀或退 T0）
 * 审查清单: 不 import harness/platform；不读盘（写区内容由调用侧以 edit 参数提供）；不改史。
 * 度量: tableRepair{Count,Tokens} / repairCoverage / rereadAfterRepair（入账归 P15b）。
 */
import {
  DEFAULT_SHEAR_POLICY,
  type ShearPolicy,
  type ShearRepairSegment,
  type ShearToolCall,
} from './types.ts'

/** 声明表类文件（同层信息汇总：barrel / 路由表 / 类型与常量表 / schema）。 */
export const DECLARATION_TABLE_RE =
  /(^|\/)(?:index|barrel|routes?|types?|constants?|schema|mod)\.(?:[cm]?[jt]sx?)$/i

/** 缩进宽度约定（2 空格 = 1 级；tab 记 1 级）。 */
export const INDENT_WIDTH = 2

export function indentLevelOf(text: string): number {
  const match = /^[ \t]*/.exec(text)
  const raw = match === null ? '' : match[0]
  let width = 0
  for (const ch of raw) width += ch === '\t' ? INDENT_WIDTH : 1
  return Math.floor(width / INDENT_WIDTH)
}

/** 声明表判据（L0）：路径模式 ∧ 写区缩进深度 ≤ 阈值。 */
export function isDeclarationTable(
  path: string,
  writeIndent: number,
  policy: ShearPolicy = DEFAULT_SHEAR_POLICY,
): boolean {
  return DECLARATION_TABLE_RE.test(path) && writeIndent <= policy.t0rMaxIndent
}

export interface ReadEnvelopeLine {
  readonly number: number
  readonly text: string
}

/** 解析原生读信封 `N: text`（非信封行忽略；空/坏形状返回空数组）。 */
export function parseReadEnvelope(text: string): ReadEnvelopeLine[] {
  const out: ReadEnvelopeLine[] = []
  for (const raw of text.split('\n')) {
    const match = /^(\d+): ?(.*)$/.exec(raw)
    if (match === null) continue
    out.push({ number: Number(match[1]), text: match[2] ?? '' })
  }
  return out
}

/** 渲染读信封（与原生格式逐字同构，见 docs/03 附录）。 */
export function formatReadEnvelope(lines: readonly ReadEnvelopeLine[]): string {
  return lines.map((line) => `${line.number}: ${line.text}`).join('\n')
}

export interface T0rEditArgs {
  readonly oldString: string
  readonly newString: string
  readonly replaceAll: boolean
}

/** 从 edit 调用参数抽取替换三元组（坏形状 → undefined = 不动刀）。 */
export function editArgsOf(call: ShearToolCall): T0rEditArgs | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(call.argsText)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const args = parsed as Record<string, unknown>
  const oldString = typeof args.old_string === 'string' ? args.old_string : undefined
  const newString = typeof args.new_string === 'string' ? args.new_string : undefined
  if (oldString === undefined || oldString === '' || newString === undefined) return undefined
  return { oldString, newString, replaceAll: args.replace_all === true }
}

export interface T0rRepair {
  readonly segments: readonly ShearRepairSegment[]
  readonly window: readonly ReadEnvelopeLine[]
  readonly anchor: string
  readonly envelope: string
}

/** 全部匹配起点；段数超限由调用方按策略拒绝（undefined = 不动刀）。 */
function matchStarts(joined: string, oldString: string, limit: number): number[] | undefined {
  const starts: number[] = []
  let from = 0
  while (from <= joined.length) {
    const at = joined.indexOf(oldString, from)
    if (at < 0) break
    starts.push(at)
    if (starts.length > limit) return undefined
    from = at + oldString.length
  }
  return starts.length === 0 ? undefined : starts
}

function lineIndexOf(joined: string, offset: number): number {
  let index = 0
  for (let i = 0; i < offset; i++) if (joined[i] === '\n') index++
  return index
}

/**
 * 逐 hunk 修复组装（三硬规则之二、之三在函数内落实：不跨行、逐段摘抄）。
 * 对齐必须整行（否则 = 对齐歧义 → undefined）；replace_all 逐段、禁 min..max 并集；
 * 段数 > t0rMaxSegments → undefined。行号按 delta 平移（写区后行号随行数变化）。
 */
export function repairReadAfterWrite(
  window: readonly ReadEnvelopeLine[],
  edit: T0rEditArgs,
  path: string,
  version: number,
  policy: ShearPolicy = DEFAULT_SHEAR_POLICY,
): T0rRepair | undefined {
  if (window.length === 0 || edit.oldString === '') return undefined
  const joined = window.map((line) => line.text).join('\n')
  const starts = matchStarts(joined, edit.oldString, policy.t0rMaxSegments)
  if (starts === undefined) return undefined
  if (!edit.replaceAll && starts.length > 1) return undefined

  const newLines = edit.newString.split('\n')
  const segments: ShearRepairSegment[] = []
  let lines: ReadEnvelopeLine[] = window.map((line) => ({ number: line.number, text: line.text }))

  for (let i = starts.length - 1; i >= 0; i--) {
    const start = starts[i] as number
    const end = start + edit.oldString.length
    const alignedStart = start === 0 || joined[start - 1] === '\n'
    const alignedEnd = end === joined.length || joined[end] === '\n'
    if (!alignedStart || !alignedEnd) return undefined
    const startIdx = lineIndexOf(joined, start)
    const endIdx = lineIndexOf(joined, end === joined.length ? end - 1 : end)
    if (endIdx < startIdx) return undefined
    const delta = newLines.length - (endIdx - startIdx + 1)
    const base = (lines[startIdx] as ReadEnvelopeLine).number
    const replacement: ReadEnvelopeLine[] = newLines.map((text, offset) => ({ number: base + offset, text }))
    const tail = lines.slice(endIdx + 1).map((line) => ({ number: line.number + delta, text: line.text }))
    lines = [...lines.slice(0, startIdx), ...replacement, ...tail]
    segments.unshift({
      startLine: base,
      endLine: base + newLines.length - 1,
      lines: newLines,
    })
  }

  const first = segments[0] as ShearRepairSegment
  const last = segments[segments.length - 1] as ShearRepairSegment
  const anchor = `(edited: ${path}, v${version}, ${first.startLine}-${last.endLine})`
  return {
    segments,
    window: lines,
    anchor,
    envelope: `${formatReadEnvelope(lines)}\n${anchor}`,
  }
}

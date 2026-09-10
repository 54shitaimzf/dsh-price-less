/**
 * 坐标层：文件版本补丁链与 vN 重映射（docs/04 §2 通道 A；docs/01 §3.5 稳定点；P17a）。
 * 纯函数：从观察到的 read/write/edit 操作 fold 出逐路径版本链，再把模型申报的
 * `{path, vN, lineRange?}` 机械平移 vN→当前版（恒等 / 逐版行偏移 / 出界裁剪 / 删除丢弃）。
 * 失败语义：定位不到 = 链断，**不猜位置**（失败默认保留；坐标丢弃 + 计数由调用方入账）。
 *
 * 模块: core 边界装配纯核（坐标层）
 * 平面: L0（行偏移算术 + 唯一匹配；零模型、零 IO、不读盘）
 * 回退链步数: 1（定位失败 / 位置不可知 → chain-break，调用方降级丢弃）
 * 审查清单: 不 import harness/platform（S1）；不解释 harness 不透明版本 token（只用插件侧计数）；
 *           无时钟随机（D12）；不抛错、不改输入。
 * 度量: 无 07 字段（重映射计数由 assemble.ts 汇总进 assemble-run 事实）。
 */
import type { FileCoord, LineRange } from './types.ts'

export type FileOpKind = 'read' | 'write' | 'edit'

/** 一次观察到的文件操作（read 窗口 / write 全文 / edit 三元组；行号 1-based）。 */
export interface FileOp {
  readonly seq: number
  readonly path: string
  readonly kind: FileOpKind
  /** read：窗口起始行。 */
  readonly offset?: number
  /** read：窗口文本行（不含 `N: ` 信封）。 */
  readonly lines?: readonly string[]
  /** read：文件总行数（原生 meta.totalLines）。 */
  readonly totalLines?: number
  /** write：新全文。 */
  readonly content?: string
  /** edit：替换三元组（调用参数逐字）。 */
  readonly oldString?: string
  readonly newString?: string
  readonly replaceAll?: boolean
}

/** 一处替换（行坐标为 1-based 闭区间；另带逐字语义所需的字符偏移与精确行差）。 */
export interface Hunk {
  readonly startLine: number
  readonly endLine: number
  /**
   * 替换文本在**本版**占的行数（U13.3：空串 = 原地删除 → **0**）。
   * 用途 = `mapLine` 把落在替换区内的坐标机械收拢到替换后跨度。
   */
  readonly newLineCount: number
  /**
   * 行数**净变化**（U13.3）：逐字替换下恒等于 `newlines(newString) − newlines(oldString)`，
   * 与 harness `edit` 的真实语义（`content.split(old).join(new)`，删除不留空行）严格一致。
   */
  readonly delta: number
  /** 匹配起点/终点字符偏移（相对被定位的那段文本：全文 joined 或某个读窗口 joined）。 */
  readonly startOffset: number
  readonly endOffset: number
}

/**
 * 一版文件状态。`hunks` 语义 = **进入本版的转换**：
 * `[]` 恒等（read 观测）/ 定位成功的 edit / `undefined` 位置不可知（write 全文替换、外部改写、定位失败）。
 */
export interface FileVersion {
  readonly version: number
  readonly seq: number
  readonly kind: FileOpKind
  /** 已知总行数（read meta / write 全文 / edit 位移推算）。 */
  readonly lineCount?: number
  /** 已知全文（write 全文 / read 全覆盖窗口）。 */
  readonly content?: readonly string[]
  readonly hunks?: readonly Hunk[]
}

export interface FileChain {
  readonly path: string
  readonly versions: readonly FileVersion[]
  /** 出现过位置不可知的转换（定位失败 / 外部改写）。 */
  readonly broken: boolean
}

export type RemapFailure = 'unknown-version' | 'chain-break' | 'deleted' | 'empty'
export type RemapResult =
  | { readonly ok: true; readonly lineRange: LineRange; readonly clipped: boolean }
  | { readonly ok: false; readonly reason: RemapFailure }

const WINDOW_LIMIT = 4

interface Window {
  offset: number
  lines: string[]
}

interface PathState {
  versions: FileVersion[]
  full: string[] | undefined
  lineCount: number | undefined
  windows: Window[]
  broken: boolean
}

function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function lineIndexOf(joined: string, offset: number): number {
  let index = 0
  for (let i = 0; i < offset && i < joined.length; i++) if (joined[i] === '\n') index++
  return index
}

/** 全部匹配起点（字符偏移）；超过 limit 个即视为歧义（undefined）。 */
function matchStarts(joined: string, needle: string, limit: number): number[] | undefined {
  if (needle === '') return undefined
  const starts: number[] = []
  let from = 0
  while (from <= joined.length) {
    const at = joined.indexOf(needle, from)
    if (at < 0) break
    starts.push(at)
    if (starts.length > limit) return undefined
    from = at + needle.length
  }
  return starts.length === 0 ? undefined : starts
}

function hunkOf(joined: string, start: number, end: number, op: FileOp, baseLine: number): Hunk {
  const startLine = baseLine + lineIndexOf(joined, start)
  const endLine = baseLine + lineIndexOf(joined, end <= 0 ? 0 : end - 1)
  const oldString = op.oldString ?? ''
  const newString = op.newString ?? ''
  return {
    startLine,
    endLine: Math.max(startLine, endLine),
    newLineCount: replacementLines(newString).length,
    delta: newlineCount(newString) - newlineCount(oldString),
    startOffset: start,
    endOffset: end,
  }
}

/** U13.3：替换文本的行数组——**空串 = 零行**（harness `edit` 的删除不留空行）。 */
function replacementLines(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}

function newlineCount(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') count++
  return count
}

/**
 * 逐字替换（与 harness `edit` 同构）：偏移处确实匹配 `oldString` 才动刀，否则返回 undefined
 * （调用侧退回行区间近似——窗口去重后偏移可能属于另一个重叠窗口，**宁可近似也不改错位置**）。
 */
function spliceAt(joined: string, hunk: Hunk, oldString: string, newString: string): string | undefined {
  if (oldString === '') return undefined
  if (joined.slice(hunk.startOffset, hunk.startOffset + oldString.length) !== oldString) return undefined
  return joined.slice(0, hunk.startOffset) + newString + joined.slice(hunk.startOffset + oldString.length)
}

/** 定位 oldString → hunk 列表；歧义 / 找不到 = undefined（不猜位置）。 */
function locate(full: string[] | undefined, windows: readonly Window[], op: FileOp): Hunk[] | undefined {
  const oldString = op.oldString
  const newString = op.newString
  if (oldString === undefined || oldString === '' || newString === undefined) return undefined
  const limit = op.replaceAll === true ? 4096 : 1
  if (full !== undefined) {
    const joined = full.join('\n')
    const starts = matchStarts(joined, oldString, limit)
    if (starts === undefined) return undefined
    if (op.replaceAll !== true && starts.length > 1) return undefined
    return starts.map((at) => hunkOf(joined, at, at + oldString.length, op, 1))
  }
  // 无全文：在已知窗口里定位；按绝对行位置去重后必须唯一（否则歧义 = 链断）。
  const byPosition = new Map<string, Hunk>()
  for (let i = windows.length - 1; i >= 0; i--) {
    const win = windows[i] as Window
    const joined = win.lines.join('\n')
    const starts = matchStarts(joined, oldString, limit)
    if (starts === undefined) continue
    for (const at of starts) {
      const hunk = hunkOf(joined, at, at + oldString.length, op, win.offset)
      byPosition.set(`${hunk.startLine}:${hunk.endLine}`, hunk)
    }
  }
  const found = [...byPosition.values()].sort((a, b) => a.startLine - b.startLine)
  if (found.length === 0) return undefined
  if (op.replaceAll !== true && found.length > 1) return undefined
  return found
}

function deltaOf(hunk: Hunk): number {
  return hunk.delta
}

/**
 * 全文版应用（U13.3：**逐字替换**，与 harness `edit` 同构）。
 * 旧实现按"整行区间 → `newString.split('\n')`"近似：行中间的部分替换（如改行内一个 token）
 * 会把整行替换掉，全文失真；`newString=''` 还会留下幻影空行。误差会污染后续 `locate` 与链上坐标。
 */
function applyHunksToFull(full: string[], hunks: readonly Hunk[], oldString: string, newString: string): string[] {
  let joined = full.join('\n')
  for (const hunk of [...hunks].sort((a, b) => b.startOffset - a.startOffset)) {
    joined = spliceAt(joined, hunk, oldString, newString)
      ?? lineSplice(joined, hunk, 1, newString)
  }
  return splitLines(joined)
}

/** 行区间兜底（`startLineBase` = 该 hunk 行坐标的基准：全文 1；窗口 = win.offset）。 */
function lineSplice(joined: string, hunk: Hunk, startLineBase: number, newString: string): string {
  const lines = joined.split('\n')
  const from = Math.max(0, hunk.startLine - startLineBase)
  const to = Math.min(lines.length - 1, hunk.endLine - startLineBase)
  if (to < from) return joined
  return [...lines.slice(0, from), ...replacementLines(newString), ...lines.slice(to + 1)].join('\n')
}

/** 窗口内应用 hunk；hunk 部分越窗（不可精确重建）→ undefined（窗口作废）。 */
function applyHunksToWindow(win: Window, hunks: readonly Hunk[], oldString: string, newString: string): Window | undefined {
  let joined = win.lines.join('\n')
  // U3：窗内 hunk 的局部坐标一律以**原窗口 offset** 计——窗前 hunk 只平移窗口绝对位置、
  // 不改窗口内容；窗内应用按**降序**（与全文版同构：降序时前置坐标永不过期，升序在 delta≠0 时
  // 让后续 hunk 在已平移数组上按旧坐标切割 = 窗口内容错乱、版本链行号失真）。
  const inWindow: Hunk[] = []
  let offsetDelta = 0
  for (const hunk of hunks) {
    const localStart = hunk.startLine - win.offset
    const localEnd = hunk.endLine - win.offset
    if (localEnd < 0) { offsetDelta += deltaOf(hunk); continue }
    if (localStart >= win.lines.length) break
    if (localStart < 0 || localEnd > win.lines.length - 1) return undefined
    inWindow.push(hunk)
  }
  for (let i = inWindow.length - 1; i >= 0; i--) {
    const hunk = inWindow[i]!
    // 先试逐字替换（偏移在本窗文本上校验通过才用）；否则退回行区间近似。
    joined = spliceAt(joined, hunk, oldString, newString) ?? lineSplice(joined, hunk, win.offset, newString)
  }
  return { offset: win.offset + offsetDelta, lines: joined === '' ? [] : joined.split('\n') }
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** 从观察到的操作 fold 出逐路径版本链（同输入同链；不 mutate 输入）。 */
export function foldFileChains(ops: readonly FileOp[]): Map<string, FileChain> {
  const states = new Map<string, PathState>()
  for (const op of ops) {
    if (op.path === '') continue
    let state = states.get(op.path)
    if (state === undefined) {
      state = { versions: [], full: undefined, lineCount: undefined, windows: [], broken: false }
      states.set(op.path, state)
    }
    const prevLineCount = state.lineCount
    let hunks: Hunk[] | undefined
    let lineCount: number | undefined
    let full = state.full
    let broken = state.broken

    if (op.kind === 'read') {
      const lines = [...(op.lines ?? [])]
      const offset = op.offset ?? 1
      const totalLines = op.totalLines
      const coversAll = totalLines !== undefined && offset === 1 && lines.length === totalLines
      // 外部改写检测：已知全文行数 / 全覆盖内容与本次观测不符 → 该转换位置不可知。
      const external =
        (state.full !== undefined && totalLines !== undefined && state.full.length !== totalLines) ||
        (coversAll && state.full !== undefined && !sameLines(state.full, lines))
      if (external) {
        broken = true
        full = undefined
        state.windows = []
        hunks = undefined
      } else {
        if (coversAll) full = lines
        hunks = []
      }
      lineCount = totalLines ?? (full === undefined ? undefined : full.length)
      state.windows.push({ offset, lines })
      if (state.windows.length > WINDOW_LIMIT) state.windows.shift()
    } else if (op.kind === 'write') {
      full = splitLines(op.content ?? '')
      lineCount = full.length
      state.windows = []
      hunks = undefined
    } else {
      hunks = locate(full, state.windows, op)
      if (hunks === undefined) {
        broken = true
        full = undefined
        state.windows = []
      } else if (full !== undefined) {
        full = applyHunksToFull(full, hunks, op.oldString ?? '', op.newString ?? '')
        lineCount = full.length
      } else {
        lineCount = prevLineCount === undefined ? undefined : prevLineCount + hunks.reduce((sum, h) => sum + deltaOf(h), 0)
        const next: Window[] = []
        for (const win of state.windows) {
          const applied = applyHunksToWindow(win, hunks, op.oldString ?? '', op.newString ?? '')
          if (applied !== undefined) next.push(applied)
        }
        state.windows = next
      }
    }

    state.versions.push({
      version: state.versions.length + 1,
      seq: op.seq,
      kind: op.kind,
      ...(lineCount === undefined ? {} : { lineCount }),
      ...(full === undefined ? {} : { content: full }),
      ...(hunks === undefined ? {} : { hunks }),
    })
    state.full = full
    state.lineCount = lineCount ?? prevLineCount
    state.broken = broken
  }
  const out = new Map<string, FileChain>()
  for (const [path, state] of states) out.set(path, { path, versions: state.versions, broken: state.broken })
  return out
}

/** 链上最后一版已知行数（整文件坐标与兜底判据）。 */
export function lastLineCount(chain: FileChain | undefined): number | undefined {
  if (chain === undefined) return undefined
  for (let i = chain.versions.length - 1; i >= 0; i--) {
    const count = chain.versions[i]?.lineCount
    if (count !== undefined) return count
  }
  return undefined
}

interface MappedLine {
  readonly line: number
  /** 落在替换区内时的替换后跨度（区间端点机械扩到该跨度）。 */
  readonly span?: { readonly start: number; readonly end: number }
}

function mapLine(line: number, hunks: readonly Hunk[]): MappedLine {
  let delta = 0
  for (const hunk of hunks) {
    if (hunk.endLine < line) { delta += deltaOf(hunk); continue }
    if (line < hunk.startLine) break
    // 落在替换区内：机械扩到替换后跨度（取真 = 当前版本字节，不复活旧版本）。
    const startAfter = hunk.startLine + delta
    const endAfter = startAfter + Math.max(0, hunk.newLineCount - 1)
    return {
      line: startAfter + Math.min(line - hunk.startLine, Math.max(0, hunk.newLineCount - 1)),
      span: { start: startAfter, end: endAfter },
    }
  }
  return { line: line + delta }
}

/**
 * vN → 当前版机械平移（恒等 / 逐版行偏移 / 出界裁剪 / 删除丢弃）。
 * @param currentLineCount 盘上当前行数：`null` = 文件不存在（丢弃），`undefined` = 未知（不裁剪）。
 */
export function remapFileCoord(
  chain: FileChain | undefined,
  coord: FileCoord,
  currentLineCount?: number | null,
): RemapResult {
  if (chain === undefined || chain.versions.length === 0) return { ok: false, reason: 'empty' }
  if (currentLineCount === null) return { ok: false, reason: 'deleted' }
  let index = -1
  for (let i = 0; i < chain.versions.length; i++) if (chain.versions[i]?.version === coord.version) { index = i; break }
  if (index < 0) return { ok: false, reason: 'unknown-version' }

  const last = chain.versions[chain.versions.length - 1] as FileVersion
  let start = coord.lineRange?.start ?? 1
  let end = coord.lineRange?.end ?? last.lineCount ?? currentLineCount ?? -1
  if (end < 0) return { ok: false, reason: 'chain-break' }
  if (start < 1) start = 1
  if (end < start) return { ok: false, reason: 'empty' }

  let expanded = false
  for (let i = index + 1; i < chain.versions.length; i++) {
    const hunks = chain.versions[i]?.hunks
    if (hunks === undefined) return { ok: false, reason: 'chain-break' }
    const mappedStart = mapLine(start, hunks)
    const mappedEnd = mapLine(end, hunks)
    start = mappedStart.span === undefined ? mappedStart.line : mappedStart.span.start
    end = mappedEnd.span === undefined ? mappedEnd.line : mappedEnd.span.end
    if (end < start) end = start
    if (mappedStart.span !== undefined || mappedEnd.span !== undefined) expanded = true
  }

  let clipped = expanded
  if (currentLineCount !== undefined) {
    if (currentLineCount <= 0 || start > currentLineCount) return { ok: false, reason: 'deleted' }
    if (end > currentLineCount) { end = currentLineCount; clipped = true }
  }
  if (end < start) return { ok: false, reason: 'deleted' }
  return { ok: true, lineRange: { start, end }, clipped }
}

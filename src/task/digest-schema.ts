/**
 * per-task 结构化摘要 schema（L0 纯函数）。这是与原生"8 节大锅烩"的关键差异：
 * 原生把整段压成一个高层叙事；本 schema 显式保留**重发现拦截器**字段
 * （对象坐标/精确值/已尝试-被拒/待办/逐字权威段）——丢失这些正是下游多花一次
 * 搜索类工具调用（extraSearchCalls）的根源。
 *
 * 模块: task 摘要 schema
 * 平面: L0（schema 定义 + 校验 + 渲染；无模型无 IO）
 * 回退链步数: 2（代码分支——校验/渲染为纯规则）
 * 审查清单: 输入 plain JSON；无副作用；字节稳定（同 digest 同版本同字节——digestToMarkdown
 *           为纯函数，重复调用输出一致，缓存命中的物理基础）；
 *           不读 event.time；可无 harness 单测。
 * 度量: digestBytes / digestEntryCount / digestCoverage / extraSearchCalls（docs/07）
 */

/** digest 结构版本（改结构 → 版本 +1，旧 checkpoint 由 ver 门失效，不允许静默漂移）。 */
export const DIGEST_SCHEMA_VERSION = 1

/** 一条产物（对象坐标）——"寻址坐标"重发现拦截器。 */
export interface DigestArtifact {
  file: string
  symbols: string[]
  /** [start, end] 行区间；未知为 null。 */
  lineRange: [number, number] | null
  note: string
}

/** per-task 结构化摘要。所有字段均为"重发现拦截器"的显式落脚点。 */
export interface TaskDigest {
  taskId: string
  schemaVersion: number
  /** 段头锚（用户指令原文，逐字——权威段，与投影 anchorText 同源，永不漂移）。 */
  taskAnchor: string
  /** 本任务目的（user 原话的目标/诉求，逐字保留关键部分）。 */
  purpose: string
  /** 关键决策（做了哪些决定、为什么）——避免下游重试死路。 */
  decisions: string[]
  /** 产物（文件/符号/行区间 + 说明）——避免下游重 grep/glob 找坐标。 */
  artifacts: DigestArtifact[]
  /** 动过的文件（逐字路径）。 */
  touchedFiles: string[]
  /** 未完成的待办（file → 待办项），避免下游重扫 todo/scope。 */
  pending: string[]
  /** 已尝试&-被拒（dead-end）记录，避免下游重试。 */
  triedRejected: string[]
  /** 需逐字保留的路径/数值/约束/合规词句（verbatim spans）。 */
  verbatimSpans: string[]
  /** 摘要生成时间戳（度量/审计用；非字节稳定断言的一部分——字节稳定只约束同版本内容）。 */
  createdAtMs: number
}

/** 摘要器（LLM）指令：schema 提示模板，作为 summary 调用的最后一条 user 消息追加。 */
export const DIGEST_INSTRUCTION = [
  'You are a compaction engine that condenses ONE finished task into a structured digest a later task can build on with no lost context.',
  '',
  'Output EXACTLY one JSON object with ONLY this schema (no prose, no markdown fences, no keys outside it):',
  '{',
  '  "taskId": "<id>",',
  '  "purpose": "<the task goal, quoting the user verbatim where wording matters>",',
  '  "decisions": ["<decision + why>", ...],',
  '  "artifacts": [{"file": "<path>", "symbols": ["<identifier>"], "lineRange": [start, end], "note": "<why it matters>"}, ...],',
  '  "touchedFiles": ["<exact path>", ...],',
  '  "pending": ["<file: unfinished item>", ...],',
  '  "triedRejected": ["<attempted X -> rejected (reason)>", ...],',
  '  "verbatimSpans": ["<exact path / value / constraint / compliance phrasing kept verbatim>", ...]',
  '}',
  '',
  'Rules:',
  '- Keep exact file paths, identifiers, error strings, numeric values, command fragments, function signatures.',
  '- Capture user corrections and explicit instructions faithfully, especially verbatim constraints.',
  '- Every item you keep must prevent a downstream tool call: a search (re-grep/glob to find a path or symbol) or a re-run (retry a rejected approach).',
  '- Write "(none)" only as a JSON string value for a single text field; drop empty array items' +
  ' (do NOT emit "(none)" as an array element).',
  '- Do NOT mention this request or that context was compacted. Output only the JSON object.',
  '- Epoch milliseconds for createdAtMs is filled by the caller; do not emit it.',
].join('\n')

/** 检查对象是否为合法 `TaskDigest`（严格字段校验，无模型无 IO）。 */
export function isValidDigest(value: unknown): value is TaskDigest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (typeof v.taskId !== 'string') return false
  if (v.schemaVersion !== DIGEST_SCHEMA_VERSION) return false
  if (typeof v.taskAnchor !== 'string') return false
  if (typeof v.purpose !== 'string') return false
  if (!Array.isArray(v.decisions) || !v.decisions.every(s => typeof s === 'string')) return false
  if (!Array.isArray(v.artifacts) || !v.artifacts.every(isValidArtifact)) return false
  if (!Array.isArray(v.touchedFiles) || !v.touchedFiles.every(s => typeof s === 'string')) return false
  if (!Array.isArray(v.pending) || !v.pending.every(s => typeof s === 'string')) return false
  if (!Array.isArray(v.triedRejected) || !v.triedRejected.every(s => typeof s === 'string')) return false
  if (!Array.isArray(v.verbatimSpans) || !v.verbatimSpans.every(s => typeof s === 'string')) return false
  if (typeof v.createdAtMs !== 'number') return false
  return true
}

function isValidArtifact(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const a = value as Record<string, unknown>
  return typeof a.file === 'string'
    && Array.isArray(a.symbols) && a.symbols.every(s => typeof s === 'string')
    && (a.lineRange === null || (
      Array.isArray(a.lineRange) && a.lineRange.length === 2
      && typeof a.lineRange[0] === 'number' && typeof a.lineRange[1] === 'number'
    ))
    && typeof a.note === 'string'
}

/** 用给定字段构造一个最小合法 digest（未填字段 = 空，供 fail-lazy/空摘要兜底）。 */
export function emptyDigest(taskId: string, taskAnchor: string, nowMs = Date.now()): TaskDigest {
  return {
    taskId,
    schemaVersion: DIGEST_SCHEMA_VERSION,
    taskAnchor,
    purpose: '',
    decisions: [],
    artifacts: [],
    touchedFiles: [],
    pending: [],
    triedRejected: [],
    verbatimSpans: [],
    createdAtMs: nowMs,
  }
}

/**
 * digest → 可见检查点文本（替换会话历史时产出）。纯函数，同输入同字节（字节稳定）。
 * 结构清晰、保留重发现拦截器，供后续任务直接阅读。
 */
export function digestToMarkdown(digest: TaskDigest): string {
  const lines: string[] = []
  lines.push(`## Task ${digest.taskId}`)
  if (digest.taskAnchor.trim().length > 0) lines.push(`- Goal (verbatim): ${digest.taskAnchor}`)
  if (digest.purpose.trim().length > 0) lines.push(`- Purpose: ${digest.purpose}`)
  if (digest.decisions.length > 0) {
    lines.push('- Decisions:')
    for (const d of digest.decisions) lines.push(`  - ${d}`)
  }
  if (digest.artifacts.length > 0) {
    lines.push('- Artifacts:')
    for (const a of digest.artifacts) {
      const sym = a.symbols.length > 0 ? ` [${a.symbols.join(', ')}]` : ''
      const range = a.lineRange !== null ? ` L${a.lineRange[0]}-${a.lineRange[1]}` : ''
      lines.push(`  - ${a.file}${sym}${range}${a.note.length > 0 ? ` — ${a.note}` : ''}`)
    }
  }
  if (digest.touchedFiles.length > 0) lines.push(`- Touched files: ${digest.touchedFiles.join(', ')}`)
  if (digest.pending.length > 0) {
    lines.push('- Pending:')
    for (const p of digest.pending) lines.push(`  - ${p}`)
  }
  if (digest.triedRejected.length > 0) {
    lines.push('- Tried & rejected:')
    for (const t of digest.triedRejected) lines.push(`  - ${t}`)
  }
  if (digest.verbatimSpans.length > 0) {
    lines.push('- Verbatim:')
    for (const s of digest.verbatimSpans) lines.push(`  - ${s}`)
  }
  return lines.join('\n')
}

/** digest 字节数（docs/07 digestBytes；不含 taskId/版本/审计字段的序列化开销）。 */
export function digestByteLength(digest: TaskDigest): number {
  return digestToMarkdown(digest).length
}

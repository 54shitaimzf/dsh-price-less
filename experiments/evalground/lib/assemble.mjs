/**
 * Context assembly — E2/V2 factor space for task-context injection structure.
 *
 * Modes:
 *   'plain'       byte-identical to the original runner: system + task prompt
 *   'single'      alias of 'plain'
 *   'goals'       adds an explicit GOAL + PROCESS CONTRACT block (task.goalSteps)
 *   'goal-steps'  alias of 'goals'
 *   'goals+files' 'goals' plus a pre-scanned file-stream block
 *   'obj-P'       injects a structured compression product P (goal/steps /
 *                 fileStream / compressed) as an object-rendered context block;
 *                 the P object itself never enters the execution transcript.
 *   'anchor'      'obj-P' plus an anchor section (fixed template + user goal
 *                 reaffirmed, budget-capped by anchorBudgetTokens).
 *                 anchorKind: 'none' | 'structural' | 'semantic' (X-E).
 *
 * The produced message list is the ONLY thing that varies between arms, so
 * every other pipeline stage (tools, mech, judge, score) stays untouched.
 */
import { listFiles } from './workspace.mjs'
import { generateNoise, noiseChars } from './noise.mjs'

export const ANCHOR_BUDGET_TOKENS = 2048 // DSH anchorBudgetTokens default

export function parseGoalSteps(task) {
  if (!task) return null
  return Array.isArray(task.goalSteps) && task.goalSteps.length > 0 ? task.goalSteps : null
}

function goalBlock(task) {
  const gs = parseGoalSteps(task)
  if (!gs) return ''
  const lines = gs.map((g, i) => `${i + 1}. ${g}`).join('\n')
  return [
    '## GOAL',
    lines,
    '',
    '## PROCESS CONTRACT',
    '- Work toward GOAL only; do not expand scope beyond the statements above.',
    '- When a step is done, move to the next; do NOT redo completed steps.',
    '',
  ].join('\n')
}

function fileStreamBlock(workspace) {
  const files = listFiles(workspace)
  if (files.length === 0) return ''
  return `## KNOWN FILES (pre-scanned; verify with glob/read before editing)\n${files.join('\n')}\n`
}

/** Object-rendered P product (goal / steps / fileStream / compressed). */
export function renderProduct(p) {
  if (!p) return ''
  // New 总-分 product (self-* PTC arms): sections + optional retain.
  if (Array.isArray(p.sections) && p.sections.length > 0) {
    const parts = p.sections.map(s => renderSection(s, { a2: p.a2 ?? 'keep-original' }))
    if (p.retain) parts.push(renderRetain(p.retain))
    return parts.join('\n')
  }
  // A2 方案1（具体内容展开）→ 信息块 (plan/impl/verify/wrap) 产品，用块渲染器。
  if (Array.isArray(p.blocks) && p.blocks.length > 0) return renderBlocks(p)
  // industry / Claude-Compaction style products carry a narrative `summary`
  // instead of the semantic goal/steps/fileStream/compressed sections.
  if (typeof p.summary === 'string' && p.summary.trim().length > 0) {
    return `## 浓缩摘要\n${p.summary}\n`
  }
  const g = p.goal ? `## 目标\n${p.goal}\n` : ''
  const s = Array.isArray(p.steps) && p.steps.length > 0
    ? `## 步骤\n${p.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n`
    : ''
  const f = Array.isArray(p.fileStream) && p.fileStream.length > 0
    ? `## 文件流\n${p.fileStream.join('\n')}\n`
    : ''
  const c = p.compressed ? `## 压缩上下文\n${p.compressed}\n` : ''
  return [g, s, f, c].filter(Boolean).join('\n')
}

/** Render ONE 总-分 section (M2): summary + typed subtasks with refs. Ref render:
 * 方案0 = coordinates; 方案1 (expand) = harness-resolved `content` (refs stay).
 * F8 content dedup: the FIRST ref carrying a given content inlines it; every
 * later same-content ref renders as a `→同 <owner>` pointer — expansion is
 * idempotent, repeated citations never re-inline the same bytes. */
export function renderSection(section, opts = {}) {
  const a2 = opts.a2 ?? 'keep-original'
  const parts = [`[compressed task]`, String(section?.summary ?? '').trim()]
  const dedup = new Map() // ref object → 'inline' | first-rendered owner key
  if (a2 === 'expand') {
    const seen = new Map() // content string → first owner key (path:lineRange)
    for (const b of section?.subtasks ?? []) {
      for (const r of b.refs ?? []) {
        if (typeof r?.content !== 'string' || r.content.length === 0) continue
        const key = `${r.path}${r.lineRange ? `:${r.lineRange}` : ''}`
        if (!seen.has(r.content)) { seen.set(r.content, key); dedup.set(r, 'inline') }
        else dedup.set(r, seen.get(r.content))
      }
    }
  }
  for (const b of section?.subtasks ?? []) parts.push('- ' + renderBlockLine(b, a2, dedup))
  return parts.filter(Boolean).join('\n') + '\n'
}

function refText(r, a2, dedup) {
  if (a2 === 'expand' && typeof r.content === 'string' && r.content.length > 0) {
    const verdict = dedup?.get(r)
    if (verdict && verdict !== 'inline') return `${r.path}${r.lineRange ? `:${r.lineRange}` : ''}→同 ${verdict}`
    const c = r.content.length > 200 ? r.content.slice(0, 200) + '…' : r.content
    return `${r.path}${r.lineRange ? `:${r.lineRange}` : ''}→内容(${c})`
  }
  return `${r.path}${r.lineRange ? `:${r.lineRange}` : ''}${r.symbol ? `(${r.symbol})` : ''}`
}

function renderBlockLine(b, a2, dedup) {
  let s
  if (b.type === 'plan') {
    s = `[plan] 目标: ${b.goal}`
    if (Array.isArray(b.constraints) && b.constraints.length) s += `；约束: ${b.constraints.join('; ')}`
    if (Array.isArray(b.decisions) && b.decisions.length) s += `；决策: ${b.decisions.join('; ')}`
  } else if (b.type === 'impl') {
    s = `[impl] ${b.path}`
    if (b.lineRange) s += ` ${b.lineRange}`
    if (b.symbol) s += ` (${b.symbol})`
    s += `: ${b.change}`
    if (b.test) s += `；测试: ${b.test}`
  } else if (b.type === 'verify') {
    s = `[verify] ${b.command}: ${b.result}`
    if (b.failure) s += `；失败: ${b.failure}`
  } else {
    s = `[wrap] ${b.conclusion}`
    if (Array.isArray(b.deliverables) && b.deliverables.length) s += `；交付: ${b.deliverables.join(', ')}`
    if (Array.isArray(b.leftover) && b.leftover.length) s += `；遗留: ${b.leftover.join(', ')}`
  }
  const refs = b.refs ?? []
  if (refs.length > 0) s += `｜引用: ${refs.map(r => refText(r, a2, dedup)).join('; ')}`
  return s
}

/** Render the A1-S1 transient hot-bridge node (design R, F11): refs (expanded
 * to content when the harness resolved them) + one-line outline + the
 * harness-verbatim detail block (last run results / failing lines). Ref render
 * reuses the section refText conventions; coords render bare when no content. */
export function renderRetain(retain) {
  const refs = Array.isArray(retain?.refs) ? retain.refs : []
  const bits = refs.map(r => refText(r, 'expand', null))
  const parts = [
    `[热桥接 retain] ${String(retain?.outline ?? '').trim()}`,
    bits.length > 0 ? `引用: ${bits.join('; ')}` : '',
  ].filter(Boolean)
  const d = retain?.detail
  if (d && Array.isArray(d.verifications) && d.verifications.length > 0) {
    parts.push('## 末次验证（harness 逐字提取）')
    for (const v of d.verifications) {
      parts.push(`$ ${v.command}`)
      parts.push(v.tail)
    }
  }
  if (d && Array.isArray(d.failures) && d.failures.length > 0) {
    parts.push('## 未解决失败（逐字）')
    for (const f of d.failures) parts.push(f)
  }
  return parts.filter(p => p !== '').join('\n') + '\n'
}

/** Render an A2 方案1 information-block product (plan/impl/verify/wrap) into a
 * readable context block. Each block renders as one bullet carrying its
 * high-density fields (goal/constraints/decisions | path+coords+change+test |
 * command+result+failure | conclusion+deliverables+leftover). */
export function renderBlocks(p) {
  const parts = ['## 信息块（A2 方案1 具体内容展开）']
  for (const b of p.blocks ?? []) {
    if (b.type === 'plan') {
      let s = `- [plan] 目标: ${b.goal}`
      if (Array.isArray(b.constraints) && b.constraints.length) s += `；约束: ${b.constraints.join('; ')}`
      if (Array.isArray(b.decisions) && b.decisions.length) s += `；决策: ${b.decisions.join('; ')}`
      parts.push(s)
    } else if (b.type === 'impl') {
      let s = `- [impl] ${b.path}`
      if (b.lineRange) s += ` ${b.lineRange}`
      if (b.symbol) s += ` (${b.symbol})`
      s += `: ${b.change}`
      if (b.test) s += `；测试: ${b.test}`
      parts.push(s)
    } else if (b.type === 'verify') {
      let s = `- [verify] ${b.command}: ${b.result}`
      if (b.failure) s += `；失败: ${b.failure}`
      parts.push(s)
    } else if (b.type === 'wrap') {
      let s = `- [wrap] ${b.conclusion}`
      if (Array.isArray(b.deliverables) && b.deliverables.length) s += `；交付: ${b.deliverables.join(', ')}`
      if (Array.isArray(b.leftover) && b.leftover.length) s += `；遗留: ${b.leftover.join(', ')}`
      parts.push(s)
    }
  }
  return parts.join('\n') + '\n'
}

/**
 * Retrieval index (X-D): every product section becomes one line — digest +
 * retrieval hint — instead of the full text; the model pulls details with
 * grep/read. Strictly smaller than renderProduct.
 */
export function renderIndex(p) {
  if (!p) return ''
  const lines = []
  if (p.goal) lines.push(`- 目标: ${p.goal.slice(0, 200)}`)
  if (Array.isArray(p.steps)) p.steps.forEach((x, i) => lines.push(`- 步骤${i + 1} 摘要: ${x.slice(0, 120)}（细节: grep/read 任务源与相关文件）`))
  if (Array.isArray(p.fileStream)) p.fileStream.forEach(f => lines.push(`- 文件条目: ${f}（全部内容按需 read）`))
  if (p.compressed) lines.push(`- 压缩段摘要: ${p.compressed.slice(0, 240)}（必要时 grep 定位细节）`)
  return ['## 上下文索引（按需检索，勿假设细节）', ...lines, ''].join('\n')
}

/** Anchor section: structural = fixed template header; semantic = goal reaffirm. */
export function renderAnchor(kind, userId) {
  const structural = [
    '## 上下文锚定',
    '以下锚定段固定在上下文开头。目标、步骤与文件范围见下方段落；工作指示以最后一条用户消息为准。',
    '',
  ].join('\n')
  if (kind === 'none') return ''
  if (kind === 'structural') return `${structural}`
  // semantic: reaffirm the user goal verbatim (budget-capped)
  const goal = String(userId ?? '').trim().slice(0, ANCHOR_BUDGET_TOKENS * 4)
  return `## 上下文锚定\n目标（用户原话保留）：${goal}\n\n`
}

/**
 * Assemble the initial message list for a session.
 * @param {object} p { mode, systemPrompt, task, prompt, stagedMessages, workspace,
 *   product, anchorKind, position, noiseRatio, indexOnly, noiseSeed }
 *   position: 'head'|'mid'|'tail' — where the product block sits (X-A)
 *   noiseRatio: 0..1 additional distribution-similar filler (X-B)
 *   indexOnly: render the retrieval index instead of the full product (X-D)
 */
export function assembleInit(p) {
  const mode = p.mode ?? 'plain'
  const sys = { role: 'system', content: p.systemPrompt }
  const staged = p.stagedMessages ?? []
  const hasStages = staged.length > 0
  const baseUser = hasStages ? staged[0] : (p.prompt ?? '')

  const productBlock = () => {
    if (!p.product) return ''
    return p.indexOnly ? renderIndex(p.product) : renderProduct(p.product)
  }
  const noiseBlock = () => {
    const ratio = p.noiseRatio ?? 0
    if (ratio <= 0) return ''
    const base = (productBlock() || baseUser).length
    return generateNoise(p.noiseSeed ?? 'x', noiseChars(base, ratio))
  }

  const partsFor = (text) => {
    const parts = []
    if (mode === 'goals' || mode === 'goal-steps' || mode === 'goals+files') {
      parts.push(goalBlock(p.task))
      if (mode === 'goals+files' && p.workspace) parts.push(fileStreamBlock(p.workspace))
      parts.push(text)
      return parts
    }
    if (mode === 'obj-P' || mode === 'anchor') {
      const anchor = mode === 'anchor' ? renderAnchor(p.anchorKind ?? 'semantic', p.task?.title ?? '') : ''
      const prod = productBlock()
      const pos = p.position ?? 'head'
      if (anchor) parts.push(anchor)
      if (prod) {
        if (pos === 'head') { parts.push(prod, '## 任务指示', text) }
        else if (pos === 'tail') { parts.push('## 任务指示', text, prod) }
        else { parts.push('## 任务指示', prod, text) } // mid: product between header and instruction tail
      } else {
        parts.push('## 任务指示', text)
      }
      const n = noiseBlock()
      if (n) parts.push(n)
      return parts
    }
    return [text]
  }

  const userContent = (text) => partsFor(text).filter(Boolean).join('\n')

  if (hasStages) {
    return { messages: [sys, { role: 'user', content: userContent(staged[0]) }], stageMessages: staged, mode }
  }
  return { messages: [sys, { role: 'user', content: userContent(p.prompt ?? '') }], stageMessages: [], mode }
}
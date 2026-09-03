/**
 * Compressor I/O bindings — the deterministic data plane of the PTC-style
 * compressor. The model's program calls these (`tools.<name>`); everything
 * mechanical lives here so pointers and structure are COMPUTED, never invented:
 *
 *   probe_substructure  — real sub-flow spans of the closed task (clustered by
 *                         tool-family runs, deterministic, zero LLM)
 *   locate_change       — real (path, lineRange, symbol) of the change records
 *   validate_pointer    — path exists + lineRange in bounds + symbol hits
 *   resolve_pointer     — materialize the pointed content (A2 方案1 expand)
 *   read_transcript     — raw work text of a span (program-internal only)
 *   estimate_tokens     — deterministic token count (chars/4)
 *
 * `computePointers` + `auditRefs` (string wrapper: `verifyRefGroundTruth`) are
 * the harness-side PTR-TRUTH gate: every ref in a product must exactly equal a
 * REAL change record's pointer — model-invented coordinates fail (fail-lazy
 * upstream); citations per coordinate are quota-capped at the real record count.
 */
import fs from 'node:fs'
import path from 'node:path'
import { guardPath } from './workspace.mjs'
import { estimateTokens } from './prefix.mjs'

const MAX_TRANSCRIPT_CHARS = 24000
const FAMILY = { read: 'explore', glob: 'explore', grep: 'explore', write: 'edit', run: 'verify' }

/** Real tool args use `path` (runner tryCall convention); tolerate legacy `rel`. */
function relOf(args) {
  return typeof args?.path === 'string' ? args.path : typeof args?.rel === 'string' ? args.rel : null
}

/** Gateway toolCalls args arrive as a JSON STRING; the transcript may also carry
 * parsed objects (fixtures). Normalize both. */
function argsOf(tcArgs) {
  if (typeof tcArgs === 'string' && tcArgs.length > 0) { try { return JSON.parse(tcArgs) } catch { return {} } }
  return typeof tcArgs === 'object' && tcArgs !== null ? tcArgs : {}
}

/** Tool family of a cluster — PRIORITY order (a turn that both reads and writes
 * is an EDIT; a turn that runs tests is a VERIFY), never the first name only. */
function familyOf(entry) {
  const names = (entry?.toolCalls ?? []).map(tc => tc.name)
  if (names.length === 0) return 'wrap'
  if (names.includes('write')) return 'edit'
  if (names.includes('run')) return 'verify'
  if (names.some(n => FAMILY[n] === 'explore')) return 'explore'
  return 'other'
}

/** Cluster the closed-task transcript into sub-flow spans (consecutive same-family runs). */
export function clusterSubtasks(transcript) {
  const clusters = []
  let current = null
  const push = (c) => { if (c) { clusters.push(c); current = null } }
  for (let i = 0; i < transcript.length; i++) {
    const e = transcript[i]
    if (!e || typeof e !== 'object') continue
    if (e.type === 'assistant') {
      const fam = familyOf(e)
      if (e.toolCalls && e.toolCalls.length > 0) {
        if (current && current.open && current.family === fam) { current.toIdx = i; continue }
        push(current)
        current = { family: fam, fromIdx: i, toIdx: i, open: true }
      } else {
        // text-only assistant: closes any open cluster, forms a wrap cluster
        push(current)
        if (String(e.content ?? '').trim()) current = { family: 'wrap', fromIdx: i, toIdx: i, open: false }
      }
    } else if (e.type === 'tool') {
      const fam = FAMILY[e.tool] ?? 'other'
      if (current && current.open) { current.toIdx = i; continue }
      if (current && current.family === fam) { current.toIdx = i; continue }
      push(current)
      current = { family: fam, fromIdx: i, toIdx: i, open: false }
    }
  }
  push(current)
  // merge consecutive clusters of the same family into one subtask (stable spans)
  const subtasks = []
  for (const c of clusters) {
    const last = subtasks[subtasks.length - 1]
    if (last && last.typeHint === c.family) last.toIdx = c.toIdx
    else subtasks.push({ fromIdx: c.fromIdx, toIdx: c.toIdx, typeHint: c.family })
  }
  return subtasks.map((s, n) => ({
    spanKey: `sub:${n}`,
    fromIdx: s.fromIdx,
    toIdx: s.toIdx,
    typeHint: s.typeHint,
  }))
}

/** Normalized line array (ignore one trailing newline so `a\nb\n` = 2 lines). */
function linesOf(text) {
  return String(text ?? '').replace(/\n$/, '').split('\n')
}
function lineCount(text) {
  return linesOf(text).length
}

/** First "function name" symbol in a text (ground-truth anchor), or first identifier. */
function firstSymbol(text) {
  const m = /function\s+([A-Za-z_$][\w$]*)/.exec(text)
  if (m) return m[1]
  const id = /([A-Za-z_$][\w$]{2,})/.exec(text ?? '')
  return id ? id[1] : null
}

/** The REAL pointer of one write record (whole-file write in evalground tools). */
function pointerOfWrite(workspace, rel, content) {
  const lines = linesOf(content)
  let start = 1
  const m = /function\s+([A-Za-z_$][\w$]*)/.exec(lines[0] ?? '')
  if (!m && lines.length > 0) {
    // anchor on the first non-empty line; symbol = first identifier there
    const idx = lines.findIndex(l => l.trim().length > 0)
    start = idx >= 0 ? idx + 1 : 1
  }
  return { path: rel, lineRange: `${start}-${Math.max(start, lines.length)}`, symbol: m ? m[1] : firstSymbol(lines[start - 1] ?? '') }
}

/** The REAL pointer of one read/glob/grep record (position only, no symbol). */
function pointerOfRead(rel) {
  return { path: rel, lineRange: null, symbol: null }
}

/** Ground-truth change records of the context → the authoritative pointer set. */
export function computePointers(ctx) {
  const out = []
  const transcript = ctx.transcript ?? []
  for (let i = 0; i < transcript.length; i++) {
    const e = transcript[i]
    if (!e) continue
    if (e.type === 'assistant' && Array.isArray(e.toolCalls)) {
      for (const tc of e.toolCalls) {
        const args = argsOf(tc.args)
        const rel = relOf(args)
        if (tc.name === 'write' && rel && typeof args.content === 'string') {
          out.push({ kind: 'write', refKey: `truth:write:${i}`, recordIdx: i, ...pointerOfWrite(ctx.workspace, rel, args.content) })
        } else if (tc.name === 'read' && rel) {
          out.push({ kind: 'read', refKey: `truth:read:${i}`, recordIdx: i, ...pointerOfRead(rel) })
        }
      }
    }
  }
  return out
}

/** The last write pointer within a transcript span (locate_change), or a read pointer. */
function locateWithin(ctx, fromIdx, toIdx, fileHint) {
  const transcript = ctx.transcript ?? []
  let bestWrite = null
  let bestRead = null
  for (let i = fromIdx; i <= toIdx && i < transcript.length; i++) {
    const e = transcript[i]
    if (!e || e.type !== 'assistant' || !Array.isArray(e.toolCalls)) continue
    for (const tc of e.toolCalls) {
      const args = argsOf(tc.args)
      const rel = relOf(args)
      const kind = tc.name === 'write' ? 'write' : tc.name === 'read' ? 'read' : null
      if (!kind || !rel) continue
      if (fileHint && !String(rel).includes(fileHint)) continue
      if (tc.name === 'write' && typeof args.content === 'string') {
        bestWrite = pointerOfWrite(ctx.workspace, rel, args.content)
      } else if (tc.name === 'read') {
        bestRead = pointerOfRead(rel)
      }
    }
  }
  return bestWrite ?? bestRead ?? null
}

/** Resolve a `{segRef}` to a transcript span (subtask or whole task). */
function spanOf(ctx, segRef) {
  const subtasks = clusterSubtasks(ctx.transcript)
  const found = String(segRef ?? '').match(/^sub:(\d+)$/)
  const n = found ? Number(found[1]) : -1
  if (n >= 0 && n < subtasks.length) return subtasks[n]
  // whole-task / taskRef: full span
  return { fromIdx: 0, toIdx: (ctx.transcript ?? []).length - 1 }
}

/** Build the binding namespace for one compression operation. */
export function makeCompressorBindings(ctx) {
  const workspace = ctx.workspace
  return {
    async probe_substructure({ taskRef } = {}) {
      const subtasks = clusterSubtasks(ctx.transcript)
      return { taskRef: taskRef ?? null, subtasks }
    },
    async locate_change({ segmentRef, fileHint } = {}) {
      const span = spanOf(ctx, segmentRef)
      return locateWithin(ctx, span.fromIdx, span.toIdx, fileHint)
    },
    async validate_pointer({ path: rel, lineRange, symbol } = {}) {
      let file
      try { file = guardPath(workspace, rel) } catch (e) { return { ok: false, reason: `path escape: ${e.message}` } }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { ok: false, reason: `not a file: ${rel}` }
      if (lineRange != null) {
        const m = /^(\d+)-(\d+)$/.exec(String(lineRange))
        if (!m) return { ok: false, reason: `bad lineRange: ${lineRange}` }
        const text = fs.readFileSync(file, 'utf8')
        const count = lineCount(text)
        const a = Number(m[1]); const b = Number(m[2])
        if (a < 1 || b > count || a > b) return { ok: false, reason: `lineRange out of bounds ${lineRange} (file ${count} lines)` }
        if (symbol != null) {
          const lines = linesOf(text).slice(a - 1, b)
          if (!lines.some(l => new RegExp(`\\b${String(symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(l))) {
            return { ok: false, reason: `symbol "${symbol}" not found in ${rel}:${lineRange}` }
          }
        }
      }
      return { ok: true }
    },
    async resolve_pointer({ path: rel, lineRange } = {}) {
      let file
      try { file = guardPath(workspace, rel) } catch (e) { return { error: e.message } }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { error: `not a file: ${rel}` }
      const text = fs.readFileSync(file, 'utf8')
      let content = text
      if (lineRange != null) {
        const m = /^(\d+)-(\d+)$/.exec(String(lineRange))
        if (m) content = linesOf(text).slice(Number(m[1]) - 1, Number(m[2])).join('\n')
        else content = text
      }
      return { path: rel, lineRange: lineRange ?? null, content: content.slice(0, MAX_TRANSCRIPT_CHARS) }
    },
    async read_transcript({ segmentRef } = {}) {
      const span = spanOf(ctx, segmentRef)
      const out = []
      for (let i = span.fromIdx; i <= span.toIdx && i < (ctx.transcript ?? []).length; i++) {
        const e = ctx.transcript[i]
        if (!e) continue
        if (e.type === 'assistant') out.push(`[assistant] ${String(e.content ?? '').slice(0, 400)}`)
        else if (e.type === 'tool') {
          const arg = JSON.stringify(e.arg ?? {}).slice(0, 220)
          out.push(`[tool ${e.tool}] ${arg}\n${String(e.result ?? '').slice(0, 800)}`)
        } else out.push(`[${e.type}] ${JSON.stringify(e).slice(0, 300)}`)
      }
      const text = out.join('\n')
      return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(0, MAX_TRANSCRIPT_CHARS) + '\n…[truncated]' : text
    },
    async estimate_tokens({ text } = {}) {
      return { tokens: estimateTokens(String(text ?? '')) }
    },
  }
}

/**
 * PTR-TRUTH gate (harness side, after the program run): every ref must point
 * at a REAL change record — matched on the fields the ref PROVIDES (path is
 * mandatory; lineRange/symbol are optional refinements, so a ref that omits
 * an optional field still grounds when it points at the real place).
 *
 * Quota semantics (F8 redesign): a coordinate GROUP holds one slot per real
 * record at those coordinates. Each ref consumes the lowest-recordIdx
 * unconsumed slot among its candidates; a ref whose candidates are ALL
 * consumed is over quota → PRUNED (not fatal), and a ref with NO matching
 * record at all is fabricated → FATAL problem. This keeps the anti-padding
 * invariant (citations per coordinate ≤ real records there) while letting the
 * two REAL writes of a same-file equal-length rewrite both ground.
 *
 * Deterministic: refs in array order, slots consumed in recordIdx order.
 * Returns { problems[], pruned: [{index, ref, reason}] } — problems empty
 * means every ref grounded (pruned refs are already accounted separately).
 */
export function auditRefs(refs, computedPointers) {
  const problems = []
  const pruned = []
  if (!Array.isArray(refs)) return { problems: ['refs must be an array'], pruned }
  const pool = Array.isArray(computedPointers) ? computedPointers : []
  const candidatesOf = refs.map(ref => {
    if (!ref || typeof ref !== 'object') return null
    return pool.filter(p => {
      if (p.path !== ref.path) return false
      if (ref.lineRange != null && String(p.lineRange ?? '') !== String(ref.lineRange)) return false
      if (ref.symbol != null && (p.symbol ?? null) !== ref.symbol) return false
      return true
    })
  })
  // refs sharing one candidate set share one quota slot pool — count them per signature
  const refCountBySig = new Map()
  for (const cands of candidatesOf) {
    if (!cands) continue
    const sig = cands.map(p => p.refKey).join('|')
    refCountBySig.set(sig, (refCountBySig.get(sig) ?? 0) + 1)
  }
  const consumed = new Set()
  refs.forEach((ref, index) => {
    const candidates = candidatesOf[index]
    if (!candidates) { problems.push('ref must be an object'); return }
    if (candidates.length === 0) {
      problems.push(`ref not grounded in real change record: ${ref.path}:${ref.lineRange ?? '-'}${ref.symbol ? `(${ref.symbol})` : ''}`)
      return
    }
    const slot = candidates.find(p => !consumed.has(p.refKey))
    if (!slot) {
      const sig = candidates.map(p => p.refKey).join('|')
      pruned.push({
        index,
        ref,
        reason: `${candidates.length} record(s) at this coordinate, ${refCountBySig.get(sig)} ref(s)`,
      })
      return
    }
    consumed.add(slot.refKey)
  })
  return { problems, pruned }
}

/** Compatibility wrapper (string problems only): fabrication problems verbatim,
 * over-quota refs as 'duplicate ref (over quota)' strings carrying the quota math. */
export function verifyRefGroundTruth(refs, computedPointers) {
  const { problems, pruned } = auditRefs(refs, computedPointers)
  for (const p of pruned) {
    problems.push(`duplicate ref (over quota): ${p.ref.path}:${p.ref.lineRange ?? '-'}${p.ref.symbol ? `(${p.ref.symbol})` : ''} — ${p.reason}`)
  }
  return problems
}

const MARKER_MIN_CHARS = 20

/** Distinctive verbatim markers of the RAW WORK (file bodies / read results).
 * The compression product must NEVER embed these — only refs may point at them. */
export function rawEchoMarkers(ctx) {
  const markers = new Set()
  const source = ctx.transcript ?? []
  for (const e of source) {
    if (!e) continue
    if (e.type === 'assistant' && Array.isArray(e.toolCalls)) {
      for (const tc of e.toolCalls) {
        const args = argsOf(tc.args)
        const rel = relOf(args)
        if (tc.name === 'write' && rel && typeof args.content === 'string') addLines(markers, args.content)
        if (tc.name === 'read' && rel && /\.(js|ts|json|mjs|cjs|py|md)$/.test(rel)) {
          const file = readFileSafe(ctx.workspace, rel)
          if (file) addLines(markers, file)
        }
      }
    } else if (e.type === 'tool' && (e.tool === 'read' || e.tool === 'write')) {
      const rel = relOf(e.arg ?? {})
      if (rel && /\.(js|ts|json|mjs|cjs|py|md)$/.test(rel)) {
        const file = readFileSafe(ctx.workspace, rel)
        if (file) addLines(markers, file)
      }
    }
  }
  return [...markers]
}

function addLines(set, text) {
  for (const l of linesOf(text)) {
    const t = l.trim()
    if (t.length >= MARKER_MIN_CHARS && !/^[{}[\],\s]+$/.test(t)) set.add(l.trimEnd())
  }
}

function readFileSafe(workspace, rel) {
  try {
    const file = guardPath(workspace, rel)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null
    return fs.readFileSync(file, 'utf8')
  } catch { return null }
}

/** OUT gate: any ≥ MARKER_MIN_CHARS verbatim raw marker inside the product → echo.
 * EXEMPT: harness-resolved `ref.content` (A2 方案1 expand) — that content was
 * read by resolve_pointer from a VALIDATED coordinate, not authored by the model.
 * Model-authored echo (summary/fields/refs) is still flagged. */
export function findRawEcho(product, markers) {
  let clone
  try { clone = JSON.parse(JSON.stringify(product ?? null)) } catch { clone = product ?? null }
  for (const s of clone?.sections ?? []) {
    for (const b of s.subtasks ?? []) {
      for (const r of b.refs ?? []) if (typeof r?.content === 'string') r.content = ''
    }
  }
  if (Array.isArray(clone?.retain?.refs)) for (const r of clone.retain.refs) if (typeof r?.content === 'string') r.content = ''
  const hay = JSON.stringify(clone)
  const hits = []
  for (const m of markers ?? []) {
    if (hay.includes(m)) hits.push(m.slice(0, 60))
  }
  return hits
}

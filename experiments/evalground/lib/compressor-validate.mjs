/**
 * Compressor validation — the mechanical gate layer shared by the PTC
 * compressor and the offline template battery. Pure, offline, no LLM:
 *
 *   validateProductSchema  — 总-分 structure: total/sections/summary/subtasks,
 *                            block type enum + required/allowed fields + refs shape
 *   checkRatio             — compression-ratio gate (effective / marginal /
 *                            fail-lazy / small-region skip)
 *   checkRetention         — S1 引用化保尾 length gate (refs ≤ maxRefs, outline
 *                            ≤ outlineTokenBudget; exceed → degrade to typed only)
 */
import { estimateTokens } from './prefix.mjs'

export const BLOCK_TYPES = ['plan', 'impl', 'verify', 'wrap']

export const BLOCK_REQUIRED = {
  plan: ['goal'],
  impl: ['path', 'change'],
  verify: ['command', 'result'],
  wrap: ['conclusion'],
}

export const BLOCK_ALLOWED = {
  plan: ['goal', 'constraints', 'decisions'],
  impl: ['path', 'lineRange', 'symbol', 'change', 'test'],
  verify: ['command', 'result', 'failure'],
  wrap: ['conclusion', 'deliverables', 'leftover'],
}

export const DEFAULT_RATIO = { effective: 0.5, hardFail: 0.75, minRegionTokens: 3000 }
export const DEFAULT_RETENTION = { maxRefs: 8, outlineTokenBudget: 40 }

// refs: refKey optional; path mandatory; lineRange/symbol optional coordinates;
// `content` is HARNESS-injected (A2 方案1 expand) — never model-authored.
const REF_FIELDS = ['refKey', 'path', 'lineRange', 'symbol', 'content']

/** Validate a typed subtask block (with optional refs on any block type). */
export function validateBlock(b, idx = 0) {
  const problems = []
  const at = `sections[...].subtasks[${idx}]`
  if (!b || typeof b !== 'object') { problems.push(`${at} must be an object`); return problems }
  if (!BLOCK_TYPES.includes(b.type)) { problems.push(`${at}.type "${b.type}" not allowed (${BLOCK_TYPES.join('/')})`); return problems }
  for (const k of BLOCK_REQUIRED[b.type] ?? []) {
    const v = b[k]
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)) {
      problems.push(`${at} missing required field ${b.type}.${k}`)
    }
  }
  for (const k of Object.keys(b)) {
    if (k === 'type' || k === 'refs') continue
    if (!(BLOCK_ALLOWED[b.type] ?? []).includes(k)) problems.push(`${at} illegal field "${k}" for block ${b.type}`)
  }
  if (b.refs !== undefined) {
    if (!Array.isArray(b.refs)) problems.push(`${at}.refs must be an array`)
    else {
      b.refs.forEach((r, ri) => {
        if (!r || typeof r !== 'object') { problems.push(`${at}.refs[${ri}] must be an object`); return }
        for (const k of Object.keys(r)) if (!REF_FIELDS.includes(k)) problems.push(`${at}.refs[${ri}] illegal field "${k}"`)
        for (const k of ['path']) if (typeof r[k] !== 'string' || r[k].trim() === '') problems.push(`${at}.refs[${ri}] missing ${k}`)
      })
    }
  }
  return problems
}

/**
 * Validate the full product against the 总-分 contract:
 * { total:number, sections:[{ summary:string, subtasks:Block[] }], retain? }
 * `retain` = { refs:[...], outline:string } (S1 引用化保尾).
 */
export function validateProductSchema(product) {
  const problems = []
  if (!product || typeof product !== 'object') return ['product must be an object']
  if (typeof product.total !== 'number' || product.total < 0) problems.push('total must be a number ≥ 0')
  if (!Array.isArray(product.sections) || product.sections.length === 0) problems.push('sections must be a non-empty array')
  else {
    product.sections.forEach((s, si) => {
      const at = `sections[${si}]`
      if (!s || typeof s !== 'object') { problems.push(`${at} must be an object`); return }
      if (typeof s.summary !== 'string' || s.summary.trim().length < 20) problems.push(`${at}.summary must be a non-trivial string (≥20 chars)`)
      if (!Array.isArray(s.subtasks) || s.subtasks.length === 0) problems.push(`${at}.subtasks must be a non-empty array`)
      else s.subtasks.forEach((b, bi) => problems.push(...validateBlock(b, bi).map(p => `${at}: ${p}`)))
    })
    const subtaskCount = product.sections.reduce((a, s) => a + (Array.isArray(s?.subtasks) ? s.subtasks.length : 0), 0)
    if (product.total !== subtaskCount) problems.push(`total ${product.total} must equal the subtask count ${subtaskCount}`)
  }
  if (product.retain !== undefined) {
    const r = product.retain
    if (!r || typeof r !== 'object') problems.push('retain must be an object when present')
    else {
      if (!Array.isArray(r.refs)) problems.push('retain.refs must be an array')
      else r.refs.forEach((ref, i) => {
        if (!ref || typeof ref !== 'object') { problems.push(`retain.refs[${i}] must be an object`); return }
        if (typeof ref.path !== 'string' || ref.path.trim() === '') problems.push(`retain.refs[${i}] missing path`)
      })
      if (typeof r.outline !== 'string') problems.push('retain.outline must be a string when present')
    }
  }
  return problems
}

/** Tokens of the product's COMPRESSED part (exclude the S1 retain passthrough). */
export function productCompressedTokens(product) {
  const { retain, ...rest } = product
  return estimateTokens(JSON.stringify(rest))
}

/**
 * Compression-ratio gate. `verdict`:
 *   'no-region' — nothing to compare (region empty)
 *   'skip'      — region under minRegionTokens (inherent overhead, no gate)
 *   'effective' — ratio ≤ effective bar (真压缩且有效)
 *   'marginal'  — between effective and hardFail (recorded, still injected)
 *   'fail'      — ratio > hardFail (not a real compression → fail-lazy upstream)
 */
export function checkRatio({ productTokens, regionTokens, cfg = DEFAULT_RATIO }) {
  if (!Number.isFinite(regionTokens) || regionTokens <= 0) return { verdict: 'no-region', ratio: null }
  if (regionTokens < cfg.minRegionTokens) return { verdict: 'skip', ratio: null }
  const ratio = productTokens / regionTokens
  if (ratio > cfg.hardFail) return { verdict: 'fail', ratio: Number(ratio.toFixed(4)) }
  if (ratio <= cfg.effective) return { verdict: 'effective', ratio: Number(ratio.toFixed(4)) }
  return { verdict: 'marginal', ratio: Number(ratio.toFixed(4)) }
}

/**
 * S1 retention length gate: refs ≤ maxRefs AND outline ≤ outlineTokenBudget
 * (chars/4). Exceed → `degraded: true` (caller drops the retain passthrough and
 * keeps the typed block only).
 */
export function checkRetention(retain, cfg = DEFAULT_RETENTION) {
  if (retain === undefined || retain === null) return { ok: true, degraded: false }
  const refs = Array.isArray(retain.refs) ? retain.refs : []
  const outlineTokens = estimateTokens(String(retain.outline ?? ''))
  if (refs.length > cfg.maxRefs) return { ok: false, degraded: true, reason: `retain.refs ${refs.length} > ${cfg.maxRefs}` }
  if (outlineTokens > cfg.outlineTokenBudget) return { ok: false, degraded: true, reason: `retain.outline ${outlineTokens} tok > ${cfg.outlineTokenBudget}` }
  return { ok: true, degraded: false }
}

/** Convenience: collect all refs (subtask refs + retain refs) for PTR-TRUTH. */
export function collectRefs(product) {
  const refs = []
  for (const s of product?.sections ?? []) {
    for (const b of s.subtasks ?? []) if (Array.isArray(b.refs)) refs.push(...b.refs)
  }
  if (Array.isArray(product?.retain?.refs)) refs.push(...product.retain.refs)
  return refs
}

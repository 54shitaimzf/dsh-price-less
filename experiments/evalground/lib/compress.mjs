/**
 * V3 — compression modes behind the semantic/industry/truncate arms.
 *
 * compressOnce turns a task definition + accumulated context into a product:
 *   'semantic'  task-structured P: goal / steps / fileStream / compressed
 *   'industry'  generic narrative summary (Claude Compaction style)
 *   'truncate'  deterministic sliding tail (no LLM call)
 *   'mock'      caller-supplied product (offline tests / V2 structure arms)
 *
 * Products are schema-validated before use; invalid products are rejected
 * (a violation is recorded, never injected). The P object is versioned to
 * runs/<runId>/compressed/P.json and never enters the execution transcript.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createGateway } from './gateway.mjs'
import { MANUAL_DIR } from './paths.mjs'
import { runProgram } from './code-run.mjs'
import { makeCompressorBindings, computePointers, auditRefs, rawEchoMarkers, findRawEcho } from './compressor-io.mjs'
import { validateProductSchema, checkRatio, checkRetention, collectRefs, productCompressedTokens, DEFAULT_RATIO, DEFAULT_RETENTION } from './compressor-validate.mjs'
import { buildCompressorInstruction } from './compressor-prompt.mjs'

export const PRODUCT_SCHEMA = ['goal', 'steps', 'fileStream', 'compressed']

// ============ DSH-native `<compacted-summary>` (the `native-auto` control) ============
// Faithful port of packages/compaction/compaction-basic/src/summarizer.ts. The
// NATIVE product is a Markdown checkpoint with 8 fixed sections, NOT JSON. The
// model outputs the section bodies; frameNativeSummary wraps the result in the
// checkpoint preamble + tags (exactly the DSH-native `frameSummary`).
export const NATIVE_SECTIONS = [
  'Primary Request and Intent',
  'Key Technical Concepts',
  'Files and Code',
  'Errors and Fixes',
  'Pending Jobs',
  'Current Work',
  'Next Step',
  'Critical Context',
]

export const NATIVE_SUMMARY_OPEN_TAG = '<compacted-summary>'
export const NATIVE_SUMMARY_CLOSE_TAG = '</compacted-summary>'

export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/** The M [delivered as the final user message] after the replayed region — the
 * region's own system+prefix+surface sit in front, so the summarizer call is a
 * genuine prefix of the last routed request (provider KV-cache reuse). */
export const NATIVE_SUMMARY_PROMPT = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${NATIVE_SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Wrap the model's section bodies in the durable checkpoint framing (DSH frameSummary). */
export function frameNativeSummary(summaryText) {
  return {
    role: 'user',
    content: `${CHECKPOINT_PREAMBLE}\n\n${NATIVE_SUMMARY_OPEN_TAG}\n${summaryText}\n${NATIVE_SUMMARY_CLOSE_TAG}`,
  }
}

/** Validate a native product = `{ summary: string }`. LENIENT, mirroring DSH-native
 * (whose `frameSummary` does NOT hard-validate the 8-section structure — it just
 * wraps whatever the model outputs). We only reject empty / trivial checkpoints so
 * garbage is never injected; a near-miss 8-section summary from a real model is
 * ACCEPTED (rejecting it would waste a compression call and leave the context
 * UNreduced). Exact-section conformance is reported separately for diagnosis. */
export function validateNativeSummary(product) {
  const problems = []
  if (!product || typeof product !== 'object') return ['native product must be an object']
  const s = typeof product.summary === 'string' ? product.summary.trim() : ''
  if (s.length === 0) { problems.push('native product needs a non-empty summary'); return problems }
  if (s.length < 80) problems.push('native summary too short to be a usable checkpoint (< 80 chars)')
  return problems
}

/** Diagnostic: how many of the 8 native sections actually appear in a summary
 * (case-insensitive, tolerant of `##`/`###` + trailing colon). NOT a gate. */
export function nativeSectionStats(summary) {
  const seen = String(summary ?? '').split('\n')
    .map(l => /^#{1,3}\s+(.+?)\s*:?\s*$/.exec(l.trim())?.[1])
    .filter(Boolean)
    .map(h => h.trim().toLowerCase())
  const present = NATIVE_SECTIONS.filter(s => seen.some(h => h === s.toLowerCase() || h.startsWith(s.toLowerCase())))
  return { found: present.length, sections: present }
}

// ============ A2 方案1 具体内容展开 — 信息块模板 ============
export const BLOCK_TYPES = ['plan', 'impl', 'verify', 'wrap']

/** Block-type → required fields (missing any → violation). */
export const BLOCK_REQUIRED = {
  plan: ['goal'],
  impl: ['path', 'change'],
  verify: ['command', 'result'],
  wrap: ['conclusion'],
}
/** Fields allowed per block type (any field outside these → violation). */
export const BLOCK_ALLOWED = {
  plan: ['goal', 'constraints', 'decisions'],
  impl: ['path', 'lineRange', 'symbol', 'change', 'test'],
  verify: ['command', 'result', 'failure'],
  wrap: ['conclusion', 'deliverables', 'leftover'],
}

/** A2 方案1: compress by explicit information blocks (plan/impl/verify/wrap).
 * `impl` uses FILE COORDINATES (`path` + `lineRange`/`symbol`) + a one-line
 * change, never the code bytes — "position transfer", recovery re-reads by
 * coordinate. The instruction is delivered as the final user message after the
 * replayed region (cache-reuse), same transport as the native/atomic modes. */
export const INFORMATION_BLOCK_PROMPT = [
  'You are a context compressor — you are NOT the executor. The conversation ABOVE is the raw work of a just-closed unit. Distill it into explicit information blocks, so an executor continues WITHOUT re-reading the raw log.',
  '',
  'Output EXACTLY ONE RAW JSON object: {"blocks": [ ... ]}. Each block is one object matching the pattern below; use ONLY the 4 block types and ONLY their listed fields. Never invent a block type or a field.',
  '',
  '- {"type":"plan",  "goal":"<objective, verbatim essentials>", "constraints":["<constraint>"], "decisions":["<decision+rationale>"]}',
  '- {"type":"impl",  "path":"<file path>", "lineRange":"<start-end>", "symbol":"<optional symbol>", "change":"<one-line change>", "test":"<command + result, if any>"}',
  '- {"type":"verify","command":"<test command>", "result":"<pass/fail>", "failure":"<exact failure reason, if failed>"}',
  '- {"type":"wrap",  "conclusion":"<outcome>", "deliverables":["<artifact>"], "leftover":["<still open>"]}',
  '',
  'Rules:',
  '- For code changes use file COORDINATES (path + lineRange/symbol) + a one-line change summary. Do NOT paste code fragments or full file bodies.',
  '- Preserve exact file paths, commands, error strings, identifiers, numeric values, and version numbers.',
  '- Do NOT add anything not in the conversation above. Do NOT invent paths or rules.',
  '- Output only the JSON object: do not call any tool or take any other action.',
].join('\n')

/** Mechanical schema validator for the A2-方案1 block product. */
export function validateProductBlocks(product) {
  const problems = []
  if (!product || typeof product !== 'object') return ['block product must be an object']
  if (!Array.isArray(product.blocks) || product.blocks.length === 0) {
    return ['block product needs a non-empty blocks array']
  }
  product.blocks.forEach((b, idx) => {
    const at = `blocks[${idx}]`
    if (!b || typeof b !== 'object') { problems.push(`${at} must be an object`); return }
    if (!BLOCK_TYPES.includes(b.type)) { problems.push(`${at}.type "${b.type}" not allowed`); return }
    const required = BLOCK_REQUIRED[b.type] ?? []
    for (const k of required) {
      if (b[k] === undefined || b[k] === null || b[k] === '') problems.push(`${at} missing required field ${b.type}.${k}`)
    }
    const allowed = BLOCK_ALLOWED[b.type] ?? []
    for (const k of Object.keys(b)) {
      if (k === 'type') continue
      if (!allowed.includes(k)) problems.push(`${at} illegal field "${k}" for block ${b.type}`)
    }
    if (b.type === 'verify' && b.failure !== undefined && typeof b.failure !== 'string') {
      problems.push(`${at}.failure must be a string when present`)
    }
  })
  return problems
}

/** Validate a product object against the mode's required fields. */
export function validateProduct(p, mode = 'semantic') {
  const problems = []
  if (!p || typeof p !== 'object') return ['product must be an object']
  if (mode === 'industry') {
    if (typeof p.summary !== 'string' || p.summary.length === 0) problems.push('industry product needs summary')
    return problems
  }
  // semantic / mock
  if (typeof p.goal !== 'string' || p.goal.trim().length === 0) problems.push('missing goal')
  if (!Array.isArray(p.steps) || p.steps.length === 0) problems.push('missing steps')
  if (typeof p.compressed !== 'string' || p.compressed.trim().length === 0) problems.push('missing compressed')
  return problems
}

const REFERENCE_RULES = {
  full: 'Use FULL file paths and full rule identifiers on EVERY mention — never abbreviate (low accessibility requires explicit anaphor anchoring).',
  natural: 'First mention uses the full path/identifier; later mentions may use natural short references. If source=true, tag every factual claim with [verified] or [assumed] inline.',
  aggressive: 'Be as terse as possible; aggressive abbreviation of identifiers and paths is allowed. Do NOT add source tags.',
}

const SEMANTIC_PROMPT = (context, reference = 'full') => [
  'You are a context compressor — you are NOT the executor. You are given the raw, un-compressed execution work of a just-closed task segment.',
  'Distill it into the smallest product that still lets an executor continue the work WITHOUT re-reading the raw log.',
  '',
  'REFERENCING RULE: ' + (REFERENCE_RULES[reference] ?? REFERENCE_RULES.full),
  '',
  'RAW UN-COMPRESSED WORK (the segment that just finished):',
  String(context ?? '').slice(0, 24000),
  '',
  'OUTPUT EXACTLY ONE RAW JSON OBJECT:',
  '{ "goal": "<one-sentence task goal, verbatim essentials>", "steps": ["<numbered compact steps>"], "fileStream": ["<relevant file paths only>"], "compressed": "<the rest, dense but lossless on requirements/paths/versions>", "source": {"<claim>": "verified|assumed"} }',
  'Do NOT add anything that is not in the context. Do NOT invent rules or paths. Keep every constraint, path, rule id, and version number.',
].join('\n')

const INDUSTRY_PROMPT = (task, context) => [
  'Summarize the conversation so far for a fresh continuation. Keep it faithful: decisions taken, files changed, test status, open issues. Write in the same language as the conversation.',
  '',
  'TASK: ' + task.id + ' — ' + task.title,
  '',
  'CONVERSATION:\n' + String(context ?? '').slice(0, 24000),
  '',
  'OUTPUT EXACTLY ONE RAW JSON OBJECT: {"summary": "<200-400 word dense narrative>"}',
].join('\n')

// Prefix-mode product instructions — the conversation ABOVE (the caller's own
// session prefix) is the data to condense; the instruction is appended as the
// FINAL user message so the summarizer call reuses the provider KV cache, exactly
// like the DSH-native `summarizeWithLlm` (`[..prefix.messages, instruction]` +
// system/tools). The product structure is IDENTICAL to SEMANTIC_PROMPT /
// INDUSTRY_PROMPT — only the data source changes (real message prefix, not a
// rebuilt string). This is the cache-reuse transport/NECESSITY layer; it is NOT
// a product-strategy change.
const SEMANTIC_PREFIX_PROMPT = (reference = 'full') => [
  'You are a context compressor — you are NOT the executor. Distill the conversation ABOVE into the smallest product that still lets an executor continue the work WITHOUT re-reading the raw log.',
  '',
  'REFERENCING RULE: ' + (REFERENCE_RULES[reference] ?? REFERENCE_RULES.full),
  '',
  'OUTPUT EXACTLY ONE RAW JSON OBJECT:',
  '{ "goal": "<one-sentence task goal, verbatim essentials>", "steps": ["<numbered compact steps>"], "fileStream": ["<relevant file paths only>"], "compressed": "<the rest, dense but lossless on requirements/paths/versions>", "source": {"<claim>": "verified|assumed"} }',
  'Do NOT add anything that is not in the conversation above. Do NOT invent rules or paths. Keep every constraint, path, rule id, and version number.',
  'Output only the JSON object: do not call any tool or take any other action.',
].join('\n')

const INDUSTRY_PREFIX_PROMPT = (task) => [
  'Summarize the conversation ABOVE for a fresh continuation. Keep it faithful: decisions taken, files changed, test status, open issues. Write in the same language as the conversation.',
  '',
  'TASK: ' + (task?.id ?? '') + ' — ' + (task?.title ?? ''),
  '',
  'OUTPUT EXACTLY ONE RAW JSON OBJECT: {"summary": "<200-400 word dense narrative>"}',
  'Output only the JSON object: do not call any tool or take any other action.',
].join('\n')

/** The K — one instruction → (instruction, validator) per (mode × a2). */
function buildCompressor(mode, a2, task, context, reference, prefix, focusDirective) {
  if (a2 === 'expand') {
    // A2 方案1 具体内容展开: explicit information blocks (plan/impl/verify/wrap).
    return { instruction: INFORMATION_BLOCK_PROMPT, validate: validateProductBlocks }
  }
  if (mode === 'native') {
    // DSH-native `<compacted-summary>`: Markdown 8 sections, NOT JSON.
    let instruction = NATIVE_SUMMARY_PROMPT
    if (focusDirective) instruction = instruction.replace('Rules:', `${focusDirective}\n\nRules:`)
    return { instruction, validate: validateNativeSummary }
  }
  if (mode === 'industry') {
    const instruction = prefix ? INDUSTRY_PREFIX_PROMPT(task) : INDUSTRY_PROMPT(task, context)
    return { instruction, validate: (p) => validateProduct(p, 'industry') }
  }
  const instruction = prefix ? SEMANTIC_PREFIX_PROMPT(reference) : SEMANTIC_PROMPT(context, reference)
  return { instruction, validate: (p) => validateProduct(p, 'semantic') }
}

/**
 * Compress one round of accumulated context.
 * @param {object} opts { task, context, mode, a2, callLLM, provider, model, mockProduct, prefix, reference }
 *   mode   — 'semantic' | 'industry' | 'native' | 'mock' | 'truncate' | 'manual'.
 *   a2     — A2 处理方式: 'keep-original' (方案0, default) | 'expand' (方案1 信息块).
 *   prefix — {messages, tools} for cache-reuse transport (native/semantic/industry).
 * @returns {Promise<{product, usage, mode, ok, problems?, raw?}>}
 */
export async function compressOnce(opts) {
  const { task, context, mode = 'semantic', reference = 'full' } = opts
  const a2 = opts.a2 ?? 'keep-original'
  if (mode === 'mock') {
    const p = opts.mockProduct ?? null
    const problems = p ? validateProduct(p, 'semantic') : ['mock product missing']
    return { product: problems.length === 0 ? p : null, usage: null, mode, ok: problems.length === 0, problems }
  }
  if (mode === 'truncate') {
    // deterministic sliding tail: first 400 + last 2400 chars of context
    const text = String(context ?? '')
    const p = {
      goal: task.title,
      steps: [],
      fileStream: [],
      compressed: text.slice(0, 400) + '\n…[truncated]…\n' + text.slice(-2400),
    }
    return { product: p, usage: null, mode, ok: true, deterministic: true }
  }
  if (mode === 'manual') {
    // gold manual product (E3 manual arm): pre-written by the test team,
    // lives under answers/manual — model-unreachable.
    const file = path.join(MANUAL_DIR, `${task.id}.json`)
    if (!fs.existsSync(file)) return { product: null, usage: null, mode, ok: false, problems: [`no gold manual product for ${task.id}: ${file}`] }
    let p
    try { p = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return { product: null, usage: null, mode, ok: false, problems: [`gold manual product unreadable: ${e.message}`] } }
    const problems = validateProduct(p, 'semantic')
    if (problems.length > 0) return { product: null, usage: null, mode, ok: false, problems }
    return { product: p, usage: null, mode, ok: true, manual: true }
  }
  if (!['semantic', 'industry', 'native'].includes(mode)) {
    return { product: null, usage: null, mode, ok: false, problems: [`unknown compression mode: ${mode}`] }
  }

  const callLLM = opts.callLLM ?? createGateway().chatCall
  const prefix = opts.prefix // undefined = non-prefix (raw context in a single user msg)
  const { instruction, validate } = buildCompressor(mode, a2, task, context, reference, prefix, opts.focusDirective)
  // Prefix mode (cache reuse) reuses the caller's own session prefix
  // (`{messages, tools}` = system/tools/messages already used by the latest main
  // request) + the instruction appended as the FINAL user message → the
  // summarizer call is a genuine prefix of the main conversation and reuses the
  // provider KV cache (DSH-native transport). Non-prefix mode places the raw
  // context first, then the instruction, in one request.
  const messages = prefix
    ? [...(prefix.messages ?? []), { role: 'user', content: instruction }]
    : [{ role: 'user', content: String(context ?? '') }, { role: 'user', content: instruction }]
  let out
  try {
    out = await callLLM({ provider: opts.provider, model: opts.model, messages, tools: prefix?.tools, maxTokens: 3000, timeoutMs: 600000 })
  } catch (e) {
    return { product: null, usage: null, mode, ok: false, problems: [`compressor call failed: ${e.message}`] }
  }
  // Native output is Markdown (not JSON); semantic/industry/expand blocks are JSON.
  let p = null
  if (mode === 'native' && a2 !== 'expand') {
    p = { summary: out.text ?? '' }
  } else {
    try { p = JSON.parse(out.text) } catch { /* fallthrough */ }
  }
  const problems = p ? validate(p) : [(mode === 'native' && a2 !== 'expand') ? 'native output not a valid <compacted-summary> (missing/all sections wrong)' : 'compressor output not valid JSON']
  if (problems.length > 0) {
    return { product: null, usage: out.usage, mode, ok: false, problems, raw: out.text.slice(0, 500) }
  }
  return { product: p, usage: out.usage, mode, ok: true }
}

/** Versioned product file path for a run. `name` defaults to 'P' (single product
 * per run); pass `P-<segmentIndex>` to persist each task-boundary compression
 * segment separately for offline audit. */
export function productPath(runDir, name = 'P') {
  const dir = path.join(runDir, 'compressed')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${name}.json`)
}

/* ============ PTC-style compressor (self-* task-boundary arms, M1–M4) ============
 * ONE LLM call (model WRITES a program against the compressor SDK; no tools) +
 * ONE code run (runProgram executes it; intermediates are execution-local) +
 * mechanical gates (schema / PTR-TRUTH / OUT / RATIO / RETENTION). No model-side
 * iteration: any failure → fail-lazy (product null, caller keeps the original).
 */
export async function compressWithProgram(opts) {
  const {
    a1 = 's2', a2 = 'keep-original',
    prefix,               // the caller's TRUE prefix ([system, ...sections, (retain), ...live])
    tools,                // the caller's tool schemas — the WIRE prefix (system+tools+messages)
                          // must mirror the last routed request or the provider cache misses
    context,              // { transcript: segmentEntries, workspace } — bindings' data plane
    callLLM, provider, model,
    regionTokens = 0,     // tokens of the region the product replaces (for the ratio gate)
    ratioCfg = DEFAULT_RATIO, retentionCfg = DEFAULT_RETENTION, codeRunCfg,
  } = opts
  const bindings = makeCompressorBindings(context)
  const markers = rawEchoMarkers(context)
  const pointers = computePointers(context)
  const instruction = buildCompressorInstruction({ a1, a2 })
  const messages = [...(prefix ?? []), { role: 'user', content: instruction }]

  let call
  try {
    call = await callLLM({ provider, model, messages, tools, maxTokens: 16000, timeoutMs: 600000 })
  } catch (e) {
    return { product: null, ok: false, problems: [`compressor call failed: ${e.message}`], usage: null }
  }
  const program = String(call?.text ?? '')
  const run = await runProgram({ program, bindings, budgets: codeRunCfg })
  if (run.error) {
    return { product: null, ok: false, problems: [`program ${run.error.kind}: ${run.error.message}`], usage: call.usage, program }
  }
  const product = run.value
  const problems = []
  const prunedRefs = []
  if (!product || typeof product !== 'object') {
    problems.push('program did not return a product object')
  } else {
    for (const p of validateProductSchema(product)) problems.push(`schema: ${p}`)
    if (problems.length === 0) {
      // PTR-TRUTH per namespace (quota semantics, EXPERIMENT.md F8): sections
      // and retain are audited SEPARATELY — the retain hot-bridge may
      // legitimately COPY a section ref (same change, same truth); each
      // namespace owns its coordinate quotas. Fabricated coordinates stay
      // FATAL; over-quota refs are PRUNED in place below (the product
      // survives, padding gains nothing) and reported via prunedRefs.
      const sectionLocs = []
      for (const s of product?.sections ?? []) {
        for (const b of s.subtasks ?? []) if (Array.isArray(b.refs)) for (const r of b.refs) sectionLocs.push({ list: b.refs, ref: r })
      }
      const sectionAudit = auditRefs(sectionLocs.map(l => l.ref), pointers)
      problems.push(...sectionAudit.problems.map(p => `ptr: ${p}`))
      const retainRefs = (product.retain && Array.isArray(product.retain.refs)) ? product.retain.refs : null
      const retainAudit = retainRefs ? auditRefs(retainRefs, pointers) : { problems: [], pruned: [] }
      problems.push(...retainAudit.problems.map(p => `ptr(retain): ${p}`))
      if (problems.length === 0) {
        const drop = (locs, audit, ns) => {
          for (const p of audit.pruned) {
            const loc = locs[p.index]
            const li = loc.list.indexOf(loc.ref)
            if (li >= 0) loc.list.splice(li, 1)
            prunedRefs.push({ ns, path: p.ref.path, lineRange: p.ref.lineRange ?? null, symbol: p.ref.symbol ?? null, reason: p.reason })
          }
        }
        drop(sectionLocs, sectionAudit, 'section')
        if (retainRefs) drop(retainRefs.map(ref => ({ list: retainRefs, ref })), retainAudit, 'retain')
      }
    }
    const echo = findRawEcho(product, markers)
    if (echo.length > 0) problems.push(`out: raw echo contains "${echo[0].slice(0, 40)}"`)
    const ratio = checkRatio({ productTokens: productCompressedTokens(product), regionTokens, cfg: ratioCfg })
    if (ratio.verdict === 'fail') problems.push(`ratio: ${ratio.ratio} > ${ratioCfg.hardFail} (not a real compression)`)
    const ret = checkRetention(product.retain, retentionCfg)
    if (ret.degraded) problems.push(`retention: ${ret.reason}`)
    return {
      product: problems.length === 0 ? product : null,
      ok: problems.length === 0,
      problems,
      prunedRefs,
      usage: call.usage,
      ratio,
      program,
      regionTokens,
    }
  }
  return { product: null, ok: false, problems, prunedRefs, usage: call.usage, program }
}

/** Harness-side expand (A2 方案1): resolve every ref to its real content.
 * Mutates the product by adding `content` on each ref (refs stay for traceability).
 * Same-target refs (path|lineRange) share ONE resolve and receive byte-identical
 * content — the renderer collapses repeats (F8), so expansion is idempotent.
 * Returns problems[] — a ref that cannot be resolved is recorded (fail-lazy upstream). */
export async function enrichRefs(product, context) {
  const problems = []
  const bindings = makeCompressorBindings(context)
  const resolveCache = new Map()
  for (const s of product?.sections ?? []) {
    for (const b of s.subtasks ?? []) {
      for (const ref of b.refs ?? []) {
        const key = `${ref.path}|${ref.lineRange ?? ''}`
        let r = resolveCache.get(key)
        if (r === undefined) {
          r = await bindings.resolve_pointer({ path: ref.path, lineRange: ref.lineRange ?? null })
          resolveCache.set(key, r)
        }
        if (r.error) { problems.push(`resolve failed ${ref.path}:${ref.lineRange ?? '-'} — ${r.error}`); delete ref.content }
        else ref.content = r.content
      }
    }
  }
  return problems
}
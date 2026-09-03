/**
 * Compressor prompt — the STRICT model-facing instruction of the PTC-style
 * compressor (V1: explicit over concise; a few more tokens are worth clarity).
 *
 * Message layout (cache-reuse transport, M1):
 *   [system: fixed compressor persona]
 *   ...真前缀: FINAL earlier sections + the NEW segment's raw work
 *   [user: the strict instruction = mode line + PROGRAM CONTRACT + template +
 *          BINDINGS_SDK + hard rules]
 *
 * The instruction's stable parts (contract/template/SDK/rules) are the same
 * strings every call; only the ONE-line mode preamble varies with (a1, a2) per
 * arm — per run the mode is fixed, so the prefix stays stable within a run.
 *
 * V0-learned contract rules (real-model failures, fixed here):
 *   - The model writes the BODY of an async function; it must NOT declare its
 *     own function signature (models wrote `async (x) => {}` / `async function
 *     f(){}` / a bare block and never returned).
 *   - It must NOT reference undefined variables (models wrote `segmentRef`
 *     bare instead of an object literal).
 *   - `total` = the subtask count (models set it to token counts).
 *   - A real change pointer is cited where it belongs (F8 quota: repeated
 *     citations are collapsed, over-quota refs are trimmed by the harness).
 *   - The TEMPLATE is included: start from it, fill placeholders.
 */
import { BINDINGS_SDK, TEMPLATE_S1, TEMPLATE_S2 } from './sdk.mjs'

/** Fixed compressor persona (never interpolated — byte-stable). */
export const COMPRESSOR_SYSTEM = [
  'You are a context compressor. You are NOT the executor and you do NOT perform the task.',
  'The conversation above is work that is already finished. Your ONLY job is to produce a dense, structured product of the NEW work so an executor can continue without re-reading the raw log.',
].join('\n')

const MODE_LINES = {
  's2:keep-original': 'A1-S2 闭合即全压 × A2 方案0: do NOT retain anything; every subtask goes into sections; refs stay as COORDINATES (no expansion — return refs only).',
  's2:expand': 'A1-S2 闭合即全压 × A2 方案1: do NOT retain anything; every subtask goes into sections; the HARNESS will expand the refs — you return refs only, NEVER file content.',
  's1:keep-original': 'A1-S1 保尾 × A2 方案0: retain the LAST subtask (a refs+outline passthrough, no raw text); refs stay as COORDINATES (return refs only).',
  's1:expand': 'A1-S1 保尾 × A2 方案1: retain the LAST subtask (a refs+outline passthrough, no raw text); the HARNESS will expand refs — you return refs only, NEVER file content.',
}

const PROGRAM_CONTRACT = [
  'PROGRAM CONTRACT — read this FIRST.',
  'Your output becomes the BODY of exactly this:  async function (tools, console) { <YOUR OUTPUT> }',
  'So write STATEMENTS directly; a top-level `return` ends the program and is how you return the product.',
  '❌ NEVER write:  `async function f() {...}` | `async (x) => {...}` | `const f = () => {...}` | a bare `{...}` block',
  '❌ NEVER reference undefined variables — always pass object literals with the binding\'s EXACT keys (e.g. { segmentRef: sub.spanKey }).',
  '❌ NEVER call a binding you were not given, and never write JSON in prose.',
].join('\n')

/** The strict instruction (stable block + one mode line + the a1 template). */
export function buildCompressorInstruction({ a1 = 's2', a2 = 'keep-original' } = {}) {
  const mode = MODE_LINES[`${a1}:${a2}`] ?? MODE_LINES['s2:keep-original']
  const template = a1 === 's1' ? TEMPLATE_S1 : TEMPLATE_S2
  return [
    'WRITE ONE PROGRAM — no prose, no explanation, output ONLY the program text.',
    'The FINAL earlier sections at the TOP of the conversation are FROZEN: never re-summarize, never modify them. Compress ONLY the NEW raw work and return ONE product section for it.',
    '',
    `<${a1}/${a2}> ${mode}`,
    '',
    PROGRAM_CONTRACT,
    '',
    'START FROM THIS TEMPLATE (fill the placeholder strings with the real work\'s content; keep its structure; you may add fields per the FIELDS list — never remove the refs logic):',
    '```',
    template,
    '```',
    '',
    BINDINGS_SDK,
    '',
    'HARD RULES (each violation makes the product unusable):',
    '- Return ONLY the product object (lossless JSON). Never return a string, never print logs, never declare a function signature.',
    '- NEVER embed raw transcript or file content in the product — only refs point at them.',
    '- refs MUST come from tools.locate_change and pass tools.validate_pointer (ok). Never construct coordinates yourself.',
    '- Cite a pointer in every subtask that genuinely owns it; the harness collapses repeated citations and trims over-quota refs — never pad refs for coverage.',
    '- `total` = the number of subtasks in the section (NOT token counts).',
    '- Condense: the product-compressed tokens must be ≤45% of the region tokens (tools.estimate_tokens). Dense summary + typed outline, NOT a transcript.',
    '- Choose each subtask type from the raw work semantics; typeHint is only a hint.',
    `- A2 ${a2}: ${a2 === 'expand' ? 'the harness expands every ref AFTER the run — you return refs only, never embed content.' : 'keep refs as coordinates (path+lineRange+symbol), no expansion.'}`,
    `- A1 ${a1}: ${a1 === 's1' ? 'attach retain = {refs, outline} for the LAST subtask only (refs ≤8, outline ≤40 tokens).' : 'no retain — omit the retain field.'}`,
    '- Output ONLY the program text (the async function body). Nothing else — no markdown fences, no explanation.',
  ].join('\n')
}

/** Render the NEW segment's raw work as the context the program summarizes. */
export function renderRawWork(text) {
  return `## NEW RAW WORK (just-closed unit — condense this)\n${text}`
}

/**
 * Assemble the compressor request messages.
 * @param {object} o { rawWorkText, a1, a2, prefix?: Array<messages> }
 *   prefix — the caller's true prefix when integrating (Phase 2). For the
 *   direct check, defaults to [user(raw work)] — the model reads it and authors.
 */
export function buildCompressorMessages(o) {
  const { rawWorkText, a1, a2 } = o
  const instruction = buildCompressorInstruction({ a1, a2 })
  const prefix = Array.isArray(o.prefix) ? o.prefix : [{ role: 'user', content: renderRawWork(rawWorkText) }]
  return [{ role: 'system', content: COMPRESSOR_SYSTEM }, ...prefix, { role: 'user', content: instruction }]
}

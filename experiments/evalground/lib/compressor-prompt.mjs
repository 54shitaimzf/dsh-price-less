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

/** Instruction version (F11, 2026-09): v3 redesigns the S1 hot tail (design R) —
 * the model still returns outline+refs ONLY; the HARNESS attaches verbatim
 * execution details + expanded ref content after the gates (5000-token cap).
 * v2 remains the F9 environment-declaration + change-manifest release. */
export const COMPRESSOR_PROMPT_VERSION = 3

/** Fixed compressor persona (never interpolated — byte-stable). */
export const COMPRESSOR_SYSTEM = [
  'You are a context compressor. You are NOT the executor and you do NOT perform the task.',
  'The conversation above is work that is already finished. Your ONLY job is to produce a dense, structured product of the NEW work so an executor can continue without re-reading the raw log.',
].join('\n')

const MODE_LINES = {
  's2:keep-original': 'A1-S2 闭合即全压 × A2 方案0: do NOT retain anything; every subtask goes into sections; refs stay as COORDINATES (no expansion — return refs only).',
  's2:expand': 'A1-S2 闭合即全压 × A2 方案1: do NOT retain anything; every subtask goes into sections; the HARNESS will expand the refs — you return refs only, NEVER file content.',
  's1:keep-original': 'A1-S1 保尾 × A2 方案0 (design R): retain the LAST subtask as a refs+outline passthrough — the HARNESS attaches the verbatim execution details and expands the refs itself; you NEVER transcribe outputs or embed file content (return refs only).',
  's1:expand': 'A1-S1 保尾 × A2 方案1 (design R): retain the LAST subtask as a refs+outline passthrough — the HARNESS expands refs AND attaches the verbatim execution details; you NEVER transcribe outputs or embed file content (return refs only).',
}

const PROGRAM_CONTRACT = [
  'PROGRAM CONTRACT — read this FIRST.',
  'Your output becomes the BODY of exactly this:  async function (tools, console) { <YOUR OUTPUT> }',
  'So write STATEMENTS directly; a top-level `return` ends the program and is how you return the product.',
  '❌ NEVER write:  `async function f() {...}` | `async (x) => {...}` | `const f = () => {...}` | a bare `{...}` block',
  '❌ NEVER reference undefined variables — always pass object literals with the binding\'s EXACT keys (e.g. { segmentRef: sub.spanKey }).',
  '❌ NEVER call a binding you were not given, and never write JSON in prose.',
].join('\n')

const EXECUTION_ENVIRONMENT = [
  'EXECUTION ENVIRONMENT — this program does NOT run in this chat.',
  'The harness executes your program in a sandboxed worker where `tools` (every binding listed in the SDK below) IS provided — calling tools.* is the REQUIRED behavior, not a hallucination.',
  'The visible tool whitelist in the conversation above (read/write/glob/grep/run) belongs to the EXECUTOR and does NOT constrain the compressor program.',
  'Replying with prose, explanations, or a refusal ("I cannot / I will not") IS the failure mode — write the program.',
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
    EXECUTION_ENVIRONMENT,
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
    '- refs MUST come from tools.locate_change and pass tools.validate_pointer (ok). Never construct coordinates yourself. The CHANGE MANIFEST at the end of this message lists the real change records — locate_change resolves within that ground truth; Never invent coordinates outside the manifest.',
    '- Cite a pointer in every subtask that genuinely owns it; the harness collapses repeated citations and trims over-quota refs — never pad refs for coverage.',
    '- `total` = the number of subtasks in the section (NOT token counts).',
    '- Condense: the product-compressed tokens must be ≤45% of the region tokens (tools.estimate_tokens). Dense summary + typed outline, NOT a transcript.',
    '- Choose each subtask type from the raw work semantics; typeHint is only a hint.',
    `- A2 ${a2}: ${a2 === 'expand' ? 'the harness expands every ref AFTER the run — you return refs only, never embed content.' : 'keep refs as coordinates (path+lineRange+symbol), no expansion.'}`,
    `- A1 ${a1}: ${a1 === 's1' ? 'attach retain = {refs, outline} for the LAST subtask only (refs ≤8, outline ≤110 tokens — the harness attaches the verbatim execution details, you never transcribe outputs).' : 'no retain — omit the retain field.'}`,
    '- Output ONLY the program text (the async function body). Nothing else — no markdown fences, no explanation.',
  ].join('\n')
}

/** Render the NEW segment's raw work as the context the program summarizes. */
export function renderRawWork(text) {
  return `## NEW RAW WORK (just-closed unit — condense this)\n${text}`
}

/**
 * Render the harness-computed change-record manifest (F9, L2 前置事实包):
 * the model SEES the complete real pointer set up front, so "refs come from
 * tools I cannot see" — the DeepSeek refusal root cause — has no basis left.
 * The PTR gate audits against the SAME records (computePointers), so the
 * manifest can never drift from the gate's judgment set. Deterministic:
 * sorted by recordIdx regardless of input order.
 */
export function renderChangeManifest(pointers) {
  const list = (Array.isArray(pointers) ? [...pointers] : [])
    .filter(p => p && typeof p === 'object')
    .sort((a, b) => (a.recordIdx ?? 0) - (b.recordIdx ?? 0))
    .map(p => {
      const loc = `${p.path ?? '?'}${p.lineRange != null ? `:${p.lineRange}` : ''}${p.symbol ? ` (${p.symbol})` : ''}`
      return `- [${p.refKey ?? 'truth:?'}] ${p.kind ?? 'record'} ${loc}`
    })
  const body = list.length > 0 ? list.join('\n') : '(no change records) — write the product without refs'
  return [
    '## CHANGE MANIFEST (harness-computed ground truth — the COMPLETE set of real change records for the region; nothing else exists)',
    body,
  ].join('\n')
}

/**
 * Deterministic refusal classifier (F9): a prose refusal ("I cannot produce
 * this program…") used to fail at type-strip as a generic invalid-program;
 * typing it lets the batch ledger observe refusal-rate separately from
 * program-error-rate. Conservative: only obvious first-person refusals match.
 */
export function classifyProgramText(text) {
  const head = String(text ?? '').slice(0, 300)
  return /I (cannot|can't|will not|won't|am unable|refuse)|cannot produce|not able to/i.test(head) ? 'refusal' : 'program'
}

/**
 * Strip markdown code fences from a program response (F9): the contract says
 * "no markdown fences", yet models wrap the program in ``` fences anyway
 * (observed: deepseek-v4-flash-vision-exp, E3 run mtlze9r5 — the program
 * itself was syntactically perfect). Formatting noise must not kill an
 * otherwise valid compression: a leading fence line (optionally with a
 * language tag) and the trailing fence line are removed deterministically.
 * Everything else passes through byte-identical; unfenced input is untouched.
 */
export function stripProgramFences(text) {
  const s = String(text ?? '').trim()
  const m = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(s)
  return m ? m[1] : s
}

/**
 * Assemble the compressor request messages.
 * @param {object} o { rawWorkText, a1, a2, prefix?: Array<messages>, manifest?: string }
 *   prefix — the caller's true prefix when integrating (Phase 2). For the
 *   direct check, defaults to [user(raw work)] — the model reads it and authors.
 *   manifest — optional renderChangeManifest output; appended to the FINAL
 *   instruction message (stable head, varying tail — prefix cache alignment
 *   is preserved because the request still starts with the routed prefix).
 */
export function buildCompressorMessages(o) {
  const { rawWorkText, a1, a2 } = o
  const instruction = o.manifest ? `${buildCompressorInstruction({ a1, a2 })}\n\n${o.manifest}` : buildCompressorInstruction({ a1, a2 })
  const prefix = Array.isArray(o.prefix) ? o.prefix : [{ role: 'user', content: renderRawWork(rawWorkText) }]
  return [{ role: 'system', content: COMPRESSOR_SYSTEM }, ...prefix, { role: 'user', content: instruction }]
}

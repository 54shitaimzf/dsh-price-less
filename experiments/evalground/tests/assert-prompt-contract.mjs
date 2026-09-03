/**
 * Assertions — V1 提示词严格遵守性契约 (prompt-contract). The compressor
 * instruction is the model-facing contract; every strict clause must be present
 * as a byte-stable string so a future edit cannot silently loosen it. Covers:
 * the PROGRAM CONTRACT, template inclusion, exact-key binding usage rules,
 * ≤45% condensation budget, no-raw-echo, refs-only-from-locate_change,
 * exactly-once refs, total=subtask count, and the a1/a2 modes.
 */
let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!cond) failures++
}

const { buildCompressorInstruction, COMPRESSOR_SYSTEM } = await import('../lib/compressor-prompt.mjs')
const { BINDINGS_SDK, TEMPLATE_S1, TEMPLATE_S2 } = await import('../lib/sdk.mjs')

const INSTR = buildCompressorInstruction({ a1: 's1', a2: 'expand' })
const INSTR_S2 = buildCompressorInstruction({ a1: 's2', a2: 'keep-original' })

// --- PROGRAM CONTRACT (V0-learned: models must not declare their own signature) ---
ok(INSTR.includes('PROGRAM CONTRACT'), 'PC-1 PROGRAM CONTRACT section present')
ok(INSTR.includes('async function (tools, console) {'), 'PC-2 contract names the exact wrapper (function body)')
ok(INSTR.includes('top-level `return`') && INSTR.includes('NEVER write'), 'PC-3 contract: top-level return + never-write list')
ok(INSTR.includes('NEVER reference undefined variables') && INSTR.includes('object literals with the binding\'s EXACT keys'), 'PC-4 contract: exact-key object literals only')

// --- TEMPLATE inclusion (one-shot reliability) ---
ok(INSTR.includes(TEMPLATE_S1) || INSTR.includes(TEMPLATE_S2), 'PC-5 the a1 template is INLINED in the instruction (one-shot)')
ok(buildCompressorInstruction({ a1: 's1' }).includes(TEMPLATE_S1), 'PC-6 S1 instruction inlines TEMPLATE_S1')
ok(INSTR_S2.includes(TEMPLATE_S2), 'PC-7 S2 instruction inlines TEMPLATE_S2')
ok(INSTR.includes('START FROM THIS TEMPLATE') && INSTR.includes('fill the placeholder strings'), 'PC-8 template usage guidance present')

// --- SDK surface ---
ok(BINDINGS_SDK.includes('probe_substructure') && BINDINGS_SDK.includes('locate_change') && BINDINGS_SDK.includes('validate_pointer') && BINDINGS_SDK.includes('read_transcript') && BINDINGS_SDK.includes('estimate_tokens'), 'PC-9 SDK lists the 5 model-facing bindings')
ok(!BINDINGS_SDK.includes('resolve_pointer'), 'PC-10 resolve_pointer NOT model-facing (expand is harness-side — models never embed content)')
ok(BINDINGS_SDK.includes('refs: [{ refKey?, path, lineRange?, symbol? }]'), 'PC-11 refs shape = refKey/path/lineRange/symbol (no content)')
ok(BINDINGS_SDK.includes('total: number') && BINDINGS_SDK.includes('summary: string') && BINDINGS_SDK.includes('type: "plan"|"impl"|"verify"|"wrap"'), 'PC-12 总-分 contract: total/summary/subtasks typed')

// --- HARD RULES ---
ok(INSTR.includes('NEVER embed raw transcript or file content'), 'PC-13 no-raw-echo rule present')
ok(INSTR.includes('Never construct coordinates yourself'), 'PC-14 refs only from locate_change rule present')
ok(INSTR.includes('Cite a pointer in every subtask that genuinely owns it') && INSTR.includes('never pad refs for coverage'), 'PC-15 quota refs rule present (F8: cite-where-owned, harness collapses repeats)')
ok(INSTR.includes('≤45% of the region tokens'), 'PC-16 condensation budget ≤45% present in the instruction')
ok(INSTR.includes('`total` = the number of subtasks'), 'PC-17 total=subtask count rule present')
ok(INSTR.includes('never re-summarize') && INSTR.includes('FROZEN'), 'PC-18 earlier sections FROZEN clause present')

// --- modes ---
ok(INSTR.includes('the HARNESS will expand'), 'PC-19 expand mode: harness-side expansion stated')
ok(INSTR_S2.includes('no retain — omit the retain field'), 'PC-20 s2: omit retain rule present')
ok(INSTR.includes('retain = {refs, outline}') && INSTR.includes('refs ≤8') && INSTR.includes('outline ≤40 tokens'), 'PC-21 s1: retain shape + length gate stated')
ok(!INSTR.includes('You are now acting as a compaction engine'), 'PC-22 instruction is NOT the native summarizer instruction (product-structure separation)')

// --- system persona ---
ok(COMPRESSOR_SYSTEM.includes('You are a context compressor') && COMPRESSOR_SYSTEM.includes('NOT the executor'), 'PC-23 fixed compressor persona (system, byte-stable)')

// --- V2: execution environment declaration + change-manifest reference (F9) ---
const { COMPRESSOR_PROMPT_VERSION, buildCompressorMessages, renderChangeManifest } = await import('../lib/compressor-prompt.mjs')
ok(COMPRESSOR_PROMPT_VERSION === 2, 'PC-24a instruction version bumped to 2 (F9 environment + manifest)')
ok(INSTR.includes('does NOT run in this chat') && INSTR.includes('sandboxed worker'), 'PC-24 execution environment declared (program runs in the harness worker, not this chat)')
ok(INSTR.includes('belongs to the EXECUTOR'), 'PC-24b executor tool-whitelist separation stated (the refusal root cause)')
ok(INSTR.includes('CHANGE MANIFEST'), 'PC-25 instruction references the change manifest as the citation ground truth')
ok(INSTR.includes('Never invent coordinates outside the manifest'), 'PC-25b manifest-bounded coordinate rule present')
const MANIFEST = renderChangeManifest([
  { kind: 'write', refKey: 'truth:write:3', recordIdx: 3, path: 'src/auth.js', lineRange: '1-6', symbol: 'checkAuth' },
  { kind: 'read', refKey: 'truth:read:0', recordIdx: 0, path: 'src/auth.js', lineRange: null, symbol: null },
])
ok(MANIFEST.includes('- [truth:write:3] write src/auth.js:1-6 (checkAuth)') && MANIFEST.includes('- [truth:read:0] read src/auth.js'), 'PC-26a manifest renders records deterministically (refKey + kind + coords + symbol)')
ok(renderChangeManifest([]).includes('(no change records)'), 'PC-26b empty manifest renders an explicit empty line')
const msgs = buildCompressorMessages({ rawWorkText: 'RAW', a1: 's1', a2: 'expand', manifest: MANIFEST })
const lastMsg = msgs[msgs.length - 1]
ok(lastMsg.role === 'user' && lastMsg.content.includes('CHANGE MANIFEST') && lastMsg.content.includes('[truth:write:3]'), 'PC-26c manifest rides the FINAL instruction message (head stable, tail varies)')
ok(lastMsg.content.indexOf('WRITE ONE PROGRAM') < lastMsg.content.indexOf('CHANGE MANIFEST'), 'PC-26d stable instruction head precedes the manifest tail')

export { failures }

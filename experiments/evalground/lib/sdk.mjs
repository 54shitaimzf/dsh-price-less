/**
 * Compressor SDK — the byte-stable, model-facing surface of the PTC-style
 * compressor. Everything here is STRING CONSTANTS (no interpolation of run
 * data) so the prompt prefix stays stable for provider KV-cache reuse:
 *
 *   BINDINGS_SDK  — binding signatures + product contract + strict rules
 *   TEMPLATE_S2   — executable skeleton for A1-S2 (no retain)
 *   TEMPLATE_S1   — executable skeleton for A1-S1 (retain = refs + outline)
 *
 * The templates are RUNNABLE as-is (placeholder literals are valid strings):
 * the offline battery executes them against the fixture bindings to prove the
 * shape before the model ever fills the placeholders.
 */
export const BINDINGS_SDK = [
  'COMPRESSOR SDK — write ONE async function body (erasable TypeScript). The global `tools` is a namespace of async JSON bindings:',
  '',
  '  tools.probe_substructure({ taskRef })',
  '    → { taskRef, subtasks: [{ spanKey, fromIdx, toIdx, typeHint }] }',
  '    typeHint ∈ explore|edit|verify|wrap (deterministic; a HINT, not the final type)',
  '  tools.locate_change({ segmentRef, fileHint })',
  '    → { path, lineRange, symbol } | null   // REAL change pointer; never invented',
  '  tools.validate_pointer({ path, lineRange, symbol })',
  '    → { ok: boolean, reason? }',
  '  tools.read_transcript({ segmentRef })',
  '    → string   // raw work text — INTERNAL ONLY, never echo it',
  '  tools.estimate_tokens({ text })',
  '    → { tokens }   // chars/4 deterministic count',
  '',
  'PRODUCT — return EXACTLY this shape (lossless JSON):',
  '{',
  '  total: number,',
  '  sections: [{ summary: string, subtasks: [{',
  '    type: "plan"|"impl"|"verify"|"wrap",',
  '    ...FIELDS,',
  '    refs: [{ refKey?, path, lineRange?, symbol? }]',
  '  }] }],',
  '  retain?: { refs: [{ path, lineRange?, symbol? }], outline: string }   // S1 only',
  '}',
  '',
  'FIELDS per type:',
  '  plan   { goal, constraints?, decisions? }',
  '  impl   { path, lineRange?, symbol?, change, test? }',
  '  verify { command, result, failure? }',
  '  wrap   { conclusion, deliverables?, leftover? }',
  '',
  'RULES (strict — violations make the product UNUSABLE):',
  '- Return ONLY the product object. NEVER return, print, or embed raw transcript or file content (only `refs` point at it).',
  '- `refs` MUST come from tools.locate_change (the REAL pointer). Never construct coordinates yourself.',
  '- A2 expand is applied by the HARNESS after the run: you ALWAYS return refs only — never embed file content yourself.',
  '- Condense to ≤45% of the region tokens (tools.estimate_tokens). Target a dense summary + typed outline, NEVER a transcript.',
  '- The conversation ABOVE contains FINAL earlier sections: do NOT re-summarize or modify them. Only compress the NEW segment and append one section.',
  '- Choose each subtask type from the raw work semantics; typeHint is only a hint.',
].join('\n')

/** A1-S2: compress every closed task, no retain (all in sections). Placeholder content runs. */
export const TEMPLATE_S2 = [
  '// A1-S2 闭合即全压 — no retain',
  'const s = await tools.probe_substructure({ taskRef: "task" })',
  'const subtasks = []',
  'for (const sub of s.subtasks) {',
  '  let refs = []',
  '  let p = null',
  '  if (sub.typeHint === "edit") {',
  '    p = await tools.locate_change({ segmentRef: sub.spanKey, fileHint: "" })',
  '    if (p) { const v = await tools.validate_pointer({ ...p }); if (v.ok) refs = [{ refKey: sub.spanKey, ...p }] }',
  '  }',
  '  // author type + fields from the raw work (typeHint is only a hint)',
  '  const type = sub.typeHint === "edit" ? "impl" : sub.typeHint === "verify" ? "verify" : sub.typeHint === "wrap" ? "wrap" : "plan"',
  '  const fields = type === "impl" ? { path: p?.path ?? "", change: "<one-line change>" }',
  '    : type === "verify" ? { command: "<command>", result: "<pass/fail>" }',
  '    : type === "wrap" ? { conclusion: "<conclusion>" }',
  '    : { goal: "<objective>" }',
  '  subtasks.push({ type, ...fields, refs })',
  '}',
  'return { total: s.subtasks.length, sections: [{ summary: "<task-level summary>", subtasks }] }',
].join('\n')

/** A1-S1: retain the LAST subtask as refs + one-line outline (no raw text). */
export const TEMPLATE_S1 = [
  '// A1-S1 保尾 — retain the last subtask as refs + outline (no raw text)',
  'const s = await tools.probe_substructure({ taskRef: "task" })',
  'const subtasks = []',
  'for (const sub of s.subtasks) {',
  '  let refs = []',
  '  let p = null',
  '  if (sub.typeHint === "edit") {',
  '    p = await tools.locate_change({ segmentRef: sub.spanKey, fileHint: "" })',
  '    if (p) { const v = await tools.validate_pointer({ ...p }); if (v.ok) refs = [{ refKey: sub.spanKey, ...p }] }',
  '  }',
  '  const type = sub.typeHint === "edit" ? "impl" : sub.typeHint === "verify" ? "verify" : sub.typeHint === "wrap" ? "wrap" : "plan"',
  '  const fields = type === "impl" ? { path: p?.path ?? "", change: "<one-line change>" }',
  '    : type === "verify" ? { command: "<command>", result: "<pass/fail>" }',
  '    : type === "wrap" ? { conclusion: "<conclusion>" }',
  '    : { goal: "<objective>" }',
  '  subtasks.push({ type, ...fields, refs })',
  '}',
  'let retain',
  'if (s.subtasks.length > 0) {',
  '  const last = s.subtasks[s.subtasks.length - 1]',
  '  let rp = last.typeHint === "edit" || last.typeHint === "verify"',
  '    ? await tools.locate_change({ segmentRef: last.spanKey, fileHint: "" }) : null',
  '  const rrefs = rp ? [{ path: rp.path, lineRange: rp.lineRange, symbol: rp.symbol }] : []',
  '  retain = { refs: rrefs, outline: "<one-line outline of the last subtask>" }',
  '}',
  'return { total: s.subtasks.length, sections: [{ summary: "<task-level summary>", subtasks }], retain }',
].join('\n')

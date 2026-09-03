/**
 * Blind judge: evidence packet + fixed rubric → minimax-m3 banded scoring +
 * anti-cheat verdict. Code-subjective dims only (human owns aesthetics).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createGateway } from './gateway.mjs'
import { digest as transcriptDigest } from './transcript.mjs'
import { loadGoldenBugs } from './mech.mjs'

const defaultCallLLM = createGateway().chatCall

export function artifactFor(taskId, workspace) {
  const rel = {
    'T1': 'REVIEW.md',
    'T2': ['docs/api.md', 'docs/rules.md'],
    'T3': ['public/filter.js', 'public/format.js', 'public/app.js'],
    'T4': ['src/audit/files-field.js', 'src/audit/semver.js', 'src/audit/severity.js', 'src/audit/index.js'],
    'T5': 'release-notes-v1.3.0.md',
    'T6': 'docs/quickstart.md',
    'T7': ['REVIEW.md', 'src/audit/files-field.js', 'docs/rules.md'],
  }[taskId]
  const ws = workspace ?? '.'
  const files = Array.isArray(rel) ? rel : rel === undefined ? [] : [rel]
  return files.map(f => {
    const file = path.join(ws, f)
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '(missing)'
    return `### ${f}\n${text.slice(0, 5000)}`
  }).join('\n\n')
}


/** Golden defect reference: partial ground truth for review tasks (T1). */
function goldenRefBlock() {
  try {
    const g = loadGoldenBugs()
    const rows = (g.bugs ?? []).map(b => `- ${b.id} ${b.file.split('/').pop()}: ${String(b.location).slice(0, 40)} — ${b.title}`)
    if (g.observation) rows.push(`- ${g.observation.id} ${g.observation.file.split('/').pop()}: ${String(g.observation.location).slice(0, 40)} — ${g.observation.title}`)
    return rows.length === 0 ? '' : rows.join('\n')
  } catch {
    return ''
  }
}

export function buildJudgePrompt(task, mech, diff, transcript, runId) {
  const rubric = task.rubric
  if (!rubric || rubric.dims.length === 0) return null
  const dimSpec = rubric.dims.map(d => {
    const anchors = d.bands.map(([band, text]) => `  ${band}分: ${text}`).join('\n')
    return `- ${d.id}「${d.name}」 (weight ${d.weight}):\n${anchors}`
  }).join('\n')
  const golden = goldenRefBlock()
  return [
    'You are a blind evaluator for a software task. The strategy/label of the run is HIDDEN from you; judge ONLY against the dimensions and anchors below.',
    '',
    `TASK: ${task.id} — ${task.title}`,
    '',
    'FIXED RUBRIC DIMENSIONS (score each dimension an integer 0–5 where 5 = BEST (flawless) and 0 = WORST (no output); read the anchor wording for each band):\n' + dimSpec,
    '',
    ...(golden ? ['GOLDEN DEFECT REFERENCE (partial ground truth — it may UNDER-cover real defects, so evaluate each EXTRA finding on its own code merits; use it to judge `grounded`/`precision`):', golden, ''] : []),
    '',
    'MECHANICAL FACTS:',
    `- mech checks: ${JSON.stringify(mech.checks.filter(c => !c.pass))}`,
    `- violations: ${JSON.stringify(mech.violations)}`,
    `- scope diff: ${JSON.stringify(diff.modified ?? [])}`,
    'NOTE: reading tests/** to learn the expected behavior is legitimate engineering and NOT cheating (only modifying tests/, faking test results, reading answer files, or touching out-of-scope paths are violations).',
    '',
    'TRANSCRIPT EXCERPT:\n' + transcript,
    '',
    'ARTIFACT(S):\n' + artifactFor(task.id, process.env.JUDGE_WORKSPACE ?? '.'),
    '',
    'OUTPUT EXACTLY ONE RAW JSON OBJECT and nothing else — no reasoning, no thinking, no markdown fences, no preamble:',
    '{ "dims": { "<dimId>": { "score": <0-5>, "why": "<one sentence tied to the anchors>" } }, "antiCheat": { "verdict": "none"|"suspect"|"proven", "evidence": "<one sentence>" }, "notes": "<one sentence>" }',
    'Scoring must be internally consistent: if your notes say the implementation is correct, no dim can be below 3 (anchor wording only: 5 flawless, 4 minor style, 3 mostly met with edge gaps, 2 partially met or wrong behavior added, 1 wrong direction, 0 no output).',
  ].join('\n')
}

/**
 * @param {object} opts { task, mech, diff, runDir, workspace, provider, model, pricing, samples }
 */
export async function judgeTask(opts) {
  const samples = Math.max(1, Number(opts.samples ?? 1))
  const single = async () => judgeOnce(opts)
  if (samples === 1) return single()
  // multi-sample: run N independent judgments, take per-dim median; flag spread.
  const results = []
  for (let i = 0; i < samples; i++) results.push(await single())
  const valid = results.filter(r => r.score !== null && r.score !== undefined)
  if (valid.length === 0) return results[0]
  const rubric = opts.task.rubric
  const dims = {}
  let unstable = false
  for (const d of rubric.dims) {
    const scores = valid.map(r => r.dims?.[d.id]).filter(s => Number.isFinite(s))
    const sorted = [...scores].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    dims[d.id] = median
    if (sorted.length >= 2 && sorted[sorted.length - 1] - sorted[0] >= 2) unstable = true
  }
  let weighted = 0
  for (const d of rubric.dims) weighted += (dims[d.id] / 5) * d.weight
  return {
    score: Math.round(weighted * 100),
    dims,
    calibrationSuspect: valid.some(r => r.calibrationSuspect),
    unstable,
    samples: valid.length,
    antiCheat: valid[0].antiCheat,
    notes: valid.map(r => r.notes).filter(Boolean).join(' | '),
    usage: valid.reduce((a, r) => ({ inputTokens: a.inputTokens + (r.usage?.inputTokens ?? 0), outputTokens: a.outputTokens + (r.usage?.outputTokens ?? 0), cacheReadTokens: a.cacheReadTokens + (r.usage?.cacheReadTokens ?? 0), calls: a.calls + (r.usage?.calls ?? 1) }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 }),
    raw: valid.map(r => r.raw ?? '').join('\n---\n').slice(0, 4000),
  }
}

async function judgeOnce(opts) {
  const { task, mech, diff, runDir, workspace } = opts
  const callLLM = opts.callLLM ?? defaultCallLLM
  const rubric = task.rubric
  if (!rubric || rubric.dims.length === 0) {
    return { score: null, dims: {}, antiCheat: { verdict: 'none', evidence: 'no rubric' }, skipped: true }
  }
  const dimIds = rubric.dims.map(d => d.id)
  // Cost discipline: a judge round may make MORE than one LLM call (strict
  // retry on bad JSON / calibration suspect) — every billed call's usage must
  // be aggregated, not overwritten by the last one.
  const usageAgg = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 }
  const addUsage = (u) => {
    if (!u) return
    usageAgg.inputTokens += u.inputTokens ?? 0
    usageAgg.outputTokens += u.outputTokens ?? 0
    usageAgg.cacheReadTokens += u.cacheReadTokens ?? 0
    usageAgg.calls += 1
  }
  const normalize = (obj) => obj.dims && typeof obj.dims === 'object' ? obj : { ...obj, dims: obj }
  process.env.JUDGE_WORKSPACE = workspace
  const prompt = buildJudgePrompt(task, mech, diff, transcriptDigest(runDir), path.basename(runDir))
  if (!prompt) return { score: null, skipped: true }
  let out
  try {
    // glm-5.3-flash ALWAYS reasons before answering ("cannot be disabled");
    // reasoning tokens consume max_tokens, so a tight cap yields finish=length
    // with empty content (seen on T4/T7 judge prompts). Give 8000 output
    // tokens: 3–5k reasoning + ~1k JSON content comfortably fits.
    out = await callLLM({ provider: opts.provider, model: opts.model, messages: [{ role: 'user', content: prompt }], maxTokens: 8000, timeoutMs: 600000 })
    addUsage(out.usage)
  } catch (error) {
    return { score: null, dims: {}, antiCheat: { verdict: 'none', evidence: `judge call failed: ${String(error)}` }, skipped: true, error: String(error), usage: usageAgg.calls > 0 ? usageAgg : null }
  }
  let parsed = parseJudgeJson(out.text, dimIds)
  const strictRetry = async (reason) => {
    // one retry with the inconsistency/parse problem spelled out
    try {
      const retry = await callLLM({ provider: opts.provider, model: opts.model, messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: out.text.slice(0, 4000) },
        { role: 'user', content: `${reason} Do NOT output any reasoning or thinking. Output ONLY the raw JSON object: {"dims": {"<dimId>": {"score": <0-5>, "why": "..."}}, "antiCheat": {"verdict":"none|suspect|proven","evidence":"..."}, "notes":"..."}` },
      ], maxTokens: 8000, timeoutMs: 600000 })
      addUsage(retry.usage)
      const retryParsed = parseJudgeJson(retry.text, dimIds)
      if (retryParsed !== null) { parsed = retryParsed; out = retry }
    } catch { /* keep original failure */ }
  }
  if (parsed === null) await strictRetry('Your previous answer was not valid JSON.')
  if (parsed === null) {
    return { score: null, dims: {}, antiCheat: { verdict: 'none', evidence: 'judge JSON parse failed' }, parseFailed: true, raw: out.text.slice(0, 500), usage: usageAgg.calls > 0 ? usageAgg : null }
  }
  parsed = normalize(parsed)
  const dims = {}
  let weighted = 0
  for (const d of rubric.dims) {
    const raw = parsed.dims?.[d.id]
    // accept both plain number and {score, why} forms
    const band = Number(typeof raw === 'object' && raw !== null ? raw.score : raw ?? 0)
    dims[d.id] = Math.max(0, Math.min(5, Math.round(band)))
    weighted += (dims[d.id] / 5) * d.weight
  }
  // internal-consistency guard: positive notes but all dims ≤2 → one self-correction pass
  const avg = Object.values(dims).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(dims).length)
  const POSITIVE = /correct|proper|good|matches|excellent|solid|complete|符合|正确|良好|达标|正确|高质量|精炼|优秀|可靠|完整|满意|出色|到位/
  const notesPositive = POSITIVE.test(parsed.notes ?? '')
  // per-dim reason words: a "why" praising the work must not carry a score ≤1
  const whyPositiveLow = Object.entries(dims).some(([id, s]) => {
    const why = parsed.dims?.[id]?.why ?? ''
    return s <= 1 && /正确|高质量|优秀|完整|良好|到位|correct|proper|good|excellent|solid|complete/.test(why)
  })
  let calibrationSuspect = (avg <= 2 && notesPositive) || whyPositiveLow
  if (calibrationSuspect) {
    const before = JSON.stringify(dims)
    await strictRetry('Your scoring contradicts your own notes: the notes say the implementation is correct but every dimension scored ≤2. Re-read the anchor wording (5 flawless … 0 no output) and re-score consistently with your notes.')
    // re-derive dims after retry (if any)
    const p2 = parsed
    if (p2) {
      for (const d of rubric.dims) {
        const raw = p2.dims?.[d.id]
        const band = Number(typeof raw === 'object' && raw !== null ? raw.score : raw ?? 0)
        dims[d.id] = Math.max(0, Math.min(5, Math.round(band)))
      }
      weighted = 0
      for (const d of rubric.dims) weighted += (dims[d.id] / 5) * d.weight
      const avg2 = Object.values(dims).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(dims).length)
      calibrationSuspect = (avg2 <= 2 && /correct|proper|good|matches|符合|正确|良好|达标|正确|高质量|精炼|优秀|可靠|完整|满意|出色|到位/.test(parsed.notes ?? ''))
        || Object.entries(dims).some(([id, s]) => {
          const why = parsed.dims?.[id]?.why ?? ''
          return s <= 1 && /正确|高质量|优秀|完整|良好|到位|correct|proper|good|excellent|solid|complete/.test(why)
        })
    }
  }
  return {
    score: calibrationSuspect ? null : Math.round(weighted * 100),
    dims,
    calibrationSuspect,
    antiCheat: parsed.antiCheat ?? { verdict: 'none', evidence: '' },
    notes: parsed.notes ?? '',
    usage: usageAgg.calls > 0 ? usageAgg : null,
    raw: out.text.slice(0, 4000),
  }
}

/**
 * Extract a judge JSON object, accepting both output shapes minimax uses:
 *   A: {"dims": {"t": {...}}, "antiCheat": {...}, "notes": "..."}
 *   B: {"t": {...}, "fit": {...}, ..., "antiCheat": {...}, "notes": "..."} (flat)
 * Scans brace-balanced candidates (not a fixed lastIndex) so inner objects
 * never shadow the real answer.
 */
export function collectCandidates(text) {
  const s = String(text).replace(/```(?:json)?\s*/gi, '').replace(/^thinking[^\n]*$/mi, '')
  const out = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue
    let depth = 0
    for (let j = i; j < s.length; j++) {
      if (s[j] === '{') depth++
      else if (s[j] === '}') {
        depth--
        if (depth === 0) { out.push(s.slice(i, j + 1)); break }
      }
    }
  }
  return out
}

export function parseJudgeJson(text, dimIds) {
  for (const candidate of collectCandidates(text).reverse()) {
    let obj
    try { obj = JSON.parse(candidate) } catch { continue }
    if (!obj || typeof obj !== 'object') continue
    // shape A: has a dims key
    if (obj.dims && typeof obj.dims === 'object') return obj
    // shape B: flat object covering all rubric dims AND carrying the mandatory
    // response keys (antiCheat/notes) — otherwise inner dim objects could be
    // mistaken for the full answer on single-dim rubrics
    if (dimIds.length > 0
      && dimIds.every(id => id in obj)
      && ('antiCheat' in obj || 'notes' in obj)) return obj
  }
  return null
}

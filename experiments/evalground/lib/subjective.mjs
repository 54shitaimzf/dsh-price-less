/**
 * Subjective audit — the human-adjacent qualitative layer of the score.
 *
 * The mechanical (mech) track is deterministic and gold-aligned; the blind
 * judge (judge.mjs) scores a fixed task rubric. Neither reads the deliverable
 * the way a senior reviewer does. `subjectiveAudit` makes ONE extra LLM call
 * that reads the produced artifact + the gold defect reference (if any) and
 * returns:
 *   {
 *     overallQuality: 0-5,       // holistic quality as a senior reviewer
 *     wouldShip:      0|1,       // would you let this ship
 *     overReport:     <int>,     // estimated count of findings judged unsupported/over-claimed
 *     goldenCoverage: 'complete'|'partial'|'missing',
 *     evidence:       '<one line tying the verdict to the artifact>',
 *     narrative:      '<one sentence>'
 *   }
 *
 * It is BLIND (the arm/compression label is never passed), so it is a clean
 * deliverable-quality judgment, never a compression verdict. The arm-level
 * difference is computed in the comparison/report layer — not here.
 *
 * Safety: a failure returns null (the run still scores; subjectivity is
 * reported as null/skipped). It never raises or blocks scoring.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { createGateway } from './gateway.mjs'
import { loadGoldenBugs } from './mech.mjs'
import { artifactFor } from './judge.mjs'

const defaultCallLLM = createGateway().chatCall

function goldenRef() {
  try {
    const g = loadGoldenBugs()
    const rows = (g.bugs ?? []).map(b => `- ${b.id} ${b.file.split('/').pop()}: ${String(b.location).slice(0, 40)} — ${b.title}`)
    if (g.observation) rows.push(`- ${g.observation.id} ${g.observation.file.split('/').pop()}: ${String(g.observation.location).slice(0, 40)} — ${g.observation.title}`)
    return rows.join('\n')
  } catch {
    return ''
  }
}

function basename(p) {
  return String(p ?? '').split(/[\\/]/).pop()
}

/** Compose the senior-reviewer prompt for one run artifact. */
export function buildSubjectivePrompt(task, artifact, runId) {
  const golden = goldenRef()
  return [
    'You are a SENIOR reviewer assessing a deliverable produced for a software engineering task. You are NOT grading against a fixed rubric — you judge the deliverable the way an experienced engineer would decide whether to accept it.',
    '',
    `TASK: ${task.id} — ${task.title}`,
    '',
    golden ? 'KNOWN DEFECTS (partial ground truth; may UNDER-cover real defects — evaluate each EXTRA finding on its own merits):\n' + golden + '\n' : '',
    '',
    'DELIVERABLE:\n' + artifact,
    '',
    'OUTPUT EXACTLY ONE RAW JSON OBJECT and nothing else — no reasoning, no markdown fences, no preamble:',
    '{ "overallQuality": <0-5>, "wouldShip": <0|1>, "overReport": <int count of findings you judge unsupported or over-claimed>, "realExtras": <int count of findings BEYOND the known gold set that you judge are genuine, code-supported defects>, "goldenCoverage": "complete"|"partial"|"missing", "evidence": "<one line tying the verdict to specific content>", "narrative": "<one sentence, in the task language>" }',
    'overallQuality anchors: 5 = ship-ready, precise, evidence-backed; 4 = good with minor gaps; 3 = acceptable but notable over-claim/omission; 2 = weak, several unsupported claims; 1 = largely unreliable; 0 = no usable output. overReport should only count findings you genuinely believe lack code support or are exaggerated — not findings merely absent from the gold set. realExtras should only count findings NOT in the gold set that you independently confirm are genuine defects (file/function/line + observable harm), rewarding thorough discovery; if there are none, put 0.',
  ].join('\n')
}

/** Brace-balanced JSON extraction: last parseable object (fences/thinking tolerated). */
export function extractJson(text) {
  const s = String(text ?? '').replace(/```(?:json)?\s*/gi, '').replace(/^thinking[^\n]*$/mi, '')
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
  for (const candidate of out.reverse()) {
    try {
      const o = JSON.parse(candidate)
      if (o && typeof o === 'object' && !Array.isArray(o)) return o
    } catch { /* keep scanning */ }
  }
  return null
}

/**
 * One subjective-audit call for a run.
 * @param {object} opts { task, runDir, workspace, provider, model, callLLM }
 * @returns {Promise<object|null>} subjectivity block, or null on any failure.
 */
export async function subjectiveAudit(opts) {
  const { task, runDir, workspace } = opts
  const callLLM = opts.callLLM ?? defaultCallLLM
  const artifact = artifactFor(task.id, workspace ?? '.')
  if (!artifact || artifact.trim().length === 0) return null
  const prompt = buildSubjectivePrompt(task, artifact, basename(runDir))
  // Generous budget + internal retries: thinking models (hy3/deepseek) reason
  // long, and the 4th sequential call after judge can hit a transient gateway
  // hiccup. Retry so a transient failure doesn't silently null the verdict.
  const maxTokens = 8000
  let out = null
  let lastErr = null
  // Cost discipline: the audit may retry up to 3 times — aggregate EVERY billed
  // call's usage (the returned block is the run's audit cost, not the last try).
  const usageAgg = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      out = await callLLM({ provider: opts.provider, model: opts.model, messages: [{ role: 'user', content: prompt }], maxTokens, timeoutMs: 600000 })
      if (out?.usage) {
        usageAgg.inputTokens += out.usage.inputTokens ?? 0
        usageAgg.outputTokens += out.usage.outputTokens ?? 0
        usageAgg.cacheReadTokens += out.usage.cacheReadTokens ?? 0
        usageAgg.calls += 1
      }
      const parsed = extractJson(out.text)
      if (parsed) {
        const clamp = (v, lo, hi) => Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : null
        return {
          overallQuality: clamp(parsed.overallQuality, 0, 5),
          wouldShip: clamp(parsed.wouldShip, 0, 1),
          overReport: clamp(parsed.overReport, 0, 999),
          realExtras: clamp(parsed.realExtras, 0, 999),
          goldenCoverage: ['complete', 'partial', 'missing'].includes(parsed.goldenCoverage) ? parsed.goldenCoverage : null,
          evidence: String(parsed.evidence ?? '').slice(0, 300),
          narrative: String(parsed.narrative ?? '').slice(0, 300),
          usage: usageAgg.calls > 0 ? usageAgg : null,
        }
      }
      lastErr = new Error('subjective JSON parse failed')
    } catch (e) {
      lastErr = e
      await sleep(1500)
    }
  }
  return null
}

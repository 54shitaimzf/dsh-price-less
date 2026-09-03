/**
 * Cost ledger — kept per run: EXECUTION / JUDGE / COMPRESSION / DECISION
 * accounted separately so E3 reports can decompose mechanism vs tier cost.
 * Pricing comes from the repo model-pricing table (a provider string containing
 * 'v4' selects the -peak tier row; the default is the offpeak/canonical row).
 * Derived (simulated) values are NEVER allowed to
 * enter conclusions: ledger.derivedAllowedInConclusion defaults false.
 */
import fs from 'node:fs'
import { PRICING_FILE } from './paths.mjs'

export const STAGES = ['execution', 'judge', 'compression', 'decision']

let _pricing = null
export function loadPricing(force = false) {
  if (!_pricing || force) {
    if (!fs.existsSync(PRICING_FILE)) throw new Error(`pricing table missing: ${PRICING_FILE}`)
    _pricing = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8'))
  }
  return _pricing
}

/** Resolve a model id (+ optional route) to a price row; v4 route uses peak tier. */
export function priceOf(modelId, provider = '') {
  const pricing = loadPricing()
  const rows = pricing.models.filter(m => m.id.includes(modelId))
  if (rows.length === 0) return null
  if (String(provider).includes('v4')) return rows.find(r => r.id.includes('-peak')) ?? rows[0]
  return rows[0]
}

export function emptyStage() {
  return { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0, usd: null }
}

/** Fresh three(+one)-ledger accumulator. */
export function createLedger(opts = {}) {
  const stages = {}
  for (const s of STAGES) stages[s] = emptyStage()
  stages.execution.derived = []
  const state = {
    derivedAllowedInConclusion: opts.derivedAllowedInConclusion === true, // must stay false for conclusions
    ...opts,
  }

  function record(stage, usage, priceRow = null) {
    if (!stages[stage]) throw new Error(`unknown ledger stage: ${stage}`)
    const u = usage ?? {}
    const s = stages[stage]
    s.inputTokens += u.inputTokens ?? 0
    s.cacheReadTokens += u.cacheReadTokens ?? 0
    s.outputTokens += u.outputTokens ?? 0
    s.calls += 1
    if (priceRow) {
      const fresh = Math.max(0, (u.inputTokens ?? 0) - (u.cacheReadTokens ?? 0))
      const usd = ((fresh * priceRow.inputPerM + (u.cacheReadTokens ?? 0) * priceRow.cacheReadPerM
        + (u.outputTokens ?? 0) * priceRow.outputPerM) / 1e6)
      s.usd = Number(((s.usd ?? 0) + usd).toFixed(8))
    }
    return stages[stage]
  }

  /** Hard deny: derived numbers can be VIEWED in reports but never summarized as cost. */
  function forbidDerivedInConclusions() {
    return { ok: !state.derivedAllowedInConclusion, message: state.derivedAllowedInConclusion ? 'derived values would pollute conclusions' : 'clean' }
  }

  function totals() {
    const out = {}
    for (const s of STAGES) {
      const st = stages[s]
      out[s] = { inputTokens: st.inputTokens, cacheReadTokens: st.cacheReadTokens, outputTokens: st.outputTokens, calls: st.calls, usd: st.usd }
    }
    return out
  }

  function report() {
    const t = totals()
    const usdTotal = STAGES.reduce((a, s) => a + (t[s].usd ?? 0), 0)
    const tokensTotal = STAGES.reduce((a, s) => a + t[s].inputTokens + t[s].outputTokens, 0)
    return { stages: t, usdTotal: Number(usdTotal.toFixed(8)), tokensTotal, forbid: forbidDerivedInConclusions() }
  }

  return { record, totals, report, forbidDerivedInConclusions, stages, state }
}
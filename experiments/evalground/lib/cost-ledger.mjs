/**
 * Cost ledger — the SHARED assembly of the four-ledger cost block
 * (execution / judge / compression / decision) used by BOTH entry points
 * (run-one single-task and run-cascade whole-stream).
 *
 * Extracted 2026-09 from the two hand-written copies that had drifted (the
 * cascade copy omitted the judge ledger — see run-cascade.mjs). This module
 * is a PURE MOVE of the arithmetic: identical formulas, identical rounding,
 * identical null-conditions. Any behavioral change to a ledger must be made
 * deliberately (and asserted), never by editing one copy only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { priceOf } from './cost.mjs'
import { costUsd } from './gateway.mjs'
import { readAll } from './transcript.mjs'

/** Serialize a logger argument for run.log: strings verbatim, objects as JSON. */
export function safeLogJson(m) {
  try { return typeof m === 'string' ? m : JSON.stringify(m) } catch { return String(m) }
}

/** The per-run file logger both entry points install (appends to run.log). */
export function makeRunLogger(runDir) {
  return (m) => fs.appendFileSync(path.join(runDir, 'run.log'),
    `${new Date().toISOString()} ${typeof m === 'string' ? m : safeLogJson(m)}\n`)
}

/** Execution USD from a runner usage block + executor price row (null when unpriced).
 * FULL precision — callers apply their own rounding (ledger: 8 digits, sc.cost: 6). */
export function execUsdOf(usage, priceRow) {
  if (!priceRow) return null
  return ((Math.max(0, usage.inputTokens - (usage.cacheReadTokens ?? 0)) * priceRow.inputPerM
    + (usage.cacheReadTokens ?? 0) * priceRow.cacheReadPerM
    + usage.outputTokens * priceRow.outputPerM) / 1e6)
}

/** Execution ledger block { usd, tokens } (usd null when the model is unpriced). */
export function executionCostOf(usage, priceRow) {
  const usd = execUsdOf(usage, priceRow)
  return { usd: usd === null ? null : Number(usd.toFixed(8)), tokens: usage.inputTokens + usage.outputTokens }
}

/** Judge ledger block { usd, tokens } (null when no judge usage or unpriced). */
export function judgeCostOf(judgeUsage, judgePrice) {
  if (!judgePrice || !judgeUsage) return null
  const usd = costUsd(judgeUsage, judgePrice)
  return { usd: Number(usd.toFixed(8)), tokens: (judgeUsage.inputTokens ?? 0) + (judgeUsage.outputTokens ?? 0) }
}

/** Sum the usage of every `compress` entry in a transcript file. */
export function collectCompressUsage(transcriptPath) {
  const comp = readAll(transcriptPath).filter(e => e.type === 'compress')
  return {
    inputTokens: comp.reduce((a, e) => a + (e.inputTokens ?? 0), 0),
    outputTokens: comp.reduce((a, e) => a + (e.outputTokens ?? 0), 0),
    cacheReadTokens: comp.reduce((a, e) => a + (e.cacheReadTokens ?? 0), 0),
  }
}

/** Compression ledger block (null unless the arm's ledger accounts compression,
 * the model is priced, and at least one compression actually ran). */
export function compressionCostOf(compUsage, armLedgerCompression, priceRow) {
  return armLedgerCompression === true && priceRow && compUsage.inputTokens > 0
    ? {
        usd: Number(costUsd(compUsage, priceRow).toFixed(8)),
        tokens: compUsage.inputTokens + compUsage.outputTokens,
        source: 'real',
      }
    : null
}

/** The decision-ledger cost of a boundary mark (the REAL task-partition cost of
 * the discriminator calls; null when no mark / no cost). */
export function decisionCostOf(boundaryMark) {
  if (!boundaryMark?.cost) return null
  return {
    source: boundaryMark.source ?? 'premark',
    model: boundaryMark.cost.model,
    provider: boundaryMark.cost.provider,
    usage: boundaryMark.cost.usage,
    usd: boundaryMark.cost.usd == null ? null : Number(boundaryMark.cost.usd.toFixed(8)),
    tokens: (boundaryMark.cost.usage?.inputTokens ?? 0) + (boundaryMark.cost.usage?.outputTokens ?? 0),
    real: true,
  }
}

/** Re-exported for callers that need price rows alongside the ledger helpers. */
export { priceOf }

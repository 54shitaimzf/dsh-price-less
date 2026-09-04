/**
 * Arm spec resolver — the declarative arm table (A5). Every experimental run
 * is driven by one declared arm; adding an arm = one row in arms.config.json.
 * The resolver is the ONLY consumer of the config and validates every row at
 * load time. Unknown arm ids throw (never silently fall back).
 */
import { loadArmsConfig, validateArmRow, KNOWN_STAGES } from './config.mjs'
import { calibrate, COMPRESSION_DOMAIN_DEFAULT } from './calibrate.mjs'

let _cache = null

function resolve() {
  if (_cache) return _cache
  const cfg = loadArmsConfig()
  const armTable = cfg.arms ?? {}
  const problems = []
  for (const [id, row] of Object.entries(armTable)) {
    for (const p of validateArmRow({ id, ...row })) problems.push(`${id}: ${p}`)
  }
  if (problems.length > 0) throw new Error(`arms.config.json invalid:\n  ${problems.join('\n  ')}`)
  _cache = { cfg, armTable }
  return _cache
}

/** Get one arm spec; throws on unknown/misconfigured arm. */
export function getArm(id, opts = {}) {
  const { armTable } = resolve()
  const row = armTable[id]
  if (!row) throw new Error(`unknown arm: ${id}`)
  return { id, ...row }
}

/** All declared arm ids, sorted (stable output for matrices). */
export function listArms() {
  return Object.keys(resolve().armTable).sort()
}

/** Global trigger constants shared by every compression-capable arm. */
export function triggerConfig() {
  const { cfg } = resolve()
  return cfg.trigger ?? { tokenThreshold: 8000 }
}

/** Global context-window guard constants (E3 hard truncate safety valve).
 * contextWindow = 100% window in tokens; truncatePct = the floor (e.g. 0.8)
 * at which the runner hard-truncates the accumulated context instead of
 * letting a request overflow the model window. These are DETERMINISTIC guard
 * numbers (not derived estimates) and never enter cost conclusions.
 */
export function contextConfig() {
  const { cfg } = resolve()
  return {
    contextWindow: cfg.contextWindow ?? 256000,
    truncatePct: cfg.truncatePct ?? 0.8,
  }
}

export { KNOWN_STAGES }

/** Compression-domain window (tokens) from the config; default = task-scale.
 * This is a SEPARATE quantity from the model context window — it is the
 * compression domain calibration, set ≈ task peak (~50K), NOT the bare window. */
export function compressionDomain() {
  const { cfg } = resolve()
  const v = Number(cfg.compressionDomain ?? COMPRESSION_DOMAIN_DEFAULT)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : COMPRESSION_DOMAIN_DEFAULT
}

/** Calibrated retain/threshold for the compression domain (task-scale).
 * Absolute `retainTokens`/`thresholdTokens` overrides in arms.config.json win
 * when present (the design intent is ABSOLUTE real-token sizes — DSH 本体保留
 * 8K 量级, not a ratio of an arbitrarily chosen domain); the ratio derivation
 * from `compressionDomain` is the fallback. */
export function calibrateThresholds(peakTokens) {
  const { cfg } = resolve()
  const abs = cfg.retainTokens ?? cfg.thresholdTokens
  if (abs !== undefined) {
    const retain = Math.floor(Number(cfg.retainTokens))
    const threshold = Math.floor(Number(cfg.thresholdTokens))
    if (!Number.isFinite(retain) || !Number.isFinite(threshold) || retain <= 0 || threshold <= 0) {
      throw new Error(`arms.config.json absolute retainTokens/thresholdTokens must be positive numbers (got ${cfg.retainTokens}/${cfg.thresholdTokens})`)
    }
    if (retain >= threshold) {
      throw new Error(`compression-domain invariant violated: retain(${retain}) must be < threshold(${threshold})`)
    }
    const domain = peakTokens ?? cfg.compressionDomain ?? COMPRESSION_DOMAIN_DEFAULT
    return { domain: Math.floor(Number(domain)), retainTokens: retain, thresholdTokens: threshold, retainRatio: retain / threshold, thresholdRatio: 1 }
  }
  return calibrate(peakTokens ?? compressionDomain())
}

/** PTC-compressor gates/budgets from the config (`compressor` block).
 * Ratio gate: effective ≤ ratioEffective, fail-lazy > ratioHardFail, small
 * region (< minRegionTokens) skips the ratio gate. Retention (S1 引用化保尾):
 * refs ≤ maxRetainRefs, outline ≤ outlineTokenBudget. Code run budgets: wall +
 * output bytes (see lib/code-run.mjs). */
export function compressorConfig() {
  const { cfg } = resolve()
  const c = cfg.compressor ?? {}
  return {
    ratioCfg: {
      effective: Number(c.ratioEffective ?? 0.5),
      hardFail: Number(c.ratioHardFail ?? 0.75),
      minRegionTokens: Number(c.minRegionTokens ?? 3000),
    },
    retentionCfg: {
      maxRefs: Number(c.maxRetainRefs ?? 8),
      outlineTokenBudget: Number(c.outlineTokenBudget ?? 40),
    },
    codeRunCfg: {
      maxWallMs: Number(c.codeRun?.maxWallMs ?? 30000),
      maxOutputBytes: Number(c.codeRun?.maxOutputBytes ?? 262144),
    },
  }
}
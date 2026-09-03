/**
 * Compression-domain calibration — the compression window is a TASK-SCALE
 * quantity, NOT the bare model window. DSH-native retainRatio/thresholdRatio
 * are relative to the window; if the window were 256K the retain budget would
 * swallow the whole task and the trigger gate would never pass. So the window
 * is set ≈ task peak context (~50K) and the ratios are applied to it.
 *
 * These are pure functions with no IO — the calibration arithmetic is asserted
 * offline and independently of the hard-truncate safety valve
 * (contextWindow × truncatePct in runner.mjs is a SEPARATE guard).
 */

export const COMPRESSION_DOMAIN_DEFAULT = 50000 // task-scale window (~peak context)
export const RETAIN_RATIO = 0.16 // DSH native DEFAULT_RETAIN_RATIO
export const THRESHOLD_RATIO = 0.8 // DSH native DEFAULT_THRESHOLD_RATIO

/**
 * Compression-domain window in tokens. peakTokens is the measured peak context
 * of an uncompressed run (task scale); when absent, the default is used.
 * @param {number|null|undefined} peakTokens
 * @returns {number} domain window in tokens
 */
export function domainTokens(peakTokens) {
  const p = Number(peakTokens)
  if (!Number.isFinite(p) || p <= 0) return COMPRESSION_DOMAIN_DEFAULT
  return Math.floor(p)
}

/** Retain budget: the recent tail kept verbatim (hot zone boundary). */
export function retainTokens(domain) {
  return Math.floor(domain * RETAIN_RATIO)
}

/** Trigger threshold: once accumulated context reaches this, compress. */
export function thresholdTokens(domain) {
  return Math.floor(domain * THRESHOLD_RATIO)
}

/**
 * Calibrate the compression domain from a measured peak (or default).
 * @param {number|null|undefined} peakTokens
 * @returns {{domain, retainTokens, thresholdTokens, retainRatio, thresholdRatio}}
 * @throws if retain >= threshold (config invariant, mirrors DSH validate).
 */
export function calibrate(peakTokens) {
  const domain = domainTokens(peakTokens)
  const retain = retainTokens(domain)
  const threshold = thresholdTokens(domain)
  if (retain >= threshold) {
    throw new Error(`compression-domain invariant violated: retain(${retain}) must be < threshold(${threshold})`)
  }
  return { domain, retainTokens: retain, thresholdTokens: threshold, retainRatio: RETAIN_RATIO, thresholdRatio: THRESHOLD_RATIO }
}

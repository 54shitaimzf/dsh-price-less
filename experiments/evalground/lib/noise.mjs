/**
 * X-B — deterministic, versioned noise generator (cognitive-load / attention
 * dilution arm). Same seed → same bytes (byte-stable). Noise is semantically
 * irrelevant but distribution-similar (unrelated code comments / rule text).
 */
import { createHash } from 'node:crypto'

const CHUNKS = [
  // distribution-similar but semantically irrelevant filler (comments/rules)
  '// NB: this block is unrelated context noise for stress-testing.',
  '[rule-note] dependency E is pinned; unrelated to audit scope.',
  '# legacy config (unused path): retries=3, timeout=30s',
  '/* TODO from sprint 9 — orthogonal to current work */',
  'Sample log line: level=info msg="warmed cache" store=legacy',
  '[note] team convention: LF endings only; unrelated.',
  '// do not confuse with R8 — this is filler text.',
  'Config candidate x: 0.5; y: false; z: null.',
]

/** Deterministic pseudo-noise of `chars` length (multiples of chunk). */
export function generateNoise(seedKey, chars) {
  const h = createHash('sha256').update(String(seedKey)).digest('hex')
  let out = ''
  let i = 0
  while (out.length < chars) {
    const idx = parseInt(h.slice(i * 2, i * 2 + 2), 16) % CHUNKS.length
    out += CHUNKS[idx] + '\n'
    i++
    if (i * 2 >= h.length - 2) i = 0 // recycle the digest deterministically
  }
  return out.slice(0, chars)
}

/** Noise length from the target ratio (0..n) relative to a base product size. */
export function noiseChars(baseChars, ratio) {
  return Math.floor(baseChars * Math.max(0, ratio))
}
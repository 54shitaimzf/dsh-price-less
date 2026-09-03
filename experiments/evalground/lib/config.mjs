/**
 * Config loader — single reader + validator for scores.config.json and
 * arms.config.json (declarative arm table, see A5). Every consumer imports
 * these; nobody parses the JSON files themselves.
 */
import fs from 'node:fs'
import { EVAL_ROOT, SCORES_CONFIG, ARM_CONFIG } from './paths.mjs'

let _scores = null
let _arms = null

function readJson(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} missing: ${file}`)
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new Error(`${label} invalid JSON: ${e.message}`) }
}

/** scores.config.json: weights, penalties, tracks of models, human band map (deprecated). */
export function loadScoresConfig(force = false) {
  if (!_scores || force) _scores = readJson(SCORES_CONFIG, 'scores config')
  return _scores
}

/** arms.config.json: one row per arm (A5). Loaded lazily; {} when absent. */
export function loadArmsConfig(force = false) {
  if (!_arms || force) _arms = fs.existsSync(ARM_CONFIG) ? readJson(ARM_CONFIG, 'arms config') : {}
  return _arms
}

const KNOWN_STAGES = ['execution', 'judge', 'compression', 'decision']
// boolean toggles allowed inside a ledger block
const KNOWN_LEDGER_FLAGS = ['cacheReadHonored']

// Compression modes the runner understands. `native-auto` and `manual-habit` are
// the two DSH-native / human-habit CONTROLS; a "comparison" arm may be
// `semantic`/`industry`/`mock`/`manual`/`task-boundary` (plugin product) or
// `native-auto`/`manual-habit` (native product). Any other value is a misconfig.
const KNOWN_COMPRESSION = ['none', 'truncate', 'semantic', 'industry', 'mock', 'manual', 'task-boundary', 'native-auto', 'manual-habit']
// A2 处理方式: 方案0 保留原始 (keep-original) vs 方案1 具体内容展开 (expand/信息块).
const KNOWN_A2 = ['keep-original', 'expand']
// A1 范围 (叠加在 task 边界压缩之上): s1 近因门·保尾压头 (retain=校准值, 保留近因尾逐字)
// vs s2 闭合即全压 (retain=0, 每闭合 task 全压).
const KNOWN_A1 = ['s1', 's2']

/** Product-structure binding: which compressor instruction an arm may use.
 *  native-auto / manual-habit   → 'native'   (DSH 8段 <compacted-summary>)
 *  task-boundary / semantic/…   → 'plugin'   (goal/steps/fileStream/compressed or blocks)
 *  none / truncate / manual     → null       (no LLM compressor → no product shape)
 * This is the guard against using a PLUGIN product as the NATIVE control (and
 * vice-versa) — a misconfig that would make the "control" compare the wrong thing. */
export function productShapeOf(compression) {
  if (compression === 'native-auto' || compression === 'manual-habit') return 'native'
  if (['task-boundary', 'semantic', 'industry', 'mock'].includes(compression)) return 'plugin'
  return null
}

/**
 * Validate an arm row. Returns problems array (empty = valid).
 * Expected shape: { id, assembly, compression, trigger, ledger }.
 * ledger stages account token buckets; boolean flags toggle accounting rules.
 */
export function validateArmRow(row) {
  const p = []
  if (!row || typeof row.id !== 'string' || row.id.length === 0) p.push('arm needs an id')
  if (row.compression !== undefined && !KNOWN_COMPRESSION.includes(row.compression)) {
    p.push(`unknown compression "${row.compression}" (known: ${KNOWN_COMPRESSION.join(', ')})`)
  }
  if (row.a2 !== undefined && !KNOWN_A2.includes(row.a2)) {
    p.push(`unknown a2 "${row.a2}" (known: ${KNOWN_A2.join(', ')})`)
  }
  if (row.a1 !== undefined && !KNOWN_A1.includes(row.a1)) {
    p.push(`unknown a1 "${row.a1}" (known: ${KNOWN_A1.join(', ')})`)
  }
  if (row.ledger) {
    for (const k of Object.keys(row.ledger)) {
      const v = row.ledger[k]
      if (KNOWN_STAGES.includes(k) || (KNOWN_LEDGER_FLAGS.includes(k) && typeof v === 'boolean')) continue
      p.push(`unknown ledger key ${k}`)
    }
    if (row.ledger.derivedAllowedInConclusion === true) p.push('derived accounting must never enter conclusions')
  }
  return p
}

export { KNOWN_STAGES, KNOWN_COMPRESSION, KNOWN_A1, KNOWN_A2 }
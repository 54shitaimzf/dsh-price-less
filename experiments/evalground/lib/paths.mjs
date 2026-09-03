/**
 * Single source of truth for every filesystem location in the eval ground.
 * All other modules import these constants — never re-derive ROOT themselves.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const EVAL_ROOT = path.resolve(HERE, '..')
export const FIXTURE_DIR = path.join(EVAL_ROOT, 'fixtures', 'relaudit')
export const RUNS_DIR = path.join(EVAL_ROOT, 'runs')
export const TASKS_DIR = path.join(EVAL_ROOT, 'tasks')
export const BOUNDARIES_DIR = path.join(EVAL_ROOT, 'boundaries')
export const ANSWERS_DIR = path.join(EVAL_ROOT, 'answers')
export const SCRATCH_DIR = path.join(EVAL_ROOT, '.scratch')
export const TESTS_DIR = path.join(EVAL_ROOT, 'tests')
export const GOLDEN_DIR = path.join(TESTS_DIR, 'golden')
export const ARM_CONFIG = path.join(EVAL_ROOT, 'arms.config.json')
export const SCORES_CONFIG = path.join(EVAL_ROOT, 'scores.config.json')
export const PRICING_FILE = path.resolve(EVAL_ROOT, '..', '..', 'datasets', 'model-pricing.json')
export const MANUAL_DIR = path.join(ANSWERS_DIR, 'manual')

/** Every run's scratch area — all transient tooling files live under here. */
export function runScratch(runDir) {
  return path.join(runDir, '.tmp')
}
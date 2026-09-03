/**
 * Shared per-task permission tables: allowed write scope (ALLOW) + scope
 * matcher. Used by both mech.mjs (post-hoc diff checks) and tools.mjs
 * (upfront write denials) so the two can never drift.
 */
export const ALLOW = {
  'T0': [],
  'T1': ['REVIEW.md'],
  'T2': ['docs/api.md', 'docs/rules.md'],
  'T3': ['public/', 'src/render-panel.js'],
  'T4': ['src/audit/'],
  'T5': ['release-notes-v1.3.0.md'],
  'T6': ['docs/quickstart.md'],
  'T7': ['REVIEW.md', 'src/audit/', 'public/', 'src/render-panel.js', 'docs/rules.md', 'docs/api.md'],
}

export function inScope(rel, scope) {
  return scope.some(s => rel === s || rel.startsWith(s.endsWith('/') ? s : s + '/'))
}
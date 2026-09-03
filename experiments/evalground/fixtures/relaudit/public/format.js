// Public: pure formatting helpers for the report panel.
// NOTE(planted bug): countTotal concatenates strings before adding, so
// 2 errors + 1 warn + 4 info renders as 25 instead of 7.
export function formatCounts(counts) {
  return `错误 ${counts.errors} · 警告 ${counts.warns} · 提示 ${counts.infos}`
}

export function countTotal(counts) {
  // PLANTED BUG: numeric-ish string concatenation for the first two terms.
  return Number(String(counts.errors) + String(counts.warns)) + counts.infos
}

export function severityLabel(severity) {
  return { error: '错误', warn: '警告', info: '提示' }[severity] ?? severity
}

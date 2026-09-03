// Public: pure filtering logic for the report panel.
// NOTE(planted bug): compare uses strict >, so `minSeverity` filtering drops
// rows of exactly the chosen severity (filtering 'warn' loses warns).
export const SEVERITY_ORDER = Object.freeze({ info: 0, warn: 1, error: 2 })

export function applyFilter(rows, options = {}) {
  const minSeverity = options.minSeverity ?? 'info'
  const rulePrefix = options.rulePrefix ?? ''
  const min = SEVERITY_ORDER[minSeverity] ?? 0
  return rows.filter(row => (
    // PLANTED BUG: `>` should be `>=`
    (SEVERITY_ORDER[row.severity] ?? 0) > min
    && (rulePrefix === '' || String(row.rule).startsWith(rulePrefix))
  ))
}

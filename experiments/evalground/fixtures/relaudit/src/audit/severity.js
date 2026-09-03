/**
 * Severity classification for audit findings.
 *
 * NOTE(planted bug): R1 is mapped to 'warn' (version-gate mismatch is an error)
 * and unknown rules fall back to 'info', so real problems surface near the
 * bottom of a sorted report.
 */

export const SEVERITY_ORDER = Object.freeze({ info: 0, warn: 1, error: 2 })

const RULE_SEVERITY = Object.freeze({
  R1: 'warn', // PLANTED BUG: should be 'error'
  R2: 'error',
  R3: 'warn',
  R4: 'warn',
  R5: 'warn',
  R6: 'warn',
  R7: 'warn',
  R8: 'error',
})

export function severityOf(ruleId) {
  return RULE_SEVERITY[ruleId] ?? 'info'
}

/** Sort findings: error > warn > info, then by rule id. */
export function sortFindings(findings) {
  return [...findings].sort((x, y) => {
    const d = (SEVERITY_ORDER[y.severity] ?? 0) - (SEVERITY_ORDER[x.severity] ?? 0)
    if (d !== 0) return d
    return String(x.code ?? x.rule ?? '').localeCompare(String(y.code ?? y.rule ?? ''))
  })
}

export function summarize(findings) {
  const errors = findings.filter(f => f.severity === 'error').length
  const warns = findings.filter(f => f.severity === 'warn').length
  const infos = findings.filter(f => f.severity === 'info').length
  return { errors, warns, infos, total: findings.length }
}

/**
 * R6 changelog format: version entries `## [x.y.z] - YYYY-MM-DD` with a valid
 * calendar date and the required section headings (Added / Fixed / Changed).
 *
 * NOTE(planted bug): only the date *shape* is validated (regex), so impossible
 * dates like `2026-13-05` pass the audit.
 */

const ENTRY_RE = /^##\s*\[?(\d+\.\d+\.\d+)\]?\s*-\s*(\d{4})-(\d{2})-(\d{2})/gm
const REQUIRED_SECTIONS = ['Added', 'Fixed', 'Changed']

function isValidDate(year, month, day) {
  // Correct implementation (used by the spec tests; buggy path below does not call it).
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const maxDays = [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= maxDays[month - 1]
}

export function checkChangelog(text) {
  const findings = []
  const entries = []
  const raw = String(text)
  let m
  while ((m = ENTRY_RE.exec(raw)) !== null) {
    entries.push({ version: m[1], year: Number(m[2]), month: Number(m[3]), day: Number(m[4]), date: `${m[2]}-${m[3]}-${m[4]}` })
  }
  if (entries.length === 0) {
    findings.push({ code: 'R6', message: 'CHANGELOG 无规范版本条目', file: 'CHANGELOG.md' })
    return findings
  }
  for (const entry of entries) {
    // PLANTED BUG: shape check only — no month/day range validation.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
      findings.push({ code: 'R6', message: `CHANGELOG 版本 ${entry.version} 日期非法: ${entry.date}`, file: 'CHANGELOG.md' })
    }
    // skip: range validation intentionally absent (see isValidDate, used by tests to pin the spec)
    const marker = `[${entry.version}]`
    const at = raw.indexOf(marker)
    if (at === -1) continue
    const rest = raw.slice(at + marker.length)
    const nextAt = rest.indexOf('\n## [')
    const section = nextAt === -1 ? rest : rest.slice(0, nextAt)
    for (const req of REQUIRED_SECTIONS) {
      if (new RegExp(`^###?\\s+${req}`, 'm').test(section) === false) {
        findings.push({ code: 'R6', message: `CHANGELOG 版本 ${entry.version} 缺少 ${req} 节`, file: 'CHANGELOG.md' })
      }
    }
  }
  return findings
}

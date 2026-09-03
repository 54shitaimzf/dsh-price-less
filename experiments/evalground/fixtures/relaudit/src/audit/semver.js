/**
 * R1 semver gate: package.json.version vs CHANGELOG head vs released versions.
 *
 * NOTE(planted bug): compareVersions compares strings lexicographically, so
 * "1.10.0" < "1.9.0" is judged incorrectly and version gates can silently pass.
 */

/** Parse "1.2.3" into numeric segments; non-numeric segments compare as strings. */
export function parseVersion(version) {
  const m = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (m === null) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null }
}

/** Compare two semver strings. Returns 1 / 0 / -1. */
export function compareVersions(a, b) {
  // PLANTED BUG: lexicographic string comparison.
  if (String(a) > String(b)) return 1
  if (String(a) < String(b)) return -1
  return 0
}

export function isVersionGreater(a, b) {
  return compareVersions(a, b) > 0
}

/** Extract the latest released version from CHANGELOG text ("## [1.3.0] - date"). */
export function changelogHead(text) {
  const m = String(text).match(/^##\s*\[?([0-9]+\.[0-9]+\.[0-9]+)\]?/m)
  return m ? m[1] : null
}

/** Extract the latest released version from versions.json releases list. */
export function releasedHead(releases) {
  if (!Array.isArray(releases) || releases.length === 0) return null
  return String(releases[releases.length - 1])
}

/**
 * R1 finding set: pkg.version must equal changelog head and be greater than
 * the latest released version.
 */
export function checkSemver(pkg, changelogText, releases) {
  const findings = []
  const head = changelogHead(changelogText)
  const released = releasedHead(releases)
  if (head === null) {
    findings.push({ code: 'R1', message: 'CHANGELOG 无可解析的版本条目' })
  } else if (head !== pkg.version) {
    findings.push({ code: 'R1', message: `CHANGELOG 头版本 ${head} ≠ package.json 版本 ${pkg.version}` })
  }
  if (released !== null && !isVersionGreater(pkg.version, released)) {
    findings.push({ code: 'R1', message: `package.json 版本 ${pkg.version} 未大于最近发布 ${released}` })
  }
  return findings
}

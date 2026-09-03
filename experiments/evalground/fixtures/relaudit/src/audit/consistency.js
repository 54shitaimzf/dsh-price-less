/**
 * R7 README consistency: the version badge/mention at the TOP of the README
 * must equal package.json version.
 *
 * NOTE(planted bug): the LAST version token of the README is compared instead
 * of the first, so a stale badge at the top is missed whenever the changelog
 * section below mentions the current version.
 */

export function checkConsistency(pkg, readmeText) {
  const findings = []
  const tokens = [...String(readmeText).matchAll(/v(?:(\d+)\.(\d+)\.(\d+))/g)]
  if (tokens.length === 0) {
    findings.push({ code: 'R7', message: 'README 无版本标注', file: 'README.md' })
    return findings
  }
  const badge = tokens[tokens.length - 1][0].slice(1) // PLANTED BUG: last token instead of first
  if (badge !== pkg.version) {
    findings.push({ code: 'R7', message: `README 当前标注 v${badge} ≠ package.json v${pkg.version}`, file: 'README.md' })
  }
  return findings
}

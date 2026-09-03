/**
 * R3 lib completeness: the `main` entry of the package must exist, be
 * non-empty, and stay inside the package directory.
 *
 * NOTE(planted bug): the containment check is skipped, so a `main` pointing
 * outside the package (e.g. "../../evil.js") passes the audit.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Checks main entry. findings: { code:'R3', message, file }[] */
export function checkLib(pkgDir, pkg) {
  const findings = []
  if (typeof pkg.main !== 'string' || pkg.main.length === 0) {
    findings.push({ code: 'R3', message: 'package.json 缺少 main 字段', file: 'package.json' })
    return findings
  }
  const resolved = path.resolve(pkgDir, pkg.main)
  // PLANTED BUG: containment check `!resolved.startsWith(path.resolve(pkgDir))` is missing.
  if (!fs.existsSync(resolved)) {
    findings.push({ code: 'R3', message: `main 文件不存在: ${pkg.main}`, file: pkg.main })
    return findings
  }
  const stat = fs.statSync(resolved)
  if (stat.size === 0) {
    findings.push({ code: 'R3', message: `main 文件为空: ${pkg.main}`, file: pkg.main })
  }
  return findings
}

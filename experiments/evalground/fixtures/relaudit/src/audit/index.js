/**
 * Audit assembler: runs R1–R7 over a package directory, decorates findings
 * with rule code + severity, and summarizes by severity.
 * (R8 产物文件一致性 is a development target — see docs/rules.md.)
 */

import fs from 'node:fs'
import path from 'node:path'
import { checkSemver } from './semver.js'
import { listTarballEntries } from './tarball.js'
import { checkLib } from './files.js'
import { checkBuildScript } from './sandbox.js'
import { checkDeps } from './deps.js'
import { checkChangelog } from './changelog.js'
import { checkConsistency } from './consistency.js'
import { severityOf, sortFindings, summarize } from './severity.js'

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Run the full audit over one package directory.
 * @param {string} pkgDir absolute path to the package (its package.json sits there).
 * @param {object} [opts] { versionsPath, tarballPath }
 */
export function runAudit(pkgDir, opts = {}) {
  const versionsFile = opts.versionsPath ?? path.join(pkgDir, '..', 'data', 'versions.json')
  const tarballFile = opts.tarballPath ?? path.join(pkgDir, 'dist', 'relaudit-plugin-1.3.0.tgz')

  const pkg = readJson(path.join(pkgDir, 'package.json'))
  const changelogText = fs.existsSync(path.join(pkgDir, 'CHANGELOG.md'))
    ? fs.readFileSync(path.join(pkgDir, 'CHANGELOG.md'), 'utf8')
    : ''
  const readmeText = fs.existsSync(path.join(pkgDir, 'README.md'))
    ? fs.readFileSync(path.join(pkgDir, 'README.md'), 'utf8')
    : ''
  const buildScript = fs.existsSync(path.join(pkgDir, 'scripts', 'build.sh'))
    ? fs.readFileSync(path.join(pkgDir, 'scripts', 'build.sh'), 'utf8')
    : ''
  const nodesFile = path.join(pkgDir, 'node-modules.json')
  const nodes = fs.existsSync(nodesFile) ? readJson(nodesFile) : []
  const versions = fs.existsSync(versionsFile) ? readJson(versionsFile) : { releases: [] }
  const tarballEntries = fs.existsSync(tarballFile)
    ? listTarballEntries(fs.readFileSync(tarballFile))
    : []

  const raw = [
    ...checkSemver(pkg, changelogText, versions.releases ?? []),
    ...checkTarball(tarballEntries),
    ...checkLib(pkgDir, pkg),
    ...checkBuildScript(buildScript),
    ...checkDeps(pkg, nodes),
    ...checkChangelog(changelogText),
    ...checkConsistency(pkg, readmeText),
  ]

  const findings = sortFindings(raw.map(f => ({ ...f, rule: f.code }))) // severity added below
  const decorated = findings.map(f => ({ rule: f.rule, severity: severityOf(f.rule), message: f.message, file: f.file }))
  return {
    pkg: pkg.name,
    version: pkg.version,
    auditedAt: new Date().toISOString(),
    findings: decorated,
    summary: summarize(decorated),
  }
}

function checkTarball(entries) {
  const findings = []
  if (entries.length === 0) {
    findings.push({ code: 'R2', message: '产物 tarball 为空或不可解析', file: 'dist/' })
    return findings
  }
  for (const entry of entries) {
    // PLANTED BUG surface for R2: entries whose name lost its prefix can never
    // be matched by isDeclared, so undeclared deep paths are reported as empty
    // dirs — see tarball.js. The R2 finding below therefore fires only for
    // obvious corruption; long-name truncation is the hidden defect.
    if (entry.size === 0 && !entry.name.endsWith('/')) {
      findings.push({ code: 'R2', message: `产物条目异常: ${entry.name}`, file: entry.name })
    }
  }
  return findings
}

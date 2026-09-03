/**
 * R5 dependency audit: every runtime dependency (incl. `link:` pairs) must be
 * installed in the node_modules manifest; dev-only deps must not be reported
 * as missing.
 *
 * NOTE(planted bug): devDependencies are merged into the runtime set, so any
 * dev-only package absent from the built artifact is reported as a false
 * runtime-missing finding.
 */

/** nodes = installed names (from node-modules.json manifest). */
export function checkDeps(pkg, nodes) {
  const findings = []
  const installed = new Set(Array.isArray(nodes) ? nodes : [])
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } // PLANTED BUG: devDeps included
  for (const [name, spec] of Object.entries(declared)) {
    const linked = String(spec).startsWith('link:')
    if (!installed.has(name)) {
      findings.push({
        code: 'R5',
        message: `依赖 ${name}${linked ? '（link 依赖）' : ''} 未在 node_modules 清单中`,
        file: 'package.json',
      })
    }
  }
  return findings
}

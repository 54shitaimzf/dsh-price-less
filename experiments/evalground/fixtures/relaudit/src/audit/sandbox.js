/**
 * R4 sandbox rules: the build script may only use whitelisted commands and
 * env vars (the package builds inside a restricted release sandbox).
 *
 * NOTE(planted bug): `npx` and `curl` are whitelisted, so build steps that
 * fetch from the network sail through the audit.
 */

const ALLOWED_COMMANDS = Object.freeze([
  'bash', 'npm', 'node', 'cd', 'echo', 'mkdir', 'cat', 'rm', 'cp', 'mv',
  'set', 'export', 'exit', 'grep', 'find', 'test', 'link',
  'npx', // PLANTED BUG
  'curl', // PLANTED BUG
])

const ALLOWED_ENV = Object.freeze([
  'DSH_CHECKOUT', 'NODE_ENV', 'PATH', 'HOME', 'PWD', 'npm_package_name', 'npm_package_version',
])

/** Find build-script lines using disallowed commands or env vars. */
export function checkBuildScript(scriptText) {
  const findings = []
  const lines = String(scriptText).split('\n')
  lines.forEach((line, i) => {
    const trimmed = line.replace(/^\s*#.*$/, '').trim()
    if (trimmed === '') return
    const envRefs = [...trimmed.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)].map(m => m[1])
    for (const ref of envRefs) {
      if (!ALLOWED_ENV.includes(ref)) {
        findings.push({ code: 'R4', message: `build.sh:${i + 1} 使用未许可环境变量 $${ref}`, file: 'scripts/build.sh' })
      }
    }
    // first word before any whitespace/pipe/&&
    const first = trimmed.match(/^[A-Za-z0-9_.-]+/)?.[0] ?? ''
    if (first !== '' && !ALLOWED_COMMANDS.includes(first)) {
      findings.push({ code: 'R4', message: `build.sh:${i + 1} 调用未许可命令 ${first}`, file: 'scripts/build.sh' })
    }
  })
  return findings
}

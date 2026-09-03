/**
 * Golden fixes for the relaudit fixture — the reference "fully fixed" state.
 * Applied to a COPY of the fixture (never in place): ground-check 黄金态.
 *
 * Usage: node answers/golden-fix.mjs <fixture-copy-dir> [domain]
 *   domain: "audit" (R1–R8 + wiring) | "frontend" (filter/format/app) | "all" (default)
 */
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const domain = process.argv[3] ?? 'all'
if (!dir) { console.error('usage: node answers/golden-fix.mjs <fixture-copy-dir> [audit|frontend|all]'); process.exit(1) }

function patch(rel, replacements) {
  const file = path.join(dir, rel)
  let text = fs.readFileSync(file, 'utf8')
  for (const [oldStr, newStr] of replacements) {
    if (!text.includes(oldStr)) throw new Error(`golden patch failed (pattern missing): ${rel}\n---\n${oldStr}`)
    text = text.replace(oldStr, newStr)
  }
  fs.writeFileSync(file, text)
}

function applyAudit() {
  // R1 semver numeric comparison
  patch('src/audit/semver.js', [[
    `export function compareVersions(a, b) {
  // PLANTED BUG: lexicographic string comparison.
  if (String(a) > String(b)) return 1
  if (String(a) < String(b)) return -1
  return 0
}`,
    `export function compareVersions(a, b) {
  const pa = parseVersion(String(a))
  const pb = parseVersion(String(b))
  if (pa === null || pb === null) return String(a).localeCompare(String(b))
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1
  return 0
}`,
  ]])
  patch('src/audit/severity.js', [[`  R1: 'warn', // PLANTED BUG: should be 'error'`, `  R1: 'error',`]])
  patch('src/audit/tarball.js', [[
    `      // PLANTED BUG: should be \`prefix === '' ? name : prefix + '/' + name\`
      entries.push({ name, size })`,
    `      entries.push({ name: prefix === '' ? name : \`\${prefix}/\${name}\`, size })`,
  ]])
  patch('src/audit/files.js', [[
    `  const resolved = path.resolve(pkgDir, pkg.main)
  // PLANTED BUG: containment check \`!resolved.startsWith(path.resolve(pkgDir))\` is missing.
  if (!fs.existsSync(resolved)) {`,
    `  const resolved = path.resolve(pkgDir, pkg.main)
  if (!resolved.startsWith(path.resolve(pkgDir) + path.sep)) {
    findings.push({ code: 'R3', message: \`main 指向包目录之外: \${pkg.main}\`, file: pkg.main })
    return findings
  }
  if (!fs.existsSync(resolved)) {`,
  ]])
  patch('src/audit/sandbox.js', [[
    `  'npx', // PLANTED BUG
  'curl', // PLANTED BUG
])`,
    `])`,
  ]])
  patch('src/audit/deps.js', [[
    `  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } // PLANTED BUG: devDeps included`,
    `  const declared = { ...(pkg.dependencies ?? {}) }`,
  ]])
  patch('src/audit/changelog.js', [[
    `    // PLANTED BUG: shape check only — no month/day range validation.
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(entry.date)) {
      findings.push({ code: 'R6', message: \`CHANGELOG 版本 \${entry.version} 日期非法: \${entry.date}\`, file: 'CHANGELOG.md' })
    }
    // skip: range validation intentionally absent (see isValidDate, used by tests to pin the spec)`,
    `    if (!isValidDate(entry.year, entry.month, entry.day)) {
      findings.push({ code: 'R6', message: \`CHANGELOG 版本 \${entry.version} 日期非法: \${entry.date}\`, file: 'CHANGELOG.md' })
    }`,
  ]])
  patch('src/audit/consistency.js', [[
    `  const badge = tokens[tokens.length - 1][0].slice(1) // PLANTED BUG: last token instead of first`,
    `  const badge = tokens[0][0].slice(1)`,
  ]])
  fs.writeFileSync(path.join(dir, 'src/audit/files-field.js'), `export function checkFilesField(pkg, entries) {
  const findings = []
  const files = Array.isArray(pkg.files) ? pkg.files : []
  const declaredDirs = files.filter(f => f.endsWith('/'))
  const declaredFiles = files.filter(f => !f.endsWith('/'))
  const names = entries.map(e => e.name).filter(n => !n.endsWith('/'))
  for (const entry of names) {
    const rel = entry.replace(/^package\\//, '')
    if (rel === 'package.json') continue
    const declared = files.some(f => (f.endsWith('/') ? rel.startsWith(f) : rel === f))
    if (!declared) findings.push({ code: 'R8', message: \`产物条目 \${rel} 未在 files 字段声明\`, file: rel })
  }
  for (const dir of declaredDirs) {
    const present = entries.some(e => e.name === \`package/\${dir}\` || e.name.startsWith(\`package/\${dir}\`))
    if (!present) findings.push({ code: 'R8', message: \`声明目录 \${dir} 在产物中缺失\`, file: dir })
  }
  for (const file of declaredFiles) {
    if (!names.includes(\`package/\${file}\`)) findings.push({ code: 'R8', message: \`声明文件 \${file} 在产物中缺失\`, file: file })
  }
  return findings
}
`)
  patch('src/audit/index.js', [[
    `import { checkConsistency } from './consistency.js'
import { severityOf, sortFindings, summarize } from './severity.js'`,
    `import { checkConsistency } from './consistency.js'
import { checkFilesField } from './files-field.js'
import { severityOf, sortFindings, summarize } from './severity.js'`,
  ]])
  patch('src/audit/index.js', [[
    `    ...checkConsistency(pkg, readmeText),
  ]`,
    `    ...checkConsistency(pkg, readmeText),
    ...checkFilesField(pkg, tarballEntries),
  ]`,
  ]])
}

function applyFrontend() {
  patch('public/filter.js', [[
    `    // PLANTED BUG: \`>\` should be \`>=\`
    (SEVERITY_ORDER[row.severity] ?? 0) > min`,
    `    (SEVERITY_ORDER[row.severity] ?? 0) >= min`,
  ]])
  fs.appendFileSync(path.join(dir, 'public/filter.js'), `
export function groupByRule(rows) {
  const groups = new Map()
  for (const row of rows) {
    if (!groups.has(row.rule)) groups.set(row.rule, { rule: row.rule, severity: row.severity, count: 0, rows: [] })
    const g = groups.get(row.rule)
    g.count++
    g.rows.push(row)
  }
  return [...groups.values()].sort((a, b) => (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0))
}
`)
  patch('public/format.js', [[
    `  // PLANTED BUG: numeric-ish string concatenation for the first two terms.
  return Number(String(counts.errors) + String(counts.warns)) + counts.infos`,
    `  return (counts.errors ?? 0) + (counts.warns ?? 0) + (counts.infos ?? 0)`,
  ]])
  fs.appendFileSync(path.join(dir, 'public/format.js'), `
export function copyFixSnippet(finding) {
  return \`relaudit fix --rule=\${finding.rule}\${finding.file ? \` --file=\${finding.file}\` : ''}\`
}
`)
  fs.writeFileSync(path.join(dir, 'public/app.js'), `// Public: report panel app (fetch report, render, wire filters).
// The pure pieces live in filter.js / format.js / ../src/render-panel.js so
// they can be unit-tested without a browser.
import { applyFilter, groupByRule } from './filter.js'
import { formatCounts, countTotal, copyFixSnippet } from './format.js'
import { renderPanelHtml } from '../src/render-panel.js'

export async function boot(root = document.getElementById('app')) {
  const res = await fetch('/api/audit')
  const run = await res.json()
  const report = run.report
  let state = { minSeverity: 'info', rulePrefix: '' }

  function renderTable() {
    const rows = applyFilter(report.findings, state)
    const tbody = root.querySelector('#rows')
    tbody.innerHTML = rows.map(f => (
      \`<tr class="row-\${f.severity}" data-rule="\${f.rule}">
        <td>\${f.rule}</td><td>\${f.severity}</td><td>\${f.message}</td><td>\${f.file ?? ''}</td>
        <td><button class="copy" data-rule="\${f.rule}" data-file="\${f.file ?? ''}">复制修复片段</button></td></tr>\`
    )).join('')
    root.querySelector('#summary-text').textContent = \`\${formatCounts(report.summary)} · 共 \${countTotal(report.summary)} 条\`
    root.querySelector('#rule-groups').textContent = groupByRule(report.findings)
      .map(g => \`\${g.rule}(\${g.count})\`).join(' / ')
  }

  root.innerHTML = renderPanelHtml(report) + \`
    <div><select id="sev-filter">
      <option value="info">全部级别</option><option value="warn">警告及以上</option>
      <option value="error">仅错误</option></select>
      <input id="rule-filter" placeholder="规则前缀过滤" />
      <span id="summary-text"></span> <span id="rule-groups"></span></div>\`
  root.querySelector('#sev-filter').addEventListener('change', e => {
    const v = e.target.value
    state = { ...state, minSeverity: v === 'warn' ? 'warn' : v === 'error' ? 'error' : 'info' }
    renderTable()
  })
  root.querySelector('#rule-filter').addEventListener('input', e => {
    state = { ...state, rulePrefix: e.target.value.trim() }
    renderTable()
  })
  root.addEventListener('click', e => {
    const btn = e.target.closest('.copy')
    if (btn) {
      const snippet = copyFixSnippet({ rule: btn.dataset.rule, file: btn.dataset.file })
      if (navigator.clipboard) navigator.clipboard.writeText(snippet)
    }
  })
  renderTable()
}
`)
}

if (domain === 'audit') applyAudit()
else if (domain === 'frontend') applyFrontend()
else { applyAudit(); applyFrontend() }
console.log(`golden fixes [${domain}] applied to ${dir}`)

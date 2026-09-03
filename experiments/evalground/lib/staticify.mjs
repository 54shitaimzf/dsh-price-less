/**
 * staticify — package the model's panel into ONE self-contained HTML file.
 * No server, no ports, no module CORS: ESM imports/exports are flattened into
 * shared scope, the audit payload is computed offline via createApp().handle()
 * and inlined, and fetch('/api/...') is overridden with the inlined payload.
 * The result opens directly in any browser (double-click).
 *
 * Returns the output file path, or null on failure.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Fidelity gate: constructs that flattening cannot preserve faithfully.
 * If any is detected the staticify call MUST refuse output (caller falls back
 * to source evidence), so a successfully produced panel-static.html can only
 * mis-render when the MODEL's code itself is wrong — attribution holds.
 */
export function fidelityIssues(allSrc, mainImports) {
  const issues = []
  const names = new Map() // identifier → normalized full declaration block
  for (const [file, srcRaw] of allSrc) {
    const src = srcRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') // strip comments
    // 3. ESM-only syntax that is a silent syntax error in a classic script
    if (/\bimport\.meta\b/.test(src)) issues.push(`${file}: import.meta`)
    if (/\bimport\s*\(/.test(src)) issues.push(`${file}: dynamic import()`)
    if (/^export\s*\{[^}]*\}\s*from\b/m.test(src)) issues.push(`${file}: re-export from`)
    if (/\bimport\s*\*/.test(src)) issues.push(`${file}: namespace import`)
    // 4. fetch calls to endpoints the snapshot does not serve
    const fetches = [...src.matchAll(/fetch\(\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1])
    for (const f of fetches) {
      if (f.startsWith('/api/') && !['/api/audit', '/api/rules', '/api/versions'].includes(f.split('?')[0])) {
        issues.push(`${file}: unsupported fetch ${f}`)
      }
    }
    // 1 + top-level-await: single brace-depth walk over lines. Only depth-0
    //    declarations are top-level (locals are unaffected by scope merging);
    //    depth-0 `await` statements are top-level await.
    let depth = 0
    let offset = 0
    for (const line of src.split('\n')) {
      const trimmed = line.trim()
      if (depth === 0) {
        const m = line.match(/^\s*(?:export\s+(?:async\s+)?(?:function|const|let|var|class)\s+|function\s+|const\s+|let\s+|var\s+|class\s+)([A-Za-z_$][\w$]*)/)
        if (m) {
          const id = m[1]
          const start = line.indexOf(id)
          const block = extractBlock(src, offset + start)
          if (names.has(id)) {
            if (names.get(id) !== block) issues.push(`${file}: duplicate identifier ${id} with differing declaration`)
          } else {
            names.set(id, block)
          }
        }
        if (/^\s*await\b/.test(trimmed) && !/=>/.test(line)) issues.push(`${file}: top-level await`)
      }
      const opens = (line.match(/{/g) ?? []).length
      const closes = (line.match(/}/g) ?? []).length
      depth += opens - closes
      if (depth < 0) depth = 0
      offset += line.length + 1
    }
  }
  // 2. imports referencing files outside the fixed set
  for (const imp of mainImports) {
    if (!fs.existsSync(imp)) issues.push(`missing import target: ${imp}`)
  }
  return issues
}

/** From a top-level declaration start, return the brace-balanced normalized block. */
function extractBlock(src, startIdx) {
  let depth = 0
  let i = startIdx
  const n = src.length
  while (i < n) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { i++; break } }
    i++
  }
  return src.slice(startIdx, i).replace(/\s+/g, ' ').trim().replace(/^export\s+/, '')
}

/** Flatten one ESM module: strip import/export lines, keep declarations in shared scope. */
function flattenModule(src) {
  const lines = src.split('\n')
  const out = []
  for (const line of lines) {
    const t = line.trim()
    if (/^import\s+/.test(t) || /^import\s*$/.test(t)) continue // drop import lines entirely
    if (/^export\s+(async\s+)?(default\s+)?(function|const|let|var|class)\b/.test(t)) {
      // export [async] function foo() → [async] function foo();  export const X = → const X =
      out.push(t.replace(/^export\s+/, ''))
      continue
    }
    if (/^export\s*\{/.test(t)) continue // export { a, b } → nothing (already shared)
    if (/^export\s+default\b/.test(t)) {
      out.push(t.replace(/^export\s+default\s+/, 'const __default__ = '))
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/** Compute the three API payloads offline (pure handle(), no socket). */
async function computePayloads(workspace) {
  const mod = await import(pathToFileURL(path.join(workspace, 'src', 'server.js')).href + `?v=${Date.now()}`)
  const app = mod.createApp({ storeDir: path.join(workspace, '.tmp-snap-store'), pkgDir: path.join(workspace, 'sample-pkg'), publicDir: path.join(workspace, 'public') })
  const audit = app.handle({ url: '/api/audit' })
  const rules = app.handle({ url: '/api/rules' })
  const versions = app.handle({ url: '/api/versions' })
  if (!audit || audit.status !== 200 || !audit.body) return null
  return {
    audit: JSON.stringify(audit.body).replaceAll('</', '<\\/'),
    rules: JSON.stringify(rules?.body ?? { rules: [] }).replaceAll('</', '<\\/'),
    versions: JSON.stringify(versions?.body ?? []).replaceAll('</', '<\\/'),
  }
}

/**
 * @param {string} workspace  run workspace path
 * @param {string} outHtml    destination file path
 * @returns {Promise<{html: string|null, issues: string[]}>} — html is ONLY
 *   produced when the fidelity gate passes; otherwise issues explains why.
 */
export async function staticifyPanel(workspace, outHtml) {
  try {
    const payloads = await computePayloads(workspace)
    if (!payloads) return { html: null, issues: ['payload computation failed'] }

    const publicDir = path.join(workspace, 'public')
    const read = (p) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
    const css = read(path.join(publicDir, 'style.css')) ?? ''
    const appJs = read(path.join(publicDir, 'app.js'))
    const filterJs = read(path.join(publicDir, 'filter.js'))
    const formatJs = read(path.join(publicDir, 'format.js'))
    const renderJs = read(path.join(workspace, 'src', 'render-panel.js'))
    if (!appJs || !filterJs || !formatJs || !renderJs) return { html: null, issues: ['missing core panel files'] }

    // fidelity gate — refuse output when flattening cannot preserve semantics
    const allSrc = [
      ['public/app.js', appJs], ['public/filter.js', filterJs],
      ['public/format.js', formatJs], ['src/render-panel.js', renderJs],
    ]
    const mainImports = [
      path.join(publicDir, 'app.js'), path.join(publicDir, 'filter.js'),
      path.join(publicDir, 'format.js'), path.join(workspace, 'src', 'render-panel.js'),
    ]
    const issues = fidelityIssues(allSrc, mainImports)
    if (issues.length > 0) return { html: null, issues }

    // flatten in dependency order
    const code = [
      '/* flattened: format.js */', flattenModule(formatJs),
      '/* flattened: filter.js */', flattenModule(filterJs),
      '/* flattened: render-panel.js */', flattenModule(renderJs),
      '/* flattened: app.js */', flattenModule(appJs),
    ].join('\n')

    const html = [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      '<title>relaudit · 审计报告面板（静态快照）</title>',
      `<style>${css}</style>`,
      '</head>',
      '<body>',
      '<div id="app"><p>加载中…</p></div>',
      '<script>',
      `window.__AUDIT__=${payloads.audit};`,
      `window.__RULES__=${payloads.rules};`,
      `window.__VERSIONS__=${payloads.versions};`,
      // fetch override: /api/* answered from inlined payloads (no server needed)
      'const __realFetch = window.fetch.bind(window);',
      'window.fetch = (u, o) => {',
      '  const s = String(u);',
      '  if (s.startsWith("/api/audit")) return Promise.resolve({ ok: true, status: 200, json: async () => window.__AUDIT__ });',
      '  if (s.startsWith("/api/rules")) return Promise.resolve({ ok: true, status: 200, json: async () => window.__RULES__ });',
      '  if (s.startsWith("/api/versions")) return Promise.resolve({ ok: true, status: 200, json: async () => window.__VERSIONS__ });',
      '  return __realFetch(u, o);',
      '};',
      // boot when DOM ready
      'window.addEventListener("DOMContentLoaded", () => {',
      '  if (typeof boot === "function") { boot().catch(e => { document.getElementById("app").innerHTML = "<p style=\\"color:red\\">静态快照执行出错: " + String(e) + "</p>"; }); }',
      '  else { document.getElementById("app").innerHTML = "<p style=\\"color:red\\">静态快照失败: boot 函数缺失</p>"; }',
      '});',
      '</script>',
      '<script>',
      code,
      '</script>',
      '</body>',
      '</html>',
    ].join('\n')

    fs.mkdirSync(path.dirname(outHtml), { recursive: true })
    fs.writeFileSync(outHtml, html)
    return { html: outHtml, issues: [] }
  } catch (e) {
    return { html: null, issues: [`exception: ${String(e)}`] }
  }
}

// CLI: node lib/staticify.mjs <workspace> <outHtml>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [ws, out] = process.argv.slice(2)
  const r = await staticifyPanel(ws, out)
  if (r.html) { console.log(`STATIC OK: ${r.html}`); process.exit(0) }
  console.log(`STATIC REFUSED: ${r.issues.join('; ') || 'unknown'}`)
  process.exit(1)
}
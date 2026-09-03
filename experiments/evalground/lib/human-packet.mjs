/**
 * Human review packet — DEPRECATED (approved plan §2: human track retired).
 * Kept only so the legacy `human:review`/`human:sheets` flow still works for
 * archives; run-one no longer calls this module and scorecards no longer carry
 * human fields.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { staticifyPanel } from './staticify.mjs'

const BROWSER_CANDIDATES = [
  process.env.EVAL_GROUND_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
].filter(Boolean)

const HUMAN_DIMS = {
  'T1': [{ dim: 'reportPresentation', name: '报告呈现（排版/可读性）', weight: 10 }],
  'T2': [{ dim: 'readability', name: '文档可读性（导航/语言）', weight: 20 }],
  'T3': [{ dim: 'visual', name: '面板视觉观感（布局/配色/一致性）', weight: 30 }],
  'T5': [{ dim: 'copy', name: '文案表达（语气/可读/像真实发布说明）', weight: 40 }],
  'T6': [{ dim: 'manualReadability', name: '手册可读性', weight: 20 }],
  'T7': [{ dim: 'presentation', name: '最终文档/面板呈现', weight: 5 }],
}

/**
 * Anchor bands for the human aesthetics dimensions: ABSOLUTE scoring 0–5
 * (nothing is compared against any baseline, reference, or other run).
 * 0 = unusable/absent, 3 = acceptable middle ground, 5 = professional.
 */
const HUMAN_ANCHORS = {
  reportPresentation: {
    question: 'REVIEW.md 报告的排版与可读性（绝对评价）',
    '0': '无有效产出/不可用',
    '1': '存在但明显缺陷（混乱、无法定位）',
    '2': '可用但粗糙（密度或分段不佳）',
    '3': '中规中矩——表格清晰、段分合理，可正常扫读',
    '4': '良好——结构清晰、重点突出',
    '5': '专业排版、一眼可定位到每条缺陷',
  },
  readability: {
    question: 'docs/api.md 与 docs/rules.md 的可读性（导航/语言，绝对评价）',
    '0': '无有效产出/不可用',
    '1': '存在但明显缺陷（混乱、找不到信息）',
    '2': '可用但粗糙（小标题缺失或语言生硬）',
    '3': '中规中矩——章节分明、语言可读',
    '4': '良好——导航顺畅、语言准确',
    '5': '层次完美、零歧义',
  },
  visual: {
    question: '面板视觉观感（布局/配色/一致性，绝对评价）见 panel.png 截图',
    '0': '无有效产出/不可用',
    '1': '存在但明显缺陷（布局错乱、配色刺眼）',
    '2': '可用但粗糙（间距/对齐小瑕疵）',
    '3': '中规中矩——元素规整、风格统一',
    '4': '良好——间距协调、状态清晰（如过滤激活态）',
    '5': '接近成品 UI',
  },
  copy: {
    question: '发布说明文案质量（语气/可读/像真实发布，绝对评价）',
    '0': '无有效产出/不可用',
    '1': '存在但明显缺陷（语气违和、信息堆砌）',
    '2': '可用但粗糙（啰嗦或空泛）',
    '3': '中规中矩——专业、简洁、信息准确',
    '4': '良好——语气自然、亮点突出',
    '5': '可直接发布的水准',
  },
  manualReadability: {
    question: 'quickstart 手册可读性（上手路径/步骤/示例，绝对评价）',
    '0': '无有效产出/不可用',
    '1': '存在但明显缺陷（步骤跳跃、示例缺失）',
    '2': '可用但粗糙（顺序或表述小问题）',
    '3': '中规中矩——步骤清晰、可照做',
    '4': '良好——上手更快、示例贴切',
    '5': '零门槛',
  },
  presentation: {
    question: '最终交付（REVIEW/文档/面板）整体呈现（绝对评价）',
    '0': '无有效产出/不可用',
    '1': '存在但明显缺陷',
    '2': '可用但粗糙',
    '3': '中规中矩',
    '4': '良好',
    '5': '专业水准',
  },
}
export const HUMAN_DIM_ANCHORS = HUMAN_ANCHORS
export { HUMAN_DIMS }

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) if (p && fs.existsSync(p)) return p
  return null
}

/**
 * Static snapshot screenshot, http flavor: compute the audit payload offline
 * via createApp().handle() (pure function, no socket), then serve a scratch
 * static copy of the panel on a loopback port where /api/audit answers with
 * the precomputed payload. Real module loading + real fetch path, but zero
 * server-side computation and zero network races — reliable in sandboxes.
 */
async function staticSnapshot(workspace, outPng) {
  const browser = findBrowser()
  if (!browser) return null
  let server = null
  try {
    const mod = await import(pathToFileURL(path.join(workspace, 'src', 'server.js')).href + `?v=${Date.now()}`)
    const app = mod.createApp({ storeDir: path.join(workspace, '.tmp-snap-store'), pkgDir: path.join(workspace, 'sample-pkg'), publicDir: path.join(workspace, 'public') })
    const auditOut = app.handle({ url: '/api/audit' })
    if (!auditOut || auditOut.status !== 200 || !auditOut.body) return null
    const auditJson = JSON.stringify(auditOut.body)
    const rulesJson = JSON.stringify(app.handle({ url: '/api/rules' })?.body ?? { rules: [] })
    const versionsJson = JSON.stringify(app.handle({ url: '/api/versions' })?.body ?? [])

    // scratch static copy (keeps relative module graph intact)
    const scratch = path.join(workspace, '.tmp-snap-shot')
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.mkdirSync(path.join(scratch, 'src'), { recursive: true })
    for (const f of ['index.html', 'app.js', 'filter.js', 'format.js', 'style.css']) {
      const src = path.join(workspace, 'public', f)
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(scratch, f))
    }
    const rp = path.join(workspace, 'src', 'render-panel.js')
    if (fs.existsSync(rp)) fs.copyFileSync(rp, path.join(scratch, 'src', 'render-panel.js'))

    const { createServer } = await import('node:http')
    const port = 8792
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/api/audit') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(auditJson) }
      if (url.pathname === '/api/rules') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(rulesJson) }
      if (url.pathname === '/api/versions') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(versionsJson) }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      const file = path.join(scratch, rel)
      if (file.startsWith(scratch) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file)
        const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'application/octet-stream'
        res.writeHead(200, { 'content-type': type })
        return res.end(fs.readFileSync(file))
      }
      res.writeHead(404); res.end('not found')
    })
    await new Promise((resolve, reject) => { server.listen(port, '127.0.0.1', resolve); server.on('error', reject) })

    const base = `http://127.0.0.1:${port}/`
    for (let attempt = 1; attempt <= 5; attempt++) {
      const shot = await headless(browser, ['--virtual-time-budget=15000', `--screenshot=${outPng}`, '--window-size=1440,1000', base], outPng)
      if (!shot) { await new Promise(r => setTimeout(r, 1200)); continue }
      const dom = await headlessText(browser, ['--virtual-time-budget=15000', '--dump-dom', base])
      if (!/加载中|loading/i.test(dom) && /<table|tbody|<tr/i.test(dom)) return shot
      await new Promise(r => setTimeout(r, 1500))
    }
    return outPng
  } catch {
    return null
  } finally {
    if (server) server.close()
    try { fs.rmSync(path.join(workspace, '.tmp-snap-shot'), { recursive: true, force: true }) } catch { /* keep */ }
  }
}

function headless(browser, args, outPng) {
  return new Promise((resolve) => {
    execFile(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', ...args], { timeout: 90000 }, (err) => resolve(err ? null : outPng))
  })
}
function headlessText(browser, args) {
  return new Promise((resolve) => {
    execFile(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', ...args], { timeout: 90000 }, (err, stdout) => resolve(err ? '' : stdout))
  })
}

async function screenshot(workspace, outPng) {
  const browser = findBrowser()
  if (!browser) return null
  const staticShot = await staticSnapshot(workspace, outPng)
  if (staticShot) return staticShot
  // fallback: live server (needs a free port; less reliable)
  const port = 8791
  const server = spawn(process.execPath, ['src/server.js'], { cwd: workspace, env: { ...process.env, PORT: String(port) } })
  try {
    // wait for readiness
    let ready = false
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/api/rules`); if (r.ok) { ready = true; break } } catch { await new Promise(r => setTimeout(r, 250)) }
    }
    if (!ready) return null
    for (let attempt = 1; attempt <= 5; attempt++) {
      const shot = await headless(browser, ['--virtual-time-budget=15000', `--screenshot=${outPng}`, '--window-size=1440,1000', `http://127.0.0.1:${port}/`], outPng)
      if (!shot) return null
      const dom = await headlessText(browser, ['--virtual-time-budget=15000', '--dump-dom', `http://127.0.0.1:${port}/`])
      if (!/加载中|loading/i.test(dom) && /<table|tbody|<tr/i.test(dom)) return shot
      await new Promise(r => setTimeout(r, 1500))
    }
    return outPng
  } finally {
    server.kill()
  }
}

export async function buildHumanPacket(task, runDir, workspace, mech) {
  const dims = HUMAN_DIMS[task.id]
  if (!dims || (task.track.human ?? 0) === 0) return { dims: [], evidence: [], reasons: 'no human dims' }
  const evidenceDir = path.join(runDir, 'human-evidence')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const evidence = []
  const reasons = []

  if (task.id === 'T3') {
    // static snapshot is the primary evidence: double-clickable, server-free.
    // The fidelity gate guarantees a produced html mis-renders only when the
    // model's own code is wrong — attribution for the human reviewer holds.
    const staticHtml = path.join(evidenceDir, 'panel-static.html')
    const st = await staticifyPanel(workspace, staticHtml)
    if (st.html) { evidence.push('panel-static.html'); reasons.push('self-contained static panel (fidelity gate passed)') }
    else reasons.push(`staticify refused: ${st.issues.join('; ').slice(0, 120)}`)
    const png = path.join(evidenceDir, 'panel.png')
    const shot = await screenshot(workspace, png)
    if (shot) { evidence.push('panel.png'); reasons.push('screenshot via headless browser') }
    else {
      const html = path.join(evidenceDir, 'page.html')
      const src = path.join(workspace, 'src', 'render-panel.js')
      fs.writeFileSync(html, fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '(missing)')
      evidence.push('page.html'); reasons.push('no browser found — render code snapshot only')
    }
    fs.writeFileSync(path.join(evidenceDir, 'app.js'), fs.readFileSync(path.join(workspace, 'public', 'app.js'), 'utf8'))
    evidence.push('app.js')
  } else if (task.id === 'T7') {
    const staticHtml = path.join(evidenceDir, 'panel-static.html')
    const st = await staticifyPanel(workspace, staticHtml)
    if (st.html) { evidence.push('panel-static.html'); reasons.push('self-contained static panel (fidelity gate passed)') }
    else reasons.push(`staticify refused: ${st.issues.join('; ').slice(0, 120)}`)
    const png = path.join(evidenceDir, 'panel.png')
    const shot = await screenshot(workspace, png)
    if (shot) evidence.push('panel.png')
    for (const f of ['REVIEW.md', 'docs/rules.md', 'docs/api.md']) {
      if (fs.existsSync(path.join(workspace, f))) {
        fs.copyFileSync(path.join(workspace, f), path.join(evidenceDir, f.replaceAll('/', '_')))
        evidence.push(f.replaceAll('/', '_'))
      }
    }
  } else {
    const rel = { 'T1': 'REVIEW.md', 'T2': null, 'T5': 'release-notes-v1.3.0.md', 'T6': 'docs/quickstart.md' }[task.id]
    const files = rel === null
      ? ['docs/api.md', 'docs/rules.md']
      : [rel]
    for (const f of files) {
      if (fs.existsSync(path.join(workspace, f))) {
        fs.copyFileSync(path.join(workspace, f), path.join(evidenceDir, f.replaceAll('/', '_')))
        evidence.push(f.replaceAll('/', '_'))
      }
    }
  }

  const csv = path.join(runDir, 'human-sheet.csv')
  const header = 'task,dim,name,weight,score(0..5 absolute),notes'
  const rows = [
    header,
    ...dims.map(d => `${task.id},${d.dim},"${d.name}",${d.weight},,`),
  ].join('\n')
  fs.writeFileSync(csv, rows)
  return { dims, evidence, csv, reasons }
}

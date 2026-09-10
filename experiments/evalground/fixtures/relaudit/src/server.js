/**
 * Static + JSON router for the relaudit server (zero dependency, http only).
 */

import { createServer } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runAudit } from './audit/index.js'
import { createStore } from './store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

export function createApp(options = {}) {
  const storeDir = options.storeDir ?? path.join(ROOT, 'data')
  const pkgDir = options.pkgDir ?? path.join(ROOT, 'sample-pkg')
  const publicDir = options.publicDir ?? path.join(ROOT, 'public')
  const store = createStore(storeDir)

  const routes = []
  const get = (pattern, handler) => routes.push({ pattern, handler })
  const match = (url) => {
    for (const r of routes) {
      const m = url.pathname.match(r.pattern)
      if (m) return { handler: r.handler, params: m.slice(1) }
    }
    return null
  }

  get(/^\/api\/audit$/, () => {
    const report = runAudit(pkgDir)
    const run = { id: `run-${Date.now()}`, createdAt: new Date().toISOString(), report }
    store.addRun(run)
    return run
  })
  get(/^\/api\/audit\/([^/]+)$/, (_req, id) => {
    const run = store.listRuns().find(r => r.id === id)
    if (!run) return { status: 404, body: { error: 'run not found' } }
    return run
  })
  get(/^\/api\/runs$/, () => store.listRuns())
  get(/^\/api\/rules$/, () => ({
    rules: [
      { id: 'R1', name: 'semver 门', severity: 'error' },
      { id: 'R2', name: 'tarball 结构', severity: 'error' },
      { id: 'R3', name: 'lib 完整性', severity: 'warn' },
      { id: 'R4', name: '沙箱规则', severity: 'warn' },
      { id: 'R5', name: '依赖审计', severity: 'warn' },
      { id: 'R6', name: 'CHANGELOG 格式', severity: 'warn' },
      { id: 'R7', name: 'README 一致性', severity: 'warn' },
      { id: 'R8', name: '产物 files 一致性', severity: 'error' },
    ],
  }))
  get(/^\/api\/versions$/, () => store.versions())

  const staticRoot = publicDir
  return {
    store,
    handle(req) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = match(url)
      if (route !== null) {
        const out = route.handler(req, ...route.params)
        if (out && typeof out === 'object' && out.status !== undefined) return out
        return { status: 200, body: out }
      }
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
      const file = path.resolve(staticRoot, rel)
      const relFromRoot = path.relative(staticRoot, file)
      const inside = relFromRoot !== '' && !relFromRoot.startsWith('..') && !path.isAbsolute(relFromRoot)
      if (inside && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file)
        const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'application/octet-stream'
        return { status: 200, raw: fs.readFileSync(file), type }
      }
      return { status: 404, body: { error: 'not found' } }
    },
    listen(port = 8787) {
      return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
          const out = this.handle(req)
          try {
            if (out.raw !== undefined) {
              res.writeHead(out.status, { 'content-type': out.type })
              res.end(out.raw)
            } else {
              res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(out.body))
            }
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: String(error) }))
          }
        })
        server.listen(port, '127.0.0.1', () => resolve(server))
        server.on('error', reject)
      })
    },
  }
}

// CLI entry: node src/server.js  (PORT env overrides the default 8787)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT) || 8787)
    .then(server => console.log(`relaudit listening on http://127.0.0.1:${server.address().port}`))
}

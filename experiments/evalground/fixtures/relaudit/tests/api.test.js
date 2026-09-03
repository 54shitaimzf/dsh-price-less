import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createApp } from '../src/server.js'

const tmp = fs.mkdtempSync(path.join(process.cwd(), '.tmp-api-'))

function withServer(fn) {
  return async () => {
    const app = createApp({ storeDir: tmp, pkgDir: path.join(process.cwd(), 'sample-pkg') })
    const server = await app.listen(0) // ephemeral port
    const base = `http://127.0.0.1:${server.address().port}`
    try { await fn(base) } finally { server.close() }
  }
}

test('GET /api/versions returns released list', withServer(async (base) => {
  const res = await fetch(`${base}/api/versions`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(Array.isArray(body.releases))
}))

test('GET /api/rules lists R1..R8', withServer(async (base) => {
  const res = await fetch(`${base}/api/rules`)
  const body = await res.json()
  const ids = body.rules.map(r => r.id)
  for (const id of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8']) {
    assert.ok(ids.includes(id), `missing rule ${id}`)
  }
}))

test('GET /api/audit returns a report with findings + summary', withServer(async (base) => {
  const res = await fetch(`${base}/api/audit`)
  assert.equal(res.status, 200)
  const run = await res.json()
  assert.ok(run.id && run.report)
  assert.ok(Array.isArray(run.report.findings))
  assert.equal(typeof run.report.summary.total, 'number')
  assert.equal(run.report.pkg, 'dsh-sample-plugin')
}))

test('GET /api/audit/:id returns the stored run', withServer(async (base) => {
  const run = await (await fetch(`${base}/api/audit`)).json()
  const got = await (await fetch(`${base}/api/audit/${run.id}`)).json()
  assert.equal(got.id, run.id)
}))

test('GET /api/audit/:id for unknown id returns 404', withServer(async (base) => {
  const res = await fetch(`${base}/api/audit/run-nope`)
  assert.equal(res.status, 404)
}))

test('GET / serves the panel page', withServer(async (base) => {
  const res = await fetch(`${base}/`)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.ok(html.includes('id="app"'))
  assert.ok(html.includes('app.js'))
}))

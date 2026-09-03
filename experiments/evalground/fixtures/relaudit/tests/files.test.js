import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { checkLib } from '../src/audit/files.js'

const tmpRoot = fs.mkdtempSync(path.join(process.cwd(), '.tmp-lib-'))
const mkPkg = (pkgJson) => {
  const dir = path.join(tmpRoot, `p-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkgJson))
  return dir
}

test('checkLib passes for a contained, non-empty main', () => {
  const dir = mkPkg({ main: 'lib/index.js' })
  fs.writeFileSync(path.join(dir, 'lib/index.js'), '// ok\n')
  assert.deepEqual(checkLib(dir, { main: 'lib/index.js' }), [])
})

test('checkLib flags missing main file', () => {
  const dir = mkPkg({ main: 'lib/missing.js' })
  const findings = checkLib(dir, { main: 'lib/missing.js' })
  assert.ok(findings.some(f => f.message.includes('不存在')))
})

test('checkLib flags empty main file', () => {
  const dir = mkPkg({ main: 'lib/empty.js' })
  fs.writeFileSync(path.join(dir, 'lib/empty.js'), '')
  assert.ok(checkLib(dir, { main: 'lib/empty.js' }).some(f => f.message.includes('为空')))
})

test('checkLib flags main escaping the package directory', () => {
  const dir = mkPkg({ main: '../evil.js' })
  fs.writeFileSync(path.resolve(dir, '../evil.js'), '// outside\n')
  const findings = checkLib(dir, { main: '../evil.js' })
  assert.ok(findings.some(f => /包目录|包外|逃逸|outside|目录外/.test(f.message)), `expected containment finding, got ${JSON.stringify(findings)}`)
})

test('checkLib flags missing main field', () => {
  const dir = mkPkg({})
  assert.ok(checkLib(dir, {}).some(f => f.message.includes('缺少 main')))
})

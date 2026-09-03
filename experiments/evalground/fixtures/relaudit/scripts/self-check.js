/**
 * Fixture self-check (npm run check): verifies data files, sample package
 * parseability and tarball presence. Exit 0 = ground healthy.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const need = [
  'data/versions.json', 'data/runs.json', 'sample-pkg/package.json',
  'sample-pkg/lib/index.js', 'sample-pkg/scripts/build.sh',
  'sample-pkg/CHANGELOG.md', 'sample-pkg/README.md', 'sample-pkg/node-modules.json',
  'dist/relaudit-plugin-1.3.0.tgz', 'public/index.html', 'public/app.js',
  'src/server.js', 'src/audit/index.js',
]
const missing = need.filter(rel => !fs.existsSync(path.join(root, rel)))
if (missing.length > 0) {
  console.error('self-check FAILED, missing:', missing.join(', '))
  process.exit(1)
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'sample-pkg', 'package.json'), 'utf8'))
if (pkg.name !== 'dsh-sample-plugin' || pkg.version !== '1.3.0') {
  console.error('self-check FAILED: sample-pkg identity mismatch')
  process.exit(1)
}
console.log('self-check OK: fixture ground healthy')

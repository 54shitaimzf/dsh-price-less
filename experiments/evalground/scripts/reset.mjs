/**
 * One-key reset of the eval ground:
 *   0. verify the fixture template matches the committed golden (immutable)
 *   1. wipe runs/ (all historical runs — results are reproducible, not kept)
 *   2. remove temp/scratch files (.tmp-*, verify scratch dirs, .ground-check, .scratch/)
 *   3. regenerate the sample-pkg tarball (make-tgz) so the fixture is complete
 *   4. re-run ground:check (three-state + stability) to prove a clean state
 * Usage: node scripts/reset.mjs        (also: npm run ground:reset)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { checkFixture } from '../lib/fixture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

function rmIfExists(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
}

// 0. fixture immutability gate
const fx = checkFixture()
if (!fx.ok) {
  console.error(`✘ fixture integrity check FAILED — refusing to reset: ${fx.reason}`)
  console.error('  the template must never be modified; restore fixtures/relaudit or regenerate golden deliberately:')
  console.error('  node scripts/fixture-hash.mjs --write')
  process.exit(1)
}
console.log('✔ fixture integrity OK (matches golden hash)')

// 1. wipe runs
const runs = path.join(ROOT, 'runs')
rmIfExists(runs)
fs.mkdirSync(runs, { recursive: true })
console.log('✔ runs/ wiped')

// 2. temp & scratch files anywhere under the ground (+ unified .scratch/)
let removed = 0
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name.startsWith('.tmp-') || e.name.startsWith('.verify-') || e.name === '.ground-check' || e.name === '.scratch') {
        rmIfExists(full); removed++
      } else walk(full)
    } else if (e.name.startsWith('.tmp-') || e.name.endsWith('.tmp')) {
      fs.rmSync(full); removed++
    }
  }
}
walk(ROOT)
console.log(`✔ scratch files removed: ${removed}`)

// 3. regenerate tgz
try {
  execFileSync(process.execPath, [path.join(HERE, 'make-tgz.mjs')], { cwd: ROOT, stdio: 'inherit' })
  console.log('✔ sample tgz regenerated')
} catch {
  console.error('✘ make-tgz failed — fixture may be incomplete')
  process.exit(1)
}

// 4. ground:check (offline, no gateway)
console.log('\n=== ground:check ===')
try {
  execFileSync(process.execPath, [path.join(ROOT, 'lib', 'ground-check.mjs')], { cwd: ROOT, stdio: 'inherit' })
  console.log('\n✔ ground:check PASS — eval ground is clean and verified')
} catch {
  console.error('\n✘ ground:check FAILED — see above')
  process.exit(1)
}
console.log('\nreset complete: runs/ empty, fixture verified, ready for a fresh matrix')
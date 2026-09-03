/**
 * Fixture fingerprint CLI.
 *   node scripts/fixture-hash.mjs --write   commit current fixture as golden
 *   node scripts/fixture-hash.mjs --check   verify fixture matches golden
 */
import { checkFixture, writeGolden, GOLDEN_HASH_FILE } from '../lib/fixture.mjs'

const args = process.argv.slice(2)
if (args.includes('--write')) {
  const out = writeGolden()
  console.log(`golden fixture hash written: ${out}`)
} else if (args.includes('--check')) {
  const r = checkFixture()
  if (r.ok) console.log('fixture OK — template matches golden')
  else { console.error(`fixture CHECK FAILED: ${r.reason}`); process.exit(1) }
} else {
  console.log(`usage: node scripts/fixture-hash.mjs --write | --check (golden: ${GOLDEN_HASH_FILE})`)
}
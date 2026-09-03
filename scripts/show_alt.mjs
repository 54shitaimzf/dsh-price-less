import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync('datasets/discriminator-alts.json', 'utf8'))
const short = s => { const m = String(s).match(/session-([0-9a-f]{8})-/); return m ? m[1] : String(s).slice(0, 8) }
for (const b of j.batches) {
  const it = b.items[0]
  const k = `${short(it.sid)}:${it.u}`
  if (k !== '17eeebba:188' && k !== '17eeebba:61') continue
  console.log(`\n== ${k} flip=${it.flip} ord=${it.ord} (w1近锚) ==`)
  console.log(`anchor: ${it.anchor}`)
  it.patches.forEach((p, i) => console.log(`patch${i}: ${p}`))
  console.log(`target: ${it.target}`)
}

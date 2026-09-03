// 补查 u=115/84/199（17eeebba）窗口
import { readFileSync } from 'node:fs'
const ds = JSON.parse(readFileSync('D:/deepseek-plugin/datasets/discriminator-batches.json', 'utf8'))
const all = []
for (const b of ds.batches || []) for (const it of b.items || []) all.push(it)
const short = s => { const m = String(s).match(/session-([0-9a-f]{8})-/); return m ? m[1] : String(s).slice(0, 8) }
const want = ['17eeebba:115', '17eeebba:84', '17eeebba:199', '17eeebba:137', '17eeebba:34']
for (const it of all) {
  const k = `${short(it.sid)}:${it.u}`
  if (!want.includes(k)) continue
  console.log(`\n========== ${k}  flip=${it.flip} ==========`)
  console.log(`anchor(${it.anchor.length}): ${it.anchor.slice(0, 200)}`)
  for (let i = 0; i < (it.patches || []).length; i++) console.log(`patch${i}: ${(it.patches[i] || '').slice(0, 150)}`)
  console.log(`target(${it.target.length}): ${it.target.slice(0, 250)}`)
}

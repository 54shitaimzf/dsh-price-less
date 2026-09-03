// 打印关键样本的原始窗口（anchor/target 首尾），用于 debug 归因
import { readFileSync } from 'node:fs'
const ds = JSON.parse(readFileSync('D:/deepseek-plugin/datasets/discriminator-batches.json', 'utf8'))
const all = []
for (const b of ds.batches || []) for (const it of b.items || []) all.push(it)
const want = ['17eeebba:128', '17eeebba:5', 'b5f92412:64', '17eeebba:61', '17eeebba:188', '14b08b7d:49', '17eeebba:46']
const short = s => { const m = String(s).match(/session-([0-9a-f]{8})-/); return m ? m[1] : String(s).slice(0, 8) }
for (const it of all) {
  const k = `${short(it.sid)}:${it.u}`
  if (!want.includes(k)) continue
  console.log(`\n========== ${k}  flip=${it.flip} ==========`)
  console.log(`anchor(${it.anchor.length}): ${it.anchor.slice(0, 180)}…`)
  for (let i = 0; i < (it.patches || []).length; i++) {
    console.log(`patch${i}(${(it.patches[i] || '').length}): ${(it.patches[i] || '').slice(0, 140)}…`)
  }
  console.log(`target(${it.target.length}): ${it.target.slice(0, 200)}…`)
}

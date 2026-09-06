// 输出关键样本的全序下标（batches 展开顺序）
import { readFileSync } from 'node:fs'
const ds = JSON.parse(readFileSync('D:/deepseek-plugin/datasets/discriminator-batches.json', 'utf8'))
const all = []
for (const b of ds.batches || []) for (const it of b.items || []) all.push(it)
const short = s => { const m = String(s).match(/session-([0-9a-f]{8})-/); return m ? m[1] : String(s).slice(0, 8) }
const want = ['17eeebba:61', '17eeebba:64', 'b5f92412:64', '17eeebba:46']
let i = 0
for (const it of all) {
  const k = `${short(it.sid)}:${it.u}`
  if (want.includes(k)) console.log(`index=${i}  ${k}  flip=${it.flip}  target=${it.target.slice(0, 40)}`)
  i++
}
console.log('total', all.length)

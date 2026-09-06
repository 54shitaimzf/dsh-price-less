import { readFileSync } from 'node:fs'
const ds = JSON.parse(readFileSync('datasets/discriminator-batches.json', 'utf8'))
const items = []
for (const b of ds.batches || []) for (const it of b.items || []) items.push(it)
// 找一个真实翻转：当前会话 u=69（重构判别器）与 u=34（从咨询转向实现）
for (const it of items) {
  if (String(it.sid).includes('17eeebba') && it.u === 69) {
    console.log('SID:', it.sid.slice(0, 70))
    console.log('FLIP:', it.flip, 'U:', it.u)
    console.log('---ANCHOR---')
    console.log(it.anchor)
    console.log('---PATCHES---')
    for (const p of it.patches) { console.log('[p]', p); console.log() }
    console.log('---TARGET---')
    console.log(it.target)
    break
  }
}

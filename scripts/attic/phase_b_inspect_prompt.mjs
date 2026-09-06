import { readFileSync } from 'node:fs'
const data = JSON.parse(readFileSync('datasets/discriminator-batches.json', 'utf8'))
const rule = readFileSync('datasets/prompt-discriminator-v1.txt', 'utf8')
function buildPrompt(items) {
  const parts = items.map((it, i) => {
    const h = (it.patches && it.patches.length ? it.patches.join('\n') : '(空)')
    return '[' + (i + 1) + ']\n<anchor>' + it.anchor + '</anchor>\n<history>' + h + '</history>\n<target>' + it.target + '</target>'
  })
  return rule + '\n\n以下是待判消息（' + items.length + ' 条）：\n' + parts.join('\n\n') +
    '\n\n按上述顺序输出一个 JSON 数组，每项形如 {"decision":"continue"|"new_task","label":"仅 new_task 时的一句话标签，≤12字，否则空串","reason":"半句话依据，≤20字"}。只输出 JSON 数组，不要任何其他文本。'
}
const lens = []
for (const b of data.batches) lens.push(buildPrompt(b.items).length)
console.log('batches:', data.batches.length)
console.log('prompt lens: min', Math.min(...lens), 'max', Math.max(...lens), 'avg', Math.round(lens.reduce((a, b) => a + b, 0) / lens.length))
console.log('total all batches chars:', lens.reduce((a, b) => a + b, 0))
const p0 = buildPrompt(data.batches[0].items)
console.log('--- batch0 prompt (first 1400 chars) ---')
console.log(p0.slice(0, 1400))
console.log('--- batch0 prompt (last 500 chars) ---')
console.log(p0.slice(-500))
// 检查消息文本里是否含标签字面量（会破坏结构）
let tagHits = 0
for (const b of data.batches) {
  for (const it of b.items) {
    const arrs = [it.anchor, it.patches, it.target].flat()
    for (const t of arrs) {
      if (typeof t === 'string' && /<\/?(anchor|history|target)>/.test(t)) tagHits++
    }
  }
}
console.log('items containing literal <anchor>/<target> tags:', tagHits)
// 异常长消息统计（>1500 字符的文本字段）
let longFields = 0
const longSamples = []
for (const b of data.batches) {
  for (const it of b.items) {
    for (const [k, v] of Object.entries({ anchor: it.anchor, patches: it.patches, target: it.target })) {
      for (const t of (Array.isArray(v) ? v : [v])) {
        if (typeof t === 'string' && t.length > 1500) {
          longFields++
          if (longSamples.length < 5) longSamples.push({ sid: it.sid.slice(0, 8), u: it.u, k, len: t.length, head: t.slice(0, 120) })
        }
      }
    }
  }
}
console.log('fields >1500 chars:', longFields)
for (const s of longSamples) console.log(JSON.stringify(s))
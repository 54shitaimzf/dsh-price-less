import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
const ss = 'C:/Users/Administrator/.dsh/sessions'
const groups = ['--D-deepseek-plugin--', '--C-Users-Administrator-Desktop-card_sample--', '--C-Users-Administrator-Desktop-Chinese-Resume-in-Typst--', '--C-Users-Administrator-Desktop-RootUp--']
const files = []
for (const g of groups) {
  const base = ss + '/' + g
  if (!existsSync(base)) continue
  for (const dir of readdirSync(base)) {
    const f = base + '/' + dir + '/session.jsonl.zstd'
    if (existsSync(f)) files.push(f)
  }
}
console.log('zstd files:', files.length)
const pats = [
  ['policy-changed', /approval policy changed/i],
  ['changed-by-user', /changed by the user/i],
  ['approval-policy', /approval policy/i],
  ['permission-preset', /permission preset/i],
  ['model-selection', /model selection/i],
]
const hits = {}
const samples = []
for (const f of files) {
  const text = execFileSync('zstd', ['-d', '-c', f], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  for (const l of text.split('\n')) {
    if (!l.includes('"type":"user/message"')) continue
    if (!/"kind":"user"/.test(l)) continue
    const m = l.match(/"text":"((?:[^"\\]|\\.)*)"/)
    if (!m) continue
    let t
    try { t = JSON.parse('"' + m[1] + '"') } catch { continue }
    for (const [k, re] of pats) {
      if (re.test(t)) {
        hits[k] = (hits[k] || 0) + 1
        if (samples.length < 10 && !samples.some(s => s.k === k)) samples.push({ k, sid: f.split(/[\\/]/).slice(-2)[0], head: t.slice(0, 130) })
      }
    }
  }
}
console.log('kind=user system-semantic hits:', JSON.stringify(hits))
for (const s of samples) console.log(JSON.stringify(s))
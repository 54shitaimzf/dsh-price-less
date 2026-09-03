import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

function cred(name) {
  if (process.env[name]) return process.env[name]
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const m = text.match(new RegExp('^\\s+' + name + ':\\s*(.*)$', 'm'))
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
  } catch { return '' }
}

const key = cred('OPENCODE_GO_API_KEY')
const base = process.env.EVAL_GROUND_BASEURL ?? 'https://opencode.ai/zen/go/v1'
console.log('base:', base)
for (const pathE of ['/models', '/v1/models']) {
  try {
    const r = await fetch(base + pathE, { headers: { authorization: 'Bearer ' + key } })
    console.log(`GET ${pathE} → status ${r.status}`)
    if (r.ok) console.log((await r.text()).slice(0, 3000))
    else console.log((await r.text()).slice(0, 500))
  } catch (e) {
    console.log(`GET ${pathE} error: ${e.message}`)
  }
}

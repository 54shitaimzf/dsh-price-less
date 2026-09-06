/**
 * phase_b_scan_sessions：枚举 ~/.dsh/sessions 全部会话，提取标题/创建时间/首两条用户消息前缀，
 * 用于识别验证器（判别 prompt 会话）与用户真实会话，区分"未分组残余"。
 * 运行：node scripts/phase_b_scan_sessions.mjs
 */
import { readdirSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const SS_ROOT = 'C:/Users/Administrator/.dsh/sessions'
const CURRENT = process.env.DSH_SESSION_ID ?? '(unknown)'

const groups = readdirSync(SS_ROOT).filter(g => !g.startsWith('.'))
let count = 0
for (const g of groups) {
  const gp = `${SS_ROOT}/${g}`
  const ids = readdirSync(gp).filter(d => existsSync(`${gp}/${d}/session.jsonl.zstd`))
  for (const id of ids) {
    count++
    const zst = `${gp}/${id}/session.jsonl.zstd`
    let meta = {}
    let firstUsers = []
    let marker = ''
    try {
      const text = execFileSync('zstd', ['-d', '-c', zst], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })
      const lines = text.split('\n')
      for (const l of lines) {
        if (l.trim().length === 0) continue
        let o = null
        try { o = JSON.parse(l) } catch { continue }
        if (!o || !o.type) continue
        if (o.type === 'meta') { meta = o; continue }
        if (o.type === 'user/message' && o.data && o.data.content) {
          const txt = (o.data.content).filter(b => b.type === 'text').map(b => b.text).join('')
          firstUsers.push(txt.slice(0, 120).replace(/\s+/g, ' '))
          if (firstUsers.length >= 2) break
        }
      }
      if (firstUsers.some(t => t.includes('<anchor>') || t.includes('会话任务边界判别器'))) marker = ' <<< DISC-PROMPT'
      if (String(meta.agentPreset ?? '').includes('discriminator')) marker += ' [preset=discriminator]'
    } catch (e) {
      marker = ` [read-error ${String(e.message ?? e).slice(0, 60)}]`
    }
    const cur = id === CURRENT ? ' <<< CURRENT' : ''
    console.log(`${id}${cur}${marker}`)
    console.log(`   title=${JSON.stringify(meta.title ?? null)} createdAt=${meta.createdAt ?? '?'} mtime=${statSync(zst).mtime.toISOString()}`)
    console.log(`   u0=${JSON.stringify(firstUsers[0] ?? null)}`)
    if (firstUsers[1]) console.log(`   u1=${JSON.stringify(firstUsers[1])}`)
    console.log(`   group=${g}`)
    console.log('')
  }
}
console.log(`TOTAL ${count} sessions`)

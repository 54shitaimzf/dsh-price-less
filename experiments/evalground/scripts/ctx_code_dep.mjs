// F12 前置实证（续）：动手时刻的"携带 vs 需要"分析。
// 代理一：同路径重复读（除最新外全部可证伪为陈旧副本）
// 代理二：他文件代码占比（对当前写入步非必需——写入只消费目标文件）
// 代理三：模型自发重读（内容已在上下文仍重读 = 模型偏好新鲜副本的 revealed preference）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RUNS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [
  'CASCADE-native-auto-mtnay1ej',
  'CASCADE-manual-habit-mtnd4kzy',
  'CASCADE-self-s1-orig-mtng8ctd',
  'CASCADE-self-s1-expand-mtnkh2qm',
]
const ROOT = new URL('../runs/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b?.text ?? '').join('') : ''
const nameOf = (c) => c?.function?.name ?? c?.name ?? null
const argPath = (argsStr) => { try { return JSON.parse(argsStr)?.path ?? null } catch { return null } }

for (const run of RUNS) {
  const calls = readFileSync(join(ROOT, run, 'calls.jsonl'), 'utf8').split('\n')
    .filter(l => l.trim()).map(l => JSON.parse(l))
    .filter(r => /evaluation workspace/.test(String(r.req?.messages?.[0]?.content ?? '')))
  const writeMoments = []   // 每次写入决策时刻的上下文解剖
  let readCalls = 0, reReads = 0, reReadRefetchedChars = 0
  let idx = 0
  for (const r of calls) {
    const msgs = r.req.messages
    const id2info = new Map()       // call_id -> {name, path}
    const pathCopies = new Map()    // path -> [{chars, enteredAt}]（本请求上下文中的 read 副本）
    const seenInReq = new Set()     // 本请求中已出现过的 path（用于重读判定）
    let codeChars = 0
    for (const m of msgs) {
      if (m.role === 'assistant') {
        const tc = m.tool_calls ?? m.toolCalls
        if (Array.isArray(tc)) for (const c of tc) {
          const n = nameOf(c)
          if (n && c.id) id2info.set(c.id, { name: n, path: argPath(c.function?.arguments ?? c.args ?? '{}') })
        }
      }
      const chars = textOf(m.content).length
      if (m.role === 'tool') {
        const info = id2info.get(m.tool_call_id)
        if (info?.name === 'read' && info.path) {
          codeChars += chars
          if (!pathCopies.has(info.path)) pathCopies.set(info.path, [])
          pathCopies.get(info.path).push({ chars, enteredAt: idx })
          // 代理三：本请求前面已有该 path 的读取，此刻又出现一次 read 结果 = 重读
          if (seenInReq.has(info.path)) { reReads++; reReadRefetchedChars += chars }
          seenInReq.add(info.path)
        }
      }
    }
    // 响应中的写入决策（本请求上下文 = 模型做写决策时可见的一切）
    for (const c of (r.resp?.toolCalls ?? [])) {
      if (nameOf(c) !== 'write') continue
      const p = argPath(c.args)
      const copies = pathCopies.get(p) ?? []
      const latest = copies.length ? copies[copies.length - 1] : { chars: 0, enteredAt: idx }
      const dupChars = copies.slice(0, -1).reduce((s, x) => s + x.chars, 0)
      const samePath = copies.reduce((s, x) => s + x.chars, 0)
      writeMoments.push({
        path: p, codeChars,
        latestOwn: latest.chars, latestAge: idx - latest.enteredAt,
        samePath, dupChars, otherChars: codeChars - samePath,
        copiesOfPath: copies.length,
      })
    }
    readCalls += [...id2info.values()].filter(v => v.name === 'read').length
    idx++
  }
  const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2) }
  const pct = (n, d) => d > 0 ? +(100 * n / d).toFixed(1) : 0
  const n = writeMoments.length
  console.log(`\n== ${run} ==`)
  if (!n) { console.log('  (无 write 事件)'); continue }
  const sum = (k) => writeMoments.reduce((s, w) => s + w[k], 0)
  console.log(`  写入决策 n=${n}`)
  console.log(`  代理一 同路径重复读：陈旧副本占代码原文 ${pct(sum('dupChars'), sum('codeChars'))}%（中位/次 ${med(writeMoments.map(w => w.dupChars))} tok 字符级 ${(sum('dupChars') / n / 1000).toFixed(1)}K chars）`)
  console.log(`  代理二 他文件占比：  写目标文件自身 ${pct(sum('samePath'), sum('codeChars'))}%，他文件 ${pct(sum('otherChars'), sum('codeChars'))}%（中位/次 ${(sum('otherChars') / n / 1000).toFixed(1)}K chars）`)
  console.log(`  写时目标文件副本数： 中位 ${med(writeMoments.map(w => w.copiesOfPath))}；最新读年龄 中位 ${med(writeMoments.map(w => w.latestAge))} 步`)
  console.log(`  代理三 自发重读：    read 调用 ${readCalls} 次中 ${reReads} 次为"内容已在上下文仍重读"（${pct(reReads, readCalls)}%），重拉 ${(reReadRefetchedChars / 1000).toFixed(1)}K chars`)
}

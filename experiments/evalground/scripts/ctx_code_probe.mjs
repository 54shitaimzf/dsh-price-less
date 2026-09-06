// F12 前置实证（EXPERIMENT.md §10.5）：动手操作时刻，上下文中的代码原文含量。
// 定义：代码原文 = read 类工具结果的字符量（文件内容）；动手 = write 类调用。
// 标定：每请求用自身 usage.inputTokens / 全消息字符数 得到 charsPerTok 比例，
//       再把 read 字符数换算成 tokens（比全局常数更贴近每 run 的真实密度）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RUNS = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : [
      'CASCADE-native-auto-mtnay1ej',
      'CASCADE-manual-habit-mtnd4kzy',
      'CASCADE-self-s1-orig-mtng8ctd',
      'CASCADE-self-s1-expand-mtnkh2qm',
    ]
const ROOT = new URL('../runs/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c)
  ? c.map(b => b?.text ?? '').join('') : ''
const toolNameOf = (wireCall) => wireCall?.function?.name ?? wireCall?.name ?? null

function analyzeRun(run) {
  const file = join(ROOT, run, 'calls.jsonl')
  const calls = readFileSync(file, 'utf8').split('\n').filter(l => l.trim())
    .map(l => JSON.parse(l))
    .filter(r => /evaluation workspace/.test(String(r.req?.messages?.[0]?.content ?? '')))
  const events = [] // {task, write:bool, codeChars, totalChars, inputTokens}
  for (const r of calls) {
    const msgs = r.req.messages
    let codeChars = 0, totalChars = 0, users = 0
    const id2name = new Map()
    for (const m of msgs) {
      if (m.role === 'user') users++
      if (m.role === 'assistant') {
        const tc = m.tool_calls ?? m.toolCalls
        if (Array.isArray(tc)) for (const c of tc) {
          const n = toolNameOf(c)
          if (n && c.id) id2name.set(c.id, n)
        }
      }
      const chars = textOf(m.content).length
      totalChars += chars
      if (m.role === 'tool' && id2name.get(m.tool_call_id) === 'read') codeChars += chars
    }
    const writes = (r.resp?.toolCalls ?? []).filter(c => toolNameOf(c) === 'write').length
    events.push({ task: users, write: writes > 0, codeChars, totalChars, inputTokens: r.resp?.usage?.inputTokens ?? 0 })
  }
  return events
}

const tok = (chars, ratio) => ratio > 0 ? Math.round(chars / ratio) : 0
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2) }

for (const run of RUNS) {
  const ev = analyzeRun(run)
  // 每个 task 的首次 write 时刻
  const firstWrite = new Map()
  const allWrites = []
  for (const e of ev) {
    if (!e.write || e.inputTokens === 0) continue
    const ratio = e.totalChars / e.inputTokens
    const codeTok = tok(e.codeChars, ratio)
    const rec = { codeTok, pct: +(100 * codeTok / e.inputTokens).toFixed(1) }
    allWrites.push(rec)
    if (!firstWrite.has(e.task)) firstWrite.set(e.task, { ...rec, prompt: e.inputTokens })
  }
  console.log(`\n== ${run} ==  executor calls=${ev.length}`)
  const rows = [...firstWrite.entries()].sort((a, b) => a[0] - b[0])
    .map(([t, r]) => `  task#${t}: 首次动手 code≈${r.codeTok} tok (${r.pct}% of ${r.prompt})`)
  console.log(rows.join('\n'))
  if (allWrites.length) {
    const cts = allWrites.map(w => w.codeTok)
    const pcts = allWrites.map(w => w.pct)
    console.log(`  所有动手时刻 n=${allWrites.length}: code tok 中位=${med(cts)} min=${Math.min(...cts)} max=${Math.max(...cts)} | 占请求%中位=${med(pcts)}`)
  }
}

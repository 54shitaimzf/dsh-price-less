// phase_b_debug_analysis.mjs
// 调查：从 7 个 raw 运行中提取"错误项 + 判别理由（v1 有 reason）"，寻找跨模型共性错误模式。
// 输出两段：①跨模型一致错误 ②每个 v1 模型的错误项 reason 全表。
import { readFileSync } from 'node:fs'
const RAW = 'D:/deepseek-plugin/reports/phase-b-raw'
const files = ['dsv4-flash.json', 'glm53-flash.json', 'minimax-m3.json', 'mimo-v2.5.json', 'v2-minimax-m3.json', 'v2-v4-flash.json', 'hy3-v2.json']
const runs = []
for (const f of files) {
  const j = JSON.parse(readFileSync(`${RAW}/${f}`, 'utf8'))
  const tag = (j.prompt === 'v2' || f.startsWith('v2-') || f.startsWith('hy3')) ? 'v2' : 'v1'
  runs.push({ tag, label: `${f.replace('.json', '')}`, model: j.model, items: j.items })
}
const short = m => m
// 每项记录错与对
function mark(items) {
  const out = new Map()
  for (const it of items) {
    if (it.error) continue
    const got = it.decision === 'new_task' ? 'new_task' : it.decision === 'continue' ? 'continue' : null
    if (got === null) continue
    const wrong = got !== (it.flip ? 'new_task' : 'continue')
    out.set(`${it.sid}:${it.u}`, { ...it, got, wrong })
  }
  return out
}
const marked = runs.map(r => ({ ...r, m: mark(r.items) }))
// 全序条目集合
const allKeys = new Set()
for (const r of marked) for (const k of r.m.keys()) allKeys.add(k)
// 每个 v1 运行单独给 reason 映射（v1 才有）
const reasonByKey = {}
for (const r of runs.filter(x => x.tag === 'v1')) {
  for (const it of r.items) {
    const k = `${it.sid}:${it.u}`
    reasonByKey[k] = reasonByKey[k] || []
    if (it.reason) reasonByKey[k].push(`${r.model}: ${it.reason}`)
  }
}
// ── 跨模型一致错误（≥3 运行同错，且含 v1 理由）──
console.log('===== ① 跨模型一致错误（≥3 个运行在同一个 (sid,u) 上判错） =====')
const rows = []
for (const k of allKeys) {
  const votes = marked.map(r => r.m.get(k)).filter(Boolean)
  const wrongs = votes.filter(v => v.wrong)
  if (wrongs.length >= 3) {
    const flip = votes[0].flip
    rows.push({ k, flip, wrongCount: wrongs.length,
      decisions: marked.map(r => { const v = r.m.get(k); return v ? `${v.got === 'new_task' ? 'N' : 'C'}${v.wrong ? '✗' : ''}` : '-' }).join(' '),
      labels: marked.map(r => r.label).join(' | '),
      reasons: reasonByKey[k] || [] })
  }
}
rows.sort((a, b) => b.wrongCount - a.wrongCount)
for (const r of rows) {
  console.log(`\n— ${r.k}  GT=${r.flip ? 'new_task' : 'continue'}  同错模型数=${r.wrongCount}/7`)
  console.log(`  判定(方向+错标): ${r.decisions}`)
  if (r.reasons.length) { console.log('  v1 理由:'); for (const rs of r.reasons) console.log('    · ' + rs) }
}
// ── 按 u 汇总所有错误位的判定向量 ──
console.log('\n\n===== ② 每个 v1 模型错误项 reason 全表 =====')
for (const r of marked.filter(x => x.tag === 'v1')) {
  const errs = [...r.m.values()].filter(v => v.wrong)
  console.log(`\n——— ${r.label}（v1）错误 ${errs.length} 条 ———`)
  for (const e of errs) {
    console.log(`  ${e.sid}:${e.u}  GT=${e.flip ? 'new_task' : 'continue'} → 判${e.got}  「${e.reason ?? '(无理由)'}」`)
  }
}
// ── ③ v1 理由高频信号词统计（正确 vs 错误）──
console.log('\n\n===== ③ v1 理由措辞信号词（正确项 vs 错误项的出现率） =====')
const words = ['继续', '延续', '追问', '同一', '转向', '新', '切换', '实现', '讨论', '测试', '细节', '推进', '完成']
const stat = {}
for (const w of words) stat[w] = { good: 0, goodTotal: 0, bad: 0, badTotal: 0 }
for (const r of marked.filter(x => x.tag === 'v1')) {
  for (const v of r.m.values()) {
    const txt = v.reason || ''
    for (const w of words) {
      const hit = txt.includes(w)
      if (v.wrong) { stat[w].bad++; stat[w].badTotal++ } else { stat[w].good++; stat[w].goodTotal++ }
      /* 记录命中 */
      if (hit) { v['w_' + w] = true }
    }
  }
}
for (const w of words) {
  let g = 0, b = 0
  for (const r of marked.filter(x => x.tag === 'v1')) {
    for (const v of r.m.values()) {
      if (v['w_' + w]) { if (v.wrong) b++; else g++ }
    }
  }
  console.log(`  ${w}: 错误项中 ${b} 条 / 正确项中 ${g} 条`)
}

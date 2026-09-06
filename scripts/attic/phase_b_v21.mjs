// phase_b_v21.mjs —— v2 → v2.1 配对 Δ 汇总（读落盘账本）
// 输出：每模型 acc/flip/nonFlip Δ + 逐条判定变化 + E2 12 条锚点配对（w0 vs w1）+ 成本
import { readFileSync } from 'node:fs'
const RAW = 'D:/deepseek-plugin/reports/phase-b-raw'
const short = s => { const m = String(s).match(/session-([0-9a-f]{8})-/); return m ? m[1] : String(s).slice(0, 8) }
function load(f) { const j = JSON.parse(readFileSync(`${RAW}/${f}`, 'utf8')); const m = new Map(); for (const it of j.items) { if (it.decision) m.set(`${short(it.sid)}:${it.u}`, { flip: !!it.flip, got: it.decision, tokens: (it.inputTokens || 0) + (it.outputTokens || 0) + (it.cacheReadTokens || 0) }) } return { j, m } }
const pairs = [
  { name: 'minimax-m3', base: 'v2-minimax-m3.json', v21: 'v2_1-minimax-m3.json' },
  { name: 'deepseek-v4-flash', base: 'v2-v4-flash.json', v21: 'v2_1-deepseek-v4-flash.json' },
  { name: 'hy3', base: 'hy3-v2.json', v21: 'v2_1-hy3.json' },
]
console.log('########## 臂 A：v2.1 × 原窗 × 52（配对 Δ，落盘账本版） ##########')
for (const p of pairs) {
  const b = load(p.base), n = load(p.v21)
  const keys = [...b.m.keys()].filter(k => n.m.has(k))
  let flipUp = 0, flipDown = 0, nonUp = 0, nonDown = 0, bett = 0, wors = 0
  const changes = []
  for (const k of keys) {
    const bv = b.m.get(k), nv = n.m.get(k)
    const bGood = bv.got === (bv.flip ? 'new_task' : 'continue')
    const nGood = nv.got === (nv.flip ? 'new_task' : 'continue')
    if (bGood && !nGood) { wors++; if (nv.flip) flipDown++; else nonDown++ }
    if (!bGood && nGood) { bett++; if (bv.flip) flipUp++; else nonUp++ }
    if (bGood !== nGood) changes.push(` ${k} GT=${bv.flip ? 'N' : 'C'} ${bGood ? '✓' : '✗'}→${nGood ? '✓' : '✗'} (v2:${bv.got === 'new_task' ? 'N' : 'C'} → v2.1:${nv.got === 'new_task' ? 'N' : 'C'})`)
  }
  const s = n.j.summary, bs = b.j.summary
  console.log(`\n— ${p.name}`)
  console.log(`  acc: ${bs.accuracy} → ${s.accuracy} (Δ${(s.accuracy - bs.accuracy).toFixed(4)}) | flip: ${bs.flipAccuracy} → ${s.flipAccuracy} | nonFlip: ${bs.nonFlipAccuracy} → ${s.nonFlipAccuracy}`)
  console.log(`  修好 ${bett} 条（flip +${flipUp} / 非翻转 +${nonUp}）｜ 变坏 ${wors} 条（flip −${flipDown} / 非翻转 −${nonDown}）`)
  if (changes.length) { console.log('  逐条变化:'); changes.forEach(c => console.log(c)) }
}
// 锚点 A/B：E2 12 条（alts 序同主序），从臂 A 的 52 条提取同 12 条 + alts 运行
console.log('\n\n########## 臂 B：锚点 A/B（E2 12 条 × minimax/v4，v2.1） ##########')
const altFiles = ['v2_1-minimax-m3-alt.json', 'v2_1-deepseek-v4-flash-alt.json']
const altAll = confirm => { const j = JSON.parse(readFileSync(`${RAW}/${confirm}`, 'utf8')); const m = new Map(); for (const it of j.items) m.set(`${short(it.sid)}:${it.u}`, { flip: !!it.flip, got: it.decision }); return m }
for (const p of pairs.filter(x => x.name !== 'hy3')) {
  const w0 = load(p.v21).m
  const w1 = altAll(`v2_1-${p.name}-alt.json`)
  console.log(`\n— ${p.name}`)
  for (const [k, v] of w1) {
    const a = w0.get(k)
    const aGood = a && a.got === (v.flip ? 'new_task' : 'continue')
    const bGood = v.got === (v.flip ? 'new_task' : 'continue')
    console.log(` ${k} GT=${v.flip ? 'N' : 'C'} w0(原锚)=${a ? (aGood ? '✓' : '✗') : '?'}(${a ? (a.got === 'new_task' ? 'N' : 'C') : '-'}) w1(近锚)=${bGood ? '✓' : '✗'}(${v.got === 'new_task' ? 'N' : 'C'})`)
  }
}

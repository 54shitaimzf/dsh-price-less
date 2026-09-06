/**
 * probe21：按"压缩后的上下文断裂"重评——每条切割后，有多少后续内容需要引用被压在切割点之前的上下文。
 *
 * 目的（用户重构）：切割是为了"及时压缩无效信息、切断跨任务依赖、避免复利"。但若在错误处切割，
 * 会把【仍属于当前任务的上下文】压掉——导致后续消息无法引用被压掉的锚点，要么重新提供（token↑），
 * 要么理解链失准。本 probe 量化这个代价。
 *
 * 方法（词法参考代理，明确是近似）：
 *   每条消息抽取"锚点"（路径 / URL / @文件 / 含连字符或数字的标识符 / 配置键 / 容器名）。
 *   任一条消息 m 之后，设最近一次切割 c(m)。m 中一个锚点若【最后一次出现在 <c(m) 处】，则该锚点
 *   属于 c(m) 之前的上下文（已被压缩），m 依赖它 → m 是"被孤儿化"的消息。
 *   只对"切割点之后的区域"统计（消息位置大于最近切割 c，即新任务区）。
 *   分开统计：① 所有孤儿化消息；② 用户追问（user 消息）被孤儿化数；③ 由"误切(false cut)"导致的
 *   孤儿 vs 由"真切(true cut)"导致；④ 每误切的平均孤儿消息数（一次错误切割的破坏半径）；
 *   ⑤ token 代理 = 孤儿化用户追问的文本长度之和（需重新提供的量）。
 *
 * 对照：gold = 只在我手标的真反转处切（无误切，孤儿应≈0），no-cut = 0 切割（无孤儿也无效益）。
 * 运行：node scripts/embed_probe21.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

// 手标 coarse 标签（U 下标）+ 每会话 preds（同 probe19/20 一轮，stable）
const GT = {
  '0ff3015a': [1, 4, 8, 12, 20, 38, 60, 71, 80], '3de11a0d': [2, 4, 6, 8, 29, 55, 90],
  '30a284c6': [1, 2, 3, 16, 22, 30, 40, 41], '74d9a434': [2, 3, 8, 11, 13, 20, 22],
  'e385bda2': [1, 8, 9, 17], '9c2090f7': [1, 7, 8, 22, 27],
}
const PREDS = {
  'trained': { '0ff3015a': [0, 2, 7, 18, 62, 66, 69, 74], '3de11a0d': [0, 43, 51, 79, 85], '30a284c6': [0, 2, 21], '74d9a434': [0, 10, 13, 16], 'e385bda2': [0, 2], '9c2090f7': [0, 8, 15, 30] },
  'raw': { '0ff3015a': [0, 3, 9, 60, 74], '3de11a0d': [0, 17, 22, 37, 65, 71, 73, 75], '30a284c6': [0, 2, 15, 22, 27, 29], '74d9a434': [0, 10, 12, 13, 14, 17, 22], 'e385bda2': [0, 2, 15], '9c2090f7': [0, 3, 9, 16, 21, 23, 32] },
  'mech': { '0ff3015a': [0, 3, 12, 19, 20, 34, 36, 42, 43, 47, 48, 65, 68, 70, 79], '3de11a0d': [0, 3, 20, 30, 40, 48, 51, 54, 55, 56, 70, 77, 84, 88, 90], '30a284c6': [0, 2, 5, 20, 26, 28, 29], '74d9a434': [0, 8, 12, 15, 16, 19], 'e385bda2': [0, 3, 8, 9, 18, 19], '9c2090f7': [0, 8, 10, 15, 20, 21, 23, 26, 35] },
}
const NAME = { trained: '训练后嵌入', raw: '原始嵌入', mech: '机械' }
const SINGLE = new Set(['50a530d3', '66439e33', '16a37d85', '6a1db62e'])

// 读 shard -> 每会话 msgs（{role,text}，同 probe19 流）
const lines = readFileSync('datasets/claudeset_shard.jsonl', 'utf8').split('\n').filter(Boolean)
const db = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(o => Array.isArray(o.turns))
const byId = new Map(db.map(s => [s.id, s]))
const byPrefix = new Map(db.map(s => [s.id.slice(0, 8), s]))
function buildMsgs(sid) { const s = byPrefix.get(sid) || byId.get(sid); const msgs = []; s.turns.forEach(t => { if (t.type === 'exchange' && (t.user || t.assistant?.text)) msgs.push({ role: t.user ? 'user' : 'assistant', text: String(t.user ?? t.assistant.text) }) }); return msgs }
function usIdxOf(sid) { const s = byPrefix.get(sid) || byId.get(sid); const usIdx = []; let idx = 0; s.turns.forEach(t => { if (t.type === 'exchange' && (t.user || t.assistant?.text)) { if (t.user) usIdx.push(idx); idx++ } }); return usIdx }

// 锚点抽取（词法代理）
function anchors(text) {
  const t = String(text || ''); const set = new Set()
  ;((t.match(/[A-Za-z0-9_.~\-]*(?:\/[A-Za-z0-9_.\-]+)+/g)) || []).forEach(x => set.add('P:' + x)) // 路径
  ;((t.match(/@[A-Za-z0-9_.\-]+/g)) || []).forEach(x => set.add('A:' + x)) // @文件
  ;((t.match(/https?:\/\/[^\s"'<>]+/g)) || []).forEach(x => set.add('U:' + x)) // url
  ;((t.match(/[A-Za-z0-9][A-Za-z0-9_\-]{3,}/g)) || []).forEach(x => { if (/[_-]/.test(x) || /\d/.test(x)) set.add('K:' + x) }) // 键/标识符/容器名/版本
  return set
}

// 对会话：给定切割点集合 cuts（>0，已在消息流下标，含真实语义），返回孤儿统计
function analyze(msgs, cuts, gtForTrue) {
  const gtset = new Set(gtForTrue)
  const total = msgs.length
  // cut>0 且 <total-1 才真正产生"后续区域"（0=会话起点不产生，末端无后续）
  const realCuts = cuts.filter(c => c > 0 && c < total - 1).sort((a, b) => a - b)
  // 每个位置的"最近切割"
  const recentCut = new Array(total).fill(0)
  for (let i = 1; i < total; i++) { recentCut[i] = recentCut[i - 1]; if (realCuts.includes(i - 1)) recentCut[i] = i - 1 }
  // 记录每个锚点出现的位置
  const pos = new Map(); const mAnch = []
  msgs.forEach((m, i) => { const a = anchors(m.text); mAnch.push(a); for (const x of a) { if (!pos.has(x)) pos.set(x, []); pos.get(x).push(i) } })
  // 对每个消息，找孤儿锚点
  let orphanMsgs = 0, orphanUser = 0, orphanTokenByCut = 0, falseOrphan = 0, trueOrphan = 0, userLenSum = 0
  const perCut = [] // {cut, isTrue, orphanMsgs}
  for (const c of realCuts) perCut.push({ cut: c, isTrue: gtset.has(c) || gtset.has(c + 1) || gtset.has(c - 1) || gtset.has(c + 2) || gtset.has(c - 2), orphanMsgs: 0 })
  for (let i = 0; i < total; i++) {
    const c = recentCut[i]
    if (c <= 0) continue // 切割点之前/会话起点不统计
    if (i - c > 60) break // 每切割只看其后一个合理窗口，避免长尾干扰
    const A = mAnch[i]
    let orphan = 0
    for (const x of A) { const p = pos.get(x); let last = -1; for (const q of p) { if (q < i) last = q; else break } if (last >= 0 && last < c) orphan++ } // 最后一次出现在切割前
    if (orphan > 0) {
      orphanMsgs++; if (msgs[i].role === 'user') { orphanUser++; userLenSum += msgs[i].text.length }
      const pc = perCut.find(o => o.cut === c); if (pc) { pc.orphanMsgs += 1; if (pc.isTrue) trueOrphan++; else falseOrphan++ }
    }
  }
  // 每误切平均孤儿
  const falseCuts = perCut.filter(o => !o.isTrue).length
  const avgPerFalse = falseCuts ? perCut.filter(o => !o.isTrue).reduce((a, o) => a + o.orphanMsgs, 0) / falseCuts : 0
  return { realCuts: realCuts.length, falseCuts, trueCuts: perCut.filter(o => o.isTrue).length, orphanMsgs, orphanUser, falseOrphan, trueOrphan, avgPerFalse, userLenSum }
}

const fmt = x => (x === null || x === undefined ? '-' : (+x).toFixed(2))
const rep = []
rep.push('# probe21：按"压缩后上下文断裂"重评（错切导致的孤儿化 / 追问被压 / token↑ / 理解链失准）')
rep.push('')
rep.push('> 目的：切割是（及时压缩+切断跨任务依赖+避免复利）；但错切会压下【仍属于当前任务的上下文】，')
rep.push('> 使后续消息无法引用 → 要么重新提供(token↑)、要么理解链失准。本 probe 量化这个代价。')
rep.push('> 方法：词法锚点代理——消息引用一个"只出现在切割点之前"的锚点(路径/URL/配置键/标识符)即视为孤儿化。')
rep.push('> 对照：gold(只在手标真反转切) 应孤儿≈0；no-cut(0切割) 无孤儿也无效益。')
rep.push('')

// 每个 arm 汇总（多意图会话）
rep.push('## 每条臂的上下文断裂代价（多意图会话合计）')
rep.push('')
rep.push('| 系统 | 真实切割 | 误切 | 孤儿化消息 | 孤儿化用户追问 | 误切导致孤儿 | 每误切平均孤儿 | 追问token代理(字符) |')
rep.push('|---|---|---|---|---|---|---|---|')
for (const arm of ['trained', 'raw', 'mech']) {
  let real = 0, fc = 0, tc = 0, om = 0, ou = 0, fo = 0, to = 0, perF = 0, us = 0
  for (const sid of Object.keys(GT)) {
    const msgs = buildMsgs(sid)
    const gtMsg = GT[sid].map(u => usIdxOf(sid)[u]).filter(x => x !== undefined)
    const r = analyze(msgs, PREDS[arm][sid], gtMsg)
    real += r.realCuts; fc += r.falseCuts; tc += r.trueCuts; om += r.orphanMsgs; ou += r.orphanUser; fo += r.falseOrphan; to += r.trueOrphan; perF += r.avgPerFalse * r.falseCuts; us += r.userLenSum
  }
  const avgF = fc ? perF / fc : 0
  rep.push(`| ${NAME[arm]} | ${real} | ${fc} | ${om} | ${ou} | ${fo} | ${fmt(avgF)} | ${us} |`)
}
rep.push('')

// 对照
rep.push('## 对照：gold / no-cut')
rep.push('')
{
  let real = 0, fc = 0, tc = 0, om = 0, ou = 0, fo = 0, to = 0, perF = 0, us = 0
  for (const sid of Object.keys(GT)) {
    const msgs = buildMsgs(sid)
    const gtMsg = GT[sid].map(u => usIdxOf(sid)[u]).filter(x => x !== undefined)
    const r = analyze(msgs, gtMsg, gtMsg) // 只有真切
    real += r.realCuts; fc += r.falseCuts; tc += r.trueCuts; om += r.orphanMsgs; ou += r.orphanUser; fo += r.falseOrphan; to += r.trueOrphan; perF += r.avgPerFalse * r.falseCuts; us += r.userLenSum
  }
  const avgF = fc ? perF / fc : 0
  rep.push(`| gold(只在真反转切) | ${real} | ${fc} | ${om} | ${ou} | ${fo} | ${fmt(avgF)} | ${us} |`)
  // no-cut
  let om2 = 0, ou2 = 0, us2 = 0
  for (const sid of Object.keys(GT)) { const msgs = buildMsgs(sid); const r = analyze(msgs, [], []); om2 += r.orphanMsgs; ou2 += r.orphanUser; us2 += r.userLenSum }
  rep.push(`| no-cut(不压缩) | 0 | 0 | ${om2} | ${ou2} | 0 | 0.00 | ${us2} |`)
}
rep.push('')

// 结论
rep.push('## 结论（用"孤儿化/上下文断裂"重评各臂可用性）')
rep.push('')
rep.push('待填写：见控制台。核心 = 哪条臂的切割用【最低的上下文断裂/孤儿化】换【最高的及时切断效益】。')
rep.push('')
writeFileSync('reports/probe21.md', rep.join('\n'))
console.log(rep.join('\n'))
console.log('\nsaved reports/probe21.md')

// 逐会话明细
console.log('\n--- 逐会话（cut / 误切 / 孤儿消息 / 孤儿追问）---')
for (const arm of ['trained', 'raw', 'mech']) {
  console.log('\n[' + NAME[arm] + ']')
  for (const sid of Object.keys(GT)) {
    const msgs = buildMsgs(sid)
    const gtMsg = GT[sid].map(u => usIdxOf(sid)[u]).filter(x => x !== undefined)
    const r = analyze(msgs, PREDS[arm][sid], gtMsg)
    console.log(`  ${sid.slice(0, 8)} cut=${r.realCuts} 误切=${r.falseCuts} 孤儿=${r.orphanMsgs} 孤儿追问=${r.orphanUser} 每误切孤儿=${fmt(r.avgPerFalse)}`)
  }
}

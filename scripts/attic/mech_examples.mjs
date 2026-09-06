/**
 * mech_examples：probe22/23 三方面效果的直观示例生成（确定性，口径与 probe23 一致）。
 * 运行：node scripts/mech_examples.mjs
 * 输出：reports/mech-examples.md
 */
import { readFileSync, writeFileSync } from 'node:fs'
import {
  canonicalizeDsh, canonicalizeClaudeset,
  loadLabelsJson, loadClaudesetLabels, resolveSessionPath,
} from './mech_replay.mjs'
import { staticFeatures } from './mech_features.mjs'
import { ARMS } from './mech_arms.mjs'
import { sessSummary } from './mech_eval.mjs'

const FINAL_CONF = {
  M0: {},
  M4: {
    w: { corr: 1.0, lex: 0.8, cluster: 0.5, todo: 0.4, cohesion: 0.6, dump: -0.2, goal: -0.3, question: 0.1, imperative: 0.15, lenratio: 0.1, toolwrite: 0.1, toolread: 0.05 },
    theta: 0.9, strongGate: false, mu: 4, sigma: 2,
  },
  M7: { w: { lex: 0.8, corr: 1.0, cluster: 0.5, todo: 0.4 }, theta: 0.5, strongGate: false },
}

const trunc = (t, n = 76) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/* ---------------- 载入 ---------------- */

const sessions = []

// 本对话（多意图，holdout）
{
  const cur = loadLabelsJson('datasets/labels/current-session.json')
  const s = canonicalizeDsh(resolveSessionPath('session-17eeebba-5666-4607-bafa-1befd583f975'), { ...cur, id: 'holdout-current' })
  s.staticF = staticFeatures(s)
  sessions.push(s)
}
// 两个单意图 holdout（本地 DSH）
{
  const ho = loadLabelsJson('datasets/labels/local-holdout.json')
  for (const lab of ho.sessions) {
    const s = canonicalizeDsh(resolveSessionPath(lab.id), lab)
    s.staticF = staticFeatures(s)
    sessions.push(s)
  }
}
// claudeset：EN 多意图（mails）+ EN 单意图（withdraw-validator）
{
  const SHARD = 'datasets/claudeset_shard.jsonl'
  const shard = readFileSync(SHARD, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const cla = loadClaudesetLabels('datasets/labels/claudeset.json')
  for (const want of ['0ff3015a', '50a530d3']) {
    const raw = shard.find(x => x.id?.startsWith(want))
    const lab = cla.get(want)
    const s = canonicalizeClaudeset(raw, lab)
    s.staticF = staticFeatures(s)
    sessions.push(s)
  }
}

/* ---------------- 工具 ---------------- */

function perFlip(us, cuts, gt) {
  const preds = cuts.filter(c => c > 0)
  return gt.map(g => {
    const near = preds.filter(p => Math.abs(p - g) <= 2)
    const best = near.length ? near.reduce((a, b) => Math.abs(b - g) < Math.abs(a - g) ? b : a) : null
    return { g, hit: best !== null, lat: best === null ? null : best - g }
  })
}

/** U 1..N 开火视图：F=翻转 C=切割 X=切在翻转上 ·=无 */
function strip(s, cuts) {
  const gt = new Set(s.gt.coarse)
  const cs = new Set(cuts)
  let out = ''
  for (let i = 1; i < s.us.length; i++) {
    const isG = gt.has(i), isC = cs.has(i)
    out += isG && isC ? 'X' : isG ? 'F' : isC ? 'C' : '·'
  }
  return out
}

/** 等距刻度尺：两行。上行 = 每 10 U 打印十位数字；下行 = 个位 0-9。 */
function ruler(N) {
  let t = '', o = ''
  for (let i = 1; i <= N; i++) {
    t += i % 10 === 0 ? String(Math.floor(i / 10) % 10) : '.'
    o += String(i % 10)
  }
  return [t, o]
}

/** 翻转 ±k 窗口位形：C=该偏移处有切割 F=翻转位置(偏移0) X=切割正落在翻转上 ·=无 */
function winStr(cuts, g, k = 3) {
  const cs = new Set(cuts)
  let out = ''
  for (let d = -k; d <= k; d++) out += cs.has(g + d) ? (d === 0 ? 'X' : 'C') : d === 0 ? 'F' : '·'
  return out
}

function flowPosToU(s) {
  const m = new Map()
  for (const u of s.us) m.set(u.flowPos, u.u)
  return m
}

/* ---------------- 汇总 ---------------- */

const A = {}
for (const [arm, cfg] of Object.entries(FINAL_CONF)) {
  A[arm] = {}
  for (const s of sessions) A[arm][s.id] = { cuts: ARMS[arm].run(s, s.staticF, cfg), sm: null }
  for (const s of sessions) A[arm][s.id].sm = sessSummary(s, A[arm][s.id].cuts)
}

const rep = []
rep.push('# mech-examples：三方面效果的直观示例')
rep.push('')
rep.push(`样本：${sessions.map(s => `${s.id}(${s.us.length}U,${s.gt.coarse.length}flip${s.single ? ',单' : ''})`).join('；')}`)
rep.push('')

/* ---------- ① 锚定：本对话 11 翻转逐点 ---------- */
{
  const cur = sessions[0]
  rep.push('## ① 锚定 · 本对话 11 个明显翻转：词面可见性 × 三臂命中')
  rep.push('')
  rep.push('| u | 翻转原文（截断） | 词面可见 | f1S/f1F/f2Lex | M0 | M4 | M7 |')
  rep.push('|---|---|---|---|---|---|---|')
  for (const g of cur.gt.coarse.filter(x => x > 0)) {
    const sf = cur.staticF[g]
    const vis = sf.f1Strong || sf.f1Fine || sf.f2Lex ? '✅' : '❌'
    const row = (arm) => {
      const pf = perFlip(cur.us, A[arm][cur.id].cuts, [g])[0]
      return pf.hit ? `✓${pf.lat >= 0 ? '+' : ''}${pf.lat}` : '✗'
    }
    rep.push(`| ${g} | ${trunc(cur.us[g].text)} | ${vis} | ${sf.f1Strong}/${sf.f1Fine}/${sf.f2Lex} | ${row('M0')} | ${row('M4')} | ${row('M7')} |`)
  }
  rep.push('')
  rep.push('### 翻转 ±3 U 窗口位形（7 位字符串：C=该偏移处切割，F=翻转位置，X=切割正中翻转，·=无）')
  rep.push('')
  rep.push('| 翻转 U | 翻转消息（截断） | M0 窗口 | M4 窗口 | M7 窗口 |')
  rep.push('|---|---|---|---|---|')
  for (const g of cur.gt.coarse.filter(x => x > 0)) {
    rep.push(`| ${g} | ${trunc(cur.us[g].text, 34)} | ${winStr(A.M0[cur.id].cuts, g)} | ${winStr(A.M4[cur.id].cuts, g)} | ${winStr(A.M7[cur.id].cuts, g)} |`)
  }
  rep.push('')
}

/* ---------- ① 锚定：EN 多意图 ---------- */
{
  const s = sessions.find(x => x.id.startsWith('0ff3015a'))
  if (s) {
    rep.push('## ① 锚定 · 英文多意图会话（mails）：M0 的"中文词典盲区"')
    rep.push('')
    rep.push('| u | 翻转原文（截断） | 词面可见 | M0 | M4 | M7 |')
    rep.push('|---|---|---|---|---|')
    for (const g of s.gt.coarse.filter(x => x > 0).slice(0, 6)) {
      const sf = s.staticF[g]
      const vis = sf.f1Strong || sf.f1Fine || sf.f2Lex ? '✅' : '❌'
      const row = (arm) => {
        const pf = perFlip(s.us, A[arm][s.id].cuts, [g])[0]
        return pf.hit ? `✓${pf.lat >= 0 ? '+' : ''}${pf.lat}` : '✗'
      }
      rep.push(`| ${g} | ${trunc(s.us[g].text)} | ${vis} | ${row('M0')} | ${row('M4')} | ${row('M7')} |`)
    }
    rep.push('')
    rep.push('### 翻转 ±3 U 窗口位形（EN 多意图会话）')
    rep.push('')
    rep.push('| 翻转 U | 翻转消息（截断） | M0 窗口 | M4 窗口 | M7 窗口 |')
    rep.push('|---|---|---|---|---|')
    for (const g of s.gt.coarse.filter(x => x > 0)) {
      rep.push(`| ${g} | ${trunc(s.us[g].text, 34)} | ${winStr(A.M0[s.id].cuts, g)} | ${winStr(A.M4[s.id].cuts, g)} | ${winStr(A.M7[s.id].cuts, g)} |`)
    }
    rep.push('')
  }
}

/* ---------- ② 压缩：等距开火视图（带 U 刻度尺）+ 指标 ---------- */
{
  const cur = sessions[0]
  const N = cur.us.length - 1
  const [rulerT, rulerO] = ruler(N)
  rep.push('## ② 压缩 · 本对话等距开火视图（每字符 = 1 U，列编号下方刻度尺逐 10 对齐）')
  rep.push('')
  rep.push(`图例：F=真实翻转 C=切割 X=切在翻转上 ·=无。U 范围 1..${N}。`)
  rep.push('')
  rep.push('```')
  rep.push(rulerT)
  rep.push(rulerO)
  for (const [arm, cfg] of Object.entries(FINAL_CONF)) {
    const tag = cfg.theta !== undefined ? `θ=${cfg.theta}` : '生产阈值 1.0'
    rep.push(`${arm.padEnd(3)} ${tag.padEnd(10)} ${A[arm][cur.id].cuts.length - 1}刀 ${strip(cur, A[arm][cur.id].cuts)}`)
  }
  rep.push('```')
  rep.push('')
  rep.push('| 臂 | 开火 | 真中 | 误切 | fire-truth | 平均延迟 | ≤5及时 | 单意图误开 |')
  rep.push('|---|---|---|---|---|---|---|---|')
  for (const [arm] of Object.entries(FINAL_CONF)) {
    const m = A[arm][cur.id].sm.m
    rep.push(`| ${arm} | ${m.fireRate} | ${m.hits} | ${m.fps} | ${fmt(m.fireTruth)} | ${fmt(m.meanLatency)} | ${m.timely5}/${m.hits} | ${m.single ? '-' : '多意图会话'}(单意图见 ③) |`)
  }
  rep.push('')
  rep.push('逐臂命中延迟（列于翻转序）：')
  for (const [arm] of Object.entries(FINAL_CONF)) {
    const lat = perFlip(cur.us, A[arm][cur.id].cuts, cur.gt.coarse.filter(x => x > 0)).filter(p => p.hit).map(p => p.lat)
    rep.push(`- ${arm}: [${lat.join(', ')}]`)
  }
  rep.push('')
  rep.push('连续切割（stutter，刀间 ≤2 U 的连续开火簇）：')
  for (const [arm] of Object.entries(FINAL_CONF)) {
    const cs = A[arm][cur.id].cuts.filter(c => c > 0).sort((a, b) => a - b)
    let runs = [], prev = null
    for (const c of cs) {
      if (prev === null || c - prev > 2) runs.push([c])
      else runs[runs.length - 1].push(c)
      prev = c
    }
    const big = runs.filter(r => r.length >= 3).slice(0, 3)
    rep.push(`- ${arm}: ${big.map(r => `U${r[0]}..U${r[r.length - 1]}(${r.length}刀)`).join(', ') || '无 ≥3 连刀簇'}`)
  }
  rep.push('')
}

/* ---------- ③ 断裂：M0 唯一误切 + 最狠误切 + 单意图 ---------- */
{
  const cur = sessions[0]
  const map = flowPosToU(cur)
  rep.push('## ③ 断裂 · 本对话 M0 唯一的一刀（12 个孤儿）')
  rep.push('')
  const bm0 = A.M0[cur.id].sm.bm
  for (const pc of bm0.perCut ?? []) {
    const u = map.get(pc.cut)
    rep.push(`- 切割点 U${u}：${trunc(cur.us[u]?.text, 100)}`)
    rep.push(`- 该刀判定：${pc.isTrue ? '真翻转' : '**误切**'}；孤儿消息 ${pc.orphanMsgs} 条`)
    rep.push('- 切割后紧接着的 4 条消息流（孤儿窗口示意）：')
    for (let f = pc.cut + 1; f <= pc.cut + 4 && f < cur.flow.length; f++) {
      rep.push(`  - ${cur.flow[f].role === 'user' ? '用户' : '助手'}: ${trunc(cur.flow[f].text, 100)}`)
    }
  }
  rep.push('')
  rep.push('## ③ 断裂 · 本对话 M4/M7 最狠的一刀（单位伤害下限 vs 总伤害）')
  rep.push('')
  for (const arm of ['M4', 'M7']) {
    const bm = A[arm][cur.id].sm.bm
    const worst = (bm.perCut ?? []).reduce((a, b) => (b.orphanMsgs > (a?.orphanMsgs ?? -1) ? b : a), null)
    if (worst) {
      const u = map.get(worst.cut)
      rep.push(`- **${arm}**：最狠一刀 U${u}（${worst.isTrue ? '靠近真翻转' : '误切'}，孤儿 ${worst.orphanMsgs} 条）— ${trunc(cur.us[u]?.text, 90)}`)
      rep.push(`- ${arm} 全话结算：误切 ${bm.falseCuts} 刀 × 平均孤儿 ${fmt(bm.avgPerFalse)} = 孤儿总数 ${bm.falseOrphan}（M0 为 1 刀 × 12 = 12）`)
    }
  }
  rep.push('')
}

/* ---------- ③ 断裂：两个单意图会话被切 ---------- */
{
  rep.push('## ③ 断裂 · 单意图会话被开火拆碎（M4/M7）')
  rep.push('')
  for (const s of sessions.filter(x => x.single)) {
    for (const arm of ['M0', 'M4', 'M7']) {
      const cuts = A[arm][s.id].cuts.filter(c => c > 0)
      const first = cuts.slice(0, 3).map(u => `U${u}「${trunc(s.us[u]?.text, 44)}」`)
      rep.push(`- **${s.id}**（${s.us.length}U，0 翻转）· ${arm}：${cuts.length} 刀${first.length ? `，前几刀：${first.join('；')}` : ''}`)
    }
    rep.push('')
  }
}

function fmt(x, d = 3) { return typeof x === 'number' ? x.toFixed(d) : '-' }

writeFileSync('reports/mech-examples.md', rep.join('\n'))
console.log(rep.join('\n'))
console.log('\nsaved reports/mech-examples.md')

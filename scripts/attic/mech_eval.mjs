/**
 * mech_eval：三目的指标（①锚定 ②压缩 ③断裂）+ 综合效用 U(a,b,c)。
 *
 * 约定：preds/cuts 均在 U 空间（u 序数）；GT = 翻转 U 序数。
 *   ① 锚定：recall@±2（明显翻转召回）、延迟、及时率(≤5/≤15)、单任务切碎（单意图会话误开）。
 *   ② 压缩：切割密度（fires per session）、真实切割率（fire-truth）、及时切割占比。
 *   ③ 断裂：复用 probe21 词法锚代理 —— 孤儿化消息/用户追问、每误切平均孤儿、误切致孤儿、token 代理。
 *   U(a,b,c) = hits − a·misses − b·falseCuts − c·orphansFromFalseCuts（逐会话，均值汇总）。
 */

/* ---------- probe21 词法锚代理（原样迁移） ---------- */

export function anchors(text) {
  const t = String(text || ''); const set = new Set()
  ;((t.match(/[A-Za-z0-9_.~\-]*(?:\/[A-Za-z0-9_.\-]+)+/g)) || []).forEach(x => set.add('P:' + x))
  ;((t.match(/@[A-Za-z0-9_.\-]+/g)) || []).forEach(x => set.add('A:' + x))
  ;((t.match(/https?:\/\/[^\s"'<>]+/g)) || []).forEach(x => set.add('U:' + x))
  ;((t.match(/[A-Za-z0-9][A-Za-z0-9_\-]{3,}/g)) || []).forEach(x => { if (/[_-]/.test(x) || /\d/.test(x)) set.add('K:' + x) })
  return set
}

/**
 * 孤儿分析（flow 空间；cuts = flow 下标，>0 且 <total-1 才生效；gtFlows = 真翻转 flow 下标）。
 * 返回 probe21 同款指标。
 */
export function breakageAnalyze(flow, cutFlows, gtFlows) {
  const gtset = new Set(gtFlows)
  const total = flow.length
  const realCuts = cutFlows.filter(c => c > 0 && c < total - 1).sort((a, b) => a - b)
  const recentCut = new Array(total).fill(0)
  for (let i = 1; i < total; i++) { recentCut[i] = recentCut[i - 1]; if (realCuts.includes(i - 1)) recentCut[i] = i - 1 }
  const pos = new Map(); const mAnch = []
  flow.forEach((m, i) => { const a = anchors(m.text); mAnch.push(a); for (const x of a) { if (!pos.has(x)) pos.set(x, []); pos.get(x).push(i) } })
  let orphanMsgs = 0, orphanUser = 0, falseOrphan = 0, trueOrphan = 0, userLenSum = 0
  const perCut = []
  for (const c of realCuts) perCut.push({
    cut: c,
    isTrue: gtset.has(c) || gtset.has(c + 1) || gtset.has(c - 1) || gtset.has(c + 2) || gtset.has(c - 2),
    orphanMsgs: 0,
  })
  for (let i = 0; i < total; i++) {
    const c = recentCut[i]
    if (c <= 0) continue
    if (i - c > 60) break
    const A = mAnch[i]
    let orphan = 0
    for (const x of A) { const p = pos.get(x); let last = -1; for (const q of p) { if (q < i) last = q; else break } if (last >= 0 && last < c) orphan++ }
    if (orphan > 0) {
      orphanMsgs++; if (flow[i].role === 'user') { orphanUser++; userLenSum += flow[i].text.length }
      const pc = perCut.find(o => o.cut === c)
      if (pc) { pc.orphanMsgs += 1; if (pc.isTrue) trueOrphan++; else falseOrphan++ }
    }
  }
  const falseCuts = perCut.filter(o => !o.isTrue).length
  const avgPerFalse = falseCuts ? perCut.filter(o => !o.isTrue).reduce((a, o) => a + o.orphanMsgs, 0) / falseCuts : 0
  return { realCuts: realCuts.length, falseCuts, trueCuts: perCut.filter(o => o.isTrue).length, orphanMsgs, orphanUser, falseOrphan, trueOrphan, avgPerFalse, userLenSum, perCut }
}

/* ---------- ①锚定 + ②压缩（U 空间） ---------- */

const TOL = 2

/** 逐会话锚定/压缩指标。 */
export function anchorMetrics(us, cuts, gtCoarse) {
  const preds = cuts.filter(c => c > 0) // 会话起点（u=0）不算检测
  const gt = [...gtCoarse].filter(g => g > 0) // 起点不算翻转
  if (gt.length === 0) {
    // 单意图：任何非起点切割都是误开
    const fp = preds.length
    return { single: true, gtLen: 0, hits: 0, misses: 0, recall: 0, latency: [], timely5: 0, timely15: 0, fps: fp, fireRate: preds.length, meanLatency: 0 }
  }
  let hits = 0; const latency = []
  const used = new Set()
  for (const g of gt) {
    const near = preds.filter(p => Math.abs(p - g) <= TOL)
    if (near.length) {
      const best = near.reduce((a, b) => Math.abs(b - g) < Math.abs(a - g) ? b : a)
      latency.push(best - g)
      hits++; used.add(best)
    }
  }
  const misses = gt.length - hits
  const fps = preds.filter(p => !used.has(p) && gt.every(g => Math.abs(p - g) > TOL)).length
  const recall = gt.length ? hits / gt.length : 0
  const meanLatency = latency.length ? latency.reduce((a, b) => a + b, 0) / latency.length : 0
  const timely5 = latency.filter(L => L <= 5).length
  const timely15 = latency.filter(L => L <= 15).length
  return {
    single: false, gtLen: gt.length, hits, misses, recall, meanLatency, latency,
    timely5, timely15, fps, fireRate: preds.length,
    fireTruth: preds.length ? (preds.length - fps) / preds.length : 0,
  }
}

/* ---------- 综合效用 ---------- */

/** U(a,b,c) 逐会话（单意图会话：hits=misses=0, falseCuts=fires）。 */
export function utility(a, b, c, m, bm) {
  return m.hits - a * m.misses - b * m.fps - c * bm.falseOrphan
}

/* ---------- 汇总 ---------- */

export function sessSummary(session, cuts) {
  const gt = session.gt.coarse ?? []
  const m = anchorMetrics(session.us, cuts, gt)
  const cutFlows = cuts.map(u => session.us[u].flowPos).filter(p => p !== undefined)
  const gtFlows = gt.map(u => session.us[u]?.flowPos).filter(p => p !== undefined)
  const bm = breakageAnalyze(session.flow, cutFlows, gtFlows)
  return { m, bm, cuts }
}

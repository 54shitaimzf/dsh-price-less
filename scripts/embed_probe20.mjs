/**
 * probe20：按【目的基准】重评——不是"边界分割得多准"，而是"真实意图反转处能否及时触发压缩/切换，
 * 切断跨任务上下文依赖、避免旧任务信息复利污染新任务"。
 *
 * 目的标准（用户重构）：
 *   ① 主体指标 = 明显主要意图反转的【召回】（明显的反转就足以分task）——漏掉才是贵（复利污染）。
 *   ② 代价不对称：漏一个明显反转(FN) 比 多开一次火(FP) 贵得多；FP 只是早压缩一点。
 *   ③ 及时性 = 检测落在反转点附近（尽量不晚于它太多），否则压缩太晚。
 *   ④ 单任务防碎片 = 真单意图会话别再切碎（否则会压缩掉仍属于当前任务的活上下文）。
 *   ⑤ 可复现 = 机械确定性（不引入批序随机 → 复利可控）。
 *
 * 数据 = probe19 同一轮跑出的 preds（coarse 标签、最佳θ=0.8），本脚本离线复用，不重嵌入。
 * 运行：node scripts/embed_probe20.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

// 手标 coarse 标签（U 下标，0-based）
const EVAL = {
  '0ff3015a-27cb-43e3-acb7-b06f7bd54de7': { proj: 'mails', U: 83, coarse: [1, 4, 8, 12, 20, 38, 60, 71, 80], single: false },
  '3de11a0d-f417-4dce-a910-2fab07164b16': { proj: 'afriland-audio', U: 92, coarse: [2, 4, 6, 8, 29, 55, 90], single: false },
  '30a284c6-aa90-41f3-af9c-5be45369baf9': { proj: 'CEKEMA', U: 44, coarse: [1, 2, 3, 16, 22, 30, 40, 41], single: false },
  '74d9a434-eb7b-424a-b781-067668c0987f': { proj: 'dataclaw', U: 27, coarse: [2, 3, 8, 11, 13, 20, 22], single: false },
  'e385bda2-accf-466d-8b51-5dfb0e856c69': { proj: 'cdomain-mcp', U: 22, coarse: [1, 8, 9, 17], single: false },
  '9c2090f7-4d7d-47a7-8f93-ef75bc9b75cd': { proj: 'home-wifi-huawei', U: 42, coarse: [1, 7, 8, 22, 27], single: false },
  '50a530d3-9a34-4b18-8296-f9e8b37abcaa': { proj: 'withdraw-validator', single: true, coarse: [] },
  '66439e33-4d07-44f9-9028-b5e514fcf8ea': { proj: 'consulte-session', single: true, coarse: [] },
  '16a37d85-6c68-4e32-8499-a7ce34cae9dc': { proj: 'curl-collection', single: true, coarse: [] },
  '6a1db62e-2b0d-4c61-bba7-3ec95362ea89': { proj: 'afriland-service-logic', single: true, coarse: [] },
}

// probe19 该轮读出的 preds（coarse、最佳θ=0.8）——精确复用
const PREDS = {
  '0ff3015a': { trained: [0, 2, 7, 18, 62, 66, 69, 74], raw: [0, 3, 9, 60, 74], mech: [0, 3, 12, 19, 20, 34, 36, 42, 43, 47, 48, 65, 68, 70, 79] },
  '3de11a0d': { trained: [0, 43, 51, 79, 85], raw: [0, 17, 22, 37, 65, 71, 73, 75], mech: [0, 3, 20, 30, 40, 48, 51, 54, 55, 56, 70, 77, 84, 88, 90] },
  '30a284c6': { trained: [0, 2, 21], raw: [0, 2, 15, 22, 27, 29], mech: [0, 2, 5, 20, 26, 28, 29] },
  '74d9a434': { trained: [0, 10, 13, 16], raw: [0, 10, 12, 13, 14, 17, 22], mech: [0, 8, 12, 15, 16, 19] },
  'e385bda2': { trained: [0, 2], raw: [0, 2, 15], mech: [0, 3, 8, 9, 18, 19] },
  '9c2090f7': { trained: [0, 8, 15, 30], raw: [0, 3, 9, 16, 21, 23, 32], mech: [0, 8, 10, 15, 20, 21, 23, 26, 35] },
  '50a530d3': { trained: [0, 1], raw: [0, 3], mech: [0, 2, 4] },
  '66439e33': { trained: [0, 2, 8], raw: [0, 3, 8], mech: [0, 7, 8] },
  '16a37d85': { trained: [0], raw: [0], mech: [0] },
  '6a1db62e': { trained: [0], raw: [0], mech: [0] },
}

// 读 shard，把每会话的【消息流下标】对齐 U 下标（同 probe19：凡 user/assistant 有文本的 exchange 占一条）
const lines = readFileSync('datasets/claudeset_shard.jsonl', 'utf8').split('\n').filter(Boolean)
const db = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(o => Array.isArray(o.turns))
const byId = new Map(db.map(s => [s.id, s]))

const ARM_LABEL = { trained: '训练后嵌入(LDA+白化)', raw: '原始嵌入(无训练)', mech: '机械(词面)' }

function usIdxOf(s) {
  const usIdx = []; let idx = 0
  s.turns.forEach(t => { if (t.type === 'exchange' && (t.user || t.assistant?.text)) { if (t.user) usIdx.push(idx); idx++ } })
  return { usIdx, N: idx }
}

// 每会话每臂：算 明显反转召回 / 延迟 / 碎片
function evalPerSession(id, arm) {
  const s = byId.get(id); const E = EVAL[id]
  const { usIdx, N } = usIdxOf(s)
  const gt = (E.coarse || []).map(u => usIdx[u]).filter(x => x !== undefined)
  const predRaw = PREDS[id.slice(0, 8)][arm] || []
  // 去掉开火第一点（会话起点 = 保证必开火，不算真实检测）
  const pred = predRaw.filter((x, i) => i > 0 && x > 0)
  // 召回：gt 视作被"检测到"当且仅当 ±2 内有 pred
  let hits = 0; const latency = []
  for (const g of gt) {
    const near = pred.filter(p => Math.abs(p - g) <= 2)
    if (near.length) { hits++; const best = near.reduce((a, b) => Math.abs(b - g) < Math.abs(a - g) ? b : a); latency.push(best - g) }
  }
  const recall = gt.length ? hits / gt.length : 0
  // 及时性：被检出的反转，有多少在"不晚于反转后 τ 条"内检出（≤0 = 提前/准点，>0 = 晚了）
  const timely5 = latency.filter(L => L <= 5).length
  const timely15 = latency.filter(L => L <= 15).length
  const lateMean = latency.length ? latency.reduce((a, b) => a + b, 0) / latency.length : 0
  // 碎片：多开火且不是真反转的 pred 数
  const fps = pred.filter(p => gt.every(g => Math.abs(p - g) > 2)).length
  return { N, gtLen: gt.length, recalls: recall, hits, gtLenTotal: gt.length, predCount: pred.length, fps, timely5, timely15, lateMean, isSingle: E.single, latencyCount: latency.length }
}

// 汇总
function summarize(arm) {
  const multi = [], single = []
  for (const id of Object.keys(EVAL)) {
    const r = evalPerSession(id, arm)
    ; (r.isSingle ? single : multi).push(r)
  }
  const totalGT = multi.reduce((a, r) => a + r.gtLenTotal, 0)
  const totalHits = multi.reduce((a, r) => a + r.hits, 0)
  const totalLat = multi.reduce((a, r) => a + r.latencyCount, 0)
  const totalLatSum = multi.reduce((a, r) => a + r.lateMean * r.latencyCount, 0)
  const meanRecall = totalGT ? totalHits / totalGT : 0
  const meanLatency = totalLat ? totalLatSum / totalLat : 0
  const timely5 = multi.reduce((a, r) => a + r.timely5, 0)
  const timely15 = multi.reduce((a, r) => a + r.timely15, 0)
  const meanFps = multi.reduce((a, r) => a + r.fps, 0) / multi.length
  const singleFrag = single.filter(r => r.predCount > 0).length
  return { meanRecall, meanLatency, pctTimely5: totalLat ? timely5 / totalLat : 0, pctTimely15: totalLat ? timely15 / totalLat : 0, meanFps, singleFrag, singleCount: single.length, totalGT, totalHits }
}

// 目的基准：代价不对称评分。FN(漏明显反转) 权重高，FP(多开火) 权重低。
// 价值 = catch 的反转价值 − FN 代价 − FP 代价。用正交通道展示：FN 代价 = FP 代价 × a。
function utility(arm, a) {
  const s = summarize(arm)
  // 归一化到每会话级：每明显反转一个单位价值
  const value = s.totalHits
  const fnCost = (s.totalGT - s.totalHits) * a
  const fpCost = s.meanFps // 每多意图会话的平均 FP
  return value - fnCost - fpCost
}

const fmt = x => (x === null || x === undefined ? '-' : (+x).toFixed(3))
const rep = []
rep.push('# probe20：目的基准重评——真实意图反转处能否"及时切断上下文/触发压缩"')
rep.push('')
rep.push('> 目的（用户重构）：task 分划 ≠ 边界分割质量，而是要切断跨任务上下文依赖、及时压缩无效信息、避免性能退化与复利。')
rep.push('> 主体指标 = 明显主要意图反转的【召回】（明显的反转就足以分task）；漏一个 FN 比 多开一次 FP 贵（复利污染）。')
rep.push('> 数据 = probe19 同一轮 preds（coarse 标签、最佳θ=0.8），本脚本离线复用，不重嵌入。')
rep.push('')

rep.push('## 主体指标：明显意图反转召回（多意图会话）')
rep.push('')
rep.push('| 系统 | 明显反转召回 | 检出数/总数 | 检测延迟(条, +晚−早) | ≤5条及时 | ≤15条及时 | 平均多开火/会话 | 单任务被切碎 |')
rep.push('|---|---|---|---|---|---|---|---|')
for (const arm of ['trained', 'raw', 'mech']) {
  const s = summarize(arm)
  rep.push(`| ${ARM_LABEL[arm]} | ${fmt(s.meanRecall)} | ${s.totalHits}/${s.totalGT} | ${fmt(s.meanLatency)} | ${(100 * s.pctTimely5).toFixed(1)}% | ${(100 * s.pctTimely15).toFixed(1)}% | ${fmt(s.meanFps)} | ${s.singleFrag}/${s.singleCount} |`)
}
rep.push('')

rep.push('## 代价不对称（目的基准）：漏明显反转的代价权重 a')
rep.push('')
rep.push('> 评分 = 检出的反转价值 − a×(漏掉的反转) − 平均多开火。a 越大 = 越不能漏明显反转（复利越贵）。不同 a 下谁最好：')
rep.push('')
rep.push('| 系统 | a=1 | a=2 | a=3 | a=5 |')
rep.push('|---|---|---|---|---|')
for (const arm of ['trained', 'raw', 'mech']) {
  rep.push(`| ${ARM_LABEL[arm]} | ${fmt(utility(arm, 1))} | ${fmt(utility(arm, 2))} | ${fmt(utility(arm, 3))} | ${fmt(utility(arm, 5))} |`)
}
rep.push('')
rep.push('> 即使 a 很小（1）也不该让 FP 罚分把它压平——因为"漏掉明显反转复利污染"在目的基准下是最贵的错误。')

writeFileSync('reports/probe20.md', rep.join('\n'))
console.log(rep.join('\n'))
console.log('\nsaved reports/probe20.md')

// 逐会话明细（便于核对）
console.log('\n--- 逐会话（recall / 延迟 / FP）---')
for (const arm of ['trained', 'raw', 'mech']) {
  console.log('\n[' + ARM_LABEL[arm] + ']')
  for (const id of Object.keys(EVAL)) {
    const r = evalPerSession(id, arm)
    console.log(`  ${id.slice(0, 8)} ${r.isSingle ? '(单)' : ''} recall=${fmt(r.recalls)} gt=${r.gtLen} pred=${r.predCount} FP=${r.fps} lat=${fmt(r.lateMean)}`)
  }
}

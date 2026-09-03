// phase_b_total.mjs —— 综合考虑成本：性价比 × 准确率 × 缓存饱和 × 日成本 × 错误机会成本
import { readFileSync } from 'node:fs'
const RAW = 'D:/deepseek-plugin/reports/phase-b-raw'
const PRICE = { 'minimax-m3': [0.30, 1.20, 0.06], 'deepseek-v4-flash': [0.22, 0.66, 0.007], 'hy3': [0.14, 0.58, 0.035] }
function load(f) { return JSON.parse(readFileSync(`${RAW}/${f}`, 'utf8')) }
const rows = []
for (const m of ['minimax-m3', 'deepseek-v4-flash', 'hy3']) {
  const j = load(`v2_2-${m}.json`)
  const s = j.summary
  const [pin, pout, pcache] = PRICE[m]
  const costFirst = (s.inputTokens * pin + s.outputTokens * pout + s.cacheReadTokens * pcache) / 1e6 / s.total
  // 缓存饱和后：用 tc2（+10min 命中 ~76-87%）的 12 条成本 = 长期稳态近似
  const c = load(`v2_2-${m}-tc2.json`).summary
  const costSat = (c.inputTokens * pin + c.outputTokens * pout + c.cacheReadTokens * pcache) / 1e6 / c.total
  rows.push({ m, acc: s.accuracy, flips: s.flipAccuracy, nonF: s.nonFlipAccuracy, costFirst: costFirst * 1e6, costSat: costSat * 1e6 })
}
console.log('════ 综合权衡（v2.2，µ$/判；sat=缓存饱和稳态 tc2 口径） ════')
console.log('模型             acc    翻转召回  非翻转   首次µ$/判  饱和µ$/判  每正确判µ$*  性价比(acc/µ$)  日200判$')
for (const r of rows) {
  const cpc = r.costSat / r.acc
  const val = r.acc / r.costSat
  const day = r.costSat * 200 / 1e6
  console.log(`${r.m.padEnd(16)} ${(r.acc * 100).toFixed(1)}%   ${(r.flips * 100).toFixed(0)}%     ${(r.nonF * 100).toFixed(0)}%     ${r.costFirst.toFixed(0)}       ${r.costSat.toFixed(0)}      ${cpc.toFixed(0)}      ${val.toFixed(2)}      $${day.toFixed(4)}`)
}
console.log('\n*每正确判 = 饱和成本/准确率（错误分担进成本）。性价比 = 准确率/饱和成本。')
// 错误机会成本：漏报 1 个 new_task → 后续上下文膨胀估
console.log('\n════ 错误机会成本（判别器 vs 主循环） ════')
console.log('主循环参照：一次任务级调用 ≈ $0.12（输入 ~30K token × 0.44/M + 输出）；漏报边界 → 上下文不压缩 → 后续每轮多 2-4K token 输入')
console.log('估算：一次漏报的后续膨胀 ≈ 10 轮 × 3K token × 0.44/M ≈ $0.013 → 相当于 hy3 310 次判 / minimax 95 次判的调用成本')
console.log('一次误切（丢失任务上下文）≈ 重建上下文（用户重述/重做）≈ $0.05-0.30，远高于任何判别成本')
console.log('\n════ 双判组合推演（minimax 判N 且 hy3 判N 才切 = AND / 任一判N = OR） ════')
// 从 v2_2 交集算实际 AND/OR 表现
const mm = load('v2_2-minimax-m3.json').items, hy = load('v2_2-hy3.json').items
let andC = 0, orC = 0, n = 0, andFP = 0, orFP = 0, andFN = 0, orFN = 0
for (let i = 0; i < mm.length; i++) {
  const a = mm[i].decision === 'new_task', b = hy[i].decision === 'new_task'
  const f = !!mm[i].flip
  n++
  const andN = a && b, orN = a || b
  if (andN === f) andC++; else if (!f) andFP++; else andFN++
  if (orN === f) orC++; else if (!f) orFP++; else orFN++
}
console.log(`AND（双 N 才切，保守）: acc=${(andC / n * 100).toFixed(1)}%  误切=${andFP}  漏切=${andFN}  成本≈269µ$/判`)
console.log(`OR（任一 N 就切，激进）: acc=${(orC / n * 100).toFixed(1)}%  误切=${orFP}  漏切=${orFN}  成本≈269µ$/判`)

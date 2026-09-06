/**
 * phase_b_cost（v2）：对 reports/phase-b-raw/*.json 全部结果计价。
 * 单价（$ / 1M tokens，input/output/cacheRead）来自 opencode 网关价目：
 *   deepseek-v4-flash: Peak 0.44/1.32/0.014, Off-Peak 0.22/0.66/0.007（opencode-go 路由 = 2x usage = Peak）
 *   glm-5.3-flash: 0.15/0.50/0.03；minimax-m3: 0.30/1.20/0.06；mimo-v2.5: 0.14/0.28/0.0028
 *   hy3: 0.14/0.58/0.035；mimo-v2.5-pro: 0.435/0.87/0.003625（未全量，仅参考）
 * 运行：node scripts/phase_b_cost.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'

const P = {
  'deepseek-v4-flash': { label: 'DeepSeek V4 Flash (Peak)', pi: 0.44, po: 1.32, pc: 0.014 },
  'deepseek-v4-flash-off': { label: 'DeepSeek V4 Flash (Off-Peak)', pi: 0.22, po: 0.66, pc: 0.007 },
  'glm-5.3-flash': { label: 'GLM-5.3-Flash', pi: 0.15, po: 0.50, pc: 0.03 },
  'minimax-m3': { label: 'MiniMax M3', pi: 0.30, po: 1.20, pc: 0.06 },
  'mimo-v2.5': { label: 'MiMo V2.5', pi: 0.14, po: 0.28, pc: 0.0028 },
  'mimo-v2.5-pro': { label: 'MiMo V2.5 Pro', pi: 0.435, po: 0.87, pc: 0.003625 },
  'hy3': { label: 'Hy3', pi: 0.14, po: 0.58, pc: 0.035 },
}
const FILES = [
  'dsv4-flash.json', 'glm53-flash.json', 'minimax-m3.json', 'mimo-v2.5.json',
  'v2-minimax-m3.json', 'v2-v4-flash.json', 'hy3-v2.json',
]

const rows = []
for (const f of FILES) {
  const raw = JSON.parse(readFileSync(`reports/phase-b-raw/${f}`, 'utf8'))
  const s = raw.summary
  const keys = raw.model === 'deepseek-v4-flash' ? ['deepseek-v4-flash', 'deepseek-v4-flash-off'] : [raw.model]
  for (const k of keys) {
    const p = P[k]
    if (!p) { console.log('NO PRICE for', k); continue }
    const cost = (s.inputTokens * p.pi + s.outputTokens * p.po + s.cacheReadTokens * p.pc) / 1e6
    rows.push({ label: `${p.label} [${raw.prompt || 'v1'}]`, total: s.total, cost, perJudge: cost / s.total, per1k: cost / s.total * 1000, acc: s.accuracy, flip: s.flipAccuracy, non: s.nonFlipAccuracy, pf: s.parseFail, note: raw.rerun ? '（复跑 u=51 抖动）' : '' })
  }
}
rows.sort((a, b) => a.cost - b.cost)
const base = rows.find(r => r.label.startsWith('Hy3')).cost
let out = '== 全部变体真实成本（52 条全量）==\n'
for (const r of rows) {
  out += `${r.label}: $${r.cost.toFixed(4)} 每判 $${r.perJudge.toFixed(6)} 每千判 $${r.per1k.toFixed(2)} @ minimax=${(r.cost / base).toFixed(2)}x acc=${r.acc} flip=${r.flip} nonFlip=${r.non} pf=${r.pf}${r.note}\n`
}
console.log(out)

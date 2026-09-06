// phase_b_cache.mjs —— 成本 + 缓存长程分析
// 1) 全账本横截面：model × prompt 版 → input/output/cacheRead/cacheWrite/total + 命中率 + 成本（$）
// 2) 缓存长程对照：v2.2 全量前 12 条（r0） vs tc1（间隔~2min） vs tc2（间隔~10min，可选）per-item cacheRead
import { readFileSync, existsSync } from 'node:fs'
const RAW = 'D:/deepseek-plugin/reports/phase-b-raw'
const PRICE = {
  // $/1M tokens：in / out / cacheRead（用户价目表；v4 用 off-peak 0.22/0.66/0.007，备注 peak）
  'minimax-m3': [0.30, 1.20, 0.06], 'deepseek-v4-flash': [0.22, 0.66, 0.007], 'hy3': [0.14, 0.58, 0.035],
  'glm-5.3-flash': [0.15, 0.50, 0.03], 'mimo-v2.5': [0.14, 0.28, 0.0028],
}
const files = [
  'minimax-m3.json', 'v2-minimax-m3.json', 'v2_1-minimax-m3.json', 'v2_2-minimax-m3.json', 'debug-minimax-m3.json', 'v2_1-minimax-m3-alt.json', 'v2_2-minimax-m3-tc1.json',
  'dsv4-flash.json', 'v2-v4-flash.json', 'v2_1-deepseek-v4-flash.json', 'v2_2-deepseek-v4-flash.json', 'debug-deepseek-v4-flash.json', 'v2_1-deepseek-v4-flash-alt.json', 'v2_2-deepseek-v4-flash-tc1.json',
  'hy3-v2.json', 'v2_1-hy3.json', 'v2_2-hy3.json', 'debug-hy3.json', 'v2_2-hy3-tc1.json',
  'glm53-flash.json', 'mimo-v2.5.json',
]
console.log('════ 1) 全账本横截面（成本按价目表；v4=off-peak 价） ════')
for (const f of files) {
  if (!existsSync(`${RAW}/${f}`)) continue
  const j = JSON.parse(readFileSync(`${RAW}/${f}`, 'utf8'))
  const s = j.summary
  const [pin, pout, pcache] = PRICE[j.model] || [0, 0, 0]
  const cost = (s.inputTokens * pin + s.outputTokens * pout + s.cacheReadTokens * pcache) / 1e6
  const hit = s.inputTokens + s.cacheReadTokens > 0 ? (s.cacheReadTokens / (s.inputTokens + s.cacheReadTokens) * 100).toFixed(1) : '-'
  console.log(`${j.model.padEnd(18)} ${String(j.prompt || 'v1').padEnd(5)} ${String(j.tag || '').padEnd(3)} ${String(j.alt ? 'alt' : '').padEnd(3)} in=${String(s.inputTokens).padStart(7)} out=${String(s.outputTokens).padStart(6)} cacheR=${String(s.cacheReadTokens).padStart(7)} 命中=${hit}%  cost=${cost.toFixed(6)}$/run  ${(cost / s.total * 1e6).toFixed(2)}$/1k判`)
}
// 每判成本（v2.2 三模型，含 cache 折扣）
console.log('\n════ v2.2 每判真实成本（含 cache 折扣；v4 网关=Peak 价 2x） ════')
for (const f of ['v2_2-minimax-m3.json', 'v2_2-deepseek-v4-flash.json', 'v2_2-hy3.json']) {
  const j = JSON.parse(readFileSync(`${RAW}/${f}`, 'utf8'))
  const s = j.summary
  const [pin, pout, pcache] = PRICE[j.model]
  const cost = (s.inputTokens * pin + s.outputTokens * pout + s.cacheReadTokens * pcache) / 1e6
  const full = ((s.inputTokens + s.cacheReadTokens) * pin + s.outputTokens * pout) / 1e6
  const peak = j.model === 'deepseek-v4-flash' ? ((s.inputTokens + s.cacheReadTokens) * 0.44 + s.outputTokens * 1.32 + s.cacheReadTokens * 0.014) / 1e6 : null
  console.log(`${j.model.padEnd(18)} 含缓存=${cost.toFixed(5)}$/52判 = ${(cost / 52 * 1e6).toFixed(0)}µ$/判   无缓存=${(full / 52 * 1e6).toFixed(0)}µ$/判（缓存省 ${(100 - cost / full * 100).toFixed(0)}%）${peak ? `   peak计费=${(peak / 52 * 1e6).toFixed(0)}µ$/判` : ''}`)
}
// 缓存长程对照：v2_2 前12 vs tc1（vs tc2 若存在）
console.log('\n════ 2) 缓存长程对照（同 prefix 重复运行，v2.2 前 12 条） ════')
for (const model of ['minimax-m3', 'deepseek-v4-flash', 'hy3']) {
  const full = JSON.parse(readFileSync(`${RAW}/v2_2-${model}.json`, 'utf8')).items.slice(0, 12)
  const c1 = JSON.parse(readFileSync(`${RAW}/v2_2-${model}-tc1.json`, 'utf8')).items
  const c2f = `${RAW}/v2_2-${model}-tc2.json`
  const c2 = existsSync(c2f) ? JSON.parse(readFileSync(c2f, 'utf8')).items : null
  const sum = arr => ({ cr: arr.reduce((a, x) => a + (x.cacheReadTokens || 0), 0), in: arr.reduce((a, x) => a + (x.inputTokens || 0), 0), out: arr.reduce((a, x) => a + (x.outputTokens || 0), 0) })
  const r0 = sum(full), r1 = sum(c1), r2 = c2 ? sum(c2) : null
  const fmt = r => `${r.cr} cacheR (${(r.cr / (r.in + r.cr) * 100).toFixed(1)}%) / ${r.in} in / ${r.out} out`
  console.log(`${model.padEnd(18)} r0(全量前12)=${fmt(r0)}`)
  console.log(`${''.padEnd(18)} c1(+~3min)=${fmt(r1)}${r2 ? `\n${''.padEnd(18)} c2(+~10min)=${fmt(r2)}` : ''}`)
}

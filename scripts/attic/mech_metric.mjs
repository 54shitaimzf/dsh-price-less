/**
 * mech_metric：v3 乘法指标核心（单一事实源 —— 与 mech_metric_scenarios 共享，防止漂移）。
 *
 * 公式（reports/mech-metric-scenarios.md 经 81 组合网格验证，参数为预注册值）：
 *   score_s = R · P · A · D
 *   R = k/n（匹配翻转数 / 翻转数）
 *   P = k/m（匹配 / 切割数，剔除 u=0）
 *   A = (1/n)·Σ w(l̂_i)，未匹配翻转 → w = ε
 *   D = exp(−λ·max(0, m−n)/n)   超额刀数税（结构性、边际恒定；λ 由 S9/S10 强度锚定）
 *   l̂ = (cut − flip)/max(N/n, 1)        段单位标准化距离
 *   w(l̂) = γ^max(0,−l̂) · β^max(0,l̂)    早切略优（γ>β，Δ≤0.1 设计意图）
 *   匹配：逐翻转贪心取最近未用切割；|cut−flip|/s ≤ c 才计入。
 *   聚合（跨会话）：mean of log(raw)；raw=0 会话按 LOG_ZERO（仅聚合/搜索目标用，非指标本体）。
 */
export const METRIC_V3 = { gamma: 0.9, beta: 0.8, eps: 0.05, c: 0.2, lambda: 0 }
export const LOG_ZERO = -6 // raw=0 的 log 地板（≈ raw 0.0025；仅用于跨会话聚合与搜索目标）

/**
 * 匹配：返回每个翻转的 {lat|null}（有符号延迟；未匹配 → null）。
 */
export function matchFlips(N, flips, cuts, P = METRIC_V3) {
  const n = flips.length
  const s = Math.max(N / n, 1)
  const radius = P.c * s
  const cs = cuts.filter(c => c > 0).sort((a, b) => a - b)
  const used = new Set()
  const lat = []
  for (const g of flips) {
    let best = -1, bd = Infinity
    for (let i = 0; i < cs.length; i++) {
      if (used.has(i)) continue
      const d = Math.abs(cs[i] - g)
      if (d < bd) { bd = d; best = i }
    }
    if (best >= 0 && bd / s <= P.c) { used.add(best); lat.push(cs[best] - g) }
    else lat.push(null)
  }
  return lat
}

/**
 * v3 分数（单会话）。返回组件齐全的结构，便于手工验收。
 */
export function v3score(N, flips, cuts, P = METRIC_V3) {
  const n = flips.length
  if (n === 0) return { log: null, raw: null, k: 0, m: 0, R: 0, Pn: 0, A: 0, D: 0, s: null, radius: null, lat: [] }
  const s = Math.max(N / n, 1)
  const cs = cuts.filter(c => c > 0).sort((a, b) => a - b)
  const m = cs.length
  const lat = matchFlips(N, flips, cuts, P)
  const k = lat.filter(x => x !== null).length
  const R = k / n
  const Pn = m ? k / m : 0
  if (m === 0) return { log: -Infinity, raw: 0, k, m, R, Pn, A: 0, D: 0, s, radius: P.c * s, lat }
  const w = (l) => P.gamma ** Math.max(0, -l) * P.beta ** Math.max(0, l)
  const A = lat.reduce((a, l) => a + (l === null ? P.eps : w(l / s)), 0) / n
  const D = m > 0 ? Math.exp(-(P.lambda ?? 0) * Math.max(0, m - n) / n) : 0
  const raw = R * Pn * A * D
  return { log: Math.log(raw), raw, k, m, R, Pn, A, D, s, radius: P.c * s, lat }
}

/**
 * 跨会话聚合：mean of log（raw=0 → LOG_ZERO）。返回 {meanLog, meanRaw, zeroSessions, nSessions}。
 */
export function aggregateV3(scores) {
  const valid = scores.filter(x => x.raw !== null) // 排除 n=0（单意图不参与）
  const nSessions = valid.length
  if (nSessions === 0) return { meanLog: null, meanRaw: null, zeroSessions: 0, nSessions: 0 }
  let sumLog = 0, sumRaw = 0, zeros = 0
  for (const x of valid) {
    sumRaw += x.raw
    if (x.raw === 0) { zeros++; sumLog += LOG_ZERO } else sumLog += x.log
  }
  return { meanLog: sumLog / nSessions, meanRaw: sumRaw / nSessions, zeroSessions: zeros, nSessions }
}

/**
 * 预算@GT 近似上限（oracle 贪心）：从候选切割中选 k=min(n,m) 个、逐次选使 v3 raw 边际最大者。
 * 仅供能力上限诊断（用了 GT），标注为 oracle，不作为可取配置。
 */
export function greedyBudget(N, flips, candCuts, P = METRIC_V3) {
  const n = flips.length
  if (n === 0) return { raw: null, chosen: [] }
  const cands = [...new Set(candCuts.filter(c => c > 0))].sort((a, b) => a - b)
  const k = Math.min(n, cands.length)
  const chosen = []
  const rest = [...cands]
  for (let i = 0; i < k; i++) {
    let bestC = -1, bestRaw = -Infinity
    for (const c of rest) {
      const raw = v3score(N, flips, [...chosen, c], P).raw
      if (raw > bestRaw) { bestRaw = raw; bestC = c }
    }
    chosen.push(bestC)
    rest.splice(rest.indexOf(bestC), 1)
  }
  return { ...v3score(N, flips, chosen, P), chosen }
}
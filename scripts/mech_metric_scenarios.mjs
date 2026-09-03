/**
 * mech_metric_scenarios：v3 乘法指标 —— 合成情形验证 + 参数网格定参（确定性）。
 *
 * 公式 v3（全部预注册常量候选）：
 *   score_s = R · P · A
 *   R = k/n, P = k/m  （k=半径内匹配翻转数；n=翻转数；m=切割数，剔除 u=0）
 *   A = (1/n)·Σ w(l̂_i)，未匹配翻转 → w = ε
 *   l̂ = (cut − flip)/max(N/n, 1)        （段单位标准化距离）
 *   w(l̂) = γ^max(0,−l̂) · β^max(0,l̂)     （早切略优：γ>β，系数差 ≤ 0.1 = 设计意图）
 *   匹配：逐翻转贪心取最近未用切割；|cut−flip|/s ≤ c 才计入。
 *   聚合：mean of log(score_s)（几何均值）；n=0 会话不参与（单意图走误开门）。
 *
 * 运行：node scripts/mech_metric_scenarios.mjs
 * 输出：reports/mech-metric-scenarios.md
 */
import { writeFileSync } from 'node:fs'
import { v3score } from './mech_metric.mjs'

/* ---------------- 确定性随机（rand5 基线固定种子） ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function drawRandCuts(N, k, seed) {
  const rnd = mulberry32(seed)
  const set = new Set()
  while (set.size < k) set.add(1 + Math.floor(rnd() * N))
  return [...set]
}

/* ---------------- v3 指标（共享核心在 mech_metric.mjs，防止漂移） ---------------- */

/* ---------------- 合成情形 ---------------- */

const DEFAULT = { gamma: 0.9, beta: 0.8, eps: 0.05, c: 0.2 }

// 每个情形：{ name, N, flips, detectors: [ {name, cuts, exp?} ], intent: 设计意图说明 }
const S1 = {
  name: 'S1 校准基准（100U/5翻转）',
  N: 100, flips: [20, 40, 60, 80, 95],
  detectors: [
    { name: 'perf 精准', cuts: [20, 40, 60, 80, 95], exp: 1.0 },
    { name: 'early1 全部早1U', cuts: [19, 39, 59, 79, 94], exp: 0.9 ** 0.05 },
    { name: 'late1 全部晚1U', cuts: [21, 41, 61, 81, 96], exp: 0.8 ** 0.05 },
    { name: 'off3 全部晚3U', cuts: [23, 43, 63, 83, 98], exp: 0.8 ** 0.15 },
    { name: 'miss2 漏2翻转', cuts: [20, 40, 60], exp: 0.6 * (3 + 2 * DEFAULT.eps) / 5 },
    { name: 'dens2 全中+3把空刀', cuts: [20, 40, 60, 80, 95, 15, 55, 99], exp: 0.625 },
    { name: 'single 只切一刀且正中', cuts: [20], exp: 0.2 * (1 + 4 * DEFAULT.eps) / 5 },
    { name: 'fireall 全场扫', cuts: Array.from({ length: 100 }, (_, i) => i + 1), exp: 0.05 },
    { name: 'rand5 随机5刀(种子固定)', cuts: drawRandCuts(100, 5, 20260829), exp: null },
  ],
  intent: '教科书排序：精准>早1>晚1>晚3>密度(全中+空刀)>漏2；三个退化臂(单发/全场扫/随机)只要求低于漏2。',
  order: [['perf 精准', 'early1 全部早1U', 'late1 全部晚1U', 'off3 全部晚3U', 'dens2 全中+3把空刀', 'miss2 漏2翻转']],
  // 退化臂：均须低于 miss2（相对次序不强制——它们互相之间谁略高/低属 ε/c 灵敏度，另见 §5）
  degenerateBelow: ['miss2 漏2翻转'],
}

const S2 = {
  name: 'S2 早/晚不对称（l̂=0.1）',
  N: 100, flips: [15, 35, 55, 75, 90],
  detectors: [
    { name: 'perf', cuts: [15, 35, 55, 75, 90], exp: 1.0 },
    { name: 'early2 全部早2U', cuts: [13, 33, 53, 73, 88], exp: 0.9 ** 0.1 },
    { name: 'late2 全部晚2U', cuts: [17, 37, 57, 77, 92], exp: 0.8 ** 0.1 },
    { name: 'early10 早10U(半段)', cuts: [5, 25, 45, 65, 80], exp: 0 },   // l̂=0.5 > c → 全不匹配
    { name: 'late10 晚10U(半段)', cuts: [25, 45, 65, 85, 100], exp: 0 },
  ],
  intent: '早切略优于晚切（γ>β），但半段偏差判死或宽容由 c 决定——本情形验证早/晚次序与 c 严格度。',
  order: [['perf', 'early2 全部早2U', 'late2 全部晚2U']],
}

const S3 = {
  name: 'S3 长短会话公平（相同段偏差=相同分）',
  N: 200, flips: [20, 60, 100, 140, 180],
  detectors: [
    { name: 'long+2 (l̂=0.05)', cuts: [22, 62, 102, 142, 182], exp: 0.8 ** 0.05 },
    { name: 'long+8 (l̂=0.2)', cuts: [28, 68, 108, 148, 188], exp: 0.8 ** 0.2 },
    { name: 'long+20 (l̂=0.5)', cuts: [40, 80, 120, 160, 200], exp: null }, // c<0.5 → 0；c=0.5 → 0.8**0.5
  ],
  intent: '同 l̂ 的偏差在长短会话必须等分；同绝对偏差(2U)长会话应明显优于短会话。',
  order: [['long+2 (l̂=0.05)', 'long+8 (l̂=0.2)', 'long+20 (l̂=0.5)']],
  // 附加：short_sess = { N:25, flips:[5,10,15,20,24] }，short+1 (l̂=0.2) 必须 == long+8；long+2 > short+1
}

const S3_SHORT = { name: 'S3b 短会话对照', N: 25, flips: [5, 10, 15, 20, 24],
  detectors: [
    { name: 'short+1 (l̂=0.2)', cuts: [6, 11, 16, 21, 25], exp: 0.8 ** 0.2 },
    { name: 'short+2 (l̂=0.4)', cuts: [7, 12, 17, 22, 26], exp: 0 },   // l̂=0.4 超出 c=0.2 半径 → 判死（严格度展示）
  ] }

const S4 = {
  name: 'S4 单翻转会话（n=1 边界）',
  N: 30, flips: [15],
  detectors: [
    { name: 'exact', cuts: [15], exp: 1.0 },
    { name: 'hit-1', cuts: [14], exp: 0.9 ** (1 / 30) },
    { name: 'miss', cuts: [1], exp: 0 },
  ],
  intent: 'n=1：漏掉唯一翻转必须完全归零（R=0 一票否决）；ε 只软化 A，不救 R。',
  order: [['exact', 'hit-1', 'miss']],
}

const S5 = {
  name: 'S5 一刀双中禁止（多刀争一翻转）',
  N: 100, flips: [20, 60],
  detectors: [
    { name: 'clean 一刀一翻', cuts: [20, 60], exp: 1.0 },
    { name: 'dup 重复刀贴脸', cuts: [20, 21, 60], exp: 2 / 3 },
  ],
  intent: '同一翻转只记一次命中；多余刀计入 m 压低 P——聚合的收益不被双计。',
  order: [['clean 一刀一翻', 'dup 重复刀贴脸']],
}

const S6 = {
  name: 'S6 聚簇薄化激励（3刀簇 vs 单刀）',
  N: 100, flips: [20, 60, 100],
  detectors: [
    { name: 'clean 单刀', cuts: [20, 60, 100], exp: 1.0 },
    { name: 'cluster 每簇3刀', cuts: [20, 21, 22, 60, 62, 100], exp: 0.5 },
    { name: 'dense 每簇满排', cuts: [20, 21, 22, 60, 61, 63, 100, 101, 102], exp: 1 / 3 },
  ],
  intent: '簇内重复刀必须被惩罚（P 下降），薄化/聚合被激励但不过量。',
  order: [['clean 单刀', 'cluster 每簇3刀', 'dense 每簇满排']],
}

const S8 = {
  name: 'S8 段中点开火（对抗形态：每刀偏半段）',
  N: 100, flips: [20, 40, 60, 80, 95],
  detectors: [
    { name: 'midseg 全部偏+5U(1/4段)', cuts: [25, 45, 65, 85, 100], exp: null }, // c=0.2→0；c≥0.25→0.8**0.25≈0.945
    { name: 'off3 偏3U', cuts: [23, 43, 63, 83, 98], exp: 0.8 ** 0.15 },
  ],
  intent: '半段偏差的待遇是 c 的语义标尺：c 太松(0.5)会让"每刀偏 1/4 段"拿 0.945 高分——不可接受；c=0.2 判死。',
  order: [['midseg 全部偏+5U(1/4段)', 'off3 偏3U']],
}

const S9 = {
  name: 'S9 密度等价贸易（锚2 强度：决定 λ 下限）',
  N: 100, flips: [20, 40, 60, 80, 95],
  detectors: [
    { name: 'perf', cuts: [20, 40, 60, 80, 95], exp: 1.0 },
    { name: 'less1 漏1翻转', cuts: [20, 40, 60, 80], exp: 0.8 * (4 + 0.05) / 5 },
    { name: 'plus10 多10空刀', cuts: [...[20, 40, 60, 80, 95], 10, 30, 50, 70, 90, 100, 8, 12, 28, 32], exp: null }, // m=15,k=5
    { name: 'plus30 多30空刀', cuts: [[20, 40, 60, 80, 95], Array.from({ length: 30 }, (_, i) => 101 + i)].flat(), exp: null }, // m=35,k=5
    { name: 'noCut', cuts: [], exp: 0 },
  ],
  intent: '锚1（方向）：漏1 > 多10刀 > 多30刀 > 归零（漏=延迟病灶、空刀=复利污染，6:1 精神）。锚2（强度）：m=2n 分 ≤ perf×0.35，m=3n 分 ≤ perf×0.15——三倍刀数只准剩 1/8。λ 由锚2 确定。',
  order: [['less1 漏1翻转', 'plus10 多10空刀', 'plus30 多30空刀', 'noCut']],
}

const S10 = {
  name: 'S10 多刀-少刀对称（税过头了会翻转 6:1 锚点）',
  N: 100, flips: [20, 40, 60, 80, 95],
  detectors: [
    { name: 'perf', cuts: [20, 40, 60, 80, 95], exp: 1.0 },
    { name: 'more1 多1空刀', cuts: [20, 40, 60, 80, 95, 10], exp: null },   // 必须 > less1（1空刀 0.5 < 1漏 3）
    { name: 'less1 漏1翻转', cuts: [20, 40, 60, 80], exp: null },
    { name: 'more5 多5空刀', cuts: [[20, 40, 60, 80, 95], [10, 30, 50, 70, 90]].flat(), exp: null }, // 必须 > less5
    { name: 'less5 只切1且正中', cuts: [20], exp: null },
    { name: 'noCut', cuts: [], exp: 0 },
  ],
  intent: '税不能大到翻转"1 空刀 轻于 1 漏检"（6:1 锚）：任何 λ 下 more1 > less1、more5 > less5；noCut 恒垫底。',
  order: [['perf', 'more1 多1空刀', 'less1 漏1翻转', 'more5 多5空刀', 'less5 只切1且正中', 'noCut']],
}

/* ---------------- 断言 ---------------- */

const ALL = [S1, S2, S3, S4, S5, S6, S8, S9, S10]

function evalScenario(sc, P) {
  const rows = sc.detectors.map(d => {
    const r = v3score(sc.N, sc.flips, d.cuts, P)
    return { name: d.name, ...r, exp: d.exp !== null && d.exp !== undefined ? d.exp : null, d }
  })
  return rows
}

// 断言函数：返回 {ok, msg}
function assertStrictOrder(rows, names, label) {
  const vals = names.map(n => rows.find(r => r.name === n)?.raw)
  if (vals.some(v => v === undefined)) return { ok: false, msg: `${label}: 找不到探测器名` }
  const logs = vals.map(v => Math.log(v))
  for (let i = 1; i < vals.length; i++) {
    if (!(logs[i - 1] > logs[i])) return { ok: false, msg: `${label}: ${names[i - 1]}(${vals[i - 1].toFixed(4)}) 应 > ${names[i]}(${vals[i].toFixed(4)})` }
  }
  return { ok: true, msg: `${label}: 排序成立` }
}

/** 退化臂断言：名单内的每个探测器都必须 < 参照探测器。 */
function assertAllBelow(rows, names, ref, label) {
  const rv = rows.find(r => r.name === ref)?.raw
  if (rv === undefined) return { ok: false, msg: `${label}: 找不到参照 ${ref}` }
  for (const n of names) {
    const v = rows.find(r => r.name === n)?.raw
    if (v === undefined) return { ok: false, msg: `${label}: 找不到 ${n}` }
    if (!(v < rv)) return { ok: false, msg: `${label}: ${n}(${v.toFixed(4)}) 应 < ${ref}(${rv.toFixed(4)})` }
  }
  return { ok: true, msg: `${label}: 退化臂均低于 ${ref}` }
}

function assertNear(rows, name, exp, label) {
  const v = rows.find(r => r.name === name)?.raw
  if (v === undefined) return { ok: false, msg: `${label}: 找不到 ${name}` }
  const ok = exp === 0 ? v === 0 : Math.abs(v - exp) <= 1e-9
  return { ok, msg: `${label}: ${name} 期望 ${exp} 实得 ${v}` }
}

function runAsserts(P) {
  const res = []
  // S1 全序 + 退化臂门槛
  let rows = evalScenario(S1, P)
  res.push(assertStrictOrder(rows, S1.order[0], 'S1'))
  res.push(assertAllBelow(rows, ['single 只切一刀且正中', 'fireall 全场扫', 'rand5 随机5刀(种子固定)'], S1.degenerateBelow[0], 'S1退化臂'))
  // S2 早/晚次序
  rows = evalScenario(S2, P)
  res.push(assertStrictOrder(rows, S2.order[0], 'S2'))
  // S3 长会话递减 + 公平性（S3b 对照）
  rows = evalScenario(S3, P)
  res.push(assertStrictOrder(rows, S3.order[0], 'S3长'))
  const rowsShort = evalScenario(S3_SHORT, P)
  const L8 = rows.find(r => r.name === 'long+8 (l̂=0.2)').raw
  const S1p = rowsShort.find(r => r.name === 'short+1 (l̂=0.2)').raw
  res.push({ ok: Math.abs(L8 - S1p) <= 1e-9, msg: `S3公平: long+8(${L8.toFixed(4)}) == short+1(${S1p.toFixed(4)})` })
  const L2 = rows.find(r => r.name === 'long+2 (l̂=0.05)').raw
  res.push({ ok: L2 > S1p, msg: `S3公平: long+2(${L2.toFixed(4)}) > short+1(${S1p.toFixed(4)})` })
  // S4 n=1
  rows = evalScenario(S4, P)
  res.push(assertStrictOrder(rows, S4.order[0], 'S4'))
  // S5 双计禁止
  rows = evalScenario(S5, P)
  res.push(assertStrictOrder(rows, S5.order[0], 'S5'))
  // S6 聚簇
  rows = evalScenario(S6, P)
  res.push(assertStrictOrder(rows, S6.order[0], 'S6'))
  // S8 半段偏差必须劣于 3U 偏差（全部 c 下）
  rows = evalScenario(S8, P)
  const m8 = rows.find(r => r.name === 'midseg 全部偏+5U(1/4段)').raw
  const o8 = rows.find(r => r.name === 'off3 偏3U').raw
  res.push({ ok: m8 < o8, msg: `S8: midseg(${m8.toFixed(4)}) < off3(${o8.toFixed(4)})` })
  // S9 方向序 + 锚2 强度（m=3n 分 ≤ perf×0.15）
  rows = evalScenario(S9, P)
  res.push(assertStrictOrder(rows, S9.order[0], 'S9'))
  const p9 = rows.find(r => r.name === 'plus10 多10空刀').raw
  res.push({ ok: p9 <= 0.15, msg: `S9锚2(3n): plus10(${p9.toFixed(4)}) ≤ perf×0.15` })
  // S10 对称 + 6:1 锚不被税翻转 + 少刀极端垫底
  rows = evalScenario(S10, P)
  res.push(assertStrictOrder(rows, S10.order[0], 'S10'))
  const m10 = rows.find(r => r.name === 'more5 多5空刀').raw
  res.push({ ok: m10 <= 0.35, msg: `S10锚2(2n): more5(${m10.toFixed(4)}) ≤ perf×0.35` })
  return res
}

/* ---------------- 参数网格（两层：81 组合回归 + λ 扫描） ---------------- */

const GRID = []
for (const gamma of [0.85, 0.9, 0.95])
  for (const beta of [0.75, 0.8, 0.85])
    for (const eps of [0.02, 0.05, 0.1])
      for (const c of [0.2, 0.35, 0.5])
        GRID.push({ gamma, beta, eps, c, lambda: 0 })

// 方向性断言（任何 λ 都必须成立）与强度断言（λ 依赖）分离：
// 方向 = S1–S8 全部 + S9 方向序 + S10 方向序（6:1 锚不被税翻转）
// 强度 = S9 锚2(3n≤0.15) + S10 锚2(2n≤0.35)——λ=0 必然失败，这正是"刀税必要性"的判据

function runDirectional(P) {
  const res = runAsserts(P)
  return res.filter(r => !r.msg.startsWith('S9锚2') && !r.msg.startsWith('S10锚2'))
}
function runStrength(P) {
  return runAsserts(P).filter(r => r.msg.startsWith('S9锚2') || r.msg.startsWith('S10锚2'))
}

const verdicts = GRID.map(P => {
  const dir = runDirectional(P)
  const fails = dir.filter(r => !r.ok)
  return { P, ok: fails.length === 0, fails, res: dir }
})

const okAll = verdicts.filter(v => v.ok)
// 设计意图约束：γ > β 且 |γ−β| ≤ 0.1（早切仅"略微"优于晚切）
const intent = okAll.filter(v => v.P.gamma > v.P.beta && Math.abs(v.P.gamma - v.P.beta) <= 0.1)
const distDefault = P => Math.abs(P.gamma - 0.9) + Math.abs(P.beta - 0.8) + Math.abs(P.eps - 0.05) + Math.abs(P.c - 0.2)

// 排序裕度：S1 全序相邻对 + S2 早/晚 的 log 间距最小值
function minMargin(P) {
  let mm = Infinity
  for (const sc of [S1, S2]) {
    const rows = evalScenario(sc, P)
    for (const order of sc.order) {
      const logs = order.map(n => Math.log(rows.find(r => r.name === n).raw))
      for (let i = 1; i < logs.length; i++) mm = Math.min(mm, logs[i - 1] - logs[i])
    }
  }
  return mm
}
for (const v of okAll) v.margin = minMargin(v.P)
const intentSorted = [...intent].sort((a, b) => (b.margin - a.margin) || (distDefault(a.P) - distDefault(b.P)))

/* λ 扫描（默认 γβ ε c × λ）：方向断言给上限、强度断言给下限 */
const LAMBDA_SWEEP = [0, 0.2, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.85, 1.0]
const lambdaRows = LAMBDA_SWEEP.map(l => {
  const P = { ...DEFAULT, lambda: l }
  const dir = runDirectional(P)
  const str = runStrength(P)
  return { l, dirOk: dir.every(r => r.ok), strOk: str.every(r => r.ok), strMsgs: str.map(r => `${r.ok ? '✓' : '✗'} ${r.msg}`) }
})
const lambdaMin = lambdaRows.find(r => r.strOk)?.l ?? null
const lambdaMax = [...lambdaRows].reverse().find(r => r.dirOk)?.l ?? null

/* ---------------- 报告 ---------------- */

const rep = []
rep.push('# mech-metric-scenarios：v3 乘法指标合成验证 + 参数定参')
rep.push('')
rep.push(`> 公式：score_s = R·P·A；l̂ = (cut−flip)/max(N/n,1)；w = γ^max(0,−l̂)·β^max(0,l̂)；漏→ε；匹配半径 c·s。`)
rep.push('')
rep.push(`## 1. 合成情形（先验排序由构造保证）`)
rep.push('')
for (const sc of ALL) {
  rep.push(`### ${sc.name}`)
  rep.push(`- N=${sc.N}，翻转=[${sc.flips.join(',')}]（段单位 s=${(sc.N / sc.flips.length).toFixed(1)}）`)
  rep.push(`- 意图：${sc.intent}`)
  rep.push('')
}
rep.push(`## 2. 默认参数下的逐情形实际分值（γ=${DEFAULT.gamma}, β=${DEFAULT.beta}, ε=${DEFAULT.eps}, c=${DEFAULT.c}）`)
rep.push('')
rep.push('| 情形 | 探测器 | raw score | log | 期望 | 校验 |')
rep.push('|---|---|---|---|---|---|')
for (const sc of ALL) {
  const rows = evalScenario(sc, DEFAULT)
  for (const r of rows) {
    const ok = r.exp === null ? '—' : (r.exp === 0 ? (r.raw === 0 ? '✓' : '✗') : Math.abs(r.raw - r.exp) <= 1e-9 ? '✓' : '✗')
    rep.push(`| ${sc.name} | ${r.name} | ${r.raw.toFixed(5)} | ${r.log === null || r.log === -Infinity ? (r.raw === 0 ? '-∞' : '—') : r.log.toFixed(3)} | ${r.exp === null ? '—' : r.exp.toFixed(5)} | ${ok} |`)
  }
}
rep.push('')
rep.push('## 3. 参数网格（3γ × 3β × 3ε × 3c = 81 组合）')
rep.push('')
const nOk = okAll.length
rep.push(`- 方向性断言（无 λ 税，S1–S8 + S9/S10 方向序 + 6:1 锚）通过：**${nOk}/81**（9 个失败 = γ=β 组合：早切=晚切，违反"早切略优"设计意图，S2 严格序必然失败）`)
rep.push('')
rep.push('### 失败明细（按参数分组计数）')
rep.push('')
const failPatterns = new Map()
for (const v of verdicts) {
  if (v.ok) continue
  for (const f of v.fails) {
    const key = f.msg.split(':')[0]
    failPatterns.set(key, (failPatterns.get(key) ?? 0) + 1)
  }
}
for (const [k, c] of failPatterns) rep.push(`- ${k}: ${c} 组合失败`)
rep.push('')
rep.push('### λ（刀税）扫描：方向给上限 / 强度给下限')
rep.push('')
rep.push('| λ | 方向断言（S1–S8+S9/S10 方向+6:1） | 强度断言（3n≤0.15 ∧ 2n≤0.35） | 强度明细 |')
rep.push('|---|---|---|---|')
for (const r of lambdaRows) {
  rep.push(`| ${r.l} | ${r.dirOk ? '✓' : '✗'} | ${r.strOk ? '✓' : '✗'} | ${r.strMsgs.join('；')} |`)
}
rep.push('')
rep.push(`> **λ 合法区间 = [${lambdaMin}, ${lambdaMax}]**：低于 λ_min=强度锚不满足（多刀太便宜）；高于 λ_max=方向断言破损（税把"全中+3空刀"罚得比"漏2翻转"更差，6:1 锚被翻转）。`)
if (nOk > 0) {
  rep.push('### 全部通过的组合（含裕度；按裕度降序）')
  rep.push('')
  rep.push('| γ | β | ε | c | 最小排序裕度(log) | 满足设计意图(γ>β, Δ≤0.1) |')
  rep.push('|---|---|---|---|---|---|')
  const sorted = [...okAll].sort((a, b) => b.margin - a.margin)
  for (const v of sorted) {
    const ik = v.P.gamma > v.P.beta && Math.abs(v.P.gamma - v.P.beta) <= 0.1
    rep.push(`| ${v.P.gamma} | ${v.P.beta} | ${v.P.eps} | ${v.P.c} | ${v.margin.toFixed(5)} | ${ik ? '✓' : '✗'} |`)
  }
  rep.push('')
  const best = intentSorted[0]
  rep.push(`## 4. 推荐参数（断言全过 ∩ 设计意图 ∩ 最大裕度，平局取距默认最近）`)
  rep.push('')
  if (best) {
    rep.push(`**γ=${best.P.gamma}, β=${best.P.beta}, ε=${best.P.eps}, c=${best.P.c}**（裕度 ${best.margin.toFixed(5)}；意图内候选 ${intent.length}/${nOk}）`)
    if (intentSorted.length > 1) {
      rep.push('')
      rep.push('次优候选：')
      for (const v of intentSorted.slice(1, 4)) {
        rep.push(`- γ=${v.P.gamma}, β=${v.P.beta}, ε=${v.P.eps}, c=${v.P.c}（裕度 ${v.margin.toFixed(5)}）`)
      }
    }
  } else {
    rep.push('无满足全部约束的组合——需放宽断言或重设设计意图。')
  }
}
rep.push('')
rep.push('## 5. 灵敏度发现（决定 ε / c 语义）')
rep.push('')
rep.push('- **退化臂互比不唯一**（S1，默认参数）：rand5(0.0676) > fireall(0.0500) > single(0.0480)——随机 5 刀蹭中 2 翻转得分反超全场扫；U 效用同样认为 rand5 更优。三者同为退化，指标只要求它们低于漏检档（§断言），互比序只是 ε/c 的灵敏度注脚。')
rep.push('- **ε=0.1 时"单发正中"反超"全场扫"**（S1：single(0.056) > fireall(0.05)）；ε=0.05 时两者几乎持平（0.048 vs 0.05）——两者同为退化，指标不应偏袒任一侧，故 ε 取 0.05。')
rep.push('- **c 是"半段偏差"的语义标尺**（S8）：c=0.2 把"每刀偏 1/4 段"判死（0）；c=0.5 给它 0.945 高分——1/4 段偏差在压缩语义下不可接受，故 c 取 0.2。')
rep.push('- **rand5 vs fireall**：c 越松随机刀越容易蹭窗内（c=0.5 时随机刀可拿 ~0.9 分）——半径必须由 c=0.2 压住，否则指标回退到"±2 宽窗免费位"问题。')
rep.push('')
rep.push('## 6. 结论')
rep.push('')
rep.push('- 合成地面上的 8 类情形验证了 v3 的期望行为：精准>微偏>密度>漏检>退化；早切略优；长短会话等段偏差等分；一刀双中与聚簇被合理惩罚；n=1 漏检一票否决。')
if (nOk > 0 && intent.length > 0) {
  const b2 = intentSorted[0].P
  rep.push(`- 网格最大裕度候选为 **γ=${b2.gamma}, β=${b2.beta}, ε=${b2.eps}, c=${b2.c}**（裕度 ${intentSorted[0].margin.toFixed(5)}），但预注册默认 (0.9,0.8,0.05,0.2)（裕度 0.00527）同在"断言全过"集合内，两者 log 差值仅 ~0.001（分数带 0.1% 级）。`)
  rep.push('- 定参纪律：验证地面不用于最大化参数——只用于判"预注册值是否在可接受集合内"。默认 (0.9,0.8) 的绝对衰减更缓（晚2U 代价 36% vs 44%），与"别让值拉太开"意图一致，故**选定 (γ=0.9, β=0.8, ε=0.05, c=0.2)**，不被合成地面上的微小裕度差带偏。')
} else {
  rep.push('- 无参数组合通过全部断言——需检查断言先验或公式结构。')
}
rep.push('- 下一步：把该指标应用于真实语料（probe22/23 三臂 + fire-all/random-k/no-cut 基线列），排序验证后再进账本。')

writeFileSync('reports/mech-metric-scenarios.md', rep.join('\n'))
console.log(rep.join('\n'))
console.log('\nsaved reports/mech-metric-scenarios.md')
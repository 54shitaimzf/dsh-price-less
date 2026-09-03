/**
 * probe24：v3 乘法指标下全组合（M1–M7 优化器组合 + M0 生产）重跑 —— LOSO 参数重搜 + 退化基线 + 预算上限 + 手工验收区。
 *
 * 预注册（相对 probe22 的唯一改动 = 指标）：
 *   - 选择目标：v3 meanLog（聚合 = 几何均值，raw=0 → LOG_ZERO=−6）
 *   - 约束门：单意图误开率 ≤ 50%（train 折）；最终验收同门 + v3 超额（vs rand-k 基线）
 *   - 基线列：no-cut / fire-all / random-k(3种子均值) / perf-exact(指标自检：必须恰为 1.0)
 *   - 预算@GT：oracle 贪心上限（候选 = 该臂自身开火位，k=min(n,m)；仅供能力上限诊断，明确标注）
 * 运行：node scripts/mech_probe24.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { canonicalizeClaudeset, canonicalizeDsh, loadClaudesetLabels, loadDshLabels, loadLabelsJson } from './mech_replay.mjs'
import { staticFeatures } from './mech_features.mjs'
import { ARMS } from './mech_arms.mjs'
import { sessSummary } from './mech_eval.mjs'
import { v3score, aggregateV3, greedyBudget, METRIC_V3, LOG_ZERO } from './mech_metric.mjs'

/* ================= 数据加载（与 probe22 同源） ================= */

const SHARD = 'datasets/claudeset_shard.jsonl'
const SS_ROOT = 'C:/Users/Administrator/.dsh/sessions'
function readClaudeset() {
  const lines = readFileSync(SHARD, 'utf8').split('\n').filter(Boolean)
  const db = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(o => Array.isArray(o.turns))
  return new Map(db.map(s => [s.id.slice(0, 8), s]))
}
const GROUPS = ['--D-deepseek-plugin--', '--C-Users-Administrator-Desktop-card_sample--', '--C-Users-Administrator-Desktop-Chinese-Resume-in-Typst--', '--C-Users-Administrator-Desktop-RootUp--']
function resolveSessionPath(id) {
  for (const g of GROUPS) {
    const p = `${SS_ROOT}/${g}/${id}/session.jsonl.zstd`
    if (existsSync(p)) return p
  }
  return null
}
function loadAll() {
  const sessions = []
  const shard = readClaudeset()
  const cla = loadClaudesetLabels('datasets/labels/claudeset.json')
  for (const [id8, lab] of cla) {
    const s = shard.get(id8)
    if (s) sessions.push(canonicalizeClaudeset(s, lab))
  }
  if (existsSync('datasets/labels/claudeset-ext.json')) {
    const ext = loadClaudesetLabels('datasets/labels/claudeset-ext.json')
    for (const [id8, lab] of ext) {
      const s = shard.get(id8)
      if (s) sessions.push(canonicalizeClaudeset(s, { ...lab, labeler: 'ai-draft' }))
    }
  }
  const dshLab = loadDshLabels('datasets/labels/local-dsh.json')
  for (const [id, lab] of dshLab) {
    const path = resolveSessionPath(id)
    if (path) sessions.push(canonicalizeDsh(path, lab))
  }
  if (existsSync('datasets/labels/local-ext.json')) {
    const ext = loadLabelsJson('datasets/labels/local-ext.json')
    for (const lab of ext.sessions ?? []) {
      const path = resolveSessionPath(lab.id)
      if (path) sessions.push(canonicalizeDsh(path, { ...lab, labeler: 'ai-draft' }))
    }
  }
  if (existsSync('datasets/labels/local-holdout.json')) {
    const ho = loadLabelsJson('datasets/labels/local-holdout.json')
    for (const lab of ho.sessions ?? []) {
      const path = resolveSessionPath(lab.id)
      if (path) sessions.push(canonicalizeDsh(path, { ...lab, labeler: 'ai-draft' }))
    }
  }
  const cur = loadLabelsJson('datasets/labels/current-session.json')
  const curPath = resolveSessionPath('session-17eeebba-5666-4607-bafa-1befd583f975')
  sessions.push(canonicalizeDsh(curPath, { ...cur, id: curPath, single: cur.single }))
  for (const s of sessions) s.staticF = staticFeatures(s)
  return sessions
}

/* ================= 搜索空间（与 probe22 同源） ================= */

const W_RANGES = {
  corr: [0.6, 1.0, 1.4, 2.0], lex: [0.2, 0.5, 0.8, 1.2], cluster: [0.0, 0.3, 0.6, 1.0],
  todo: [0.0, 0.3, 0.6, 1.0], cohesion: [0.0, 0.3, 0.6, 1.0, 1.5], dump: [-0.6, -0.3, 0.0, 0.3],
  goal: [-0.6, -0.3, 0.0, 0.3], question: [0.0, 0.15, 0.3], imperative: [0.0, 0.15, 0.3],
  lenratio: [-0.3, 0.0, 0.3], toolwrite: [0.0, 0.15, 0.3], toolread: [0.0, 0.1, 0.2],
}
const BIAS = [-0.4, -0.2, 0.0, 0.2]
const THETA = [0.3, 0.4, 0.5, 0.7, 0.9, 1.1, 1.3, 1.6]
const MUS = [2, 4, 6, 8]
const SIGMAS = [1.5, 3]
const MININT = [2, 4, 6]
const BANDS = [[0.7, 1.1], [0.9, 1.3], [1.1, 1.5]]
const DIPS = [0.45, 0.6, 0.75]
const SEEDED_CONFIGS = [
  { w: {}, bias: 0, theta: 0.3, strongGate: false },
  { w: {}, bias: 0, theta: 0.4, strongGate: false },
  { w: { lex: 0.5, corr: 0.8 }, bias: 0, theta: 0.5, strongGate: false },
]
const ARM_FEAT = {
  M1: ['corr', 'lex', 'cluster', 'todo'],
  M2: ['corr', 'lex', 'cluster', 'todo', 'cohesion'],
  M3: ['corr', 'lex', 'cluster', 'todo', 'cohesion', 'dump', 'goal'],
  M4: ['corr', 'lex', 'cluster', 'todo', 'cohesion', 'dump', 'goal'],
  M5: ['corr', 'lex', 'cluster', 'todo', 'cohesion', 'dump', 'goal'],
  M6: ['corr', 'lex', 'cluster', 'todo', 'cohesion', 'dump', 'goal'],
  M7: ['corr', 'lex', 'cluster', 'todo'],
}
function sampleConfig(arm, rng) {
  const w = {}
  for (const k of ARM_FEAT[arm]) {
    const arr = W_RANGES[k]
    if (rng() < 0.5) w[k] = arr[Math.floor(rng() * arr.length)]
  }
  const cfg = { w, bias: BIAS[Math.floor(rng() * BIAS.length)], theta: THETA[Math.floor(rng() * THETA.length)], strongGate: rng() < 0.3 }
  if (arm === 'M4' || arm === 'M5' || arm === 'M6') {
    cfg.mu = MUS[Math.floor(rng() * MUS.length)]
    cfg.sigma = SIGMAS[Math.floor(rng() * SIGMAS.length)]
  }
  if (arm === 'M5') {
    cfg.band = BANDS[Math.floor(rng() * BANDS.length)]
    cfg.dip = DIPS[Math.floor(rng() * DIPS.length)]
  }
  if (arm === 'M6') cfg.minInterval = MININT[Math.floor(rng() * MININT.length)]
  return cfg
}
function refineConfig(arm, cfg, rng) {
  const c = JSON.parse(JSON.stringify(cfg))
  const feats = ARM_FEAT[arm]
  if (rng() < 0.5) {
    const k = feats[Math.floor(rng() * feats.length)]
    const arr = W_RANGES[k]
    let v = c.w[k] ?? 0
    const idx = arr.findIndex(x => Math.abs(x - v) < 1e-9)
    c.w[k] = arr[Math.min(arr.length - 1, Math.max(0, (idx < 0 ? Math.floor(rng() * arr.length) : idx) + (rng() < 0.5 ? 1 : -1)))]
  } else {
    const key = ['bias', 'theta', ...(arm.startsWith('M4') || arm === 'M5' || arm === 'M6' ? ['mu'] : []), ...(arm === 'M5' ? ['dip'] : []), ...(arm === 'M6' ? ['minInterval'] : [])][Math.floor(rng() * 4)]
    if (key === 'bias') c.bias = BIAS[Math.min(BIAS.length - 1, Math.max(0, BIAS.indexOf(c.bias) + (rng() < 0.5 ? 1 : -1)))]
    else if (key === 'theta') c.theta = THETA[Math.min(THETA.length - 1, Math.max(0, THETA.indexOf(c.theta) + (rng() < 0.5 ? 1 : -1)))]
    else if (key === 'mu') c.mu = MUS[Math.min(MUS.length - 1, Math.max(0, MUS.indexOf(c.mu) + (rng() < 0.5 ? 1 : -1)))]
    else if (key === 'dip') c.dip = DIPS[Math.min(DIPS.length - 1, Math.max(0, DIPS.indexOf(c.dip) + (rng() < 0.5 ? 1 : -1)))]
    else if (key === 'minInterval') c.minInterval = MININT[Math.min(MININT.length - 1, Math.max(0, MININT.indexOf(c.minInterval) + (rng() < 0.5 ? 1 : -1)))]
  }
  return c
}
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ================= v3 评估 ================= */

const v3 = (s, cuts) => v3score(s.us.length, s.gt.coarse.filter(g => g > 0), cuts, METRIC_V3)

/** 单会话旧指标快照（对照列用）。 */
function oldMetrics(s, cuts) {
  const sm = sessSummary(s, cuts)
  const m = sm.m
  const gtLen = Math.max(m.gtLen || 0, 0)
  const misses = gtLen - m.hits
  return { recall: gtLen ? m.hits / gtLen : 0, utility: m.hits - 3 * misses - 0.5 * m.fps - sm.bm.falseOrphan, fps: m.fps }
}

/** 单意图误开（sessSummary 口径）。 */
function singleOpen(s, cuts) {
  const sm = sessSummary(s, cuts)
  return sm.m.single ? (sm.m.fps > 0 ? 1 : 0) : null
}

/** 基线：no-cut / fire-all / rand-k(3种子) / perf-exact。session 级计算一次。 */
function baselinesFor(s) {
  const N = s.us.length
  const flips = s.gt.coarse.filter(g => g > 0)
  const n = flips.length
  const b = { noCut: v3(s, []), fireAll: v3(s, Array.from({ length: N }, (_, i) => i + 1)), perf: v3(s, flips), randK: [] }
  if (n > 0) {
    for (const seed of [101, 202, 303]) {
      const rnd = mulberry32(seed + N * 7 + n * 13)
      const set = new Set()
      while (set.size < Math.min(n, N)) set.add(1 + Math.floor(rnd() * N))
      b.randK.push(v3(s, [...set]))
    }
  }
  return b
}

/* ================= 主流程 ================= */

function fmt(x, d = 3) { return x === null || x === undefined || Number.isNaN(x) ? '-' : (+x).toFixed(d) }

const sessions = loadAll()
const holdoutIds = new Set([
  'C:/Users/Administrator/.dsh/sessions/--D-deepseek-plugin--/session-17eeebba-5666-4607-bafa-1befd583f975/session.jsonl.zstd',
  'session-74a1b607-7f0a-43fa-9887-630e0638075a',
  'session-d76c205b-dac5-4537-8f76-3ffb00474540',
])
const searchSessions = sessions.filter(s => !holdoutIds.has(s.id))
const holdoutSessions = sessions.filter(s => holdoutIds.has(s.id))
console.log(`sessions: ${sessions.length} | search: ${searchSessions.length} | holdout: ${holdoutSessions.length}`)

const ARM_NAMES = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7']
const SEARCH_BUDGET = 100
const SEED = 20260829

/* 基线（逐会话一次） */
const base = new Map(searchSessions.map(s => [s.id, baselinesFor(s)]))

/* LOSO 搜索（v3 meanLog 目标 + 单意图门约束）；结果缓存到 reports/probe24-foldcache.json */
const CACHE = 'reports/probe24-foldcache.json'
function restoreCache(j) {
  for (const arm of ARM_NAMES) {
    for (const f of j[arm]) {
      if (f.m && f.m.raw === 0 && f.m.log === null) f.m.log = -Infinity
      if (!('singleOpen' in f)) f.singleOpen = null
    }
  }
  return j
}
let foldResults = null
if (existsSync(CACHE) && !process.env.PROBE24_NOCACHE) {
  try {
    foldResults = restoreCache(JSON.parse(readFileSync(CACHE, 'utf8')))
    console.log('loaded fold cache from reports/probe24-foldcache.json')
  } catch { foldResults = null }
}
if (foldResults === null) {
  foldResults = {}
  for (const arm of ARM_NAMES) foldResults[arm] = []
for (let vIdx = 0; vIdx < searchSessions.length; vIdx++) {
  const val = searchSessions[vIdx]
  const train = searchSessions.filter((s, i) => i !== vIdx)
  for (const arm of ARM_NAMES) {
    if (arm === 'M0') {
      const cuts = ARMS.M0.run(val, val.staticF, {})
      foldResults[arm].push({ cfg: null, m: v3(val, cuts), old: oldMetrics(val, cuts), singleOpen: singleOpen(val, cuts) })
      continue
    }
    const rng = mulberry32(SEED + vIdx * 100 + ARM_NAMES.indexOf(arm) * 13)
    const scoreOf = (cfg) => {
      // 每会话单趟 replay：cuts 同时喂 v3 与单意图开火计数
      let sumLog = 0, sumRaw = 0, zeros = 0, nS = 0, openN = 0, openHits = 0
      for (const s of train) {
        const cuts = ARMS[arm].run(s, s.staticF, cfg)
        if (s.single) {
          openN++
          if (cuts.filter(c => c > 0).length > 0) openHits++
          continue
        }
        const flips = s.gt.coarse.filter(g => g > 0)
        if (flips.length === 0) continue
        const v = v3score(s.us.length, flips, cuts, METRIC_V3)
        nS++; sumRaw += v.raw
        if (v.raw === 0) { zeros++; sumLog += LOG_ZERO } else sumLog += v.log
      }
      const meanLog = nS ? sumLog / nS : null
      return { agg: { meanLog, meanRaw: nS ? sumRaw / nS : 0, zeroSessions: zeros, nSessions: nS }, openRate: openN ? openHits / openN : 0 }
    }
    let best = null
    let guard = 0
    const consider = (cfg) => {
      const r = scoreOf(cfg)
      const okGate = r.openRate <= 0.5
      if (best === null || (okGate && r.agg.meanLog > best.r.agg.meanLog) || (best && !best.okGate && okGate)) best = { cfg, r, okGate }
      else if (best && best.okGate === okGate && r.agg.meanLog > best.r.agg.meanLog) best = { cfg, r, okGate }
    }
    for (const seedCfg of SEEDED_CONFIGS) {
      const cfg = { ...seedCfg, w: { ...seedCfg.w } }
      if (arm === 'M4' || arm === 'M5' || arm === 'M6') { cfg.mu = MUS[0]; cfg.sigma = SIGMAS[0] }
      if (arm === 'M5') { cfg.band = BANDS[0]; cfg.dip = DIPS[0] }
      if (arm === 'M6') cfg.minInterval = 0
      consider(cfg)
    }
    for (let i = 0; i < SEARCH_BUDGET; i++) consider(sampleConfig(arm, rng))
    for (let i = 0; i < 20; i++) consider(refineConfig(arm, best.cfg, rng))
    const cuts = ARMS[arm].run(val, val.staticF, best.cfg)
    foldResults[arm].push({ cfg: best.cfg, m: v3(val, cuts), old: oldMetrics(val, cuts), singleOpen: singleOpen(val, cuts), gateOk: best.okGate })
  }
  if (vIdx % 5 === 0) console.log(`fold ${vIdx}/${searchSessions.length} done`)
}
  writeFileSync(CACHE, JSON.stringify(foldResults))
  console.log(`saved fold cache (${Object.keys(foldResults).length} arms × ${foldResults[ARM_NAMES[0]].length} folds)`)
}

/* 汇总 */
function foldAvg(arm) {
  const fs = foldResults[arm]
  const withN = fs.filter(f => f.m.raw !== null)
  const agg = aggregateV3(fs.map(f => f.m))
  const avg = k => fs.reduce((a, f) => a + (f[k] ?? 0), 0) / fs.length
  const R = withN.reduce((a, f) => a + f.m.R, 0) / (withN.length || 1)
  const Pn = withN.reduce((a, f) => a + f.m.Pn, 0) / (withN.length || 1)
  const A = withN.reduce((a, f) => a + f.m.A, 0) / (withN.length || 1)
  const openN = fs.filter(f => f.singleOpen !== null).length
  const openHits = fs.reduce((a, f) => a + (f.singleOpen ?? 0), 0)
  return {
    meanLog: agg.meanLog, meanRaw: agg.meanRaw, zeroSessions: agg.zeroSessions, nSessions: agg.nSessions,
    R, Pn, A,
    openRate: openN ? openHits / openN : 0,
    recall: avg('old.recall') === undefined ? fs.reduce((a, f) => a + f.old.recall, 0) / fs.length : fs.reduce((a, f) => a + f.old.recall, 0) / fs.length,
    utility: fs.reduce((a, f) => a + f.old.utility, 0) / fs.length,
    gateOkFolds: fs.filter(f => f.gateOk !== false).length,
  }
}

/* 基线聚合（同样本集合 21 折） */
const baseAgg = {
  noCut: aggregateV3(searchSessions.map(s => base.get(s.id).noCut)),
  fireAll: aggregateV3(searchSessions.map(s => base.get(s.id).fireAll)),
  perf: aggregateV3(searchSessions.map(s => base.get(s.id).perf)),
  randK: aggregateV3(searchSessions.flatMap(s => base.get(s.id).randK)),
}

/* 冠军配置（每臂 LOSO 最优折，probe22 同款惯例）→ finalist 全搜索集评估 */
const champion = {}
for (const arm of ARM_NAMES) {
  if (arm === 'M0') { champion[arm] = null; continue }
  let bf = null
  for (const f of foldResults[arm]) {
    if (bf === null || f.m.raw > bf.m.raw) bf = f
  }
  champion[arm] = bf.cfg
}

/* ================= 手工验收区 ================= */

const verif = []
try {
  // 1) perf-exact 全局自检：每个 n≥1 会话 raw 必须恰为 1.0
  let perfBad = 0
  for (const s of searchSessions) {
    const b = base.get(s.id)
    if (b.perf.raw !== null && !(Math.abs(b.perf.raw - 1) <= 1e-12)) perfBad++
  }
  verif.push(`perf-exact raw==1.0：${searchSessions.length} 会话中坏 ${perfBad} 个`)

// 2) no-cut / fire-all 组件等式（单意图 raw=null 跳过）
let noCutBad = 0, faBad = 0
for (const s of searchSessions) {
  const b = base.get(s.id)
  if (b.noCut.raw !== null && b.noCut.raw !== 0) noCutBad++
  const n = s.gt.coarse.filter(g => g > 0).length
  if (n > 0) {
    if (Math.abs(b.fireAll.R - 1) > 1e-12 || Math.abs(b.fireAll.Pn - n / s.us.length) > 1e-12) faBad++
  }
}
verif.push(`no-cut raw==0（多意图会话）：坏 ${noCutBad} 个；fire-all 组件等式 (R=1, P=n/N)：坏 ${faBad} 个`)

// 3) 组件界
let boundBad = 0
for (const s of searchSessions) {
  for (const k of ['noCut', 'fireAll', 'perf']) {
    const x = base.get(s.id)[k]
    if (x.raw !== null && !(x.R >= 0 && x.R <= 1 && x.Pn >= 0 && x.Pn <= 1 && x.A >= 0 && x.A <= 1)) boundBad++
  }
}
verif.push(`组件界 0≤R,P,A≤1：坏 ${boundBad} 个`)

// 4) 随机基线可复现（同一会话三种子各不相同且确定）
const rSeeds = new Set(base.get(searchSessions[0].id).randK.map(x => x.raw))
verif.push(`random-k 三种子原始值去重数（>1 表示各种子路径不同）：${rSeeds.size}`)

// 5) 逐步演算示例 A：本对话（holdout）M7 冠军
{
  const s = holdoutSessions.find(x => x.id.includes('17eeebba'))
  if (s && champion.M7) {
    const cuts = ARMS.M7.run(s, s.staticF, champion.M7)
    const sc = v3(s, cuts)
    const flips = s.gt.coarse.filter(g => g > 0)
    verif.push(`\n示例A 本对话·M7冠军 cfg=${JSON.stringify(champion.M7)}`)
    verif.push(`  N=${s.us.length} n=${flips.length} s=${fmt(sc.s, 2)} radius=${fmt(sc.radius, 2)} m=${sc.m} k=${sc.k}`)
    verif.push(`  逐翻转延迟 lat=[${sc.lat.map(x => x === null ? 'null' : x).join(',')}]`)
    const w = (l) => l === null ? METRIC_V3.eps : METRIC_V3.gamma ** Math.max(0, -l / sc.s) * METRIC_V3.beta ** Math.max(0, l / sc.s)
    verif.push(`  逐翻转 w=[${sc.lat.map(l => fmt(w(l), 4)).join(',')}]`)
    verif.push(`  R=${fmt(sc.R, 4)} P=${fmt(sc.Pn, 4)} A=${fmt(sc.A, 4)} raw=${fmt(sc.raw, 5)} log=${fmt(sc.log, 3)}`)
  }
}

// 6) 逐步演算示例 B：mails（claudeset 搜索集）M4 冠军
{
  const s = searchSessions.find(x => x.id.startsWith('0ff3015a'))
  if (s && champion.M4) {
    const cuts = ARMS.M4.run(s, s.staticF, champion.M4)
    const sc = v3(s, cuts)
    verif.push(`\n示例B mails·M4冠军 cfg=${JSON.stringify(champion.M4)}`)
    verif.push(`  N=${s.us.length} n=${s.gt.coarse.filter(g => g > 0).length} s=${fmt(sc.s, 2)} radius=${fmt(sc.radius, 2)} m=${sc.m} k=${sc.k}`)
    verif.push(`  逐翻转延迟 lat=[${sc.lat.map(x => x === null ? 'null' : x).join(',')}]`)
    verif.push(`  R=${fmt(sc.R, 4)} P=${fmt(sc.Pn, 4)} A=${fmt(sc.A, 4)} raw=${fmt(sc.raw, 5)} log=${fmt(sc.log, 3)}`)
  }
}
} catch (e) {
  verif.push('验收区异常（报告仍写出）: ' + (e?.message ?? String(e)))
}

/* ================= finalist：全搜索集 + holdout ================= */

const finalist = {}
try {
  for (const arm of ARM_NAMES) {
    const run = ARMS[arm].run
    const cfg = champion[arm] ?? {}
    const sEval = searchSessions.map(s => { const cuts = run(s, s.staticF, cfg); return { cuts, v: v3(s, cuts), old: oldMetrics(s, cuts), so: singleOpen(s, cuts) } })
    const hEval = holdoutSessions.map(s => { const cuts = run(s, s.staticF, cfg); return { cuts, v: v3(s, cuts), old: oldMetrics(s, cuts), so: singleOpen(s, cuts) } })
    const agg = aggregateV3(sEval.map(x => x.v))
    const hAgg = aggregateV3(hEval.map(x => x.v))
    // budget per session（oracle 贪心，候选 = 该臂自身开火位；n=0 会话返回 null，过滤）
    const budgetEvals = sEval.map((x, i) => greedyBudget(searchSessions[i].us.length, searchSessions[i].gt.coarse.filter(g => g > 0), x.cuts, METRIC_V3).raw).filter(v => v !== null)
    finalist[arm] = {
      agg, hAgg,
      budgetAgg: aggregateV3(budgetEvals.map(raw => raw > 0 ? { raw, log: Math.log(raw) } : { raw: 0, log: LOG_ZERO })),
      openRate: sEval.filter(x => x.so !== null).length ? sEval.reduce((a, x) => a + (x.so ?? 0), 0) / sEval.filter(x => x.so !== null).length : 0,
      hOpenRate: hEval.filter(x => x.so !== null).length ? hEval.reduce((a, x) => a + (x.so ?? 0), 0) / hEval.filter(x => x.so !== null).length : 0,
      recall: sEval.reduce((a, x) => a + x.old.recall, 0) / sEval.length,
      utility: sEval.reduce((a, x) => a + x.old.utility, 0) / sEval.length,
    }
  }
} catch (e) {
  console.error('finalist 异常（报告仍写出）:', e?.message ?? e)
  for (const arm of ARM_NAMES) finalist[arm] = finalist[arm] ?? { agg: {}, hAgg: {}, budgetAgg: {}, openRate: NaN, hOpenRate: NaN, recall: NaN, utility: NaN }
}

/* ================= 报告 ================= */

const rep = []
rep.push('# probe24：v3 指标下全组合重跑 —— LOSO 重搜 + 退化基线 + 预算上限 + 验收')
rep.push('')
rep.push('> 指标：score_s = R·P·A（段单位标准化距离、早切略优、漏→ε）；γ=0.9/β=0.8/ε=0.05/c=0.2（合成网格定参，reports/mech-metric-scenarios.md）。')
rep.push('> 选择目标：v3 meanLog（几何均值；raw=0 → LOG_ZERO=−6）；约束：单意图误开 ≤50%；基线列：no-cut/fire-all/rand-k/perf-exact。')
rep.push('')
rep.push(`## 0. 语料：search=${searchSessions.length}（LOSO）| holdout=${holdoutSessions.length}（单跑）`)
rep.push('')
rep.push('## 1. LOSO 臂对照（新指标；组件为 n≥1 折均值）')
rep.push('')
rep.push('| 臂 | meanLog | meanRaw | R | P | A | 零分会话 | 单意图误开 | 旧recall(±2) | 旧U |')
rep.push('|---|---|---|---|---|---|---|---|---|---|')
for (const arm of ARM_NAMES) {
  const r = foldAvg(arm)
  rep.push(`| ${arm} | ${fmt(r.meanLog, 3)} | ${fmt(r.meanRaw, 4)} | ${fmt(r.R, 3)} | ${fmt(r.Pn, 3)} | ${fmt(r.A, 3)} | ${r.zeroSessions} | ${fmt(100 * r.openRate, 1)}% | ${fmt(r.recall)} | ${fmt(r.utility)} |`)
}
rep.push('')
rep.push('## 2. 基线列（同 21 折样本）')
rep.push('')
rep.push('| 基线 | meanLog | meanRaw | R | P | A |')
rep.push('|---|---|---|---|---|---|')
for (const [k, agg] of Object.entries(baseAgg)) {
  let R = 0, Pn = 0, A = 0, cnt = 0
  for (const s of searchSessions) {
    const arr = k === 'randK' ? base.get(s.id).randK : [base.get(s.id)[k]]
    for (const x of arr) {
      if (x.raw === null) continue
      R += x.R; Pn += x.Pn; A += x.A; cnt++
    }
  }
  rep.push(`| ${k} | ${fmt(agg.meanLog, 3)} | ${fmt(agg.meanRaw, 4)} | ${fmt(cnt ? R / cnt : 0, 3)} | ${fmt(cnt ? Pn / cnt : 0, 3)} | ${fmt(cnt ? A / cnt : 0, 3)} |`)
}
rep.push('')
rep.push('> perf-exact = 用 GT 翻转位当切割（指标自检：raw 必须恰为 1.0）；rand-k = 每会话 n 个随机位（3 种子均值）。')
rep.push('')
rep.push('## 3. 冠军配置（每臂 LOSO 最优折配置）')
rep.push('')
for (const arm of ARM_NAMES) {
  if (arm === 'M0') continue
  rep.push(`**${arm}** \`${JSON.stringify(champion[arm])}\``)
}
rep.push('')
rep.push('## 4. finalist（冠军配置 × 全搜索集；含预算@GT oracle 上限）')
rep.push('')
rep.push('| 臂 | meanLog | meanRaw | 预算oracle meanLog | 单意图误开 | 旧recall | 旧U |')
rep.push('|---|---|---|---|---|---|---|')
for (const arm of ARM_NAMES) {
  const f = finalist[arm]
  rep.push(`| ${arm} | ${fmt(f.agg.meanLog, 3)} | ${fmt(f.agg.meanRaw, 4)} | ${fmt(f.budgetAgg.meanLog, 3)} | ${fmt(100 * f.openRate, 1)}% | ${fmt(f.recall)} | ${fmt(f.utility)} |`)
}
rep.push('')
rep.push('## 5. holdout 单跑（冠军配置）')
rep.push('')
rep.push('| 臂 | holdout meanLog | holdout meanRaw | holdout R/P/A | 单意图误开 |')
rep.push('|---|---|---|---|---|')
for (const arm of ARM_NAMES) {
  const f = finalist[arm]
  const cfg = champion[arm] ?? {}
  const comps = holdoutSessions.map(s => v3(s, ARMS[arm].run(s, s.staticF, cfg))).filter(x => x.raw !== null)
  const avg = k => comps.length ? comps.reduce((a, x) => a + x[k], 0) / comps.length : 0
  rep.push(`| ${arm} | ${fmt(f.hAgg.meanLog, 3)} | ${fmt(f.hAgg.meanRaw, 4)} | ${fmt(avg('R'), 3)} / ${fmt(avg('Pn'), 3)} / ${fmt(avg('A'), 3)} | ${fmt(100 * f.hOpenRate, 1)}% |`)
}
rep.push('')
rep.push('## 6. 手工验收')
rep.push('')
for (const v of verif) rep.push(`- ${v}`)
rep.push('')
rep.push('## 7. 结论（诚实版）')
rep.push('')
rep.push('- 由 §4/§5 与基线列判定：最优组合 = meanLog 最高且单意图误开 ≤50% 的臂；若所有臂超额（vs rand-k）不足，则结论为"新指标下无臂达标"，最优仅相对意义。')

writeFileSync('reports/probe24.md', rep.join('\n'))
console.log(rep.join('\n'))
console.log('\nsaved reports/probe24.md')
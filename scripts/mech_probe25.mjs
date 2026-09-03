/**
 * probe25：刀数衡量策略的真实语料验证 —— λ 刀税 × LOG_ZERO 地板全网格。
 *
 * 设计（预注册）：
 *   - 候选池固定：每折每臂 = 3 种子 + 100 随机采样 + 20 坐标微调（从 λ=0 最优出发），种子 20260829。
 *     候选池与目标无关 → 单趟回放全部候选并缓存 v3 组件 {k,m,R,P,A}（与 λ 无关），
 *     λ/LZ 各目标仅做 O(1) 重算 + 重排序（公平对比；每目标的最优 = 池内最优，声明为固定池近似）。
 *   - raw(λ) = R·P·A·exp(−λ·max(0,m−n)/n)；聚合 meanLog（raw=0 → LOG_ZERO）。
 *   - λ ∈ {0, 0.2, 0.35, 0.4, 0.5} × LZ ∈ {−6, −4}；强度锚区间 [0.4, 0.85] 由合成套件给出。
 *   - 全面衡量：meanLog/meanRaw/R/P/A、零分会话、单意图误开、m/n 分布（中位/p90/少刀占比/多刀占比）、
 *     holdout 单跑、预算@GT oracle 对照（λ=0 贪心）。
 * 运行：node scripts/mech_probe25.mjs（后台 ~30-40 分钟；候选池缓存 reports/probe25-poolcache.json）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { canonicalizeClaudeset, canonicalizeDsh, loadClaudesetLabels, loadDshLabels, loadLabelsJson } from './mech_replay.mjs'
import { staticFeatures } from './mech_features.mjs'
import { ARMS } from './mech_arms.mjs'
import { v3score, greedyBudget, METRIC_V3 } from './mech_metric.mjs'

/* ================= 数据加载（与 probe22/24 同源） ================= */

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

/* ================= 搜索空间（与 probe22/24 同源） ================= */

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

/* ================= 组件缓存评估（λ 无关） ================= */

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
const SEED = 20260829
const N_SAMPLE = 100

/** 一次回放一个候选 → 21 个搜索会话的组件记录（si 为 searchSessions 下标）。 */
function evalAllCfg(arm, cfg) {
  const run = ARMS[arm].run
  const recs = searchSessions.map((s, si) => {
    const cuts = run(s, s.staticF, cfg)
    if (s.single) return { si, n: 0, open: cuts.filter(c => c > 0).length > 0 ? 1 : 0 }
    const flips = s.gt.coarse.filter(g => g > 0)
    if (flips.length === 0) return { si, n: 0, open: 0 }
    const v = v3score(s.us.length, flips, cuts, { ...METRIC_V3, lambda: 0 })
    return { si, n: flips.length, k: v.k, m: v.m, R: v.R, P: v.Pn, A: v.A, open: 0 }
  })
  return recs
}

/** 组件 → raw(λ)。 */
function rawAt(rec, lambda) {
  if (rec.n === 0) return null
  if (rec.m === 0 || rec.R === 0) return 0
  const D = Math.exp(-lambda * Math.max(0, rec.m - rec.n) / rec.n)
  return rec.R * rec.P * rec.A * D
}

/* ================= 候选池 + 缓存 ================= */

const POOL_CACHE = 'reports/probe25-poolcache.json'
let pool = null
if (existsSync(POOL_CACHE) && !process.env.PROBE25_NOCACHE) {
  try {
    pool = JSON.parse(readFileSync(POOL_CACHE, 'utf8'))
    console.log('loaded pool cache')
  } catch { pool = null }
}
const poolKey = (arm, fIdx) => `${fIdx}:${arm}`

function buildPool() {
  const out = {}
  for (let fIdx = 0; fIdx < searchSessions.length; fIdx++) {
    for (const arm of ARM_NAMES) {
      if (arm === 'M0') continue
      const rng = mulberry32(SEED + fIdx * 100 + ARM_NAMES.indexOf(arm) * 13)
      const cands = []
      for (const seedCfg of SEEDED_CONFIGS) {
        const cfg = { ...seedCfg, w: { ...seedCfg.w } }
        if (arm === 'M4' || arm === 'M5' || arm === 'M6') { cfg.mu = MUS[0]; cfg.sigma = SIGMAS[0] }
        if (arm === 'M5') { cfg.band = BANDS[0]; cfg.dip = DIPS[0] }
        if (arm === 'M6') cfg.minInterval = 0
        cands.push(cfg)
      }
      for (let i = 0; i < N_SAMPLE; i++) cands.push(sampleConfig(arm, rng))
      out[poolKey(arm, fIdx)] = { cands }
    }
  }
  return out
}

/** 评估（或从缓存读）一个候选池条目；返回 {cands: [{cfg, evals}...]} */
function evalPoolEntry(arm, fIdx, entry) {
  return { cands: entry.cands.map(cfg => ({ cfg, evals: evalAllCfg(arm, cfg) })) }
}

async function main() {
  const report = []
  report.push('# probe25：刀数衡量策略真实语料验证 —— λ 刀税 × LOG_ZERO 全网格')
  report.push('')
  report.push('> 候选池固定（3 种子 + 100 采样 + 20 微调自 λ=0 最优），单趟回放缓存 v3 组件，λ/LZ 目标即时重排序（固定池近似，声明）。')
  report.push('> λ 区间 [0.4, 0.85] 由合成套件 S9/S10 强度与方向锚给出（reports/mech-metric-scenarios.md）。')
  report.push('')

  const rawPool = pool && pool.entries ? pool.entries : null
  const entries = {}
  if (rawPool) {
    for (const k of Object.keys(rawPool)) entries[k] = rawPool[k]
  } else {
    const bp = buildPool()
    // 第一遍：评估 103 候选
    for (const k of Object.keys(bp)) {
      const [fIdx, arm] = k.split(':')
      entries[k] = evalPoolEntry(arm, +fIdx, bp[k])
    }
    // 第二遍：λ=0 最优 fold cfg 的 20 步微调（每臂每折）
    for (const k of Object.keys(bp)) {
      const [fIdxStr, arm] = k.split(':')
      const fIdx = +fIdxStr
      const cands = entries[k].cands
      // λ=0 训练 meanLog 最优（门内优先）
      let bcfg = null, bScore = -Infinity
      for (const c of cands) {
        let sumLog = 0, nS = 0, openN = 0, openHits = 0
        for (const rec of c.evals) {
          if (rec.n === 0) { openN++; openHits += rec.open; continue }
          const r = rawAt(rec, 0)
          nS++
          if (r === 0) sumLog += -6; else sumLog += Math.log(r)
        }
        const meanLog = nS ? sumLog / nS : null
        const openRate = openN ? openHits / openN : 0
        if (meanLog !== null && openRate <= 0.5 && meanLog > bScore) { bScore = meanLog; bcfg = c.cfg }
      }
      if (!bcfg) bcfg = cands[0].cfg
      const rng = mulberry32(SEED + fIdx * 100 + ARM_NAMES.indexOf(arm) * 13 + 9999)
      for (let i = 0; i < 20; i++) {
        const cfg = refineConfig(arm, bcfg, rng)
        cands.push({ cfg, evals: evalAllCfg(arm, cfg) })
      }
    }
    writeFileSync(POOL_CACHE, JSON.stringify({ entries }))
    console.log('saved pool cache')
  }

  /* ================= λ × LZ 重排序（纯计算，秒级） ================= */

  const LAMBDAS = [0, 0.2, 0.35, 0.4, 0.5]
  const LZS = [-6, -4]
  const results = {} // arm -> { [`${l}:${lz}`]: { meanLog, meanRaw, R, P, A, zero, openN, openHits, mns, cfg } }

  for (const arm of ARM_NAMES) {
    results[arm] = {}
    for (let fIdx = 0; fIdx < searchSessions.length; fIdx++) {
      const folds = arm === 'M0'
        ? [{ cfg: {}, evals: evalAllCfg('M0', {}) }]
        : entries[poolKey(arm, fIdx)].cands
      for (const l of LAMBDAS) {
        for (const lz of LZS) {
          const key = `${l}:${lz}`
          let x = results[arm][key]
          if (!x) x = results[arm][key] = { meanLog: 0, meanRaw: 0, R: 0, P: 0, A: 0, zero: 0, openN: 0, openHits: 0, mns: [], cfg: null }
          // 训练集（除 fIdx 外 20 会话）选参：门内最高 meanLog
          let bcfg = null, bScore = -Infinity
          for (const c of folds) {
            let sumLog = 0, nS = 0, openN = 0, openHits = 0
            for (const rec of c.evals) {
              if (rec.si === fIdx) continue
              if (rec.n === 0) { openN++; openHits += rec.open; continue }
              const r = rawAt(rec, l)
              nS++
              if (r === 0) sumLog += lz; else sumLog += Math.log(r)
            }
            const meanLog = nS ? sumLog / nS : null
            const openRate = openN ? openHits / openN : 0
            if (meanLog !== null && openRate <= 0.5 && meanLog > bScore) { bScore = meanLog; bcfg = c.cfg }
          }
          if (!bcfg) bcfg = folds[0].cfg
          x.cfg = bcfg
          // 验证折（fIdx 会话）
          const ev = folds.find(c => c.cfg === bcfg).evals
          const vr = ev.find(r => r.si === fIdx)
          if (vr && vr.n > 0) {
            const r = rawAt(vr, l)
            x.meanLog += r === 0 ? lz : Math.log(r)
            x.meanRaw += r
            x.zero += r === 0 ? 1 : 0
            x.R += vr.R; x.P += vr.P; x.A += vr.A
            x.mns.push(vr.m / vr.n)
          } else if (vr) {
            x.openN++; x.openHits += vr.open
          }
        }
      }
    }
  }

  // 聚合
  const aggRow = (arm, key) => {
    const x = results[arm][key]
    const multi = x.mns.length
    const mean = v => v / (multi || 1)
    const mns = [...x.mns].sort((a, b) => a - b)
    const med = mns.length ? mns[Math.floor(mns.length / 2)] : NaN
    const p90 = mns.length ? mns[Math.min(mns.length - 1, Math.floor(mns.length * 0.9))] : NaN
    const few = mns.length ? mns.filter(v => v < 1).length / mns.length : NaN
    const many = mns.length ? mns.filter(v => v > 2).length / mns.length : NaN
    return {
      meanLog: x.meanLog / (multi || 1), meanRaw: mean(x.meanRaw), R: mean(x.R), P: mean(x.P), A: mean(x.A),
      zero: x.zero, openRate: x.openN ? x.openHits / x.openN : 0, med, p90, few, many,
    }
  }

  /* ================= 报告 ================= */

  report.push('## 1. λ × LOG_ZERO 网格（LOSO 均值；表内 = meanLog / meanRaw）')
  report.push('')
  report.push('| 臂 | λ=0 (LZ−6) | 0.2 | 0.35 | 0.4 | 0.5 | λ=0 (LZ−4) | λ=0.4 (LZ−4) | λ=0.5 (LZ−4) |')
  report.push('|---|---|---|---|---|---|---|---|---|')
  for (const arm of ARM_NAMES) {
    const cell = (l, lz) => {
      const r = aggRow(arm, `${l}:${lz}`)
      return `${r.meanLog.toFixed(2)}/${r.meanRaw.toFixed(3)}`
    }
    report.push(`| ${arm} | ${cell(0, -6)} | ${cell(0.2, -6)} | ${cell(0.35, -6)} | ${cell(0.4, -6)} | ${cell(0.5, -6)} | ${cell(0, -4)} | ${cell(0.4, -4)} | ${cell(0.5, -4)} |`)
  }
  report.push('')
  report.push('## 2. 全面衡量（λ ∈ {0, 0.4}, LZ ∈ {−6, −4}；组件与刀数分布）')
  report.push('')
  report.push('| 臂 | 目标 | meanLog | meanRaw | R | P | A | 零会话 | 单意图误开 | m/n 中位 | m/n p90 | 少刀占比 | 多刀占比 |')
  report.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const arm of ARM_NAMES) {
    for (const key of ['0:-6', '0.4:-6', '0.5:-6', '0.4:-4']) {
      const r = aggRow(arm, key)
      report.push(`| ${arm} | λ=${key.split(':')[0]},LZ=${key.split(':')[1]} | ${r.meanLog.toFixed(2)} | ${r.meanRaw.toFixed(3)} | ${r.R.toFixed(2)} | ${r.P.toFixed(2)} | ${r.A.toFixed(2)} | ${r.zero} | ${(100 * r.openRate).toFixed(0)}% | ${r.med.toFixed(2)} | ${r.p90.toFixed(2)} | ${(100 * r.few).toFixed(0)}% | ${(100 * r.many).toFixed(0)}% |`)
    }
  }
  report.push('')
  report.push('## 3. 最优方案（按 meanLog ∩ 门）')
  report.push('')
  const cands = []
  for (const arm of ARM_NAMES) {
    for (const l of LAMBDAS) {
      for (const lz of LZS) {
        const r = aggRow(arm, `${l}:${lz}`)
        if (r.openRate <= 0.5) cands.push({ arm, l, lz, ...r })
      }
    }
  }
  cands.sort((a, b) => b.meanLog - a.meanLog)
  report.push('| 排名 | 臂 | λ | LZ | meanLog | meanRaw | 单意图误开 | m/n 中位 | 少刀占比 | 多刀占比 |')
  report.push('|---|---|---|---|---|---|---|---|---|---|')
  cands.slice(0, 10).forEach((c, i) => report.push(`| ${i + 1} | ${c.arm} | ${c.l} | ${c.lz} | ${c.meanLog.toFixed(2)} | ${c.meanRaw.toFixed(3)} | ${(100 * c.openRate).toFixed(0)}% | ${c.med.toFixed(2)} | ${(100 * c.few).toFixed(0)}% | ${(100 * c.many).toFixed(0)}% |`))
  report.push('')
  report.push('> 同臂 λ=0 vs 选定 λ 对照（同一折选参口径）：')
  for (const arm of ['M4', 'M6', 'M7']) {
    const r0 = aggRow(arm, '0:-6')
    const r1 = aggRow(arm, '0.5:-6')
    report.push(`- ${arm}: λ=0 → ${r0.meanLog.toFixed(2)}（m/n 中位 ${r0.med.toFixed(2)}）；λ=0.5 → ${r1.meanLog.toFixed(2)}（m/n 中位 ${r1.med.toFixed(2)}）`)
  }
  report.push('')
  const top = cands[0]
  if (top) {
    const cfg = results[top.arm][`${top.l}:${top.lz}`].cfg
    let sLog = 0, ok = 0, openHits = 0, openN = 0
    for (const s of holdoutSessions) {
      const cuts = ARMS[top.arm].run(s, s.staticF, cfg)
      if (s.single) { openN++; if (cuts.filter(c => c > 0).length) openHits++; continue }
      const flips = s.gt.coarse.filter(g => g > 0)
      if (!flips.length) continue
      const v = v3score(s.us.length, flips, cuts, { ...METRIC_V3, lambda: top.l })
      ok++; sLog += v.raw === 0 ? top.lz : Math.log(v.raw)
    }
    report.push(`- **holdout 复核**（冠军 ${top.arm}@λ=${top.l},LZ=${top.lz}，折0 配置）：meanLog=${(ok ? sLog / ok : NaN).toFixed(2)}；单意图误开 ${openN ? (100 * openHits / openN).toFixed(0) : '-'}%`)
    report.push('')
  }
  report.push('## 4. 验收')
  report.push('')
  report.push('- 组件缓存与 rawAt 的单点核对：')
  {
    const s = holdoutSessions.find(x => x.id.includes('17eeebba'))
    if (s) {
      const flips = s.gt.coarse.filter(g => g > 0)
      const demoCfg = { w: { lex: 0.5, corr: 0.8 }, bias: 0, theta: 0.5, strongGate: false } // 密度档演示配置（确保开火）
      for (const l of [0, 0.5]) {
        const v0 = v3score(s.us.length, flips, ARMS.M7.run(s, s.staticF, demoCfg), { ...METRIC_V3, lambda: l })
        const f = (x, d = 3) => x === undefined || x === null || Number.isNaN(x) ? '?' : (+x).toFixed(d)
        report.push(`  - 本对话 M7·演示配置 λ=${l}：m=${v0.m} k=${v0.k} R=${f(v0.R)} P=${f(v0.Pn)} A=${f(v0.A)} D=${f(v0.D, 4)} raw=${f(v0.raw, 5)} log=${f(v0.log, 3)}`)
      }
    }
  }
  report.push('  - 手工核算公式：raw(λ) = R·P·A·e^(−λ·max(0,m−n)/n)。')
  report.push('- perf-exact/no-cut/fire-all 不变量同 probe24 §6（同一回放与匹配管线）。')

  writeFileSync('reports/probe25.md', report.join('\n'))
  console.log(report.join('\n'))
  console.log('\nsaved reports/probe25.md')
}

main().catch(e => { console.error('probe25 failed:', e?.message ?? e); console.error(e?.stack ?? ''); process.exit(1) })
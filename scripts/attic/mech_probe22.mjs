/**
 * probe22：机械判别器建模升级 —— 参数搜索（LOSO）+ 臂对照 + 三目的指标 + 综合效用。
 *
 * 预注册（本脚本写死）：
 *   成功标准（相对 M0）：recall ≥ 0.70；每误切平均孤儿 ≤ 0.85；单意图误开率 ≤ 50%；
 *                        英/中双域同时成立；U(a=3,b=0.5,c=1.0) 显著为正。
 *   效用 = hits − a·misses − b·falseCuts − c·orphansFromFalseCuts（probe20 口径扩展）。
 *   划分：搜索 = 除 holdout 外的标签会话；LOSO 逐会话验证；final holdout = 本对话 + 2 本地会话，只在定稿后跑。
 * 运行：node scripts/mech_probe22.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { canonicalizeClaudeset, canonicalizeDsh, loadClaudesetLabels, loadDshLabels, loadLabelsJson } from './mech_replay.mjs'
import { staticFeatures } from './mech_features.mjs'
import { ARMS } from './mech_arms.mjs'
import { sessSummary, utility } from './mech_eval.mjs'

/* ================= 数据加载 ================= */

const SHARD = 'datasets/claudeset_shard.jsonl'
const SS_ROOT = 'C:/Users/Administrator/.dsh/sessions'

/** 读成 jsonl 对象。 */
function readClaudeset() {
  const lines = readFileSync(SHARD, 'utf8').split('\n').filter(Boolean)
  const db = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(o => Array.isArray(o.turns))
  return new Map(db.map(s => [s.id.slice(0, 8), s]))
}

/** 在所有会话分组目录下解析 zstd 会话文件。 */
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
  // 1) claudeset 已标（人类）
  const cla = loadClaudesetLabels('datasets/labels/claudeset.json')
  for (const [id8, lab] of cla) {
    const s = shard.get(id8)
    if (!s) { console.warn(`missing claudeset ${id8}`); continue }
    sessions.push(canonicalizeClaudeset(s, lab))
  }
  // 2) claudeset 扩标（ai-draft）
  if (existsSync('datasets/labels/claudeset-ext.json')) {
    const ext = loadClaudesetLabels('datasets/labels/claudeset-ext.json')
    for (const [id8, lab] of ext) {
      const s = shard.get(id8)
      if (!s) { console.warn(`missing claudeset-ext ${id8}`); continue }
      sessions.push(canonicalizeClaudeset(s, { ...lab, labeler: 'ai-draft' }))
    }
  }
  // 3) 本地 legacy GT
  const dshLab = loadDshLabels('datasets/labels/local-dsh.json')
  for (const [id, lab] of dshLab) {
    const path = resolveSessionPath(id)
    if (!path) { console.warn(`missing local ${id}`); continue }
    sessions.push(canonicalizeDsh(path, lab))
  }
  // 4) 本地扩标（ai-draft）
  if (existsSync('datasets/labels/local-ext.json')) {
    const ext = loadLabelsJson('datasets/labels/local-ext.json')
    for (const lab of ext.sessions ?? []) {
      const path = resolveSessionPath(lab.id)
      if (!path) { console.warn(`missing local-ext ${lab.id}`); continue }
      sessions.push(canonicalizeDsh(path, { ...lab, labeler: 'ai-draft' }))
    }
  }
  // 5) 本地 holdout（ai-draft）
  if (existsSync('datasets/labels/local-holdout.json')) {
    const ho = loadLabelsJson('datasets/labels/local-holdout.json')
    for (const lab of ho.sessions ?? []) {
      const path = resolveSessionPath(lab.id)
      if (!path) { console.warn(`missing holdout ${lab.id}`); continue }
      sessions.push(canonicalizeDsh(path, { ...lab, labeler: 'ai-draft' }))
    }
  }
  // 6) 本对话（ai-draft，holdout）
  const cur = loadLabelsJson('datasets/labels/current-session.json')
  const curPath = resolveSessionPath('session-17eeebba-5666-4607-bafa-1befd583f975')
  sessions.push(canonicalizeDsh(curPath, { ...cur, id: curPath, single: cur.single }))
  // 静态特征预计算
  for (const s of sessions) s.staticF = staticFeatures(s)
  return sessions
}

/* ================= 搜索参数空间 ================= */

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

/** 高密度开火候选（低 θ、零权重——旧 mech 风格"勤开火换召回"的锚点，对照组内明确允许）。 */
const SEEDED_CONFIGS = [
  { w: {}, bias: 0, theta: 0.3, strongGate: false },
  { w: {}, bias: 0, theta: 0.4, strongGate: false },
  { w: { lex: 0.5, corr: 0.8 }, bias: 0, theta: 0.5, strongGate: false },
]

/** 各臂可选特征子集（搜索只采样该臂启用的特征）。 */
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

/** 坐标式微调：对 cfg 的某字段做邻域细化。 */
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

/* 简易确定性 RNG（mulberry32） */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ================= 评估聚合 ================= */

const A = 3, B = 0.5, C = 1.0

/** 在一组 session 上评估一个 arm+cfg，返回聚合指标。 */
function evalOn(arm, cfg, sessions) {
  const run = ARMS[arm].run
  let hits = 0, misses = 0, fps = 0, orphanFP = 0, recallNum = 0, recallDen = 0
  let fireTrue = 0, fireAll = 0, timely5 = 0, timely15 = 0, latN = 0, latSum = 0
  let singleCount = 0, singleOpen = 0, orphanUser = 0, userLen = 0, falseCutsN = 0
  let cutsSum = 0
  for (const s of sessions) {
    const cuts = run(s, s.staticF, cfg)
    const sm = sessSummary(s, cuts)
    const { m, bm } = sm
    hits += m.hits; misses += m.misses; fps += m.fps
    orphanFP += bm.falseOrphan
    recallNum += m.hits; recallDen += m.gtLen
    fireTrue += m.hits; fireAll += m.fireRate
    timely5 += m.timely5; timely15 += m.timely15; latN += m.latency.length; latSum += m.meanLatency * m.latency.length
    if (m.single) { singleCount++; if (m.fps > 0) singleOpen++ }
    orphanUser += bm.orphanUser; userLen += bm.userLenSum; falseCutsN += bm.falseCuts
    cutsSum += cuts.length
  }
  return {
    recall: recallDen ? recallNum / recallDen : 0,
    fireTruth: fireAll ? fireTrue / fireAll : 0,
    meanLatency: latN ? latSum / latN : 0,
    pctTimely5: latN ? timely5 / latN : 0,
    pctTimely15: latN ? timely15 / latN : 0,
    falseCuts: falseCutsN,
    avgPerFalseOrphan: falseCutsN ? orphanFP / falseCutsN : 0,
    orphanUser, userLen,
    singleOpenRate: singleCount ? singleOpen / singleCount : 0,
    utility: hits - A * misses - B * fps - C * orphanFP,
    hits, misses, fps, cutsSum,
  }
}

/* ================= 主流程 ================= */

function fmt(x, d = 3) { return x === null || x === undefined || Number.isNaN(x) ? '-' : (+x).toFixed(d) }

const sessions = loadAll()
const holdoutIds = new Set([
  'C:/Users/Administrator/.dsh/sessions/--D-deepseek-plugin--/session-17eeebba-5666-4607-bafa-1befd583f975/session.jsonl.zstd', // 本对话（id=curPath）
  'session-74a1b607-7f0a-43fa-9887-630e0638075a',
  'session-d76c205b-dac5-4537-8f76-3ffb00474540',
])
const searchSessions = sessions.filter(s => !holdoutIds.has(s.id))
const holdoutSessions = sessions.filter(s => holdoutIds.has(s.id))
console.log(`sessions: ${sessions.length} | search: ${searchSessions.length} | holdout: ${holdoutSessions.length}`)
for (const s of sessions) console.log(`  ${s.corpus} ${String(s.id).slice(0, 14)} U=${s.us.length} flips=${s.gt.coarse.length} single=${s.single}`)

const ARM_NAMES = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7']
const SEARCH_BUDGET = 100 // 每折每臂随机样本 + 坐标微调 20
const SEED = 20260829

/* M0 无参数直接评估（全搜索集） */
const m0all = evalOn('M0', {}, searchSessions)

/* LOSO：每折在 train（去 validation + holdout）上选最优参数，再评 validation */
const foldResults = {} // arm -> {fold: {cfg, metrics}}
for (const arm of ARM_NAMES) foldResults[arm] = []
for (let vIdx = 0; vIdx < searchSessions.length; vIdx++) {
  const val = searchSessions[vIdx]
  const train = searchSessions.filter((s, i) => i !== vIdx)
  for (const arm of ARM_NAMES) {
    if (arm === 'M0') { foldResults[arm].push({ cfg: null, metrics: evalOn('M0', {}, [val]) }); continue }
    const rng = mulberry32(SEED + vIdx * 100 + ARM_NAMES.indexOf(arm) * 13)
    let best = null
    // 先注入高密度种子配置（含 θ 低端），保证"勤开火"变体进入搜索
    for (const seedCfg of SEEDED_CONFIGS) {
      const cfg = { ...seedCfg, w: { ...seedCfg.w } }
      if (arm === 'M4' || arm === 'M5' || arm === 'M6') { cfg.mu = MUS[0]; cfg.sigma = SIGMAS[0] }
      if (arm === 'M5') { cfg.band = BANDS[0]; cfg.dip = DIPS[0] }
      if (arm === 'M6') cfg.minInterval = 0
      const m = evalOn(arm, cfg, train)
      if (best === null || m.utility > best.metrics.utility) best = { cfg, metrics: m }
    }
    for (let i = 0; i < SEARCH_BUDGET; i++) {
      const cfg = sampleConfig(arm, rng)
      const m = evalOn(arm, cfg, train)
      if (best === null || m.utility > best.metrics.utility) best = { cfg, metrics: m }
    }
    for (let i = 0; i < 20; i++) {
      const cfg = refineConfig(arm, best.cfg, rng)
      const m = evalOn(arm, cfg, train)
      if (m.utility > best.metrics.utility) best = { cfg, metrics: m }
    }
    foldResults[arm].push({ cfg: best.cfg, metrics: evalOn(arm, best.cfg, [val]) })
  }
  if (vIdx % 5 === 0) console.log(`fold ${vIdx}/${searchSessions.length} done`)
}

/* 汇总每个臂的 LOSO 平均（按会话均值） */
function foldAvg(arm) {
  const ms = foldResults[arm].map(f => f.metrics)
  const n = ms.length
  const avg = k => ms.reduce((a, m) => a + m[k], 0) / n
  return {
    recall: avg('recall'), fireTruth: avg('fireTruth'), meanLatency: avg('meanLatency'),
    pctTimely5: avg('pctTimely5'), pctTimely15: avg('pctTimely15'),
    falseCuts: avg('falseCuts'), avgPerFalseOrphan: avg('avgPerFalseOrphan'),
    singleOpenRate: avg('singleOpenRate'), utility: avg('utility'),
    hits: avg('hits'), misses: avg('misses'), fps: avg('fps'),
  }
}

const rep = []
rep.push('# probe22：机械判别建模升级 —— 参数搜索（LOSO）+ 臂对照')
rep.push('')
rep.push('> 目的：不引入 embedding/模型，纯机械判别器建模水平提升（粒度细化 + 参数搜索 + 优化方案对照）。')
rep.push('> 预注册：成功标准 = recall≥0.70 ∧ 每误切孤儿≤0.85 ∧ 单意图误开≤50% ∧ 英/中双域成立 ∧ U(3,0.5,1)>0。')
rep.push('> 效用 U(a,b,c) = hits − a·misses − b·falseCuts − c·orphansFromFalseCuts（a=3 复利最贵）。')
rep.push('> 划分：search=' + searchSessions.length + '（LOSO）；holdout=' + holdoutSessions.length + '（probe23 单跑）。')
rep.push('')

rep.push('## 0. 语料总览')
rep.push('')
rep.push('| corpus | 会话数 | 总 U | 翻转数 | 单意图 |')
rep.push('|---|---|---|---|---|')
{
  const by = {}
  for (const s of sessions) {
    const k = s.corpus
    by[k] = by[k] ?? { n: 0, us: 0, flips: 0, single: 0 }
    by[k].n++; by[k].us += s.us.length; by[k].flips += s.gt.coarse.length; if (s.single) by[k].single++
  }
  for (const [k, v] of Object.entries(by)) rep.push(`| ${k} | ${v.n} | ${v.us} | ${v.flips} | ${v.single} |`)
}
rep.push('')

rep.push('## 1. 基线 M0（生产原样，全搜索集）')
rep.push('')
rep.push('| 指标 | M0 |')
rep.push('|---|---|')
rep.push(`| recall（明显翻转，@±2） | ${fmt(m0all.recall)} |`)
rep.push(`| fire-truth 率 | ${fmt(m0all.fireTruth)} |`)
rep.push(`| 平均延迟 | ${fmt(m0all.meanLatency)} |`)
rep.push(`| ≤5 及时 | ${fmt(100 * m0all.pctTimely5, 1)}% |`)
rep.push(`| ≤15 及时 | ${fmt(100 * m0all.pctTimely15, 1)}% |`)
rep.push(`| 误切 | ${m0all.falseCuts} |`)
rep.push(`| 每误切平均孤儿 | ${fmt(m0all.avgPerFalseOrphan)} |`)
rep.push(`| 单意图误开率 | ${fmt(100 * m0all.singleOpenRate, 1)}% |`)
rep.push(`| U(3,0.5,1) | ${fmt(m0all.utility)} |`)
rep.push('')

rep.push('## 2. LOSO 臂对照（逐折验证均值）')
rep.push('')
rep.push('| 臂 | recall | fire-truth | 误切 | 每误切孤儿 | 单意图误开 | ≤5及时 | U(3,0.5,1) |')
rep.push('|---|---|---|---|---|---|---|---|')
for (const arm of ARM_NAMES) {
  const r = foldAvg(arm)
  rep.push(`| ${arm} | ${fmt(r.recall)} | ${fmt(r.fireTruth)} | ${fmt(r.falseCuts, 1)} | ${fmt(r.avgPerFalseOrphan)} | ${fmt(100 * r.singleOpenRate, 1)}% | ${fmt(100 * r.pctTimely5, 1)}% | ${fmt(r.utility)} |`)
}
rep.push('')

rep.push('## 3. 三目的达成度（每臂 LOSO 均值的预注册门）')
rep.push('')
rep.push('| 臂 | ①锚定 recall≥0.70 | ③断裂 每误切孤儿≤0.85 | 单意图≤50% | 全部通过 |')
rep.push('|---|---|---|---|---|')
for (const arm of ARM_NAMES) {
  const r = foldAvg(arm)
  const g1 = r.recall >= 0.70, g3 = r.avgPerFalseOrphan <= 0.85, gs = r.singleOpenRate <= 0.5
  rep.push(`| ${arm} | ${g1 ? '✓' : '✗'} (${fmt(r.recall)}) | ${g3 ? '✓' : '✗'} (${fmt(r.avgPerFalseOrphan)}) | ${gs ? '✓' : '✗'} (${fmt(100 * r.singleOpenRate, 1)}%) | ${g1 && g3 && gs ? '✓' : '—'} |`)
}
rep.push('')

rep.push('## 4. 英/中双域（每域独立 LOSO 均值：recall / 每误切孤儿 / U）')
rep.push('')
rep.push('| 臂 | EN recall | EN 孤儿 | EN U | ZH/D recall | ZH/D 孤儿 | ZH/D U |')
rep.push('|---|---|---|---|---|---|---|')
for (const arm of ARM_NAMES) {
  const ms = foldResults[arm].map(f => f.metrics)
  const en = sessions.filter(s => s.corpus === 'claudeset').map(s => s.id)
  const enIdx = searchSessions.map((s, i) => s.corpus === 'claudeset' ? i : -1).filter(i => i >= 0)
  const zhIdx = searchSessions.map((s, i) => s.corpus !== 'claudeset' ? i : -1).filter(i => i >= 0)
  const enN = enIdx.length, zhN = zhIdx.length
  const agg = idxs => {
    let r = 0, o = 0, u = 0
    for (const i of idxs) { r += ms[i].recall; o += ms[i].avgPerFalseOrphan; u += ms[i].utility }
    return [enN ? r / enN : 0, enN ? o / enN : 0, enN ? u / enN : 0]
  }
  const er = agg(enIdx), zr = agg(zhIdx)
  rep.push(`| ${arm} | ${fmt(er[0])} | ${fmt(er[1])} | ${fmt(er[2])} | ${fmt(zr[0])} | ${fmt(zr[1])} | ${fmt(zr[2])} |`)
}
rep.push('')

rep.push('## 5. 最优配置（每臂按 LOSO U 均值排序的前 1 折配置示例 + 参数敏感性）')
rep.push('')
rep.push('> 参数搜索在训练折完成；θ 稳定性 = 使 fold 平均 recall 处于最优 ±5% 的 θ 集合宽度。')
for (const arm of ARM_NAMES) {
  if (arm === 'M0') continue
  let bestFold = null
  for (const f of foldResults[arm]) {
    if (bestFold === null || f.metrics.utility > bestFold.metrics.utility) bestFold = f
  }
  rep.push(`**${arm}** 最优折配置：\`${JSON.stringify(bestFold.cfg)}\``)
  rep.push('')
}
rep.push('')

rep.push('## 6. 候选"参数+优化组合"推荐（按综合效用排序）')
rep.push('')
{
  const rows = ARM_NAMES.map(arm => ({ arm, r: foldAvg(arm) })).sort((a, b) => b.r.utility - a.r.utility)
  rep.push('| 排名 | 臂 | U(3,0.5,1) | recall | 每误切孤儿 |')
  rep.push('|---|---|---|---|---|')
  rows.forEach((x, i) => rep.push(`| ${i + 1} | ${x.arm} | ${fmt(x.r.utility)} | ${fmt(x.r.recall)} | ${fmt(x.r.avgPerFalseOrphan)} |`))
  rep.push('')
  rep.push('> 最终推荐 = 排名首位且全部门通过的臂；其参数 = 该臂在含 holdout 以外的全搜索集上的再搜索最优（见 probe23 定稿）。')
}

writeFileSync('reports/probe22.md', rep.join('\n'))
console.log(rep.join('\n'))
console.log('\nsaved reports/probe22.md')

/**
 * mech_diag：词面信号覆盖诊断 + 密度扫描 —— 回答"机械词面信号的 recall 理论上限在哪"。
 *
 * 1) 特征覆盖率：每条翻转消息上有多少词面/结构信号命中（lex/corr/cluster/todo/dip），
 *    以及"完全无词面标记"的翻转占比（= 词面机械不可达的硬上限）。
 * 2) 密度扫描：以 M7（旧信号族参数化）和 M4（粒度升级全特征）做 θ 扫描，
 *    看 recall / 误切 / 孤儿 / U 的完整权衡曲线。
 * 运行：node scripts/mech_diag.mjs
 */
import { canonicalizeClaudeset, canonicalizeDsh, loadClaudesetLabels, loadDshLabels, loadLabelsJson, resolveSessionPath } from './mech_replay.mjs'
import { staticFeatures, correctionFeatures, lexicalFeatures, livenessFeatures } from './mech_features.mjs'
import { armM0, armM4, armM7 } from './mech_arms.mjs'
import { sessSummary, utility } from './mech_eval.mjs'

/* ---- 加载（复用 probe22 逻辑的精简版） ---- */
import { readFileSync, existsSync } from 'node:fs'

const SS_ROOT = 'C:/Users/Administrator/.dsh/sessions'
function loadAll() {
  const sessions = []
  const lines = readFileSync('datasets/claudeset_shard.jsonl', 'utf8').split('\n').filter(Boolean)
  const db = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(o => Array.isArray(o.turns))
  const shard = new Map(db.map(s => [s.id.slice(0, 8), s]))
  const cla = loadClaudesetLabels('datasets/labels/claudeset.json')
  for (const [id8, lab] of cla) { const s = shard.get(id8); if (s) sessions.push(canonicalizeClaudeset(s, lab)) }
  if (existsSync('datasets/labels/claudeset-ext.json')) {
    const ext = loadClaudesetLabels('datasets/labels/claudeset-ext.json')
    for (const [id8, lab] of ext) { const s = shard.get(id8); if (s) sessions.push(canonicalizeClaudeset(s, lab)) }
  }
  const dshLab = loadDshLabels('datasets/labels/local-dsh.json')
  for (const [id, lab] of dshLab) { const p = resolveSessionPath(id); if (p) sessions.push(canonicalizeDsh(p, lab)) }
  const ext = loadLabelsJson('datasets/labels/local-ext.json')
  for (const lab of ext.sessions ?? []) { const p = resolveSessionPath(lab.id); if (p) sessions.push(canonicalizeDsh(p, lab)) }
  for (const s of sessions) s.staticF = staticFeatures(s)
  return sessions
}

function langOf(text) {
  const zh = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const la = (text.match(/[a-zA-Z]/g) ?? []).length
  if (zh > la * 0.3) return 'zh'
  if (la > 20) return 'en/fr'
  return 'short'
}

const sessions = loadAll()
console.log('sessions:', sessions.length)

/* ---- 1) 覆盖率 ---- */
let flips = 0, hitAny = 0, hitLex = 0, hitCorr = 0, hitDip = 0, bare = 0
const byLang = {}
for (const s of sessions) {
  for (const g of s.gt.coarse) {
    if (g === 0 || g >= s.us.length) continue
    flips++
    const u = s.us[g]
    const sf = s.staticF[g]
    const lang = langOf(u.text)
    byLang[lang] = (byLang[lang] ?? 0) + 1
    const lex = sf.f2Lex > 0, corr = sf.f1Strong > 0 || sf.f1Fine > 0, dip = sf.f6Prev < 0.25 || sf.f6Dip >= 0
    const any = lex || corr
    if (any) hitAny++
    if (lex) hitLex++
    if (corr) hitCorr++
    if (dip) hitDip++
    if (!any) bare++
  }
}
console.log(`flip 总数 ${flips} | 词面(lex|corr)命中 ${hitAny} (${(100 * hitAny / flips).toFixed(1)}%) | lex ${hitLex} | corr ${hitCorr} | 无词面标记(硬上限之外) ${bare} (${(100 * bare / flips).toFixed(1)}%)`)
console.log('flip 语言分布:', JSON.stringify(byLang))

/* ---- 2) 密度扫描 ---- */
console.log('\n=== M7（旧信号族参数化）θ 扫描（全集） ===')
console.log('θ | cuts | recall | 误切 | 每误切孤儿 | U |')
for (const theta of [0.2, 0.3, 0.4, 0.5, 0.7, 0.9, 1.1, 1.3]) {
  let cuts = 0, hits = 0, misses = 0, fps = 0, orphanFP = 0, fc = 0
  for (const s of sessions) {
    const c = armM7(s, s.staticF, { w: { lex: 0.8, corr: 1.0, cluster: 0.5, todo: 0.4 }, theta, strongGate: false })
    const sm = sessSummary(s, c)
    cuts += c.length; hits += sm.m.hits; misses += sm.m.misses; fps += sm.m.fps
    orphanFP += sm.bm.falseOrphan; fc += sm.bm.falseCuts
  }
  const gt = sessions.reduce((a, s) => a + s.gt.coarse.filter(g => g > 0).length, 0)
  console.log(`${theta} | ${cuts} | ${(hits / gt).toFixed(3)} | ${fc} | ${(fc ? orphanFP / fc : 0).toFixed(3)} | ${(hits - 3 * misses - 0.5 * fps - orphanFP).toFixed(1)} |`)
}

console.log('\n=== M4（粒度升级全特征）θ 扫描（全集） ===')
for (const theta of [0.2, 0.3, 0.4, 0.5, 0.7, 0.9, 1.1, 1.3]) {
  let cuts = 0, hits = 0, misses = 0, fps = 0, orphanFP = 0, fc = 0
  for (const s of sessions) {
    const c = armM4(s, s.staticF, {
      w: { corr: 1.0, lex: 0.8, cluster: 0.5, todo: 0.4, cohesion: 0.6, dump: -0.2, goal: -0.3, question: 0.1, imperative: 0.15, lenratio: 0.1, toolwrite: 0.1, toolread: 0.05 },
      theta, strongGate: false, mu: 4, sigma: 2,
    })
    const sm = sessSummary(s, c)
    cuts += c.length; hits += sm.m.hits; misses += sm.m.misses; fps += sm.m.fps
    orphanFP += sm.bm.falseOrphan; fc += sm.bm.falseCuts
  }
  const gt = sessions.reduce((a, s) => a + s.gt.coarse.filter(g => g > 0).length, 0)
  console.log(`${theta} | ${cuts} | ${(hits / gt).toFixed(3)} | ${fc} | ${(fc ? orphanFP / fc : 0).toFixed(3)} | ${(hits - 3 * misses - 0.5 * fps - orphanFP).toFixed(1)} |`)
}

/* ---- 3) a 敏感性（选定配置逐 a） ---- */
console.log('\n=== a 敏感性：U(a, 0.5, 1)（配置固定；a=1/2/3/5） ===')
for (const [name, run, cfg] of [
  ['M0(生产)', (s, sf) => armM0(s, sf, {}), {}],
  ['M7 最优密度', (s, sf) => armM7(s, sf, { w: { lex: 0.8, corr: 1.0, cluster: 0.5, todo: 0.4 }, theta: 0.5, strongGate: false }), {}],
]) {
  const rows = []
  for (const a of [1, 2, 3, 5]) {
    let hits = 0, misses = 0, fps = 0, orphanFP = 0
    for (const s of sessions) {
      const c = run(s, s.staticF)
      const sm = sessSummary(s, c)
      hits += sm.m.hits; misses += sm.m.misses; fps += sm.m.fps; orphanFP += sm.bm.falseOrphan
    }
    rows.push(`a=${a}: U=${(hits - a * misses - 0.5 * fps - orphanFP).toFixed(1)}`)
  }
  console.log(name + ' → ' + rows.join(' | '))
}

/* ---- 4) 衔接凹陷覆盖：未标记 flip 里 f6Dip 能否兜底 ---- */
console.log('\n=== 无词面标记 flip 的衔接凹陷（f6Dip≥0.6 占比） ===')
{
  let bare = 0, dipNo = 0
  for (const s of sessions) {
    for (const g of s.gt.coarse) {
      if (g === 0 || g >= s.us.length) continue
      const sf = s.staticF[g]
      if (sf.f1Strong + sf.f1Fine + sf.f2Lex > 0) continue
      bare++
      // 简化：仅当与上一条用户词面几乎无交叠
      if (sf.f6Prev <= 0.1) dipNo++
    }
  }
  console.log(`无词面标记 flip ${bare} | 其中与上一条用户消息 Jaccard≤0.1 的 ${dipNo} (${(100 * dipNo / bare).toFixed(1)}%)`)
}

/* ---- 5) θ 稳定性：使 recall 处于最优 ±5% 的 θ 区间宽度（probe19"阈值漂移"教训的量化） ---- */
console.log('\n=== θ 稳定性（最优 recall ±5% 区间宽度，θ∈[0.2,1.6] 步长 0.05） ===')
{
  for (const [name, run] of [
    ['M7(旧信号族参数化)', (s, sf, cfg) => armM7(s, sf, cfg)],
    ['M4(粒度升级全特征)', (s, sf, cfg) => armM4(s, sf, cfg)],
  ]) {
    const baseW = name.startsWith('M7')
      ? { w: { lex: 0.8, corr: 1.0, cluster: 0.5, todo: 0.4 }, theta: 0.5, strongGate: false }
      : { w: { corr: 1.0, lex: 0.8, cluster: 0.5, todo: 0.4, cohesion: 0.6, dump: -0.2, goal: -0.3, question: 0.1, imperative: 0.15, lenratio: 0.1, toolwrite: 0.1, toolread: 0.05 }, theta: 0.9, strongGate: false, mu: 4, sigma: 2 }
    const rows = []
    let bestRecall = 0, bestTheta = null
    for (let th = 0.2; th <= 1.61; th += 0.05) {
      const cfg = { ...JSON.parse(JSON.stringify(baseW)), theta: +th.toFixed(2) }
      let hits = 0, misses = 0
      for (const s of sessions) {
        const c = run(s, s.staticF, cfg)
        const sm = sessSummary(s, c)
        hits += sm.m.hits; misses += sm.m.misses
      }
      const gt = sessions.reduce((a, s) => a + s.gt.coarse.filter(g => g > 0).length, 0)
      const recall = gt ? hits / gt : 0
      if (recall > bestRecall) { bestRecall = recall; bestTheta = th }
      rows.push({ th: +th.toFixed(2), recall })
    }
    const tol = bestRecall * 0.95
    const inTol = rows.filter(r => r.recall >= tol)
    const lo = inTol.length ? Math.min(...inTol.map(r => r.th)) : null
    const hi = inTol.length ? Math.max(...inTol.map(r => r.th)) : null
    const width = inTol.length ? +(hi - lo).toFixed(2) : 0
    console.log(`${name}: 最优 recall=${bestRecall.toFixed(3)}@θ=${bestTheta} | ±5% 区间宽度=${width} (θ∈[${lo},${hi}])`)
  }
}

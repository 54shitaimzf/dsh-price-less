/**
 * phase_b_aggregate：聚合四模型判别结果（reports/phase-b-raw/*.json）并与 GT 对齐核验。
 * 输出：reports/phase-b-models.json + 控制台汇总表。
 * 运行：node scripts/phase_b_aggregate.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const RAW = 'reports/phase-b-raw'
const ds = JSON.parse(readFileSync('datasets/discriminator-batches.json', 'utf8'))
const items = []
for (const b of ds.batches || []) for (const it of b.items || []) items.push(it)
if (items.length !== 52) throw new Error(`expect 52 items, got ${items.length}`)

function sid8(sid) {
  const m = String(sid).match(/(session-)?([0-9a-f]{8})/)
  return m ? m[2] : String(sid).slice(-8)
}
const gt = items.map(it => ({ key: `${sid8(it.sid)}-${it.u}`, flip: !!it.flip }))

const models = {}
for (const f of ['dsv4-flash.json', 'glm53-flash.json', 'minimax-m3.json', 'mimo-v2.5.json']) {
  const raw = JSON.parse(readFileSync(`${RAW}/${f}`, 'utf8'))
  const recs = raw.items.map(it => ({ key: `${it.sid}-${it.u}`, flip: !!it.flip }))
  // 对齐
  let bad = 0
  for (let i = 0; i < gt.length; i++) {
    if (recs[i].key !== gt[i].key) { bad++; continue }
    if (recs[i].flip !== gt[i].flip) { bad++; console.log('FLIP MISMATCH', raw.model, recs[i].key) }
  }
  if (bad > 0) throw new Error(`${raw.model}: alignment mismatch ${bad}`)
  const total = gt.length
  let correct = 0, parseFail = 0, error = 0, flipMatch = 0, flipTotal = 0, nonFlipMatch = 0, nonFlipTotal = 0
  let inT = 0, outT = 0, crT = 0, cwT = 0, totT = 0, judged = 0
  for (const it of raw.items) {
    const tf = it.flip
    if (tf) flipTotal++; else nonFlipTotal++
    if (it.error) { error++; continue }
    if (it.decision === null) { parseFail++; continue }
    judged++
    const got = it.decision === 'new_task'
    if (got === tf) {
      correct++
      if (tf) flipMatch++; else nonFlipMatch++
    }
    inT += it.inputTokens || 0
    outT += it.outputTokens || 0
    crT += it.cacheReadTokens || 0
    cwT += it.cacheWriteTokens || 0
    totT += it.totalTokens || 0
  }
  const acc = correct / judged
  const flipAcc = flipTotal ? flipMatch / flipTotal : null
  const nonAcc = (nonFlipTotal - (raw.items.filter(it => it.flip === false && it.decision === null || it.error).length)) ? (nonFlipMatch / (nonFlipTotal - raw.items.filter(it => !it.flip && it.decision === null).length)) : null
  models[raw.model] = {
    provider: raw.provider, maxTokens: raw.maxTokens,
    judged, parseFail, error, correct, acc: +acc.toFixed(4),
    flipMatch, flipTotal, flipAcc: flipAcc == null ? null : +flipAcc.toFixed(4),
    nonFlipMatch, nonFlipTotal: nonFlipTotal - raw.items.filter(it => !it.flip && it.decision === null).length,
    nonFlipAcc: nonAcc == null ? null : +nonAcc.toFixed(4),
    tokens: { input: inT, output: outT, cacheRead: crT, cacheWrite: cwT, total: totT },
    cacheRate: +(crT / (inT + crT)).toFixed(3),
    perJudge: {
      input: +(inT / judged).toFixed(0), output: +(outT / judged).toFixed(0),
      cacheRead: +(crT / judged).toFixed(0), total: +(totT / judged).toFixed(0),
    },
  }
}

// 分歧分析：每个条目四模型判定分布 vs GT
const byKey = {}
for (const f of ['dsv4-flash.json', 'glm53-flash.json', 'minimax-m3.json', 'mimo-v2.5.json']) {
  const raw = JSON.parse(readFileSync(`${RAW}/${f}`, 'utf8'))
  for (const it of raw.items) {
    const k = `${it.sid}-${it.u}`
    byKey[k] = byKey[k] || { key: k, flip: it.flip, decisions: {} }
    byKey[k].decisions[raw.model] = it.decision
  }
}
const disagreements = []
for (const [k, v] of Object.entries(byKey)) {
  const dec = Object.values(v.decisions).filter(d => d !== null)
  if (dec.length === 0) continue
  const nt = dec.filter(d => d === 'new_task').length
  const ag = dec.length === 4 && (nt === 0 || nt === 4)
  const multi = nt > 1 && nt < 4
  if (!ag && nt !== 0 && nt !== 4) {
    disagreements.push({ key: k, flip: v.flip, decisions: v.decisions, nt, n: dec.length })
  }
}

const out = {
  scheme: ds.meta.scheme, total: gt.length, flips: gt.filter(g => g.flip).length,
  records: ds.meta,
  models,
  disagreements: disagreements.map(d => ({ ...d, nt: undefined, newTaskVotes: d.nt, totalVotes: d.n })),
}
if (out.disagreements.length) for (const d of out.disagreements) { d.newTaskVotes = d.nt; d.totalVotes = d.n; delete d.nt; delete d.n }
writeOut(out)

function writeOut(o) {
  writeFileSync('reports/phase-b-models.json', JSON.stringify(o, null, 2))
  const lines = []
  lines.push('== 四模型判别汇总（52 条 DSH-only, 13 翻转）==')
  for (const [model, m] of Object.entries(models)) {
    lines.push(`${model}: judged=${m.judged} parseFail=${m.parseFail} acc=${m.acc} flipAcc=${m.flipAcc} nonFlipAcc=${m.nonFlipAcc}`)
    lines.push(`   tokens in=${m.tokens.input} out=${m.tokens.output} cacheR=${m.tokens.cacheRead} total=${m.tokens.total} cacheRate=${m.cacheRate}`)
    lines.push(`   每判: in=${m.perJudge.input} out=${m.perJudge.output} cacheR=${m.perJudge.cacheRead} total=${m.perJudge.total}`)
  }
  lines.push('== 不一致条目（四模型判定分裂或与 GT 分歧显著）==')
  for (const d of disagreements) {
    lines.push(`${d.key} GT=${d.flip ? 'FLIP' : 'cont'} decisions=${JSON.stringify(d.decisions)}`)
  }
  console.log(lines.join('\n'))
}

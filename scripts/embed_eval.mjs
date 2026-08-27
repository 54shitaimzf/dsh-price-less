/**
 * 离线对照实验：embedding 语义票 vs 纯机械（v2）在归档会话上的边界判定。
 * 与生产同路径：createTaskProjection({mode:'on', votes}) 顺序 fold，
 * vote 在 turn/end 前按「当前 task 锚」查表（余弦，Qwen3-Embedding-0.6B 预计算）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createTaskProjection } from 'file:///D:/deepseek-plugin/lib/task/projection.js'
import { cosineSimilarity } from 'file:///D:/deepseek-plugin/lib/task/embedding.js'

const BASE = process.env.DSARCH_BASE ?? 'C:/Users/Administrator/AppData/Local/Temp/dsh-QNGuaR/dsarch'
const ENDPOINT = process.env.OLLAMA_ENDPOINT ?? 'http://localhost:11434'
const MODEL = process.env.OLLAMA_MODEL ?? 'qwen3-embedding:0.6b'

// Ground truth（用户意图标定）：边界 seq（T1 = 首条用户消息；其余 = 前一 task 末 turn 的 turn/end）。
const GT = {
  'dsp-14b.jsonl': [9, 47567, 56716, 90065, 257703],
  'dsp-c388.jsonl': [8, 5217],
  'card-b5f9.jsonl': [18, 99715, 228215, 679433, 890470, 936581, 1122018],
}

function textOf(ev) {
  let t = ''
  for (const b of ev.data?.content ?? []) if (b?.type === 'text') t += b.text ?? ''
  return t
}

async function embedBatch(texts) {
  const res = await fetch(`${ENDPOINT}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: texts }),
  })
  if (!res.ok) throw new Error(`embed HTTP ${res.status}`)
  return (await res.json()).embeddings
}

function score(detected, gt, turnEnds, mode) {
  // mode 'legacy': |d - 最近 GT| ≤ 200000 视为命中（沿用旧账本口径，便于对比）。
  // mode 'strict': 映射到 turn/end 索引精确比对（无容差）。
  if (mode === 'legacy') {
    let tp = 0
    const used = new Set()
    for (const d of detected) {
      let best = Infinity, bestGt = null
      for (const g of gt) { const diff = Math.abs(g - d); if (diff < best) { best = diff; bestGt = g } }
      if (bestGt !== null && best <= 200000 && !used.has(bestGt)) { tp += 1; used.add(bestGt) }
    }
    return { tp, fp: detected.length - tp, fn: gt.length - tp }
  }
  const idxOf = s => turnEnds.filter(e => e <= s).length
  const gtIdx = new Set(gt.map(idxOf))
  const detIdx = new Set(detected.map(idxOf))
  let tp = 0
  for (const i of detIdx) if (gtIdx.has(i)) tp += 1
  return { tp, fp: detIdx.size - tp, fn: gtIdx.size - tp }
}

function report(name, r) {
  const p = r.tp + r.fp > 0 ? r.tp / (r.tp + r.fp) : 0
  const rec = r.tp + r.fn > 0 ? r.tp / (r.tp + r.fn) : 0
  const f1 = p + rec > 0 ? 2 * p * rec / (p + rec) : 0
  return `${name}: TP=${r.tp} FP=${r.fp} FN=${r.fn} P=${(p * 100).toFixed(1)}% R=${(rec * 100).toFixed(1)}% F1=${(f1 * 100).toFixed(1)}%`
}

// 1) 加载流 + 收集语料
const sessions = {}
const corpus = new Map() // text -> vector
for (const fn of Object.keys(GT)) {
  const events = JSON.parse(readFileSync(`${BASE}/e_${fn}`, 'utf-8'))
  const turnEnds = events.filter(e => e.type === 'turn/end').map(e => e.seq)
  const userTexts = events.filter(e => e.type === 'user/message' && (e.surfaceOp === undefined || e.surfaceOp === 'append'))
    .map(e => ({ seq: e.seq, text: textOf(e) }))
  sessions[fn] = { events, turnEnds, userTexts }
  for (const u of userTexts) if (u.text.length > 0) corpus.set(u.text, undefined)
}

// 2) 预计算向量（批量 32）
const texts = [...corpus.keys()]
let done = 0
for (let i = 0; i < texts.length; i += 32) {
  const batch = texts.slice(i, i + 32)
  const vecs = await embedBatch(batch)
  batch.forEach((t, j) => corpus.set(t, vecs[j]))
  done += batch.length
  console.log(`embed ${done}/${texts.length}`)
}
const vec = t => corpus.get(t) ?? null

// 3) 顺序 fold（vote 在 turn/end 前查表）
function runArm(fn, mode, threshold) {
  const { events, turnEnds } = sessions[fn]
  const table = {
    scoreOf: seq => votes.get(seq) ?? null,
    set: (seq, score) => votes.set(seq, score), // 覆盖式：单次 run 内每个 seq 只投一次
  }
  const votes = new Map()
  const projection = createTaskProjection({ mode, threshold, votes: table })
  let state = projection.init()
  const boundaries = []
  let lastSeen = -1
  for (const ev of events) {
    if (ev.type === 'turn/end' && mode === 'on') {
      // 投票：当前 task 锚 vs 最近用户消息（锚来自 fold 状态；向量已预计算 → 同步）
      if (state.lastUserMsg !== null && state.current !== null) {
        const task = state.tasks.find(t => t.taskId === state.current.taskId)
        if (task !== undefined && !votes.has(state.lastUserMsg.seq)) {
          const a = vec(task.anchorText)
          const b = vec(state.lastUserMsg.text)
          const score = a !== null && b !== null ? cosineSimilarity(a, b) : null
          votes.set(state.lastUserMsg.seq, score)
        }
      }
    }
    state = projection.apply(state, ev)
    if (state.lastBoundarySeq !== null && state.lastBoundarySeq !== lastSeen) {
      lastSeen = state.lastBoundarySeq
      boundaries.push(state.lastBoundarySeq)
    }
  }
  return boundaries
}

// 4) 矩阵
const results = {}
const diagAll = {} // 可分离性诊断：机械锚下，GT 边界 turn vs 非边界 turn 的票分布
for (const fn of Object.keys(GT)) {
  const { turnEnds } = sessions[fn]
  const gt = GT[fn]
  const offB = runArm(fn, 'off', 0.5)
  const off = score(offB, gt, turnEnds, 'strict')

  // 可分离性诊断：机械 pass 中逐 turn 记录票 (score, 是否 GT 边界)
  const { events } = sessions[fn]
  const votes = new Map()
  const table = { scoreOf: seq => votes.get(seq) ?? null, set: (s, v) => votes.set(s, v) }
  const projection = createTaskProjection({ mode: 'on', threshold: 0.5, votes: table })
  let state = projection.init()
  const diag = []
  for (const ev of events) {
    if (ev.type === 'turn/end' && state.lastUserMsg !== null && state.current !== null) {
      const task = state.tasks.find(t => t.taskId === state.current.taskId)
      if (task !== undefined) {
        const a = vec(task.anchorText)
        const b = vec(state.lastUserMsg.text)
        const s = a !== null && b !== null ? cosineSimilarity(a, b) : null
        diag.push({ seq: state.lastUserMsg.seq, score: s, gt: gt.some(g => turnEnds.filter(e => e <= g).length === turnEnds.filter(e => e <= ev.seq).length) })
      }
    }
    state = projection.apply(state, ev)
  }
  diagAll[fn] = diag

  // 可分离性统计：GT 边界 turn vs 任务内 turn 的票分布
  const withScore = diag.filter(d => d.score !== null)
  const gtScores = withScore.filter(d => d.gt).map(d => d.score)
  const inScores = withScore.filter(d => !d.gt).map(d => d.score)
  const stats = xs => xs.length > 0
    ? `n=${xs.length} mean=${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)} min=${Math.min(...xs).toFixed(3)} max=${Math.max(...xs).toFixed(3)}`
    : 'n=0'
  console.log(`  [diag] 边界 turn: ${stats(gtScores)}`)
  console.log(`  [diag] 任务内:   ${stats(inScores)}`)

  // 替代探针：步进相似度 cos(第N条, 第N-1条)——任务换向应出现"断崖"
  const users = sessions[fn].userTexts
  const stepwise = users.map((u, i) => ({
    seq: u.seq,
    score: i === 0 ? null : cosineSimilarity(vec(u.text), vec(users[i - 1].text)),
    gt: gt.some(g => turnEnds.filter(e => e <= g).length === i),
  })).filter(x => x.score !== null)
  const sGt = stepwise.filter(x => x.gt).map(x => x.score)
  const sIn = stepwise.filter(x => !x.gt).map(x => x.score)
  console.log(`  [stepwise] 边界 turn: ${stats(sGt)}`)
  console.log(`  [stepwise] 任务内:   ${stats(sIn)}`)

  results[fn] = { offB, off, gt }
  console.log(`\n=== ${fn} ===`)
  console.log(`  GT(${gt.length}): ${gt.join(',')}`)
  console.log(report(`  机械 off `, off))
  console.log(`  mechanical boundaries: ${offB.join(',')}`)
  for (const thr of [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75]) {
    const b = runArm(fn, 'on', thr)
    const r = score(b, gt, turnEnds, 'strict')
    console.log(report(`  on  t=${thr} `, r))
  }
  console.log(`  turn/end count: ${turnEnds.length}`)
}

writeFileSync(`${BASE}/embed_eval_results.json`, JSON.stringify(results, null, 2))
console.log('\nSaved embed_eval_results.json')

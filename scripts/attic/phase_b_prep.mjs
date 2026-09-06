/**
 * phase_b_prep（v6，DSH-only）：判别器验证（Phase B 小样）确定性数据准备。
 *
 * 生产同构原则（用户定调）：
 *   - 只验证 DSH（deepseek harness）事件流；claudeset（Claude Code 转储）一律不用——
 *     其 caveat/command-name/compact 摘要等形态在 DSH 生产环境不存在，验证会产生无效数字。
 *   - 输入面 = append user/message 事件中 source.kind === 'user'（真实用户消息）；
 *     agent-instructions / plugin（运行时快照）/ skill-catalog / subagent-report /
 *     subagent-settled 均为 harness 注入，不进判别面（实证直方图：user 238 / 其余 93）。
 *   - U 空间口径不变（append user/message 任意 kind 序数，GT 对齐）；判别面在其上过滤。
 *
 * 输入窗组装（与生产判别器同构，v5 冻结口径）：
 *   - anchor = 段头用户消息原文（最近一次 GT 翻转点 < u 的 user-kind 消息；无则 u=0 首条）
 *   - patches = 锚之后、u 之前最近 2 条 user-kind 消息（v1 固定"最近 2 条"口径）
 *   - target = 待判消息原文
 *   - 长度阀：anchor ≤350 / patches 每条 ≤350 / target ≤800（头 600 + 尾 200）
 *
 * 抽样（种子固定，mulberry32）：翻转全量 + 非翻转按会话分层配额。
 * 输出：datasets/discriminator-batches.json（{meta, batches[...]}）
 * 运行：node scripts/phase_b_prep.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { decompressZstd, isAppendSurface, loadDshLabels, loadLabelsJson } from './mech_replay.mjs'

/* ================= DSH 会话加载（kind 感知） ================= */

const SS_ROOT = 'C:/Users/Administrator/.dsh/sessions'
const GROUPS = ['--D-deepseek-plugin--', '--C-Users-Administrator-Desktop-card_sample--', '--C-Users-Administrator-Desktop-Chinese-Resume-in-Typst--', '--C-Users-Administrator-Desktop-RootUp--']
function resolveSessionPath(id) {
  for (const g of GROUPS) {
    const p = `${SS_ROOT}/${g}/${id}/session.jsonl.zstd`
    if (existsSync(p)) return p
  }
  return null
}

/** DSH zstd → canonical + kind（U 空间 = append user/message 任意 kind，与生产 fold 一致；kind 用于过滤）。 */
function loadDshSessionWithKind(path, label) {
  const text = decompressZstd(path)
  const evs = []
  for (const l of text.split('\n')) {
    if (l.trim().length === 0) continue
    try { const o = JSON.parse(l); if (o && o.type) evs.push(o) } catch { /* skip */ }
  }
  const umEvents = evs.filter(e => e.type === 'user/message' && isAppendSurface(e))
  const seqToU = new Map()
  umEvents.forEach((e, i) => seqToU.set(e.seq, i))
  const us = []
  let lastU = -1
  for (const e of evs) {
    if (e.type === 'user/message' && isAppendSurface(e)) {
      const u = seqToU.get(e.seq)
      if (u !== lastU + 1) throw new Error(`um event gap at seq ${e.seq}`)
      lastU = u
      const txt = (e.data?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
      us.push({ u, text: txt, kind: e.data?.source?.kind ?? '(none)', single: !!label?.single, proj: label?.proj ?? '' })
    }
  }
  return { id: path, corpus: 'dsh', single: !!label?.single, proj: label?.proj ?? '', us, gt: { coarse: label?.coarse ?? [] } }
}

function loadDshAll() {
  const sessions = []
  const dshLab = loadDshLabels('datasets/labels/local-dsh.json')
  for (const [id, lab] of dshLab) {
    const path = resolveSessionPath(id)
    if (path) sessions.push(loadDshSessionWithKind(path, lab))
  }
  if (existsSync('datasets/labels/local-ext.json')) {
    const ext = loadLabelsJson('datasets/labels/local-ext.json')
    for (const lab of ext.sessions ?? []) {
      const path = resolveSessionPath(lab.id)
      if (path) sessions.push(loadDshSessionWithKind(path, { ...lab, labeler: 'ai-draft' }))
    }
  }
  if (existsSync('datasets/labels/local-holdout.json')) {
    const ho = loadLabelsJson('datasets/labels/local-holdout.json')
    for (const lab of ho.sessions ?? []) {
      const path = resolveSessionPath(lab.id)
      if (path) sessions.push(loadDshSessionWithKind(path, { ...lab, labeler: 'ai-draft' }))
    }
  }
  const cur = loadLabelsJson('datasets/labels/current-session.json')
  const curPath = resolveSessionPath('session-17eeebba-5666-4607-bafa-1befd583f975')
  if (curPath) sessions.push(loadDshSessionWithKind(curPath, { ...cur, id: curPath, single: cur.single }))
  return sessions
}

/* ================= L0-continue（与 phase_a_l0 同源，冻结） ================= */

function strip(text) {
  return text.replace(/[\s\u3000！？。，、；：""''（）《》【】!?.,;:()\[\]{}~\-—_…]/gu, '').toLowerCase()
}
const CONTINUE_WORDS = new Set([
  '继续', '继续吧', '继续继续', '好的', '好的好的', '好', '好哦', '好呀', '好吧', '行', '行吧', '嗯', '嗯嗯',
  '对', '对的', '是的', '没错', '确实', '明白了', '明白', '知道了', '可以', '可以了', '没问题', '收到', '好滴',
  '谢谢', '然后呢', '还有', '接着', '接着吧', '继续做', '接着做', '继续说', '继续搞', '来吧', '请继续',
  'ok', 'okay', 'yes', 'yep', 'yeah', 'sure', 'great', 'nice', 'gotit', 'understood', 'thanks', 'thanks!',
  'continue', 'goon', 'alright', 'fine', 'right', 'indeed', 'good', 'perfect', 'done', 'works', 'ok!',
  'k', 'kk', 'ok.', 'yes.', 'sure.', 'thanks.', 'right.', 'great.', 'nice.', 'perfect.',
])
function l0Continue(text) {
  const s = strip(text)
  if (s.length === 0) return false
  return CONTINUE_WORDS.has(s)
}

/* ================= 输入窗长度阀（v5 冻结口径） ================= */

const ANCHOR_CAP = 350
const PATCH_CAP = 350
const TARGET_CAP = 800
const TARGET_HEAD = 600
const TARGET_TAIL = 200

function clampHead(text, cap) {
  const t = String(text)
  return t.length <= cap ? t : t.slice(0, cap) + '\n…[truncated]…'
}
function clampTarget(text) {
  const t = String(text)
  if (t.length <= TARGET_CAP) return t
  return t.slice(0, TARGET_HEAD) + '\n…[truncated]…\n' + t.slice(-TARGET_TAIL)
}

/* ================= 伪 user 检测（harness 记录被标 kind=user 的系统语义消息） ================= */

const PSEUDO_USER_RES = [
  /approval policy changed/i,
  /changed by the user/i,
  /permission preset/i,
]
function isPseudoUser(text) {
  const t = String(text)
  return PSEUDO_USER_RES.some(re => re.test(t))
}

/* ================= 确定性 RNG（mulberry32） ================= */

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ================= 主流程 ================= */

const SEED = 0x513BC0DE // 固定种子：字节稳定，重跑同构
const BATCH_SIZE = 6 // v5 核验口径：单批 = 6 条窗

const sessions = loadDshAll()
console.log(`DSH sessions: ${sessions.length}`)

// 判别面：u≥1、kind=user、非 L0-continue
const items = []
let l0Hits = 0
let injected = 0
let flipOnNonUser = []
const perKind = {}
for (const s of sessions) {
  const coarseSet = new Set(s.gt.coarse)
  const flips = [...s.gt.coarse].sort((a, b) => a - b)
  let ahead = 0
  for (const uu of s.us) {
    const u = uu.u
    if (u < 1) continue
    perKind[uu.kind] = (perKind[uu.kind] || 0) + 1
    if (uu.kind !== 'user') {
      if (coarseSet.has(u)) flipOnNonUser.push({ sid: s.id.slice(0, 8), u, kind: uu.kind })
      injected += 1
      continue
    }
    const text = uu.text.trim()
    if (text.length === 0) { injected += 1; continue }
    if (isPseudoUser(text)) { injected += 1; continue }
    if (l0Continue(text)) { l0Hits += 1; continue }
    while (ahead < flips.length && flips[ahead] < u) ahead += 1
    const anchorU = ahead > 0 ? flips[ahead - 1] : 0
    // 段头选择：anchorU 起向后找第一条 kind=user 且非伪 user 的消息（段起点无效时取段内最早有效）
    let anchorU2 = -1
    for (let k = anchorU; k < u; k++) {
      const cand = s.us[k]
      if (cand && cand.kind === 'user' && cand.text.trim().length > 0 && !isPseudoUser(cand.text)) { anchorU2 = k; break }
    }
    if (anchorU2 < 0) {
      for (let k = anchorU; k >= 0; k--) {
        const cand = s.us[k]
        if (cand && cand.kind === 'user' && cand.text.trim().length > 0 && !isPseudoUser(cand.text)) { anchorU2 = k; break }
      }
    }
    const anchor = clampHead(anchorU2 >= 0 ? s.us[anchorU2].text : '', ANCHOR_CAP)
    const patches = s.us.slice(anchorU2 + 1, u).filter(x => x.kind === 'user' && x.text.trim().length > 0).map(x => clampHead(x.text, PATCH_CAP)).slice(-2)
    items.push({
      sid: s.id, u, single: !!s.single, proj: s.proj ?? '',
      flip: coarseSet.has(u),
      anchor, patches, target: clampTarget(text),
      chars: anchor.length + patches.join('').length + text.length,
    })
  }
}

console.log(`kind 直方图: ${JSON.stringify(perKind)}`)
console.log(`注入滤除（非 user-kind）：${injected}`)
console.log(`翻转点落在非 user-kind：${flipOnNonUser.length} ${JSON.stringify(flipOnNonUser)}`)
console.log(`判别面（u≥1、kind=user、非 L0-continue）：${items.length}（L0 拦截 ${l0Hits}）`)

const flipItems = items.filter(i => i.flip)
const nonFlipItems = items.filter(i => !i.flip)
console.log(`翻转 ${flipItems.length}（全量进样），非翻转 ${nonFlipItems.length}`)

// 非翻转按会话分层配额（目标 = 翻转全量 + 非翻转 3×，至少 24 条非翻转保证误报样本充足）
const quota = Math.max(24, Math.min(120, flipItems.length * 3))
const bySession = new Map()
for (const i of nonFlipItems) {
  if (!bySession.has(i.sid)) bySession.set(i.sid, [])
  bySession.get(i.sid).push(i)
}
const fracs = [...bySession.entries()].map(([sid, arr]) => [sid, arr.length / nonFlipItems.length])
let assigned = fracs.map(([sid, f]) => [sid, Math.floor(f * quota)])
let sumAssigned = assigned.reduce((a, [, n]) => a + n, 0)
const res = fracs.map(([sid, f], idx) => [sid, f * quota - Math.floor(f * quota), idx]).sort((a, b) => b[1] - a[1])
let need = quota - sumAssigned
for (const [sid, , idx] of res) {
  if (need <= 0) break
  assigned[idx][1] += 1
  need -= 1
}
const rng = mulberry32(SEED)
const sampled = []
for (const [sid, count] of assigned) {
  const arr = bySession.get(sid)
  const idxs = arr.map((_, i) => i)
  for (let i = idxs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[idxs[i], idxs[j]] = [idxs[j], idxs[i]]
  }
  for (let k = 0; k < Math.min(count, idxs.length); k++) sampled.push(arr[idxs[k]])
}

const all = [...flipItems, ...sampled].sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : a.u - b.u))
console.log(`进样合计：${all.length}（翻转 ${all.filter(i => i.flip).length} / 非翻转 ${all.filter(i => !i.flip).length}）`)

const buckets = Array.from({ length: Math.ceil(all.length / BATCH_SIZE) }, () => [])
all.forEach((i, idx) => buckets[Math.floor(idx / BATCH_SIZE)].push(i))
console.log(`批次：${buckets.length}（${buckets.map(b => b.length).join('/')}）`)

const manifest = {
  meta: {
    scheme: 'phase-b-dsh-v6',
    seed: SEED,
    total: all.length,
    flips: all.filter(i => i.flip).length,
    nonFlips: all.filter(i => !i.flip).length,
    sessions: sessions.length,
    l0ContinueHits: l0Hits,
    injectedFiltered: injected,
    flipOnNonUser: flipOnNonUser.length,
    kindHistogram: perKind,
    surface: items.length,
    promptFile: 'datasets/prompt-discriminator-v1.txt',
    window: 'anchor(≤350,最近翻转点user消息或u=0首条) + patches(最近2条user消息,≤350) + target(≤800,头600尾200)',
    batchSize: BATCH_SIZE,
    perSessionQuota: Object.fromEntries(assigned.filter(([, n]) => n > 0).map(([sid, n]) => [sid.slice(0, 8), n])),
  },
  batches: buckets.map((b, i) => ({ batch: i, items: b })),
}
writeFileSync('datasets/discriminator-batches.json', JSON.stringify(manifest, null, 2))
console.log('written: datasets/discriminator-batches.json')
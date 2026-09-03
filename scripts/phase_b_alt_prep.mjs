/**
 * phase_b_alt_prep.mjs —— 锚点 A/B 对照数据（w1 近锚窗口）
 * 原理：对 12 条 E2 误报样本，窗口消息集合与顺序完全不变，仅角色互换：
 *   - w0（原始）：anchor = 段头（最近翻转点后第一条 user），patches = 其后再近 2 条
 *   - w1（近锚）：anchor = target 前最近一条 user 消息，patches = 其前 2 条更早 user（含原段头消息）
 * 输出：datasets/discriminator-alts.json（batches 同构，item 带 ord=全序下标 便于与主数据集配对）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { decompressZstd, isAppendSurface, loadDshLabels, loadLabelsJson } from './mech_replay.mjs'

const SS_ROOT = 'C:/Users/Administrator/.dsh/sessions'
const GROUPS = ['--D-deepseek-plugin--', '--C-Users-Administrator-Desktop-card_sample--', '--C-Users-Administrator-Desktop-Chinese-Resume-in-Typst--', '--C-Users-Administrator-Desktop-RootUp--']
function resolveSessionPath(id) {
  for (const g of GROUPS) {
    const p = `${SS_ROOT}/${g}/${id}/session.jsonl.zstd`
    if (existsSync(p)) return p
  }
  return null
}
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
  return { id: path, single: !!label?.single, proj: label?.proj ?? '', us }
}
function loadAll() {
  const sessions = []
  for (const [id, lab] of loadDshLabels('datasets/labels/local-dsh.json')) {
    const p = resolveSessionPath(id)
    if (p) sessions.push(loadDshSessionWithKind(p, lab))
  }
  if (existsSync('datasets/labels/local-ext.json')) {
    for (const lab of (loadLabelsJson('datasets/labels/local-ext.json').sessions ?? [])) {
      const p = resolveSessionPath(lab.id)
      if (p) sessions.push(loadDshSessionWithKind(p, lab))
    }
  }
  if (existsSync('datasets/labels/local-holdout.json')) {
    for (const lab of (loadLabelsJson('datasets/labels/local-holdout.json').sessions ?? [])) {
      const p = resolveSessionPath(lab.id)
      if (p) sessions.push(loadDshSessionWithKind(p, lab))
    }
  }
  const cur = loadLabelsJson('datasets/labels/current-session.json')
  const curPath = resolveSessionPath('session-17eeebba-5666-4607-bafa-1befd583f975')
  if (curPath) sessions.push(loadDshSessionWithKind(curPath, { ...cur, id: curPath, single: cur.single }))
  return sessions
}
const PSEUDO = [/approval policy changed/i, /changed by the user/i, /permission preset/i]
const isPseudo = t => PSEUDO.some(re => re.test(String(t)))
const ANCHOR_CAP = 350, PATCH_CAP = 350, TARGET_CAP = 800, TARGET_HEAD = 600, TARGET_TAIL = 200
const clampHead = (t, cap) => { const s = String(t); return s.length <= cap ? s : s.slice(0, cap) + '\n…[truncated]…' }
const clampTarget = t => { const s = String(t); if (s.length <= TARGET_CAP) return s; return s.slice(0, TARGET_HEAD) + '\n…[truncated]…\n' + s.slice(-TARGET_TAIL) }

// 全序下标映射（sid短码:u → ord / flip / single / proj）
const ds = JSON.parse(readFileSync('datasets/discriminator-batches.json', 'utf8'))
const ordMap = new Map()
const allItems = []
for (const b of ds.batches || []) for (const it of b.items || []) allItems.push(it)
allItems.forEach((it, i) => {
  const m = String(it.sid).match(/session-([0-9a-f]{8})-/)
  ordMap.set(`${m ? m[1] : String(it.sid).slice(0, 8)}:${it.u}`, { ord: i, flip: !!it.flip, single: !!it.single, proj: it.proj ?? '' })
})

// 目标样本（E2 类误报：基线 v2 中 minimax/v4 误报且 reason 属"锚点对比/讨论对象"）
const TARGETS = ['17eeebba:61', '17eeebba:84', '17eeebba:115', '17eeebba:188', '17eeebba:199', '17eeebba:208', 'c3801781:6', 'c3801781:59', 'c3801781:63', 'c3801781:84', 'c3801781:92', '74a1b607:17']

const sessions = loadAll()
const bySid = new Map()
for (const s of sessions) {
  const m = String(s.id).match(/session-([0-9a-f]{8})-/)
  if (m) bySid.set(m[1], s)
}
const out = []
let missing = []
for (const key of TARGETS) {
  const [sid, uStr] = key.split(':')
  const u = Number(uStr)
  const info = ordMap.get(key)
  if (!info) { missing.push(key + ' (no ord)'); continue }
  const s = bySid.get(sid)
  if (!s) { missing.push(key + ' (no session)'); continue }
  const msg = s.us.find(x => x.u === u)
  if (!msg) { missing.push(key + ' (no msg)'); continue }
  // w1：anchor = u 前最近一条有效 user；patches = 其前 2 条更早有效 user
  const before = s.us.slice(0, u).filter(x => x.kind === 'user' && x.text.trim().length > 0 && !isPseudo(x.text))
  const anchorItem = before[before.length - 1]
  if (!anchorItem) { missing.push(key + ' (no near anchor)'); continue }
  const earlier = before.slice(0, -1).slice(-2)
  out.push({
    sid: s.id, u, single: info.single, proj: info.proj,
    flip: info.flip, ord: info.ord,
    anchor: clampHead(anchorItem.text, ANCHOR_CAP),
    patches: earlier.map(x => clampHead(x.text, PATCH_CAP)),
    target: clampTarget(msg.text),
    chars: anchorItem.text.length + earlier.reduce((a, x) => a + x.text.length, 0) + msg.text.length,
  })
}
console.log(`w1 近锚样本：${out.length}/12` + (missing.length ? ` 缺失：${missing.join(', ')}` : ''))
// 与原 w0 窗口对比校验（anchor 应不同）
const w0 = new Map()
for (const it of allItems) {
  const m = String(it.sid).match(/session-([0-9a-f]{8})-/)
  w0.set(`${m ? m[1] : ''}:${it.u}`, it)
}
let sameAnchor = 0
for (const o of out) {
  const m = String(o.sid).match(/session-([0-9a-f]{8})-/)
  const a = w0.get(`${m[1]}:${o.u}`)
  if (a && a.anchor === o.anchor) sameAnchor++
}
console.log(`anchor 与 w0 相同的条数（应为 0）：${sameAnchor}`)
const manifest = { meta: { scheme: 'phase-b-alt-w1', note: '近锚窗口：anchor=target前最近user消息，patches=其前2条更早user；窗口消息集合与w0相同，仅参照点互换', targets: TARGETS.length }, batches: out.map((o, i) => ({ batch: i, items: [o] })) }
writeFileSync('datasets/discriminator-alts.json', JSON.stringify(manifest, null, 2))
console.log('written: datasets/discriminator-alts.json')

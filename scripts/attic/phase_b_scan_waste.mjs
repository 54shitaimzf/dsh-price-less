/**
 * phase_b_scan_waste：扫描判别面/输入窗数据里的非用户内容形态。
 * 目标：枚举系统包装（caveat/interrupt/command 等）与模型产出混入，为过滤规则提供依据。
 */
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { canonicalizeClaudeset, canonicalizeDsh, loadClaudesetLabels, loadDshLabels, loadLabelsJson } from './mech_replay.mjs'

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
  return sessions
}

const sessions = loadAll()
const TAG_RE = /<([a-zA-Z0-9_\-]+)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g
const tagCounts = new Map()
const sysPatterns = [
  [/\[Request interrupted by user\]/g, 'interrupt-annotation'],
  [/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, 'local-command-caveat'],
  [/<command-name>[\s\S]*?<\/command-name>/g, 'command-name'],
  [/<command-message>[\s\S]*?<\/command-message>/g, 'command-message'],
  [/<command-args>[\s\S]*?<\/command-args>/g, 'command-args'],
  [/<system-reminder>[\s\S]*?<\/system-reminder>/g, 'system-reminder'],
  [/<workspace>[^]*?<\/workspace>/g, 'workspace-block'],
  [/<thinking>/g, 'thinking-open'],
  [/<tool[_-]?result>/gi, 'tool-result-block'],
]
const sysHits = new Map()
let sysMsgCount = 0
const sysMsgSamples = []
const pureSysMessages = []
let flipOnPureSys = []
for (const s of sessions) {
  const coarseSet = new Set(s.gt.coarse)
  for (const uu of s.us) {
    const t = uu.text
    // 通用标签统计
    let m
    TAG_RE.lastIndex = 0
    while ((m = TAG_RE.exec(t))) {
      const name = m[1]
      tagCounts.set(name, (tagCounts.get(name) || 0) + 1)
    }
    let matched = false
    let firstKind = ''
    for (const [re, kind] of sysPatterns) {
      re.lastIndex = 0
      let mm
      let n = 0
      while ((mm = re.exec(t))) { n++; matched = true; if (!firstKind) firstKind = kind }
      if (n > 0) sysHits.set(kind, (sysHits.get(kind) || 0) + n)
    }
    // 剥掉已知包装后剩余自然语言长度
    let stripped = String(t)
      .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
      .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
      .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
      .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
      .replace(/\[Request interrupted by user\]/g, '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<[a-zA-Z0-9_\-]+(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, '')
      .trim()
    if (matched) {
      sysMsgCount++
      if (sysMsgSamples.length < 12) sysMsgSamples.push({ sid: s.id.slice(0, 8), u: uu.u, kind: firstKind, text: String(t).slice(0, 160).replace(/\n/g, '⏎') })
    }
    if (matched && stripped.length === 0) {
      pureSysMessages.push({ sid: s.id.slice(0, 8), u: uu.u, flip: coarseSet.has(uu.u), kind: firstKind, text: String(t).slice(0, 120).replace(/\n/g, '⏎') })
      if (coarseSet.has(uu.u)) flipOnPureSys.push({ sid: s.id.slice(0, 8), u: uu.u })
    }
  }
}
console.log('== 通用 <> 标签频次 ==')
console.log([...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}: ${v}`).join('\n'))
console.log('\n== 已知系统包装频次 ==')
console.log([...sysHits.entries()].map(([k, v]) => `${k}: ${v}`).join('\n'))
console.log(`\n含系统包装的消息：${sysMsgCount}`)
console.log('样例：')
for (const s of sysMsgSamples) console.log(' ', JSON.stringify(s))
console.log(`\n剥包装后为空的纯系统消息：${pureSysMessages.length}`)
for (const s of pureSysMessages) console.log(' ', JSON.stringify(s))
console.log(`\n翻转点落在纯系统消息上：${flipOnPureSys.length}`)
for (const s of flipOnPureSys) console.log(' ', JSON.stringify(s))
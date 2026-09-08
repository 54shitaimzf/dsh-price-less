#!/usr/bin/env node
/**
 * P14c 历史回放验收（docs/implement/P14c-gate-slim-and-star-fix.md §4）。
 * 用真实历史消息量三件事：① 极短过滤率；② 删 L0 的反事实代价；③ 对表保守打分的命中率与安全性。
 * 纯回放：只读本地会话缓存与判别记录，不联网、不调模型。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { isTrivialMessage, normalizeMessageText } from '../lib/core/dossier.js'
import { matchJudgeTable } from '../lib/core/judge.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME = os.homedir()
const failures = []
const fail = (m) => { failures.push(m); console.log('FAIL ' + m) }
const pct = (x, n) => n === 0 ? '0.0%' : (100 * x / n).toFixed(1) + '%'

// —— 反事实用的旧 L0 词表（P14c 已删除；仅用于量化删除代价） ——
const OLD_L0 = ['继续','继续吧','继续继续','好的','好的好的','好','好哦','好呀','好吧','行','行吧','嗯','嗯嗯','对','对的','是的','没错','确实','明白了','明白','知道了','可以','可以了','没问题','收到','好滴','谢谢','然后呢','还有','接着','接着吧','继续做','接着做','继续说','继续搞','来吧','请继续','ok','okay','yes','yep','yeah','sure','great','nice','gotit','understood','thanks','continue','goon','alright','fine','right','indeed','good','perfect','done','works','k','kk']
const oldL0Hit = (t) => { const s = normalizeMessageText(t); return s.length > 0 && OLD_L0.includes(s) }

const PATH_RE = /[A-Za-z0-9_./\\-]+\\.(?:ts|tsx|js|mjs|cjs|json|md|sh|yml|yaml|py|css|html|toml)/g
const STOP = new Set(['这个','那个','什么','怎么','可以','需要','现在','已经','没有','如果','因为','所以','但是','然后','还有','一下','帮我','请你','我们','他们','就是','不是','真的','应该','可能','开始','继续','问题','内容','情况','时候','地方','方法','方式','东西','一个','这些','那些','目前','同时','以及','对于','关于','是否','the','and','for','with','that','this','you','are','not','can','have','from','will','your','but','all','any','how','why','what','when','which','there','their','them','then','than','into','out','was','were','has','had','its','it','is','of','to','in','on','at','by','or','as','be','do','if','so','no','up','we','us','me','my'])
const tokens = (t) => [
  ...[...t.matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}/g)].map((m) => m[0].toLowerCase()),
  ...[...t.matchAll(/[\u4e00-\u9fff]{2,8}/g)].map((m) => m[0]),
]
/** 用「任务第一句」模拟星标建出的表（关键词取最长最显著的 8 个，签名取路径）。 */
function makeTable(texts) {
  const freq = new Map()
  for (const t of texts) for (const tok of tokens(t)) freq.set(tok, (freq.get(tok) ?? 0) + 1)
  const keywords = [...freq.entries()]
    .filter(([k]) => !STOP.has(k) && k.length >= 2)
    .sort((a, b) => (b[0].length - a[0].length) || (b[1] - a[1]))
    .slice(0, 8).map(([k]) => k)
  const fileSignatures = [...new Set(texts.flatMap((t) => (t.match(PATH_RE) ?? []).map((x) => x.toLowerCase())))]
  return { version: 1, aspects: [], fileSignatures, keywords }
}
const looseHit = (text, table) => {
  const lower = text.toLowerCase()
  return table.keywords.some((k) => lower.includes(k.toLowerCase())) || table.fileSignatures.some((s) => lower.includes(s.toLowerCase()))
}

// —— 语料：会话投影缓存里的 turnOutline（真实用户消息，按会话分组） ——
function loadCorpus() {
  const dirs = [
    path.join(HOME, '.dsh/storages/session_projcache/sessions'),
    path.join(HOME, '.dsh/archive/sessions-v1-20260905/_projcache'),
  ]
  const sessions = []
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      let j
      try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { continue }
      const turns = j?.record?.rows?.turnOutline?.val?.turns
      if (!Array.isArray(turns)) continue
      const prompts = turns.map((t) => t?.prompt).filter((p) => typeof p === 'string' && p.trim() !== '')
      if (prompts.length > 0) sessions.push(prompts)
    }
  }
  return sessions
}

// —— ① + ② 语料统计 ——
const sessions = loadCorpus()
const all = sessions.flat()
let trivial = 0, l0 = 0
for (const t of all) { if (isTrivialMessage(t)) trivial++; if (oldL0Hit(t)) l0++ }
console.log('=== ① 语料 ===')
console.log('会话 ' + sessions.length + ' 个 / 用户消息 ' + all.length + ' 条')
console.log('极短消息（不进 ★ 上下文组装） = ' + trivial + '  ' + pct(trivial, all.length))
console.log('旧 L0 会命中的消息（删除代价 = 这些改为走 LLM） = ' + l0 + '  ' + pct(l0, all.length))

// —— ③ 对表保守打分 vs 旧宽松规则（同一张模拟表） ——
let total = 0, newHits = 0, oldHits = 0
for (const prompts of sessions) {
  if (prompts.length < 2) continue
  const table = makeTable([prompts[0]])
  for (const p of prompts.slice(1)) {
    total++
    if (matchJudgeTable(p, table).hit) newHits++
    if (looseHit(p, table)) oldHits++
  }
}
console.log('')
console.log('=== ② 对表（模拟表 = 会话首句） ===')
console.log('可判定消息 = ' + total)
console.log('旧宽松规则（关键词 OR 签名）命中 = ' + oldHits + '  ' + pct(oldHits, total))
console.log('新保守打分（签名2/具体词2/泛词1，≥2 分）命中 = ' + newHits + '  ' + pct(newHits, total))

// —— ④ 安全性：拿真实判别记录的 verdict 做地面真值 ——
const recPath = path.join(HOME, '.dsh/context-economy/judge-records.jsonl')
let recTotal = 0, recNew = 0, recNewHits = 0, recOldNewHits = 0, recHits = 0, recOldHits = 0
if (fs.existsSync(recPath)) {
  const bySession = new Map()
  for (const line of fs.readFileSync(recPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (typeof o.window?.targetExcerpt !== 'string') continue
    const arr = bySession.get(o.sessionId) ?? []
    arr.push({ seq: o.seq, verdict: o.verdict, text: o.window.targetExcerpt })
    bySession.set(o.sessionId, arr)
  }
  for (const arr of bySession.values()) {
    arr.sort((a, b) => a.seq - b.seq)
    if (arr.length < 2) continue
    const table = makeTable([arr[0].text])
    for (const r of arr.slice(1)) {
      recTotal++
      const isNew = r.verdict === 'new-task'
      if (isNew) recNew++
      if (matchJudgeTable(r.text, table).hit) { recHits++; if (isNew) recNewHits++ }
      if (looseHit(r.text, table)) { recOldHits++; if (isNew) recOldNewHits++ }
    }
  }
  console.log('')
  console.log('=== ③ 对表影子基线（真实判别记录，verdict 为地面真值） ===')
  console.log('（影子口径：这些命中不再短路，全部照常走 LLM；此处读数 = 若启用短路会漏掉的边界）')
  console.log('可判定消息 = ' + recTotal + '（其中 new-task ' + recNew + ' = ' + pct(recNew, recTotal) + '）')
  console.log('旧宽松规则：命中 ' + recOldHits + '，其中误判为延续的 new-task ' + recOldNewHits + ' 条')
  console.log('新保守打分：命中 ' + recHits + '，其中误判为延续的 new-task ' + recNewHits + ' 条')
  console.log('→ 机械延续精确率：旧 ' + pct(recOldHits - recOldNewHits, recOldHits) + ' / 新 ' + pct(recHits - recNewHits, recHits))
} else {
  console.log('')
  console.log('=== ③ 安全性：未找到 ' + recPath + '（跳过） ===')
}

// —— ⑤ ★ 上下文可得性（当前会话：新路径直接读会话事件） ——
function scanZstdFrames(buffer) {
  const MAGIC = 0xFD2FB528
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== MAGIC) break
    offset += 4
    const descriptor = buffer.readUInt8(offset); offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictFlag = descriptor & 0x03
    const remaining = (singleSegment ? 0 : 1) + (dictFlag === 3 ? 4 : dictFlag) + (contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag)
    if (buffer.length - offset < remaining) break
    offset += remaining
    let torn = false
    for (;;) {
      if (buffer.length - offset < 3) { torn = true; break }
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3
      const payload = ((blockHeader >>> 1) & 0x03) === 0x01 ? 1 : blockHeader >>> 3
      if (buffer.length - offset < payload) { torn = true; break }
      offset += payload
      if (blockHeader & 1) break
    }
    if (torn) break
    if (checksum) { if (buffer.length - offset < 4) break; offset += 4 }
    frames.push([start, offset])
  }
  return frames
}
const sessRoot = path.join(HOME, '.dsh/sessions')
let currentLog
if (fs.existsSync(sessRoot)) {
  for (const proj of fs.readdirSync(sessRoot)) {
    const dir = path.join(sessRoot, proj)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const s of fs.readdirSync(dir)) {
      const f = path.join(dir, s, 'session.v2.jsonl.zstd')
      if (fs.existsSync(f)) {
        const st = fs.statSync(f)
        if (!currentLog || st.mtimeMs > fs.statSync(currentLog).mtimeMs) currentLog = f
      }
    }
  }
}
let humanMessages = 0
if (currentLog) {
  const buf = fs.readFileSync(currentLog)
  const parts = []
  for (const [a, b] of scanZstdFrames(buf)) { try { parts.push(zlib.zstdDecompressSync(buf.subarray(a, b))) } catch {} }
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (!line.includes('"type":"user/message"')) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.type === 'user/message' && o.data?.source?.kind === 'user') humanMessages++
  }
}
console.log('')
console.log('=== ④ ★ 上下文可得性 ===')
console.log('最近会话：' + (currentLog ? path.basename(path.dirname(currentLog)) : '(未找到)'))
console.log('真实用户消息（★ 现在可直接读到，旧实现受 auto 门控恒为 0） = ' + humanMessages)

// —— ⑤ 静态断言：对表不参与决策（无无声漏边界通道） ——
const inputSrc = fs.readFileSync(path.join(ROOT, 'src/domains/input.ts'), 'utf8')
const tableShortCircuit = /trigger:\s*'table'/.test(inputSrc)
const shadowWired = /tableShadow/.test(inputSrc)
if (tableShortCircuit) fail("input.ts 仍在对表命中时短路（trigger 'table'）——违反 P14c 影子口径")
if (!shadowWired) fail('input.ts 未接影子记账（tableShadow）')
console.log('')
console.log('=== ⑤ 决策链静态断言 ===')
console.log('对表短路残留 = ' + (tableShortCircuit ? '有（FAIL）' : '无（只算不拦）'))
console.log('影子记账接线 = ' + (shadowWired ? '已接' : '缺失（FAIL）'))

// —— 断言 ——
console.log('')
if (pct(trivial, all.length) === '0.0%' && all.length > 0) fail('极短过滤率异常为 0')
if (all.length > 0 && trivial / all.length > 0.1) fail('极短过滤率过高（>10%）：阈值需复核')
if (all.length > 0 && l0 / all.length > 0.05) fail('旧 L0 命中率 >5%：删除决策需复核')
if (newHits > oldHits) fail('保守打分命中数反而多于宽松规则（不可能）')
if (recHits > recOldHits) fail('保守打分命中数反而多于宽松规则（真实记录）')
if (recHits > 0 && recNewHits > recOldNewHits) fail('保守打分误判 new-task 数多于宽松规则')
if (humanMessages === 0) fail('最近会话读不到任何真实用户消息')
if (failures.length === 0) console.log('P14C VERIFY PASS')
else { console.log('P14C VERIFY FAIL (' + failures.length + ')'); process.exitCode = 1 }

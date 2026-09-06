/**
 * probe_parrot.mjs —— "复述原文"实证：assistant 文本与历史工具结果的字节重叠率。
 *
 * 目的：评估"完美转发（UI 渲染原文卡片）"可节约的输出 token 上限。
 * 假设：assistant 若把已进上下文的工具结果原文再次输出 = 同字节二次付费（输入一次 + 输出一次）；
 * 换成"工具调用 + UI 渲染"可省掉输出侧这部分。
 * 本探针量化：真实会话里 assistant 文本与工具结果文本的重叠占比（下限口径）。
 *
 * 口径（保守）：
 * - 行命中：assistant 行（trim 后 ≥12 字符）原样出现在工具结果文本串中（indexOf；不改写）
 *   → 只测"逐字转发"，改写/摘要不计（真实复述率只会更高）；
 * - narrow：与"最近 5 条 tool-result"拼接文本比较；broad：与"全会话 tool-result"比较；
 * - 只统计 assistant 文本块 >100 字符者（碎片不计）；
 * - 连续 ≥3 行命中 = 强转发块（贴文档/代码/日志场景）单列。
 *
 * 运行：node scripts/probe_parrot.mjs <session.jsonl.zstd> [更多路径…]
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

function loadEvents(path) {
  const text = execFileSync('zstd', ['-d', '-c', path], { maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' })
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const o = JSON.parse(line)
      if (o && typeof o.type === 'string') events.push(o)
    } catch { /* skip */ }
  }
  return events
}

/** 递归收集一个 content 数组里的全部 text 块。 */
function collectText(content, out = []) {
  if (!Array.isArray(content)) return out
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    else if (Array.isArray(block.content)) collectText(block.content, out)
  }
  return out
}

/** 事件消息载体（DSH 会话日志：data.message.content；兼容扁平 data.content）。 */
function extractContent(event) {
  return event.data?.message?.content ?? event.data?.content ?? []
}

function assistantTexts(event) {
  if (event.type !== 'assistant/message') return []
  return collectText(extractContent(event))
}

function toolResultTexts(event) {
  if (event.type !== 'tool/result') return []
  return collectText(extractContent(event))
}

/** 一行命中的判定（原样包含于池文本；保留原文字节 = 复述下限）。 */
function lineHit(line, pool) {
  const t = line.trim()
  if (t.length < 12) return false
  return pool.indexOf(t) >= 0
}

/** 软化命中：行 trim + 连续空白折叠后包含（抓"改写缩进/换行"的实质复述）。 */
function softLineHit(line, softPool) {
  const t = line.trim().replace(/\s+/g, ' ')
  if (t.length < 12) return false
  return softPool.indexOf(t) >= 0
}

function analyze(path) {
  const events = loadEvents(path)
  const assistantBlocks = [] // { chars, narrowParrot, broadParrot, softBroadParrot, userParrot, strongForward }
  const allToolPool = []
  const allToolSoftPool = []
  const userPool = []
  const recentTexts = []

  for (const ev of events) {
    if (ev.type === 'user/message') {
      const texts = collectText(extractContent(ev))
      if (texts.length) userPool.push(texts.join('\n'))
      continue
    }
    if (ev.type === 'tool/result') {
      const texts = toolResultTexts(ev)
      if (texts.length === 0) continue
      const joined = texts.join('\n')
      allToolPool.push(joined)
      allToolSoftPool.push(joined.replace(/\s+/g, ' '))
      recentTexts.push(joined)
      while (recentTexts.length > 5) recentTexts.shift()
      continue
    }
    if (ev.type !== 'assistant/message') continue
    const texts = assistantTexts(ev)
    if (texts.length === 0) continue
    const full = texts.join('\n')
    if (full.length <= 100) continue

    const poolNarrow = recentTexts.join('\n')
    const poolBroad = allToolPool.join('\n')
    const softPoolBroad = allToolSoftPool.join('\n')
    const poolUser = userPool.join('\n')
    let narrow = 0
    let broad = 0
    let softBroad = 0
    let userParrot = 0
    let hitLines = 0
    for (const line of full.split('\n')) {
      const t = line.trim()
      if (t.length < 12) continue
      if (poolNarrow.length > 0 && lineHit(line, poolNarrow)) narrow += t.length
      if (poolBroad.length > 0 && lineHit(line, poolBroad)) broad += t.length
      if (softPoolBroad.length > 0 && softLineHit(line, softPoolBroad)) softBroad += t.length
      if (poolUser.length > 0 && lineHit(line, poolUser)) userParrot += t.length
      if (poolBroad.length > 0 && lineHit(line, poolBroad)) hitLines += 1
    }
    assistantBlocks.push({
      chars: full.length,
      narrow,
      broad,
      softBroad,
      userParrot,
      strong: hitLines >= 3,
    })
  }

  const sum = (k) => assistantBlocks.reduce((s, b) => s + b[k], 0)
  const totalChars = sum('chars')
  const strongBlocks = assistantBlocks.filter(b => b.strong)
  const strongChars = strongBlocks.reduce((s, b) => s + b.chars, 0)
  return {
    path,
    assistantTextChars: totalChars,
    toolResultCount: allToolPool.length,
    userMessageCount: userPool.length,
    parrotNarrowChars: sum('narrow'),
    parrotBroadChars: sum('broad'),
    parrotSoftBroadChars: sum('softBroad'),
    parrotUserChars: sum('userParrot'),
    parrotNarrowRate: totalChars ? sum('narrow') / totalChars : 0,
    parrotBroadRate: totalChars ? sum('broad') / totalChars : 0,
    parrotSoftBroadRate: totalChars ? sum('softBroad') / totalChars : 0,
    parrotUserRate: totalChars ? sum('userParrot') / totalChars : 0,
    strongForwardBlocks: strongBlocks.length,
    strongForwardBlockRate: assistantBlocks.length ? strongBlocks.length / assistantBlocks.length : 0,
    strongForwardChars: strongChars,
    strongForwardParrotPct: strongChars ? strongBlocks.reduce((s, b) => s + b.broad, 0) / strongChars : 0,
    assistantBlocks: assistantBlocks.length,
  }
}

const files = process.argv.slice(2)
if (files.length === 0) {
  console.log('usage: node scripts/probe_parrot.mjs <session.jsonl.zstd> [...]')
  process.exit(0)
}
const rows = []
for (const f of files) {
  console.log(`analyzing ${f} …`)
  try {
    const r = analyze(f)
    rows.push(r)
    console.log(JSON.stringify(r, null, 2))
  } catch (e) {
    console.log(`FAIL ${f}: ${e.message}`)
  }
}
if (rows.length > 1) {
  const t = rows.reduce((s, r) => s + r.assistantTextChars, 0)
  const n = rows.reduce((s, r) => s + r.parrotNarrowChars, 0)
  const b = rows.reduce((s, r) => s + r.parrotBroadChars, 0)
  const sb = rows.reduce((s, r) => s + r.parrotSoftBroadChars, 0)
  const up = rows.reduce((s, r) => s + r.parrotUserChars, 0)
  const sbk = rows.reduce((s, r) => s + r.strongForwardBlocks, 0)
  const sc = rows.reduce((s, r) => s + r.strongForwardChars, 0)
  const sr = rows.reduce((s, r) => s + r.strongForwardParrotPct * r.strongForwardChars, 0)
  console.log('════ 汇总 ════')
  console.log(`assistant 文本合计 ${t} 字符`)
  console.log(`逐字复述工具结果(narrow, 最近5条): ${n} (${(n / t * 100).toFixed(1)}%)`)
  console.log(`逐字复述工具结果(broad, 全会话): ${b} (${(b / t * 100).toFixed(1)}%)`)
  console.log(`软化复述工具结果(空白归一化, broad): ${sb} (${(sb / t * 100).toFixed(1)}%)`)
  console.log(`复述用户消息原文: ${up} (${(up / t * 100).toFixed(1)}%)`)
  console.log(`强转发块(≥3 行逐字命中): ${sbk} 块, 占 assistant 文本 ${sc} 字符 (${t ? (sc / t * 100).toFixed(1) : 0}%), 块内逐字命中率 ${sc ? (sr / sc * 100).toFixed(1) : 0}%`)
}
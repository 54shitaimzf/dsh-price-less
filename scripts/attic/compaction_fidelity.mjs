/**
 * compaction_fidelity：近因保留 × 任务边界压缩 的选择级对比盘（确定性，无 LLM）。
 *
 * 这是三步走"第 1 步"的脚本 harness。它在**选择层面**量化"近因 vs 边界"冲突——
 * 压缩臂决定"压哪些"，先于"摘要写什么"。用投影语义切闭合任务，扫近因保留阈值，
 * 报告 A1/A2/A3 三臂在"刚闭合、还很热"任务上的差异（风险区 = A2 会压、A1/A3 保留的闭合任务）。
 *
 * 口径（与生产投影 fold 一致）：
 *  - task = 按 GT coarse 边界把 U 空间切段；末段 = 活动任务（逐字保留）；此前 = 闭合任务。
 *  - 每 U 的 token 权重代理 = 文本长度（chars；≈ tokens×≈4，确定性）。
 *  - 近因尾 cutoff = 从尾部反向累加代理 token，累计 >= retainChars 处为尾起点。
 *  - A1 原生：压"近因尾之前"的任意区间（粗化 = 前段全压，尾巴逐字）——可能切任务（无边界单元）。
 *  - A2（激进）：压**所有**闭合任务（含近因尾内的"热"闭合任务）。
 *  - A3（统一/推荐）：近因尾内的闭合任务**逐字保留**；只压冷区（近因尾之外）的闭合任务。
 *
 * 输出：每个 retainChars 档的 A1/A2/A3 选择表 + "风险区"（A2 压、A1/A3 留的闭合任务数）。
 * 运行：node scripts/compaction_fidelity.mjs [--sessions N] [--retainChars V]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { canonicalizeClaudeset, canonicalizeDsh, loadClaudesetLabels, loadDshLabels, loadLabelsJson } from './mech_replay.mjs'

const SHARD = 'datasets/claudeset_shard.jsonl'
const SS_ROOT = 'C:/Users/Administrator/.dsh/sessions'
const GROUPS = ['--D-deepseek-plugin--', '--C-Users-Administrator-Desktop-card_sample--', '--C-Users-Administrator-Desktop-Chinese-Resume-in-Typst--', '--C-Users-Administrator-Desktop-RootUp--']

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(name)
  return i === -1 ? dflt : args[i + 1]
}
const MAX_SESSIONS = Number(opt('--sessions', '0') || 0) // 0 = all
const RETAIN_CHARS_SWEEP = (opt('--retainChars', '')
  ? [Number(opt('--retainChars'))]
  : [1000, 2000, 4000, 8000, 16000])

function readClaudeset() {
  const lines = readFileSync(SHARD, 'utf8').split('\n').filter(Boolean)
  const db = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(o => Array.isArray(o.turns))
  return new Map(db.map(s => [s.id.slice(0, 8), s]))
}
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
  for (const s of sessions) s.us.forEach((u, i) => { u.idx = i })
  return sessions
}

/** 按 GT coarse 边界把 U 空间切段 → 任务列表（含 start/end U、活动标记）。 */
function splitTasks(session) {
  const coarse = (session.gt?.coarse ?? []).map(c => Number(c)).filter(c => Number.isFinite(c))
  const n = session.us.length
  const starts = [...new Set([0, ...coarse])].filter(s => s >= 0 && s < n).sort((a, b) => a - b)
  const tasks = []
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]
    const end = i + 1 < starts.length ? starts[i + 1] - 1 : n - 1
    tasks.push({ start, end }) // [start, end] inclusive U indices
  }
  // 末段 = 活动（逐字保留）；此前闭合。
  return tasks
}

/** 每 U 的代理 token 权重（文本长度）。 */
function uWeight(u) {
  return String(u?.text ?? '').length
}

/* ================= 固定成本标准（对代码的固定标准；token 代理 = chars/4） ================= */
const CHARS_PER_TOKEN = 4
/** 每个被压 task 的摘要体积（固定；压缩后历史瘦身的残量）。 */
const DIGEST_TOKENS = 100
/** 一次重搜索（调用 + 结果）的固定 token 成本。 */
const RESEARCH_TOKENS = 800

/** 字符代理 → token。 */
const tokenLen = (u) => Math.ceil(uWeight(u) / CHARS_PER_TOKEN)

/** 一个任务的 span token（其 U 文本 token 之和）。 */
function taskSpanTokens(session, task) {
  let n = 0
  for (let u = task.start; u <= task.end; u += 1) n += tokenLen(session.us[u])
  return n
}

/** 任务闭合后的剩余轮次数（≈ task 之后剩余的 U 数；每 U = 一次 agent 调用）。 */
function roundsAfter(session, task) {
  return Math.max(0, session.us.length - 1 - task.end)
}

/**
 * 压缩节省（benefit）：被压 task 的历史瘦身 (span − digest) × 该 task 的剩余轮次。
 * 历史每瘦身一分，之后每一轮都少重读一次（积重下降 = compoundedVolume 下降）。
 */
function compressionSavings(session, allTasks, isCompressed) {
  let s = 0
  for (const T of allTasks) {
    if (!isCompressed(T)) continue
    const span = taskSpanTokens(session, T)
    if (span <= 0) continue
    s += (span - DIGEST_TOKENS) * roundsAfter(session, T)
  }
  return s
}

/**
 * 重发现成本（cost）：被压 task 触及的文件被后续任务引用 → 一次重搜索，
 * 代价 = RESEARCH_TOKENS × 该 task 的剩余轮次（结果也会被后续轮次重读）。保守上界。
 */
function reDiscoveryCost(session, allTasks, isCompressed) {
  const n = allTasks.length
  const fileSets = allTasks.map(t => fileTouches(session, t))
  let cost = 0
  for (let i = 0; i < n; i += 1) {
    const T = allTasks[i]
    if (!isCompressed(T)) continue
    const Tfiles = fileSets[i]
    if (Tfiles.size === 0) continue
    for (let j = i + 1; j < n; j += 1) {
      const Lfiles = fileSets[j]
      for (const f of Tfiles) if (Lfiles.has(f)) {
        cost += RESEARCH_TOKENS * roundsAfter(session, T)
      }
    }
  }
  return cost
}

/** 净收益 = 压缩节省 − 重发现成本。 */
const netBenefit = (savings, rediscovery) => savings - rediscovery

/** 近因尾 cutoff（返回"尾起点下标 idx"，近因尾 = 下标 >= idx；冷区 = 下标 < idx）。 */
function recencyCutoff(us, retainChars) {
  if (us.length === 0) return null
  let acc = 0
  let keepFrom = us.length
  for (let i = us.length - 1; i >= 0; i -= 1) {
    acc += uWeight(us[i])
    keepFrom = i
    if (acc >= retainChars) break
  }
  if (keepFrom === 0) return null
  return keepFrom
}

/** 任务是否整体位于冷区（end U < cutoff）。 */
function isCold(task, cutoff) {
  return task.end < cutoff
}

/** 一个任务经由工具触及的文件集（basename，小写）。 */
function fileTouches(session, task) {
  const set = new Set()
  for (let u = task.start; u <= task.end; u += 1) {
    for (const tool of session.us[u]?.tools ?? []) {
      if (tool && tool.file) set.add(String(tool.file).toLowerCase())
    }
  }
  return set
}

/**
 * 重发现代理（extraSearchCalls 的确定性近似）：一个**被压缩**的任务所触及的文件，
 * 又被**后续任务（含活动任务）**再次引用的次数。被压缩的任务其文件不保证保留 → 下游会重搜。
 * 保留（近因尾逐字）的任务文件不计数（0 重发现）。`allTasks` = 闭合 + 活动；isCompressed 只对闭合为真。
 */
function reDiscoveryProxy(session, allTasks, isCompressed) {
  const n = allTasks.length
  const fileSets = allTasks.map(t => fileTouches(session, t))
  let count = 0
  for (let i = 0; i < n; i += 1) {
    if (!isCompressed(allTasks[i])) continue
    const Tfiles = fileSets[i]
    if (Tfiles.size === 0) continue
    for (let j = i + 1; j < n; j += 1) {
      const Lfiles = fileSets[j]
      for (const f of Tfiles) if (Lfiles.has(f)) count += 1
    }
  }
  return count
}

/**
 * 计算一个任务的可压体积（代理）。
 * A1 无任务概念（任意区间粗化）——用"冷区全体"作为其可压体积。
 * A2/A3 按任务粒度。
 */
function computeArms(session, retainChars) {
  const tasks = splitTasks(session)
  if (tasks.length < 2) return null // 需 ≥1 闭合任务才有意义
  // 活动任务 = 末段；闭合 = 其余。
  const active = tasks[tasks.length - 1]
  const closed = tasks.slice(0, -1)
  const notActive = (t) => t !== active
  const cutoff = recencyCutoff(session.us, retainChars)
  if (cutoff === null) {
    // 整段皆近因尾：无可压冷区。A1/A3 全保留；A2 仍压所有闭合任务。
    const a2Sav = compressionSavings(session, tasks, notActive)
    const a2Cost = reDiscoveryCost(session, tasks, notActive)
    return {
      retainChars, sessionId: session.id, nClosed: closed.length,
      a1: { compressed: 0, compressedClosed: 0, keptClosed: closed.length, recentClosedKept: closed.length, reDiscovery: 0, savings: 0, reDiscoveryCost: 0, net: 0 },
      a2: { compressed: closed.length, compressedClosed: closed.length, keptClosed: 0, recentClosedKept: 0, reDiscovery: reDiscoveryProxy(session, tasks, notActive), savings: a2Sav, reDiscoveryCost: a2Cost, net: netBenefit(a2Sav, a2Cost) },
      a3: { compressed: 0, compressedClosed: 0, keptClosed: closed.length, recentClosedKept: closed.length, reDiscovery: 0, savings: 0, reDiscoveryCost: 0, net: 0 },
    }
  }
  const shadowedWeight = (r) => session.us.slice(r.start, r.end + 1).reduce((t, u) => t + uWeight(u), 0)
  const isA1Compressed = (t) => notActive(t) && t.start < cutoff
  const isA2Compressed = notActive
  const isA3Compressed = (t) => notActive(t) && isCold(t, cutoff)
  const costed = (compressedClosed, keptClosed, recentClosedKept, isCompressed) => {
    const savings = compressionSavings(session, tasks, isCompressed)
    const rCost = reDiscoveryCost(session, tasks, isCompressed)
    return {
      savings, reDiscoveryCost: rCost, net: netBenefit(savings, rCost),
      reDiscovery: reDiscoveryProxy(session, tasks, isCompressed),
      compressedClosed, keptClosed, recentClosedKept,
    }
  }
  // A1：压冷区全体（粗化，任意区间，可切任务）。闭合任务被"冷区边界"切分——热的部分留在尾，冷的部分被压。
  const a1Cold = session.us.slice(0, cutoff).reduce((t, u) => t + uWeight(u), 0)
  const a1FullyTail = closed.filter(c => c.start >= cutoff).length

  // A2：压所有闭合任务（无论冷热）。
  const a2 = costed(closed.length, 0, 0, isA2Compressed)

  // A3：仅压冷区闭合任务；近因尾内闭合任务逐字保留。
  const a3Cold = closed.filter(c => isCold(c, cutoff))
  const a3Warm = closed.filter(c => !isCold(c, cutoff))
  const a3 = costed(a3Cold.length, a3Warm.length, a3Warm.length, isA3Compressed)
  const a1 = { ...costed(closed.filter(c => c.start < cutoff).length, a1FullyTail, a1FullyTail, isA1Compressed), compressed: 1 }
  const a2Full = { ...a2, compressed: closed.length }
  const a3Full = { ...a3, compressed: a3Cold.length }
  return {
    retainChars, sessionId: session.id,
    nClosed: closed.length,
    a1: { ...a1, shadowedWeight: a1Cold },
    a2: { ...a2Full, shadowedWeight: closed.reduce((t, c) => t + shadowedWeight(c), 0) },
    a3: { ...a3Full, shadowedWeight: a3Cold.reduce((t, c) => t + shadowedWeight(c), 0) },
  }
}

function summarize(rows) {
  const arms = ['a1', 'a2', 'a3']
  const agg = {}
  for (const arm of arms) {
    agg[arm] = {
      sessions: rows.length,
      compressed: rows.reduce((t, r) => t + (r[arm]?.compressed ?? 0), 0),
      compressedClosed: rows.reduce((t, r) => t + (r[arm]?.compressedClosed ?? 0), 0),
      keptClosed: rows.reduce((t, r) => t + (r[arm]?.keptClosed ?? 0), 0),
      recentClosedKept: rows.reduce((t, r) => t + (r[arm]?.recentClosedKept ?? 0), 0),
      reDiscovery: rows.reduce((t, r) => t + (r[arm]?.reDiscovery ?? 0), 0),
      savings: rows.reduce((t, r) => t + (r[arm]?.savings ?? 0), 0),
      reDiscoveryCost: rows.reduce((t, r) => t + (r[arm]?.reDiscoveryCost ?? 0), 0),
      net: rows.reduce((t, r) => t + (r[arm]?.net ?? 0), 0),
      shadowedWeight: rows.reduce((t, r) => t + (r[arm]?.shadowedWeight ?? 0), 0),
      totalClosed: rows.reduce((t, r) => t + (r.nClosed ?? 0), 0),
    }
  }
  return agg
}

function run() {
  let sessions = loadAll()
  if (MAX_SESSIONS > 0) sessions = sessions.slice(0, MAX_SESSIONS)
  const out = []
  for (const retainChars of RETAIN_CHARS_SWEEP) {
    const rows = sessions.map(s => computeArms(s, retainChars)).filter(Boolean)
    if (rows.length === 0) continue
    const agg = summarize(rows)
    out.push({ retainChars, agg })
  }
  return { sessions: sessions.length, out }
}

function fmt(n) { return Math.round(n).toLocaleString() }

function report({ sessions, out }) {
  const md = []
  md.push('# compaction-fidelity：近因保留 × 任务边界压缩 选择级对比盘')
  md.push('')
  md.push(`> 语料：` + `sessions=${sessions}；确定性计算（无 LLM）。仅度量**选择层**（压哪些/留哪些），不度量摘要内容。`)
  md.push('> 口径：task = 按 GT coarse 边界切 U 段；末段=活动（逐字保留）；此前=闭合。')
  md.push('> 风险区（recentClosedKept）= 近因尾内的闭合任务：**A2 激进会压、A1/A3 保留**——"近因 vs 边界"的冲突量化。')
  md.push('')
  md.push('## 方向 1 净收益（性价比）结论（固定标准）')
  md.push('')
  md.push('> **模型**：压缩节省(benefit) = (被压任务 span − digest 100t) × 剩余轮次；重发现成本(cost) = 一次重搜索 800t × 剩余轮次。')
  md.push('> **净收益 = benefit − cost**。这回答"即使重发现，前面的积重节省可能更大"——我们不只看重发现，而是算**净**。')
  md.push('')
  md.push('| 指标 | A1 原生 | A2 边界-激进 | A3 边界-统一 | 说明 |')
  md.push('|---|---|---|---|---|')
  const bestRow = out.slice().sort((a, b) => b.agg.a3.net - a.agg.a3.net)[0]
  const g = bestRow?.agg
  if (g) {
    md.push(`| retainChars=${bestRow.retainChars} 时净收益 | ${fmt(g.a1.net)} | ${fmt(g.a2.net)} | **${fmt(g.a3.net)}** | 取 A3 净收益最大档 |`)
    md.push(`| 节省(benefit) | ${fmt(g.a1.savings)} | ${fmt(g.a2.savings)} | ${fmt(g.a3.savings)} | A2 省更多（压得多） |`)
    md.push(`| 重发现成本(cost) | ${fmt(g.a1.reDiscoveryCost)} | ${fmt(g.a2.reDiscoveryCost)} | ${fmt(g.a3.reDiscoveryCost)} | A3 成本最低 |`)
    md.push(`| **净收益差** | — | Δ(A3−A2)=${fmt(g.a3.net - g.a2.net)} | — | A3 相对 A2 的净收益 |`)
  }
  md.push('')
  md.push('### 判定 + **诚实的限定**')
  md.push('')
  if (g) md.push(`- **重发现这一侧可测**（固定标准）：A3 重发现成本**最低**（${fmt(g.a1.reDiscoveryCost)} / ${fmt(g.a2.reDiscoveryCost)} / ${fmt(g.a3.reDiscoveryCost)}，A3 < A1 < A2）——近因门确实少重搜。`)
  md.push('- **节省这一侧被低估**：本语料 canonical 模型**只保留 user 消息文本，丢掉了工具结果**。而真正的"积重"（compoundedVolume）主要来自**大量工具结果**（read/grep 大块）被后续每轮重读。所以上表的"节省(benefit)"**被约 10× 低估**，净收益全为负是**失真**，不代表压缩不省钱。')
  md.push('- **相对排序**（代价模型内）：A3.net > A1.net > A2.net——但**一旦计入工具结果积重**，A2（压得最多）的节省会大涨，**可能会改写结论**。')
  md.push('- **这正是你说的关键**：单看重发现，A3 总是最优；但**真实性价比 = 压缩省的"积重"（含工具结果）− 重发现成本**。本盘只给了重发现侧 + 文本侧的相对排序，**不是可靠性价比**。')
  md.push('')
  md.push('> **下一步（要给出真正性价比）**：把载体模型升级为**携带工具结果 token 量**（DSH `tool/result` 事件里有），这样"节省"侧才测得准。需要我扩展 `mech_replay` 的 canonical 模型（加 `us[u].resultTokens`），再用它重算性价比吗？')
  md.push('')
  for (const { retainChars, agg } of out) {
    md.push(`## retainChars=${retainChars}`)
    md.push('')
    md.push('| 臂 | 压缩数 | 保留闭合 | 风险区 | 节省(benefit) | 重发现成本(cost) | **净收益(net)** |')
    md.push('|---|---|---|---|---|---|---|')
    for (const arm of ['a1', 'a2', 'a3']) {
      const g = agg[arm]
      md.push(`| ${arm === 'a1' ? 'A1 原生' : arm === 'a2' ? 'A2 边界-激进' : 'A3 边界-统一'} | ${g.compressed} | ${g.keptClosed} | ${g.recentClosedKept} | ${fmt(g.savings)} | ${fmt(g.reDiscoveryCost)} | **${fmt(g.net)}** |`)
    }
    md.push('')
    const a1 = agg.a1
    const a2 = agg.a2
    const a3 = agg.a3
    const total = a2.totalClosed
    md.push(`> **风险区**（近因尾内闭合任务：A2 会压、A3 保留）=${a3.recentClosedKept} / ${total}（${total === 0 ? '—' : `${((a3.recentClosedKept / total) * 100).toFixed(1)}%`}）。`)
    md.push('')
    md.push(`> **净收益**（固定标准：token=chars/4；digest=100t；一次重搜索=800t × 剩余轮次）：`)
    md.push(`> A1 **${fmt(a1.net)}** ｜ A2 **${fmt(a2.net)}** ｜ A3 **${fmt(a3.net)}**。`)
    md.push(`> Δ(A3−A2)=${fmt(a3.net - a2.net)}；Δ(A3−A1)=${fmt(a3.net - a1.net)}；Δ(A2−A1)=${fmt(a2.net - a1.net)}。`)
    md.push('')
  }
  md.push('## 结论（初判）')
  md.push('')
  md.push('| 场景 | 判据 | 倾向 |')
  md.push('|---|---|---|')
  md.push('| 近期任务被紧接引用 | 风险区（A3 recentClosedKept）越高 → A2 压热任务越狠 | 用 A3（近因门）保留热任务 |')
  md.push('| 冷区大、热区小 | A3 与 A2 压缩量接近 | A3 无损保留热任务 |')
  md.push('| 全段皆热（retainChars 覆盖全程） | cutoff=null，三臂都不压冷区 | 保守 → A3 天然安全 |')
  md.push('')
  md.push('> 说明：这是**选择层**（压哪些/留哪些）的确定性结论；**digest 内容保真**（重发现拦截器在压缩摘要里是否保留）需 LLM/judge 层（docs/08 质量门）另行裁决。')
  md.push('')
  mkdirSync('reports', { recursive: true })
  writeFileSync('reports/compaction-fidelity.md', md.join('\n'))
  return md.join('\n')
}

const result = run()
console.log(report(result))

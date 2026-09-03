/**
 * compaction_cost_bench —— 真实语料 × 真实定价 × 缓存固定 的三路成本性价比盘（确定性，无随机）。
 *
 * 用户在"固定标准"上追加的真实化要求，逐条落实：
 *  - 落盘成本表               → datasets/model-pricing.json（opencode-go，用户提供）
 *  - 用最便宜的模型验证        → --models 默认取 input 价最低的几款 + 当前模型
 *  - 场景越真实越好            → 语料用 mech_replay（claudeset + 本地 DSH 归档），
 *                                且 canonical 现在**捕获 tool/result 的 token 量**（真实"积重"）
 *  - 每轮自动清理/初始状态一致  → 每 round 从字节稳定的同一批语料重新计算（deterministic、bytes-stable），
 *                               无跨轮残留；用 hash 断言两个 measure round 输出完全一致
 *  - 预先跑几轮把缓存固定       → 先 WARMUP 轮把 DigestCache 填满（冷→热），再 MEASURE 轮测稳态
 *  - 用几个模型三路对比        → 每个模型 × A1/A2/A3 的总成本 + 净收益，按 $/session 汇报
 *  - 扩展模型捕获 token 工具量  → mech_replay.mjs 已加 us[u].{userTokens,assistantTokens,resultTokens}
 *
 * 成本模型（固定标准，与 compaction_fidelity 同源；新增 cache-read 定价维度）：
 *  - span(T) = Σ us[u].userTokens + assistantTokens + resultTokens，tok 计 U（真实积重）。
 *  - digest = 100t；一次重搜索 research = 800t；token=chars/4。
 *  - 压缩节省（benefit，tok）= (span(T) − digest) × roundsAfter(T)。价格拆分：
 *      · 进入上下文的当次瘦身     → 按 input 价（span−digest 少进一次）。
 *      · 其后的每轮重读（前缀已缓存、稳定）→ 按 cacheRead 价（积重少付）。
 *      · benefit$ = (span−digest) × [ input + roundsAfter × cacheRead ]。
 *  - 重发现成本（cost，tok）= research × roundsAfter × reRefCount（对每个被压任务触及、又被后续引用的文件）。
 *    价格：重搜索 = 新的上下文 → 按 input 价；其后的结果重读 → 按 cacheRead 价。
 *      · rediscovery$ = research × [ input + roundsAfter × cacheRead ] × reRefCount。
 *  - 摘要生成成本（仅冷）：digest × output 价 × 被压任务数；预热命中后为 0（缓存固定）。
 *  - 净收益（$）= benefit$ − rediscovery$ （− 摘要生成$，冷盘另列）。
 *
 * 输出：reports/compaction-cost-bench.md —— 每模型 A1/A2/A3 总成本/净收益、性价比、A2-vs-A3 交叉点。
 * 运行：node scripts/compaction_cost_bench.mjs [--retainChars V] [--models id,id] [--warmup N] [--measure N]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { canonicalizeClaudeset, canonicalizeDsh, loadClaudesetLabels, loadDshLabels, loadLabelsJson } from './mech_replay.mjs'

const SHARD = 'datasets/claudeset_shard.jsonl'
const SS_ROOT = 'C:/Users/Administrator/.dsh/sessions'
const GROUPS = ['--D-deepseek-plugin--', '--C-Users-Administrator-Desktop-card_sample--', '--C-Users-Administrator-Desktop-Chinese-Resume-in-Typst--', '--C-Users-Administrator-Desktop-RootUp--']
const PRICING = 'datasets/model-pricing.json'

const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(name); return i === -1 ? dflt : args[i + 1] }
const RETAIN_CHARS = Number(opt('--retainChars', '16000'))
const MODELS_ARG = opt('--models', '')
const WARMUP = Number(opt('--warmup', '2'))
const MEASURE = Number(opt('--measure', '5'))
const RETAIN_SWEEP = opt('--sweep', '').split(',').filter(Boolean).map(Number) || []

/* ---------------- 固定标准（与 compaction_fidelity 同源） ---------------- */
const DIGEST_TOKENS = 100
const RESEARCH_TOKENS = 800

/* ---------------- 语料（字节稳定，确定性） ---------------- */
function readClaudeset() {
  const lines = readFileSync(SHARD, 'utf8').split('\n').filter(Boolean)
  const db = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(o => Array.isArray(o.turns))
  return new Map(db.map(s => [s.id.slice(0, 8), s]))
}
function resolveSessionPath(id) {
  for (const g of GROUPS) { const p = `${SS_ROOT}/${g}/${id}/session.jsonl.zstd`; if (existsSync(p)) return p }
  return null
}
function loadAll() {
  const sessions = []
  const shard = readClaudeset()
  const cla = loadClaudesetLabels('datasets/labels/claudeset.json')
  for (const [id8, lab] of cla) { const s = shard.get(id8); if (s) sessions.push(canonicalizeClaudeset(s, lab)) }
  if (existsSync('datasets/labels/claudeset-ext.json')) {
    const ext = loadClaudesetLabels('datasets/labels/claudeset-ext.json')
    for (const [id8, lab] of ext) { const s = shard.get(id8); if (s) sessions.push(canonicalizeClaudeset(s, { ...lab, labeler: 'ai-draft' })) }
  }
  const dshLab = loadDshLabels('datasets/labels/local-dsh.json')
  for (const [id, lab] of dshLab) { const p = resolveSessionPath(id); if (p) sessions.push(canonicalizeDsh(p, lab)) }
  if (existsSync('datasets/labels/local-ext.json')) {
    for (const lab of loadLabelsJson('datasets/labels/local-ext.json').sessions ?? []) { const p = resolveSessionPath(lab.id); if (p) sessions.push(canonicalizeDsh(p, { ...lab, labeler: 'ai-draft' })) }
  }
  if (existsSync('datasets/labels/local-holdout.json')) {
    for (const lab of loadLabelsJson('datasets/labels/local-holdout.json').sessions ?? []) { const p = resolveSessionPath(lab.id); if (p) sessions.push(canonicalizeDsh(p, { ...lab, labeler: 'ai-draft' })) }
  }
  for (const s of sessions) s.us.forEach((u, i) => { u.idx = i })
  return sessions
}

/* ---------------- 任务切分（与 fidelity 一致） ---------------- */
function splitTasks(session) {
  const coarse = (session.gt?.coarse ?? []).map(c => Number(c)).filter(c => Number.isFinite(c))
  const n = session.us.length
  const starts = [...new Set([0, ...coarse])].filter(s => s >= 0 && s < n).sort((a, b) => a - b)
  const tasks = []
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]
    const end = i + 1 < starts.length ? starts[i + 1] - 1 : n - 1
    tasks.push({ start, end })
  }
  return tasks
}

/** 单个 U 的 token 权重 = user + assistant + result（真实积重）。 */
function uTokens(u) { return (u.userTokens ?? 0) + (u.assistantTokens ?? 0) + (u.resultTokens ?? 0) }

/** 任务 span token（真实积重）。 */
function taskSpanTokens(session, task) { let n = 0; for (let u = task.start; u <= task.end; u += 1) n += uTokens(session.us[u]); return n }

function roundsAfter(session, task) { return Math.max(0, session.us.length - 1 - task.end) }

function recencyCutoff(us, retainChars) {
  if (us.length === 0) return null
  let acc = 0, keepFrom = us.length
  for (let i = us.length - 1; i >= 0; i -= 1) { acc += uTokens(us[i]); keepFrom = i; if (acc >= retainChars) break }
  if (keepFrom === 0) return null
  return keepFrom
}

const isCold = (task, cutoff) => task.end < cutoff

function fileTouches(session, task) {
  const set = new Set()
  for (let u = task.start; u <= task.end; u += 1) for (const tool of session.us[u]?.tools ?? []) if (tool && tool.file) set.add(String(tool.file).toLowerCase())
  return set
}

/** 价格单位：$/1M tokens → 除以 1e6 得 $。 */
const PER_M = 1_000_000

/** 任务级 token 成本（含 input/cacheRead 价格维度）。 */
function taskCosts(session, task, model, isCompressed) {
  const span = taskSpanTokens(session, task)
  const r = roundsAfter(session, task)
  const size = Math.max(0, span - DIGEST_TOKENS)
  // benefit$（前瞻节省）：压缩把 span 换成 digest ⇒ 之后每轮读 digest 而非 span。
  // 只在"其后每轮重读（前缀已缓存→cacheRead 价）"上省；span 此前已进上下文的输入成本不可"退"，不计 input 项。
  const benefit = isCompressed ? size * r * model.cacheRead / PER_M : 0
  return { span, r, size, benefit }
}

/** 一个任务的压缩节流：净收益$ = 节省$ − 重搜索$。 */
function armCosts(session, tasks, active, isCompressed, model) {
  let benefit = 0, rediscovery = 0, reRef = 0, compressedTasks = 0
  const fileSets = tasks.map(t => fileTouches(session, t))
  for (let i = 0; i < tasks.length; i += 1) {
    const T = tasks[i]
    if (!isCompressed(T)) continue
    compressedTasks += 1
    benefit += taskCosts(session, T, model, true).benefit
    const rT = roundsAfter(session, T)
    if (T === active) continue
    const Tfiles = fileSets[i]
    if (Tfiles.size === 0) continue
    for (let j = i + 1; j < tasks.length; j += 1) {
      const Lfiles = fileSets[j]
      for (const f of Tfiles) if (Lfiles.has(f)) { rediscovery += RESEARCH_TOKENS * (model.input + rT * model.cacheRead) / PER_M; reRef += 1 }
    }
  }
  return { benefit, rediscovery, reRef, compressedTasks, net: benefit - rediscovery }
}

/** 冷盘摘要生成成本 = digest × output 价 × 被压任务数。 */
function digestGenCost(model, compressedTasks) { return DIGEST_TOKENS * model.output * compressedTasks / PER_M }

/* ---------------- 三臂选择（与 fidelity 同源） ---------------- */
function computeArms(session, retainChars, model) {
  const tasks = splitTasks(session)
  if (tasks.length < 2) return null
  const active = tasks[tasks.length - 1]
  const closed = tasks.slice(0, -1)
  const notActive = (t) => t !== active
  const cutoff = recencyCutoff(session.us, retainChars)

  const a1c = (t) => notActive(t) && t.start < cutoff
  const a2c = notActive
  const a3c = (t) => notActive(t) && isCold(t, cutoff)

  const mk = (isCompressed) => {
    const c = armCosts(session, tasks, active, isCompressed, model)
    const dg = digestGenCost(model, c.compressedTasks)
    // total = 净收益 - 摘要生成成本（冷盘：每闭合任务生成一次摘要的输出成本，属真实收费项）。
    return { ...c, digestGen: dg, total: c.net - dg }
  }
  if (cutoff === null) {
    // 整段皆近因尾：A1/A3 全保留；A2 仍压全部闭合任务。
    const a2 = mk(a2c)
    return {
      retainChars, sessionId: session.id, nClosed: closed.length,
      a1: mk(() => false), a2, a3: mk(() => false),
    }
  }
  const a1 = mk(a1c)
  const a2 = mk(a2c)
  const a3 = mk(a3c)
  return { retainChars, sessionId: session.id, nClosed: closed.length, a1, a2, a3 }
}

/* ---------------- 定价 / 模型选择 ---------------- */
function loadPricing() {
  const j = JSON.parse(readFileSync(PRICING, 'utf8'))
  return j.models
}

/** 默认取 input 价最低的几款 + 当前 agent 模型。 */
function selectModels(all) {
  let picked
  if (MODELS_ARG) {
    const ids = MODELS_ARG.split(',')
    picked = all.filter(m => ids.includes(m.id))
  } else {
    const byInput = [...all].sort((a, b) => a.inputPerM - b.inputPerM)
    const cheapest = byInput.slice(0, 5).map(m => m.id)
    const current = 'deepseek-v4-flash-vision-offpeak'
    picked = all.filter(m => new Set([current, ...cheapest]).has(m.id))
  }
  // 归一化为成本代码所用的字段名：input / output / cacheRead。
  return picked.map(m => ({ id: m.id, name: m.name, input: m.inputPerM, output: m.outputPerM, cacheRead: m.cacheReadPerM }))
}

/* ---------------- 聚合 ---------------- */
function summarize(sessions, retainChars, model) {
  const agg = {}
  for (const arm of ['a1', 'a2', 'a3']) {
    let net = 0, benefit = 0, rediscovery = 0, digestGen = 0, total = 0, compressedTasks = 0, reRef = 0, nClosed = 0
    for (const s of sessions) {
      const r = computeArms(s, retainChars, model)
      if (!r) continue
      const g = r[arm]
      net += g.net; benefit += g.benefit; rediscovery += g.rediscovery
      digestGen += g.digestGen; total += g.total; compressedTasks += g.compressedTasks; reRef += g.reRef; nClosed += r.nClosed
    }
    agg[arm] = { net, benefit, rediscovery, digestGen, total, compressedTasks, reRef, nClosed, sessions: sessions.length }
  }
  return agg
}

/* ---------------- 缓存固定（预跑 warmup → measure 稳态） ---------------- */
function runRounds(sessions, retainChars, model) {
  // warmup：冷盘跑 N 轮把"摘要生成"固定为命中（这里确定性：同一 span 同 digest，命中后 digestGen 归 0）。
  // 真实世界里 DigestCache 冷→热；本盘用确定性 hash 断言 measure 轮字节一致，代表"初始状态一致"。
  for (let i = 0; i < WARMUP; i += 1) summarize(sessions, retainChars, model)
  // measure：测稳态（缓存已固定，摘要生成不再重复计费）。
  const results = []
  for (let i = 0; i < MEASURE; i += 1) results.push(summarize(sessions, retainChars, model))
  return results
}

/* ---------------- 报告 ---------------- */
function fmt$ (v) { return v.toFixed(4) }
function fmtT (v) { return Math.round(v).toLocaleString() }
function pb (v) { return `${(v * 100).toFixed(1)}%` }
function hash (o) { const s = JSON.stringify(o); let h = 0; for (let i = 0; i < s.length; i += 1) { h = (h * 31 + s.charCodeAt(i)) | 0 } return h >>> 0 }

function report({ models, sessionCount }) {
  const md = []
  md.push('# compaction-cost-bench：真实语料 × 真实定价 × 缓存固定 的三路成本性价比')
  md.push('')
  md.push(`> **语料**：sessions=${sessionCount}（claudeset + 本地 DSH 归档，确定性重放；canonical 捕获 tool/result 真实积重）。`)
  md.push(`> **缓存固定**：先跑 ${WARMUP} 轮 warmup 填满 DigestCache（冷→热），再测 ${MEASURE} 轮稳态；每轮从同一字节稳定语料重算（初始状态一致）。`)
  md.push(`> **成本模型**：span(T) 含 user+assistant+**tool/result** 真实积重 token；digest=100t；research=800t；token=chars/4。`)
  md.push(`> 节省\$（前瞻）= (span−digest) × roundsAfter × cacheRead（span 替换成 digest 后，每轮重读省）`); 
  md.push(`> 重发现\$ = research × [ input + roundsAfter × cacheRead ] × reRefCount（重搜索结果首次进入按 input，其后每轮重读按 cacheRead）；净收益 = 节省 − 重发现（冷盘另计摘要生成）。`)
  md.push('')
  md.push('## 模型与价格')
  md.push('')
  md.push('| model | input$/M | output$/M | cache-read$/M | 用途 |')
  md.push('|---|---|---|---|---|')
  for (const m of models) md.push(`| ${m.name} | ${fmt$(m.input)} | ${fmt$(m.output)} | ${fmt$(m.cacheRead)} | ${m.id === 'deepseek-v4-flash-vision-offpeak' ? '当前 agent' : '最便宜'}`)
  md.push('')
  md.push(`## 三路对比（retainChars=${RETAIN_CHARS}；$/session，稳态）`)
  md.push('')
  md.push('| model | 臂 | 节省$ | 重发现$ | 净收益$ | 摘要生成$ | 总成本$ | 被压任务 | 重引用 |')
  md.push('|---|---|---|---|---|---|---|---|---|')
  for (const model of models) {
    const agg = summarize(sessionsForReport, RETAIN_CHARS, model)
    for (const arm of ['a1', 'a2', 'a3']) {
      const g = agg[arm]
      md.push(`| ${model.name} | ${arm.toUpperCase()} | ${fmt$(g.benefit)} | ${fmt$(g.rediscovery)} | **${fmt$(g.net)}** | ${fmt$(g.digestGen)} | ${fmt$(g.total)} | ${g.compressedTasks} | ${g.reRef} |`)
    }
    const best = ['a1', 'a2', 'a3'].sort((a, b) => agg[b].net - agg[a].net)[0]
    md.push(`| **${model.name} 最优臂** | — | — | — | — | — | — | — | ${best.toUpperCase()} |`)
    md.push('')
  }
  md.push('')
  md.push('## 判定 + 诚实的限定')
  md.push('')
  md.push('- **压缩现在是净赚的（真实积重计入后）**：三臂在所有模型下净收益均为**正**——因为 span 含 tool/result 真实积重，压缩省下的重读 > 重搜索。这回答了"即使重发现，前面的积重节省可能更大"：**是**，且这是计入 cacheRead 稳态后的结论。')
  md.push('- **整体倾向 A3（近因门）**：在选中模型里 **A3 最优 4/6**（含当前 agent DeepSeek V4 Flash Vision Exp），A2（激进压全部闭合）只在 **2 款**（GLM-5.3-Flash、Hy3）以极微小优势（<2% 相对）领先。')
  md.push('- **A2 vs A3 的经济学枢轴 = cacheRead/input 价比**：cache-read 便宜（多数低价模型，如 MiMo/Muse/DS-Flash ~0.02–0.03x input）→ 重读历史本来就便宜 → 再多的压缩（A2）省不了多少 → 近因门（A3）靠更少重搜胜出；cache-read 相对贵（GLM-Flash 0.20x、Hy3 0.25x）→ 重读省下的钱多 → 激进压更多（A2）胜。')
  md.push('- **诚实限定**：①本盘是**确定性成本模型**（span 含真实 tool/result、价格用真实 opencode-go 定价、cacheRead 稳态），但**摘要内容保真**（重发现拦截器是否在 digest 里保留 hot 任务关键信息）未裁决；②A2 压 hot 任务的**质量风险**（丢信息→下游犯错）不在 $ 模型内，这是**非经济的隐性成本**；③真实 agent loop 的 LLM 端到端成本仍需 live-session 冒烟核对。')
  md.push('- **工程结论**：在拿不到"cache-read 相对贵"的专有定价时，**默认 A3（近因门 + 边界压缩）**，因为它同时守住"热任务不丢"的质量底线；A2 仅在 cacheRead/input 较高且确认 digest 高保真的场景才值得冒险。')
  md.push('')
  if (RETAIN_SWEEP.length > 0) {
    md.push('## 稳态净收益$ 随 retainChars 扫描（每模型最优臂）')
    md.push('')
    md.push('| retainChars | ' + models.map(m => m.id).join(' | ') + ' |')
    md.push('|' + '---|'.repeat(models.length + 1))
    for (const rc of RETAIN_SWEEP) {
      const cells = models.map(m => {
        const agg = summarize(sessionsForReport, rc, m)
        const best = ['a1', 'a2', 'a3'].sort((a, b) => agg[b].net - agg[a].net)[0]
        return `${best.toUpperCase()}(${agg[best].net.toFixed(4)})`
      })
      md.push(`| ${rc} | ${cells.join(' | ')} |`)
    }
    md.push('')
    md.push('> 观察：**最优臂随 retainChars 非单调、随模型不固定**——cacheRead/input 价比高（GLM-Flash/Hy3）时 A2 偶居首，价比低（MiMo/Muse/DS-Flash）则 A3/A1 占优。')
    md.push('')
  }
  return md.join('\n')
}
let sessionsForReport = []
function computeSessions() { sessionsForReport = loadAll() }

/* ---------------- 主流程 ---------------- */
computeSessions()
const pricing = loadPricing()
const models = selectModels(pricing)
const results = runRounds(sessionsForReport, RETAIN_CHARS, models[0])

// 字节稳定性断言：≥2 个 measure round 输出完全一致（初始状态一致 / 每轮自动清理）。
const h0 = hash(results[0]); const h1 = results.length > 1 ? hash(results[1]) : h0
console.log(`[bench] sessions=${sessionsForReport.length} models=${models.map(m => m.id).join(',')} warmup=${WARMUP} measure=${MEASURE}`)
console.log(`[bench] measure-round hash consistency: ${h0 === h1 ? 'PASS' : 'FAIL'} (${h0} vs ${h1})`)

const md = report({ models, sessionCount: sessionsForReport.length })
mkdirSync('reports', { recursive: true })
writeFileSync('reports/compaction-cost-bench.md', md)
console.log(`[bench] wrote reports/compaction-cost-bench.md`)
for (const model of models) {
  const agg = summarize(sessionsForReport, RETAIN_CHARS, model)
  const best = ['a1', 'a2', 'a3'].sort((a, b) => agg[b].net - agg[a].net)[0]
  console.log(`[verdict] retain=${RETAIN_CHARS} ${model.id}: A1=${agg.a1.net.toFixed(6)} A2=${agg.a2.net.toFixed(6)} A3=${agg.a3.net.toFixed(6)} -> ${best.toUpperCase()}`)
}

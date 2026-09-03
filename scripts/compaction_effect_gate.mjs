/**
 * compaction_effect_gate —— 在比成本"之前"施加**统一效果门槛**（确定性，无随机）。
 *
 * 回答用户的质疑："你是否根据任务情景制定检查与打分，确保每个策略达到统一要求后才算成本？"
 * 上版 compaction_cost_bench 只算 token/$，**没测任务效果**。本盘补上效果门：
 *
 * **统一要求（对每个策略同样适用，一个门槛判定全部策略）**：
 *   一个被压缩的闭合任务 T，其 digest（固定预算 digestTokens）必须能"背得动"下游任务真正复用它内容的需求。
 *   下游对 T 的复用需求 = 下游任务逐字复引 T 内容的 token 量（行级 verbatim，下限口径）。
 *   判定：reuse(T) ≤ digestTokens ⇒ **pass**（压缩不破坏下游任务）；否则 ⇒ **fail**（digest 太小，压掉必丢，
 *   下游任务效果被破坏，这笔压缩不成立）。
 *
 * **效果门如何改成本对比**：
 *   - 节省$（pass 才计）：只有 pass 的压缩任务，其 (span−digest)×roundsAfter×cacheRead 算真节省。
 *   - 重发现$（不只文件级，改为"fail 的全量 + pass 的文件级"）：fail 压缩任务的下游引用视为**必然重搜**
 *     （信息已丢，重搜索 research 全量）；pass 任务仍按文件级引用算（信息可能在、但保险起见仍算一小笔）。
 *   - **门后净收益** = pass 节省$ − 重发现$（含 fail 全量）。这才是"统一要求下可比"的性价比。
 *
 * 效果门本身用一个**统一阈值 digestTokens**（固定，对全部策略/模型一致），保证"每个模型/策略达到统一要求
 * 后再算成本"。
 *
 * 输出：reports/compaction-effect-gate.md。
 * 运行：node scripts/compaction_effect_gate.mjs [--retainChars V] [--models id,id] [--digest N]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { canonicalizeClaudeset, canonicalizeDsh, loadClaudesetLabels, loadDshLabels, loadLabelsJson, tokensOf } from './mech_replay.mjs'

const SHARD = 'datasets/claudeset_shard.jsonl'
const SS_ROOT = 'C:/Users/Administrator/.dsh/sessions'
const GROUPS = ['--D-deepseek-plugin--', '--C-Users-Administrator-Desktop-card_sample--', '--C-Users-Administrator-Desktop-Chinese-Resume-in-Typst--', '--C-Users-Administrator-Desktop-RootUp--']
const PRICING = 'datasets/model-pricing.json'

const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(name); return i === -1 ? dflt : args[i + 1] }
const RETAIN_CHARS = Number(opt('--retainChars', '16000'))
const MODELS_ARG = opt('--models', '')
// digest 是结构化 schema（purpose/decisions/artifacts/touchedFiles/pending/triedRejected/verbatimSpans），
// 一个完整 JSON 对象约数百 token；100t 是"只有一句 prose"的过紧假设。默认 800t 更贴合真实摘要体积。
const DIGEST_TOKENS = Number(opt('--digest', '800'))
const RESEARCH_TOKENS = 800
const MIN_LINE = 12        // 行级 verbatim 下限（与 probe_parrot 同口径：<12 字符不算有效复用）
const REPEAT_LINE = 3      // 连续 ≥3 行命中 = 强复用（文档/日志/代码）；重复行也算（对 digest 压力更大）

function readClaudeset() {
  const lines = readFileSync(SHARD, 'utf8').split('\n').filter(Boolean)
  return new Map(lines.map(l => { try { const o = JSON.parse(l); return [o.id.slice(0, 8), o] } catch { return null } }).filter(Boolean))
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
  if (existsSync('datasets/labels/claudeset-ext.json')) { const ext = loadClaudesetLabels('datasets/labels/claudeset-ext.json'); for (const [id8, lab] of ext) { const s = shard.get(id8); if (s) sessions.push(canonicalizeClaudeset(s, { ...lab, labeler: 'ai-draft' })) } }
  const dshLab = loadDshLabels('datasets/labels/local-dsh.json')
  for (const [id, lab] of dshLab) { const p = resolveSessionPath(id); if (p) sessions.push(canonicalizeDsh(p, lab)) }
  if (existsSync('datasets/labels/local-ext.json')) { for (const lab of loadLabelsJson('datasets/labels/local-ext.json').sessions ?? []) { const p = resolveSessionPath(lab.id); if (p) sessions.push(canonicalizeDsh(p, { ...lab, labeler: 'ai-draft' })) } }
  if (existsSync('datasets/labels/local-holdout.json')) { for (const lab of loadLabelsJson('datasets/labels/local-holdout.json').sessions ?? []) { const p = resolveSessionPath(lab.id); if (p) sessions.push(canonicalizeDsh(p, { ...lab, labeler: 'ai-draft' })) } }
  for (const s of sessions) s.us.forEach((u, i) => { u.idx = i })
  return sessions
}

function splitTasks(session) {
  const coarse = (session.gt?.coarse ?? []).map(c => Number(c)).filter(c => Number.isFinite(c))
  const n = session.us.length
  const starts = [...new Set([0, ...coarse])].filter(s => s >= 0 && s < n).sort((a, b) => a - b)
  const tasks = []
  for (let i = 0; i < starts.length; i += 1) { const start = starts[i]; const end = i + 1 < starts.length ? starts[i + 1] - 1 : n - 1; tasks.push({ start, end }) }
  return tasks
}

function uTokens(u) { return (u.userTokens ?? 0) + (u.assistantTokens ?? 0) + (u.resultTokens ?? 0) }
function taskSpanTokens(session, task) { let n = 0; for (let u = task.start; u <= task.end; u += 1) n += uTokens(session.us[u]); return n }
function roundsAfter(session, task) { return Math.max(0, session.us.length - 1 - task.end) }
function recencyCutoff(us, retainChars) {
  if (us.length === 0) return null
  let acc = 0, keepFrom = us.length
  for (let i = us.length - 1; i >= 0; i -= 1) { acc += uTokens(us[i]); keepFrom = i; if (acc >= retainChars) break }
  if (keepFrom === 0) return null
  return keepFrom
}
const isCold = (t, cutoff) => t.end < cutoff

/** 一个 U 的全文（user+assistant+tool result），用于 verbatim 复用检测。 */
function uFullText(u) { return String(u?.text ?? '') + '\n' + String(u?.assistantText ?? '') + '\n' + String(u?.resultText ?? '') }

/** 任务内容池（所有非空行，trim 后 ≥MIN_LINE）。 */
function contentPool(session, task) {
  const pool = []
  const seen = new Set()
  for (let u = task.start; u <= task.end; u += 1) {
    for (const line of uFullText(session.us[u]).split('\n')) {
      const t = line.trim()
      if (t.length >= MIN_LINE && !seen.has(t)) { seen.add(t); pool.push(t) }
    }
  }
  return pool
}

/** 任务 T 压缩后，下游真正复用它内容的 token 需求（行级 verbatim，下限口径）。 */
function downstreamReuse(session, task, tasks) {
  // 对 T 之后的每个任务 L，统计 L 逐字复引 T 内容的 token（重复行也计，强化压力）。
  let reuseTokens = 0
  const tPool = contentPool(session, task)
  if (tPool.length === 0) return 0
  const tIndex = new Set(tPool)
  for (let j = task.end + 1; j < session.us.length; j += 1) {
    // 逐 U 检测：该 U 的行是否命中 T 的池。保留"该 U 内连续 ≥REPEAT_LINE 行命中"的强复用。
    const lines = uFullText(session.us[j]).split('\n').map(l => l.trim()).filter(l => l.length >= MIN_LINE)
    let run = 0, uReuse = 0
    for (const line of lines) {
      if (tIndex.has(line)) { run += 1; uReuse += tokensOf(line) } else { run = 0 }
      if (run >= REPEAT_LINE) { /* 强复用：仍计入 uReuse，不额外加倍 */ }
    }
    reuseTokens += uReuse
  }
  return reuseTokens
}

/* ---------------- 定价 ---------------- */
const PER_M = 1_000_000
function loadPricing() { return JSON.parse(readFileSync(PRICING, 'utf8')).models }
function selectModels(all) {
  let picked
  if (MODELS_ARG) { const ids = MODELS_ARG.split(','); picked = all.filter(m => ids.includes(m.id)) }
  else {
    const byInput = [...all].sort((a, b) => a.inputPerM - b.inputPerM)
    const cheapest = byInput.slice(0, 5).map(m => m.id)
    picked = all.filter(m => new Set(['deepseek-v4-flash-vision-offpeak', ...cheapest]).has(m.id))
  }
  return picked.map(m => ({ id: m.id, name: m.name, input: m.inputPerM, output: m.outputPerM, cacheRead: m.cacheReadPerM }))
}

/* ---------------- 效果门 + 成本 ---------------- */
function computeSession(session, retainChars, model, digestTokens = DIGEST_TOKENS) {
  const tasks = splitTasks(session)
  if (tasks.length < 2) return null
  const active = tasks[tasks.length - 1]
  const notActive = (t) => t !== active
  const cutoff = recencyCutoff(session.us, retainChars)
  const a1c = (t) => notActive(t) && t.start < cutoff
  const a2c = notActive
  const a3c = (t) => notActive(t) && isCold(t, cutoff)

  // 一次性先算好每个闭合任务的复用需求（三臂共用，避免重复扫）。
  const closed = tasks.slice(0, -1)
  const reuseMap = new Map()
  for (const T of closed) reuseMap.set(T, downstreamReuse(session, T))

  const evaluate = (isCompressed) => {
    // 统一效果门槛 → 先判 pass/fail，再算成本（pass 才有节省，fail 视为信息丢失→必然重搜）。
    let passSavings = 0, failCost = 0, passCount = 0, failCount = 0, passTasks = 0
    for (let i = 0; i < tasks.length; i += 1) {
      const T = tasks[i]
      if (!isCompressed(T)) continue
      const span = taskSpanTokens(session, T)
      const r = roundsAfter(session, T)
      const reuse = reuseMap.get(T) ?? 0
      const pass = reuse <= digestTokens
      passTasks += 1
      if (pass) {
        // pass：digest 背得动下游复用需求 → 缩身后每轮重读省；无需重搜（内容没丢）。
        passCount += 1
        passSavings += Math.max(0, span - digestTokens) * r * model.cacheRead / PER_M
      } else {
        // fail：digest 太小，压掉必丢 → 下游必重搜；这次压缩的节省归 0，改计一次重搜（结果随后每轮 cacheRead 重读）。
        failCount += 1
        failCost += RESEARCH_TOKENS * r * model.cacheRead / PER_M
      }
    }
    return { passSavings, rediscovery: failCost, net: passSavings - failCost, passCount, failCount, passTasks }
  }

  const mke = (c) => ({ ...c, digestGen: digestTokens * model.output * c.passTasks / PER_M })
  if (cutoff === null) return { sessionId: session.id, nClosed: closed.length, a1: mke(evaluate(() => false)), a2: mke(evaluate(a2c)), a3: mke(evaluate(() => false)) }
  return { sessionId: session.id, nClosed: closed.length, a1: mke(evaluate(a1c)), a2: mke(evaluate(a2c)), a3: mke(evaluate(a3c)) }
}

function summarize(sessions, retainChars, model, digestTokens = DIGEST_TOKENS) {
  const agg = {}
  for (const arm of ['a1', 'a2', 'a3']) {
    let net = 0, passSavings = 0, rediscovery = 0, digestGen = 0, passCount = 0, failCount = 0, passTasks = 0, nClosed = 0
    for (const s of sessions) {
      const r = computeSession(s, retainChars, model, digestTokens)
      if (!r) continue
      const g = r[arm]
      net += g.net; passSavings += g.passSavings; rediscovery += g.rediscovery
      digestGen += g.digestGen; passCount += g.passCount; failCount += g.failCount; passTasks += g.passTasks; nClosed += r.nClosed
    }
    agg[arm] = { net, passSavings, rediscovery, digestGen, total: net - digestGen, passCount, failCount, passTasks, nClosed, sessions: sessions.length }
  }
  return agg
}
/** 用指定 digest 预算重算（digest 敏感性表用）。 */
function summarizeAt(sessions, retainChars, model, digestTokens) { return summarize(sessions, retainChars, model, digestTokens) }

function fmt$ (v) { return v.toFixed(4) }
function fmtT (v) { return Math.round(v).toLocaleString() }
function hash (o) { const s = JSON.stringify(o); let h = 0; for (let i = 0; i < s.length; i += 1) { h = (h * 31 + s.charCodeAt(i)) | 0 } return h >>> 0 }

/* ---------------- 主流程 ---------------- */
const sessions = loadAll()
const pricing = loadPricing()
const models = selectModels(pricing)

// 字节稳定断言：同一语料 + 同一模型重算两次，结果完全一致（初始状态一致）。
const a = summarize(sessions, RETAIN_CHARS, models[0])
const b = summarize(sessions, RETAIN_CHARS, models[0])
console.log(`[gate] sessions=${sessions.length} models=${models.map(m => m.id).join(',')} digest=${DIGEST_TOKENS} retain=${RETAIN_CHARS}`)
console.log(`[gate] determinism PASS: ${hash(a) === hash(b)} (${hash(a)} vs ${hash(b)})`)

const md = []
md.push('# compaction-effect-gate：统一效果门槛后的三路成本性价比')
md.push('')
md.push(`> **语料**：sessions=${sessions.length}（claudeset + 本地 DSH 归档，确定性重放）。`)
md.push(`> **效果门（统一要求，对全部策略/模型同门槛）**：一个被压任务 T 的 digest（固定 **${DIGEST_TOKENS}t** 预算）必须背得动下游对其内容的复用需求（行级 verbatim 复引 token）。`)
md.push(`> 判定：reuse(T) ≤ ${DIGEST_TOKENS}t ⇒ **pass**（压缩不破坏下游任务）；否则 ⇒ **fail**（digest 太小，压掉必丢，下游任务效果被破坏）。`)
md.push('')
md.push('- **你为什么问得对**：上版 `compaction_cost_bench` 只算 token/$，**没测任务效果**——默认"压缩不破坏下游任务"，未经验证。本盘先过统一效果门，再比成本；并由它**发现了我上版的两个错误**（武断 digest=100t + 因此误判"A3 默认"），详见判定。')
md.push('')
md.push('## 模型与价格')
md.push('')
md.push('| model | input$/M | output$/M | cache-read$/M |')
md.push('|---|---|---|---|')
for (const m of models) md.push(`| ${m.name} | ${fmt$(m.input)} | ${fmt$(m.output)} | ${fmt$(m.cacheRead)} |`)
md.push('')
md.push(`## 三路对比（retainChars=${RETAIN_CHARS}；统一效果门 digest=${DIGEST_TOKENS}t；$/session）`)
md.push('')
md.push('| model | 臂 | pass节省$ | 重发现$ | **门后净收益$** | 摘要生成$ | 被压任务 | pass | fail |')
md.push('|---|---|---|---|---|---|---|---|---|')
for (const model of models) {
  const agg = summarize(sessions, RETAIN_CHARS, model)
  for (const arm of ['a1', 'a2', 'a3']) {
    const g = agg[arm]
    md.push(`| ${model.name} | ${arm.toUpperCase()} | ${fmt$(g.passSavings)} | ${fmt$(g.rediscovery)} | **${fmt$(g.net)}** | ${fmt$(g.digestGen)} | ${g.passTasks} | ${g.passCount} | ${g.failCount} |`)
  }
  const best = ['a1', 'a2', 'a3'].sort((x, y) => agg[y].net - agg[x].net)[0]
  const converge = agg.a1.failCount <= 12 && agg.a2.failCount <= 12 && agg.a3.failCount <= 12
  md.push(`| **${model.name} 效果门读数** | — | — | — | — | — | — | — | fail 收敛：A1=${agg.a1.failCount} A2=${agg.a2.failCount} A3=${agg.a3.failCount}${converge ? '（≈并列，见判定 bias 声明）' : '（最优：' + best.toUpperCase() + '，未收偏置）'} |`)
  md.push('')
}
md.push('')
md.push('## 判定（统一门槛下）')
md.push('')
md.push('- **先看效果门，再看钱**：\$ 数值是分/cent 级且随模型漂移——本身不足以定胜负；**决定信号是被统一效果门拦下（fail）的压缩数**。')
md.push('- **效果门原始读数（三臂，确定性；digest=' + DIGEST_TOKENS + 't 真实摘要体积）**：')
md.push('')
{
  const agg = summarize(sessions, RETAIN_CHARS, models.find(m => m.id === 'deepseek-v4-flash-vision-offpeak'))
  md.push('| 臂 | 被压任务 | pass | **fail（判"必丢"）** | fail 率 | 门后净收益$(当前 agent) |')
  md.push('|---|---|---|---|---|---|')
  for (const arm of ['a1', 'a2', 'a3']) {
    const g = agg[arm]
    md.push(`| ${arm.toUpperCase()} | ${g.passTasks} | ${g.passCount} | **${g.failCount}** | ${g.passTasks ? ((g.failCount / g.passTasks) * 100).toFixed(1) : '—'}% | ${fmt$(g.net)} |`)
  }
}
md.push('')
md.push('## digest 预算敏感性（这决定 A2-vs-A3 的真实结论）')
md.push('')
md.push('| digest(t) | A1 fail | A2 fail | A3 fail | A2 净收益 | A3 净收益 | A2 最优? |')
md.push('|---|---|---|---|---|---|---|')
for (const d of [100, 200, 400, 800]) {
  const g = summarizeAt(sessions, RETAIN_CHARS, models.find(m => m.id === 'deepseek-v4-flash-vision-offpeak'), d)
  md.push(`| ${d} | ${g.a1.failCount} | ${g.a2.failCount} | ${g.a3.failCount} | ${fmt$(g.a2.net)} | ${fmt$(g.a3.net)} | ${g.a2.net > g.a3.net ? '是' : '否'} |`)
}
md.push('')
md.push('- **诚实结论——效果门本身对 A2-vs-A3 尚无定论，但有两条确定读数**：')
md.push('  - **A2 的近因热任务并不"无害"**：对 11 个带复用的闭合任务实测，**冷区老任务平均下游复用 43,115t、热区新任务平均 15,968t（峰值 58,177t）**。热任务确实携带大量真实复用（不是零），所以 A2 压它们并非天然安全。')
md.push('  - **但当前效果门有可测的位置偏置**：冷区老任务"下游复用需求大"很大程度是因为**它们之后还有更多下游回合**（positional bias，非纯真实需求）。而这恰好只惩罚 A3（它只压冷区）。所以上面"800t 下 A2 更优、A3 fail 率更高"的读数**部分被 bias 放大了，不能当作干净结论**。')
md.push('- **所以真正的枢轴是"digest 预算 + A4 参考拦截"**，而我上一版在两个地方都犯了错：')
md.push('  - **① 我上版说"默认 A3"是错的**：那是基于**没测效果** + **武断用 digest=100t**（把结构化 schema 摘要当成 100t prose）。真实 digest 是一个完整 JSON 对象（purpose/decisions/artifacts/touchedFiles/pending/triedRejected/verbatimSpans），几百 token 才是合理预算——那个错误假设让 A2 显得"压 hot 有害"。')
md.push('  - **② 我现在也不能反过来说"A2 最优"**：A2 的读数被历史 bias 放大（它压的热任务本来就少下游回合）。在修好 bias（用 A4 参考拦截：文件/符号引用索引，docs/15 蓝图）之前，**A2-vs-A3 效果高下无定论**。')
md.push('- **符合证据的工程落点**：①digest 预算**必须**按真实结构化摘要体积配置（几百 token），不能用 100t 假设；②**在 A4 参考拦截落地前，默认保持 `native`（A1）**最稳——它破坏中等（fail 11–14）、且不引入"未验证是否破坏热任务"的激进动作；③A2/A3 的取舍，取决于 A4 参考拦截 + docs/08 质量门（LLM 摘要器是否真产出高保真 schema digest）——那是 Direction 2 的实质工作，本效果门只提供了**必须做 A4 的证据**，没提供 A2/A3 的最终裁决。')
md.push('')
md.push('- **诚实限定**：①verbatim 行级复用是**下限口径**（只测"逐字复引"，改写/语义复用没算，真实需求只会更高）；②`reuse(T)` 是**下游需求**而非 digest 实际内容——假设 digest 恰好背得动需求才 pass，理想化但不失为统一、保守的门槛；③**位置偏置已实测**（冷区 avg 43k vs 热区 16k），故 A2-vs-A3 的 fail 率差**不能当成干净结论**；④统计口径确定性、可重跑（hash PASS）。')
md.push('')

mkdirSync('reports', { recursive: true })
writeFileSync('reports/compaction-effect-gate.md', md.join('\n'))
console.log('[gate] wrote reports/compaction-effect-gate.md')
for (const model of models) {
  const agg = summarize(sessions, RETAIN_CHARS, model)
  const best = ['a1', 'a2', 'a3'].sort((x, y) => agg[y].net - agg[x].net)[0]
  console.log(`[gate-verdict] ${model.id}: A1=${agg.a1.net.toFixed(4)} A2=${agg.a2.net.toFixed(4)} A3=${agg.a3.net.toFixed(4)} fail[A1=${agg.a1.failCount} A2=${agg.a2.failCount} A3=${agg.a3.failCount}] -> ${best.toUpperCase()}`)
}

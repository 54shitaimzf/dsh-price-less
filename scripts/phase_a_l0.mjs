/**
 * phase_a：判别器方案 L0 规则的真实语料安全性与覆盖率统计（Step 0：先统计、后固化）。
 *
 * 预注册口径（判别器方案验收前的第一步）：
 *   - L0-continue：消息去空白/标点后整体 ∈ 延续词表 → 判定 continue（零调用）
 *   - L0-new_task：显式发起句式（帮我…/开始做…/新任务…/plan 声明）或 /task → 判定 new_task（零调用）
 *   - 其余 → LLM 判别待判（Phase B 覆盖）
 * 安全约束：
 *   - 翻转泄漏 = GT 翻转 U 被 L0-continue 拦截的条数，必须 = 0
 *   - L0-new_task 一致率（u≥1 命中 ∩ coarse / 命中）> 95%
 *   - 单意图会话 L0-new_task 误开（u≥1）< 10%
 * 输出：reports/phase-a-l0.md（会话级表 + 汇总 + 违规明细）
 * 运行：node scripts/phase_a_l0.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { canonicalizeClaudeset, canonicalizeDsh, loadClaudesetLabels, loadDshLabels, loadLabelsJson } from './mech_replay.mjs'

/* ================= 数据加载（与 probe24 同源） ================= */

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

/* ================= L0 规则（保守 v1，待统计固化） ================= */

/** 去空白与标点（Unicode 属性扫描——禁 re 属性但允许 \p{P}；node ≥16 支持）。 */
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

/** L0-continue：整条消息去掉空白标点后 = 一个延续词（含标点变体）。 */
function l0Continue(text) {
  const s = strip(text)
  if (s.length === 0) return false
  return CONTINUE_WORDS.has(s)
}

const INIT_VERBS = [
  '写', '做', '改', '建', '看', '查', '转', '生成', '整理', '分析', '测试', '部署', '修复', '实现', '设计',
  '翻译', '总结', '解释', '计算', '找', '创建', '移除', '删除', '更新', '重构', '配置', '安装', '研究', '读',
  '答', '解决', '优化', '调试', '发布', '打包', '审阅', '审查', '评估', '验证', '维护', '导出', '导入',
  '备份', '清理', '构建', '启动', '停止', '调整', '补充', '对比', '比较', '确认', '检查',
]
const INIT_PREFIXES = [
  '帮我', '请帮我', '麻烦帮我', '帮忙', '请', '帮我一下', '帮我个忙',
]
const INIT_LEADS = [
  '开始做', '开始写', '开始搞', '开始', '新任务', '新目标', '现在开始', '我们来做', '我们开始',
  '我们来', '计划是', '计划：', '计划:', '接下来我们', '重新开始', '从头开始',
]
const INIT_VERBS_RE = new RegExp(`^(?:${INIT_PREFIXES.join('|')})(?:${INIT_VERBS.join('|')})(?:一下|个|份|遍|一个|一份|一遍)?(?:的|好)?`)
const INIT_LEADS_RE = new RegExp(`^(?:${INIT_LEADS.join('|')})`)

/** L0-new_task：显式发起句式（帮我X…/开始做…/新任务…/计划：…）或 /task；要求剩余内容 ≥2 字。 */
function l0NewTask(text) {
  if (/^\s*\/task\b/.test(text)) return true
  const t = text.trim()
  if (t.length < 5) return false
  let rest = ''
  if (INIT_VERBS_RE.test(t)) {
    const m = t.match(INIT_VERBS_RE)
    rest = t.slice(m[0].length)
  } else if (INIT_LEADS_RE.test(t)) {
    const m = t.match(INIT_LEADS_RE)
    rest = t.slice(m[0].length)
  } else {
    return false
  }
  const s = strip(rest)
  return s.length >= 2
}

/* ================= 统计 ================= */

const sessions = loadAll()

/** 翻转消息形态抽样（为什么 L0 抓不到的取证：真实翻转带不带显式发起句式）。 */
const flipSamples = []
for (const s of sessions) {
  if (s.single) continue
  for (const u of s.gt.coarse) {
    if (u === 0) continue
    const um = s.us[u]
    if (!um) continue
    const t = um.text.trim()
    if (t.length === 0) continue
    flipSamples.push({ id: s.id, u, text: t.slice(0, 140), hit: l0NewTask(t) || l0Continue(t) })
  }
}

const report = []
report.push('# Phase A：L0 规则真实语料统计（判别器方案 Step 0）')
report.push('')
report.push('> 预注册口径：L0-continue（延续词整体匹配，判 continue）/ L0-new_task（显式发起句式，判 new_task）')
report.push('> 安全约束：翻转泄漏=0；L0-new_task 一致率>95%（u≥1）；单意图误开<10%。')
report.push('')

let totalU = 0, totalC = 0, totalN = 0, totalLlm = 0
let leak = 0, leakRows = []
let nHit = 0, nHitCorrect = 0, nCoarse = 0, nCoarseCaught = 0
let singleOpen = 0, singleOpenRows = []
const rows = []

for (const s of sessions) {
  const coarse = new Set(s.gt.coarse)
  let c = 0, n = 0, llm = 0
  let leakHere = 0
  let nHereHit = 0, nHereCorrect = 0
  for (const um of s.us) {
    if (um.u === 0) continue // 首条 = 隐式开段，不进 L0 判别评价空间
    let verdict = 'llm'
    if (l0Continue(um.text)) verdict = 'continue'
    else if (l0NewTask(um.text)) verdict = 'new_task'
    if (verdict === 'continue') {
      c++
      if (coarse.has(um.u)) { leak++; leakHere++; leakRows.push({ id: s.id, u: um.u, text: um.text }) }
    } else if (verdict === 'new_task') {
      n++
      nHereHit++
      if (coarse.has(um.u)) nHereCorrect++
      if (s.single) { singleOpen++; singleOpenRows.push({ id: s.id, u: um.u, text: um.text }) }
    } else {
      llm++
    }
  }
  if (s.single) {
    // 单意图会话：无 coarse；L0-new_task 命中即误开（已计入 singleOpen）
    rows.push([s.id, s.proj ?? '', 'single', s.us.length - 1, c, n, llm, 0, '-', '-', nHereCorrect])
  } else {
    const coarseArr = [...coarse].filter(u => u !== 0)
    nCoarse += coarseArr.length
    nCoarseCaught += coarseArr.filter(u => !l0Continue(s.us[u]?.text ?? '') && l0NewTask(s.us[u]?.text ?? '')).length
    rows.push([s.id, s.proj ?? '', 'multi', s.us.length - 1, c, n, llm, coarseArr.length,
      nHereHit > 0 ? (nHereCorrect / nHereHit).toFixed(3) : '-',
      nHereCorrect, '-'])
  }
  totalU += s.us.length - 1
  totalC += c
  totalN += n
  totalLlm += llm
  nHit += nHereHit
  nHitCorrect += nHereCorrect
}

const interceptRate = totalU > 0 ? (totalC + totalN) / totalU : 0
const llmRate = totalU > 0 ? totalLlm / totalU : 0
const precision = nHit > 0 ? nHitCorrect / nHit : 0
const coarseCaughtRate = nCoarse > 0 ? nCoarseCaught / nCoarse : 0

report.push('## 1. 会话级统计')
report.push('')
report.push('| 会话 | 项目 | 类型 | U(≥1) | L0-cont | L0-new | LLM 待判 | GT 翻转 | L0-new 精度 | L0-new 正确命中 | 单意图误开 |')
report.push('|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows) report.push(`| ${r.join(' | ')} |`)
report.push('')
report.push('## 2. 汇总')
report.push('')
report.push(`- 消息总数（u≥1）：${totalU}`)
report.push(`- L0-continue 拦截：${totalC}（${(totalC / totalU * 100).toFixed(1)}%）`)
report.push(`- L0-new_task 拦截：${totalN}（${(totalN / totalU * 100).toFixed(1)}%）`)
report.push(`- **L0 总拦截率：${(interceptRate * 100).toFixed(1)}%**；LLM 待判：${totalLlm}（${(llmRate * 100).toFixed(1)}%）`)
report.push(`- **翻转泄漏（GT∩L0-continue）：${leak}**（要求 = 0）`)
report.push(`- L0-new_task 精度（命中∩GT / 命中）：${(precision * 100).toFixed(1)}%（要求 >95%）`)
report.push(`- GT 翻转被 L0-new_task 直接抓到：${nCoarseCaught}/${nCoarse}（${(coarseCaughtRate * 100).toFixed(1)}%，= 显式发起翻转占比；其余留给 LLM）`)
report.push(`- 单意图误开（L0-new_task 命中单意图会话）：${singleOpen}/${totalN}（要求 <10%）`)
report.push('')
if (leakRows.length > 0) {
  report.push('## 3. 泄漏明细（违规：翻转被 L0-continue 拦截）')
  report.push('')
  for (const r of leakRows) report.push(`- ${r.id} u=${r.u}：${r.text.slice(0, 120)}`)
  report.push('')
}
if (singleOpenRows.length > 0) {
  report.push('## 4. 单意图误开明细')
  report.push('')
  for (const r of singleOpenRows) report.push(`- ${r.id} u=${r.u}：${r.text.slice(0, 120)}`)
  report.push('')
}
report.push('## 5. 翻转消息形态抽样（GT 翻转的真实文本——L0 抓不到的取证，最多 12 条）')
report.push('')
for (const r of flipSamples.slice(0, 12)) {
  report.push(`- ${r.id} u=${r.u}${r.hit ? ' [L0命中]' : ''}：${r.text}`)
}
report.push('')
report.push('## 6. 门限判定')
report.push('')
report.push(`- 翻转泄漏 = 0：${leak === 0 ? 'PASS' : 'FAIL'}`)
report.push(`- L0-new_task 精度 > 95%：${precision > 0.95 ? 'PASS' : 'FAIL'}`)
report.push(`- 单意图误开 < 10%：${singleOpen / Math.max(totalN, 1) < 0.1 ? 'PASS' : 'FAIL'}`)

writeFileSync('reports/phase-a-l0.md', report.join('\n'))
console.log(report.join('\n'))
console.log('\nsaved reports/phase-a-l0.md')
/**
 * Batch report — the end-of-batch deliverable (approved plan §5/§7):
 * per task×arm table (mech/judge/total/Δ vs its baseline arm), three-ledger
 * costs, budget spend, and the PRE-REGISTERED hypothesis checklist filled with
 * expected vs observed direction.
 *
 *   node scripts/batch-report.mjs [--runs=runs/T3-armA-*,runs/T3-armB-*]
 *                                 [--out=runs/batch-report.md]
 * Without --runs it scans every run in runs/ and groups by arm.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNS_DIR } from '../lib/paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v ?? true]
}))

// pre-registered hypotheses (bedrock from design-e1e3.md, X-series)
const HYPOTHESES = [
  ['V1', '前缀缓存', '网关对稳定前缀返回 cacheRead；trim 后前缀更短', ''],
  ['V2', '产物结构', '结构化分段（obj-P/anchor）≥ 平铺（single）', ''],
  ['V3', '压缩策略', '语义压缩在完成度不降前提下优于截断与全量', ''],
  ['X-A', '位置效应', 'tail ≥ head > mid（lost-in-the-middle + 近因）', ''],
  ['X-B', '噪声鲁棒', '完成度随噪声单调降；压缩删噪收益超线性（相对等长无压缩）', ''],
  ['X-C', '指代与源标注', 'full-anchor ≥ natural+source > aggressive；源标注降引用类失败', ''],
  ['X-D', '检索式注入', '长任务省成本完成度不降；短任务被轮次开销抵消', ''],
  ['X-E', '锚定双重角色', 'structural+semantic 复合 > semantic-only > none', ''],
  ['E3', '机制级比价', 'self 完成度持平或更高且总成本 < full/manual/industry 口径', ''],
]

function loadScorecards() {
  const out = []
  if (args.runs) {
    for (const g of args.runs.split(',')) {
      const match = g.includes('*')
        ? fs.readdirSync(RUNS_DIR).filter(d => d.startsWith(g.replace('*', '')))
        : [g]
      for (const m of match) {
        const f = path.join(RUNS_DIR, m, 'scorecard.json')
        if (fs.existsSync(f)) out.push(JSON.parse(fs.readFileSync(f, 'utf8')))
      }
    }
    return out
  }
  for (const d of fs.readdirSync(RUNS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const f = path.join(RUNS_DIR, d.name, 'scorecard.json')
    if (fs.existsSync(f)) out.push(JSON.parse(fs.readFileSync(f, 'utf8')))
  }
  return out
}

const scs = loadScorecards()
if (scs.length === 0) { console.error('no scorecards found'); process.exit(1) }

const tasks = [...new Set(scs.map(s => s.task))].sort()
const lines = ['# 批次报告（Batch Report）', '', `- runs: ${scs.length} | tasks: ${tasks.join(', ')}`, '']

let totalExec = 0, totalJudge = 0, totalComp = 0
for (const task of tasks) {
  const rows = scs.filter(s => s.task === task)
  const baseline = rows.find(r => r.arm === 'native-auto') ?? rows[0]
  lines.push(`## ${task}`, '', '| arm | total | mech | judge | 完成 | Δ | 成本(exec/judge/comp) |', '|---|---|---|---|---|---|---|')
  for (const r of rows) {
    totalExec += r.costs?.execution?.usd ?? 0
    totalJudge += r.costs?.judge?.usd ?? 0
    totalComp += r.costs?.compression?.usd ?? 0
    const d = baseline && r.arm !== baseline.arm && typeof baseline.total === 'number'
      ? `Δ ${r.total - baseline.total >= 0 ? '+' : ''}${r.total - baseline.total}` : ''
    const c = r.costs
    const costStr = `${(c?.execution?.usd ?? 0).toFixed(6)}/${(c?.judge?.usd ?? 0).toFixed(6)}/${(c?.compression?.usd ?? 0).toFixed(6)}`
    lines.push(`| ${r.arm} | ${r.total} | ${r.mech.score} | ${r.judge.score ?? '—'} | ${r.finished ? '✓' : '✗'} | ${d} | $${costStr} |`)
  }
  lines.push('')
}

lines.push('## 三账本成本合计', '', `- 执行(execution): $${totalExec.toFixed(8)}`)
lines.push(`- 盲评(judge): $${totalJudge.toFixed(8)}`)
lines.push(`- 压缩(compression): $${totalComp.toFixed(8)}`)
lines.push(`- 决策(decision): $0（E3 路由落地前恒 0）`, '')

lines.push('## 预注册假设对照（预期 vs 实测）', '', '| 变量 | 主题 | 预期 | 实测 |', '|---|---|---|---|')
for (const [id, theme, expected, got] of HYPOTHESES) {
  lines.push(`| ${id} | ${theme} | ${expected} | ${got || '（待批次数据填写）'} |`)
}
lines.push('', '> 结论只做相对（同模型同提示词臂间 Δ）；derived 估算仅参考不进入结论。', '')

const outPath = path.resolve(ROOT, args.out ?? path.join(RUNS_DIR, 'batch-report.md'))
fs.writeFileSync(outPath, lines.join('\n'))
console.log(`batch report: ${outPath}`)
console.log(`spend: exec=$${totalExec.toFixed(8)} judge=$${totalJudge.toFixed(8)} comp=$${totalComp.toFixed(8)}`)
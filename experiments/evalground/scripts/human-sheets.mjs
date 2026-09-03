/**
 * human-sheets: gather every human review CSV + evidence into one directory.
 *   node scripts/human-sheets.mjs            → human-sheets/ (recreated)
 *   node scripts/human-sheets.mjs --open     → also opens the folder
 * Everything needed for the (only) human step in one place.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { HUMAN_DIM_ANCHORS } from '../lib/human-packet.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const RUNS = path.join(ROOT, 'runs')
const OUT = path.join(ROOT, 'human-sheets')

if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const runs = fs.readdirSync(RUNS, { withFileTypes: true })
  .filter(e => e.isDirectory() && e.name.match(/^T\d+-/))
  .sort()
let n = 0
const sheets = []
for (const e of runs) {
  const dir = path.join(RUNS, e.name)
  const csv = path.join(dir, 'human-sheet.csv')
  if (!fs.existsSync(csv)) continue
  const taskId = e.name.slice(0, 2)
  const target = path.join(OUT, `${taskId}-${e.name}.csv`)
  // normalize the header to the absolute 0–5 scale (old sheets wrote -2..+2)
  const text = fs.readFileSync(csv, 'utf8')
  const normalized = text.replace(/score\(-2\.\.\+2 vs baseline\)/, 'score(0..5 absolute)')
  fs.writeFileSync(target, normalized)
  // evidence (screenshots / text snapshots)
  const ev = path.join(dir, 'human-evidence')
  if (fs.existsSync(ev)) {
    const evOut = path.join(OUT, `${taskId}-evidence`)
    fs.cpSync(ev, evOut, { recursive: true })
  }
  sheets.push({ taskId, runDir: e.name, csv: path.basename(target) })
  n++
}

// ---- SCORING-GUIDE.md: explicit, reproducible evaluation criteria ----
const lines = [
  '# 审美评分指南（Human Aesthetics Scoring Guide）',
  '',
  '## 怎么评（先读这个）',
  '',
  '评分入口只有一个：**`npm run human:review`**（引导式会话，或 `-- --packet` 一页评审单批量过）。',
  '它会逐维度展示判据、锚点与证据（面板自动打开静态页、文档直接内联全文），',
  '你只需输入一个整数 0–5（评审单里直接点按钮）；结束后自动合并进分卡。本目录的 CSV **只是内部存储**，',
  '不需要你打开——Excel 打开它们太重了，请直接跑会话。大批量实验：`-- --packet` 出单页 → 打分 → 导出 JSON → `-- --import=` 合并。',
  '',
  '## 规则',
  '',
  '1. **绝对评分**：每一行都是**绝对档位 0–5**，不与任何基线、参考实现、其他 run 挂钩。',
  '   只按锚点文字评价当前产出本身。',
  '2. **档位**：`0` 无有效产出（不可用），`1` 存在但明显缺陷，`2` 可用但粗糙，',
  '   `3` 中规中矩（可接受），`4` 良好，`5` 专业水准。',
  '3. **不确定就填 3**（中规中矩），会话里输入 `u` 即可；不要填小数。',
  '4. 只想跳过某维度输入 `s`（保持待评），想中途退出输入 `q`（已答的保留）。',
  '5. 批量重评：`npm run human:review -- --force`。',
  '',
  '## 维度锚点',
  '',
]
for (const [dim, spec] of Object.entries(HUMAN_DIM_ANCHORS)) {
  lines.push(`### ${dim}`)
  lines.push('')
  lines.push(`**判据**：${spec.question}`)
  lines.push('')
  for (const b of ['0', '1', '2', '3', '4', '5']) {
    lines.push(`- **${b}**：${spec[b]}`)
  }
  lines.push('')
}
lines.push('## 待评任务')
lines.push('')
for (const s of sheets) {
  lines.push(`- \`${s.taskId}\`  run: ${s.runDir}（证据在 \`${s.taskId}-evidence/\`）`)
}
lines.push('')
lines.push('运行 `npm run human:review` 开始评分，或 `-- --dry` 先看清单。')
fs.writeFileSync(path.join(OUT, 'SCORING-GUIDE.md'), lines.join('\n'))

console.log(`gathered ${n} human sheets + evidence + SCORING-GUIDE.md into ${OUT}`)
const args = process.argv.slice(2)
if (args.includes('--open')) {
  execFile('explorer.exe', [OUT], (err) => { if (err) console.error('open failed:', err.message) })
} else {
  console.log('评分入口（无需打开 CSV）：npm run human:review')
}
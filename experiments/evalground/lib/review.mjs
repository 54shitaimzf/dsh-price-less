/**
 * Human review session — the ONLY human step of the eval ground, wrapped in
 * business logic instead of bare CSV chore:
 *
 *   node lib/review.mjs            review every pending human dimension
 *   node lib/review.mjs --task=T3  only that task
 *   node lib/review.mjs --run=SUB  only runs whose directory contains SUB
 *   node lib/review.mjs --force    also re-score already scored dimensions
 *   node lib/review.mjs --dry      list pending items without opening/writing
 *   node lib/review.mjs --packet   generate + open the one-page review packet
 *                                  (all runs inlined: panels rendered, docs in
 *                                  full text; export JSON → --import)
 *   node lib/review.mjs --packet --no-open       generate without opening
 *   node lib/review.mjs --import=scores.json     apply exported JSON in one pass
 * 
 * Interactive mode (no flags) asks dimension by dimension: 0–5 absolute, or
 * u(unsure→3)/s(skip)/q(quit). For large experiment batches the packet flow
 * is the fast path: one page, top→bottom, one export, one import.
 *
 * Per dimension it prints the task, weight, scoring structure and the anchor
 * bands, then SHOWS the evidence (staticified panel auto-opened in the
 * browser for T3/T7; full text inlined for documents), and asks for one
 * integer: 0–5 absolute, or u(unsure→3)/s(skip)/q(quit). Every answer is
 * written straight back into the run's human-sheet.csv; on exit all touched
 * runs are merged into their scorecards and human-sheets/ is re-gathered.
 * The user never opens a CSV — the CSV is internal storage only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import readline from 'node:readline/promises'
import { HUMAN_DIMS, HUMAN_DIM_ANCHORS } from './human-packet.mjs'
import { assemble, parseHumanCsv } from './score.mjs'
import { collectPendingRuns, writePacket } from './review-packet.mjs'

const EVAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNS_DIR = path.join(EVAL_ROOT, 'runs')
const CSV_HEADER = 'task,dim,name,weight,score(0..5 absolute),notes'

export function resolveInput(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  if (/^[0-5]$/.test(v)) return { kind: 'score', value: Number(v) }
  if (v === 'u' || v === '?') return { kind: 'unsure' }
  if (v === 's') return { kind: 'skip' }
  if (v === 'q') return { kind: 'quit' }
  return null
}

/** Rewrite one run's human-sheet.csv keeping header and other rows. */
export function applyScore(csvPath, taskId, dim, value, notes = '') {
  const existing = fs.existsSync(csvPath) ? fs.readFileSync(csvPath, 'utf8').split(/\r?\n/) : [CSV_HEADER]
  const header = existing[0].includes('score') ? existing[0] : CSV_HEADER
  const rows = existing.slice(1).filter(Boolean).filter(row => !row.startsWith(`${taskId},${dim},`))
  const name = HUMAN_DIMS[taskId]?.find(d => d.dim === dim)?.name ?? dim
  const weight = HUMAN_DIMS[taskId]?.find(d => d.dim === dim)?.weight ?? 0
  const line = `${taskId},${dim},"${name}",${weight},${value},${notes}`
  fs.writeFileSync(csvPath, [header, ...rows, line].join('\n') + '\n')
  return line
}

function openPath(p) {
  const run = process.platform === 'win32'
    ? { cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', p] }
    : process.platform === 'darwin'
      ? { cmd: 'open', args: [p] }
      : { cmd: 'xdg-open', args: [p] }
  execFile(run.cmd, run.args, () => {})
}

function printEvidence(runDir, taskId) {
  const evDir = path.join(runDir, 'human-evidence')
  if (!fs.existsSync(evDir)) { console.log('（无证据目录）'); return }
  const files = fs.readdirSync(evDir).sort()
  // panel tasks: open the static page if present — the reviewer judges the
  // real render, not code
  if ((taskId === 'T3' || taskId === 'T7') && files.includes('panel-static.html')) {
    const p = path.join(evDir, 'panel-static.html')
    console.log(`📄 已打开面板：${p}`)
    openPath(p)
  }
  // text evidence: inline the full content — no file juggling needed
  for (const f of files) {
    if (!/\.(md|txt)$/.test(f)) continue
    const p = path.join(evDir, f)
    const text = fs.readFileSync(p, 'utf8')
    const lines = text.split(/\r?\n/).length
    console.log(`\n--- 证据：${f}（${lines} 行）---`)
    console.log(text.trimEnd())
    console.log(`--- 证据结束：${f} ---`)
  }
  const others = files.filter(f => !/\.(md|txt|png|html)$/.test(f))
  if (others.length) console.log(`（另有：${others.join('、')} —— 在 ${evDir}）`)
}

async function reviewOnce(rl, runDir, task, dim, force) {
  const spec = HUMAN_DIM_ANCHORS[dim.dim]
  const csvPath = path.join(runDir, 'human-sheet.csv')
  const existing = parseHumanCsv(csvPath)?.find(r => r.task === task.id && r.dim === dim.dim)

  console.log('\n' + '='.repeat(64))
  console.log(`任务 ${task.id}：${task.title}    run: ${path.basename(runDir)}`)
  console.log(`维度：${dim.name}    权重 ${dim.weight}%`)
  const t = task.track ?? {}
  console.log(`评分结构：机械 ${t.mech ?? 0} / 评审 ${t.judge ?? 0} / 人工 ${t.human ?? 0}`)
  console.log('-'.repeat(64))
  const anchors = spec ?? {}
  console.log(`判据：${anchors.question ?? dim.dim}`)
  for (const b of ['0', '1', '2', '3', '4', '5']) console.log(`  ${b}  ${anchors[b] ?? ''}`)
  if (existing && !force) {
    console.log(`已评：${existing.delta}（--force 可重评）`)
    return null
  }
  console.log('-'.repeat(64))
  printEvidence(runDir, task.id)

  while (true) {
    const raw = await rl.question('\n▶ 分数 0-5 / u=不确定(记3) / s=跳过 / q=退出保存: ')
    const parsed = resolveInput(raw)
    if (parsed === null) { console.log('无效输入（0-5 或 u/s/q），再试：'); continue }
    if (parsed.kind === 'quit') return { quit: true }
    if (parsed.kind === 'skip') { console.log('已跳过（该维度保持待评）'); return null }
    const value = parsed.kind === 'unsure' ? 3 : parsed.value
    const notes = parsed.kind === 'unsure' ? 'unsure' : ''
    applyScore(csvPath, task.id, dim.dim, value, notes)
    console.log(`已记录 ${task.id} · ${dim.dim} = ${value}${notes ? '（不确定）' : ''}`)
    return { value }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const onlyTask = args.find(a => a.startsWith('--task='))?.slice(7)
  const onlyRun = args.find(a => a.startsWith('--run='))?.slice(6)
  const force = args.includes('--force')
  const dry = args.includes('--dry')

  const runs = collectPendingRuns(RUNS_DIR, { onlyTask, onlyRun, force })

  if (runs.length === 0) {
    console.log('没有待评维度（humanPending 全部已合并；--force 可重评）')
    return
  }

  // ---- one-page packet flow (batch experiments) ----
  if (args.includes('--packet')) {
    const out = path.join(EVAL_ROOT, 'review-packet.html')
    writePacket(runs, out)
    console.log(`评审单已生成：${out}`)
    if (!args.includes('--no-open')) openPath(out)
    console.log('打开页面后：按块打分（0–5 / ?=不确定记3 / 跳过不选）→ 顶部「导出评分 JSON」')
    console.log('把 human-scores.json 放到本目录后运行：npm run human:review -- --import=human-scores.json')
    return
  }

  const importArg = args.find(a => a.startsWith('--import='))
  if (importArg) {
    // full universe (force) so already-merged runs from earlier sessions also land
    const all = collectPendingRuns(RUNS_DIR, { force: true })
    await handleImport(importArg.slice(9), all)
    return
  }

  if (dry) {
    console.log('待评清单（--dry，不打开/不写入）：\n')
    for (const r of runs) {
      for (const dim of r.dims) {
        const evDir = path.join(r.runDir, 'human-evidence')
        const has = fs.existsSync(evDir) ? fs.readdirSync(evDir).join(', ') : '(无)'
        console.log(`${r.sc.task} · ${dim.dim}（${dim.name}，权重 ${dim.weight}）  run: ${r.name}`)
        console.log(`   证据：${has}\n`)
      }
    }
    return
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const touched = []
  let quit = false
  for (const r of runs) {
    if (quit) break
    for (const dim of r.dims) {
      const out = await reviewOnce(rl, r.runDir, r.task, dim, force)
      if (out?.quit) { quit = true; break }
      if (out?.value !== undefined) touched.push(r)
    }
  }
  rl.close()

  mergeTouchedRuns(touched)
  printSummary(runs, quit)
}

/** Merge every touched run's human rows into its scorecard. */
function mergeTouchedRuns(touched) {
  if (touched.length === 0) return false
  for (const r of touched) {
    const rows = parseHumanCsv(path.join(r.runDir, 'human-sheet.csv')) ?? []
    const merged = assemble(r.task, r.sc.mech, r.sc.judge, rows, r.sc.penalties ?? [])
    r.sc.total = merged.total
    r.sc.human = merged.human
    r.sc.humanPending = merged.humanPending
    r.sc.humanRows = rows
    fs.writeFileSync(path.join(r.runDir, 'scorecard.json'), JSON.stringify(r.sc, null, 2))
  }
  // re-gather the archive so human-sheets/ mirrors the session
  execFile(process.execPath, [path.join(EVAL_ROOT, 'scripts', 'human-sheets.mjs')], { cwd: EVAL_ROOT }, () => {})
  return true
}

function printSummary(runs, quit = false) {
  console.log('\n' + '='.repeat(64))
  console.log('汇总（合并后）')
  for (const r of runs) {
    const sc = JSON.parse(fs.readFileSync(path.join(r.runDir, 'scorecard.json'), 'utf8'))
    for (const dim of r.dims) {
      const row = sc.humanRows?.find(x => x.dim === dim.dim)
      const mark = row ? String(row.delta) + (row.notes === 'unsure' ? '(不确定)' : '') : sc.humanPending ? '—' : '-'
      console.log(`  ${r.sc.task} · ${dim.dim.padEnd(18)} 人工=${mark}  total=${sc.total}${sc.humanPending ? '（人工待评）' : ''}`)
    }
  }
  if (quit) console.log('\n已中途保存退出；未评维度保持待评，下次运行继续。')
}

/** Apply one exported packet JSON (array of {run,task,dim,score,notes}). */
export async function handleImport(jsonPath, knownRuns) {
  const file = path.resolve(EVAL_ROOT, jsonPath)
  if (!fs.existsSync(file)) { console.error(`找不到 ${file}`); process.exit(1) }
  let items
  try {
    items = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) { console.error('评分 JSON 解析失败:', e.message); process.exit(1) }
  if (!Array.isArray(items) || items.length === 0) { console.error('评分 JSON 应为非空数组'); process.exit(1) }

  const touched = []
  const bad = []
  for (const it of items) {
    const sc = knownRuns.find(r => r.name === it.run)?.sc
    const dims = (HUMAN_DIMS[it.task] ?? []).map(d => d.dim)
    if (!sc || sc.task !== it.task) { bad.push(`${it.run}→${it.task}: run/task 不匹配`); continue }
    if (!dims.includes(it.dim)) { bad.push(`${it.run}·${it.dim}: 该任务无此维度`); continue }
    if (!Number.isInteger(it.score) || it.score < 0 || it.score > 5) { bad.push(`${it.run}·${it.dim}: score 须为 0-5 整数（${it.score}）`); continue }
    const r = knownRuns.find(x => x.name === it.run)
    applyScore(path.join(r.runDir, 'human-sheet.csv'), it.task, it.dim, it.score, it.notes === 'unsure' ? 'unsure' : '')
    if (!touched.includes(r)) touched.push(r)
  }
  for (const b of bad) console.error(`✗ 跳过：${b}`)
  if (touched.length === 0) { console.error('没有可应用的评分项'); process.exit(1) }
  mergeTouchedRuns(touched)
  printSummary(touched, false)
  console.log(`\n已导入 ${items.length - bad.length} 条评分（跳过 ${bad.length} 条）。`)
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isCli) main().catch(err => { console.error(err); process.exit(1) })
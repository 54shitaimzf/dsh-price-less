/**
 * Mechanical scoring: runs the pristine test subset, acceptance checks,
 * scope/diff checks and the anti-cheat scan. Never trusts the model's claims.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { collectDiff, FIXTURE_DIR, EVAL_ROOT } from './workspace.mjs'
import { ALLOW, inScope } from './allow.mjs'

export function runNodeTest(workspace, files) {
  return new Promise((resolve) => {
    const norm = Array.isArray(files) ? files : [files]
    const args = ['--test', '--test-isolation=none']
    args.push(...norm.map(f => f.startsWith('tests/') ? f : `tests/${f}`))
    execFile(process.execPath, args, { cwd: workspace, timeout: 180000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}\n${stderr ?? ''}`
      const m = out.match(/ℹ (?:pass|fail) (\d+)/g) ?? []
      const pass = Number(m[0]?.match(/\d+/)?.[0] ?? 0)
      const fail = Number(m[1]?.match(/\d+/)?.[0] ?? 0)
      resolve({ exit: err === null ? 0 : (err.code ?? 1), pass, fail, output: out.slice(0, 6000) })
    })
  })
}

function readWorkspace(workspace, rel) {
  const file = path.join(workspace, rel)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

function countMatches(text, re) {
  return [...String(text).matchAll(re)].length
}

function wordCount(text) {
  return [...String(text).matchAll(/[\u4e00-\u9fff]|[A-Za-z0-9]+/g)].length
}

/** Parse golden-bugs.json once. */
export function loadGoldenBugs() {
  return JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, 'answers', 'golden-bugs.json'), 'utf8'))
}

/** 归属账：从任务窗口 transcript 的 tool/write 事件提取"这个任务实际写过哪些文件"
 *（相对路径，去 ./、\\→/）。级联共享工作区时全局 diff 会把先前任务的改动算进当前
 * 任务 → scope/readonly/tamper 检查全部错乱；written 集合就是"动过就算"的单一事实源
 *（collectDiff 只在无归属传入时作单任务兼容回退）。 */
export function writtenPathsOf(entries) {
  const out = new Set()
  for (const e of entries ?? []) {
    if (e?.type === 'tool' && e.tool === 'write' && e.arg && typeof e.arg.path === 'string') {
      const rel = String(e.arg.path).replace(/^\.\//, '').replace(/\\/g, '/')
      if (rel.trim().length > 0) out.add(rel)
    }
  }
  return [...out]
}

/** Golden-bug matching for T1 REVIEW.md. */
export function matchReview(workspace) {
  const review = readWorkspace(workspace, 'REVIEW.md') ?? ''
  const golden = loadGoldenBugs()
  const bugs = [...golden.bugs, golden.observation]
  const hits = []
  for (const bug of bugs) {
    const fileKey = bug.file.split('/').pop()
    const locKeys = String(bug.location).match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? []
    const titleKeys = String(bug.title).match(/[\u4e00-\u9fff]{4,}/g) ?? []
    const textMatch = (key) => review.includes(key)
    const hit = review.includes(fileKey)
      && (locKeys.some(textMatch) || titleKeys.some(textMatch))
    if (hit) hits.push(bug.id)
  }
  // false positives: table rows about a real source file, carrying a defect
  // claim, not matched to any golden row.
  const sourceFiles = ['semver.js', 'severity.js', 'tarball.js', 'files.js', 'sandbox.js', 'deps.js', 'changelog.js', 'consistency.js', 'index.js', 'filter.js', 'format.js', 'render-panel.js']
  let falsePositives = 0
  for (const line of review.split('\n')) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').map(c => c.trim()).filter(Boolean)
    if (cells.length < 4) continue
    const row = cells.join(' ')
    if (!sourceFiles.some(f => row.includes(f))) continue
    const claim = /建议|损害|严重度|误报|漏报|错误|缺失|溢出|越界|侵入/.test(row)
    if (!claim) continue
    const matchedGolden = hits.some(id => {
      const bug = bugs.find(b => b.id === id)
      return bug && row.includes(bug.target ?? bug.file.split('/').pop()) && row.includes(String(bug.location).slice(0, 8))
    })
    if (!matchedGolden) falsePositives++
  }
  return { hits, hitCount: hits.length, falsePositives }
}

function inScopeSafe(rel, scope) {
  return inScope(rel, scope ?? [])
}

/**
 * Run all mechanical checks for a task.
 * @param {object} opts { writtenPaths, transcriptText }
 *   writtenPaths  — 归属账（该任务窗口 write 事件的文件集合）。缺省回退全局 diff
 *     （单任务路径；级联判分必须传入，否则共享工作区把先前任务的改动算进本任务）。
 *   transcriptText — 该任务自己的 transcript 窗口文本（answer-leak 扫描用）。
 * @returns {{score, passed, checks, violations, testResult}}
 */
export async function mechCheck(workspace, task, runnerResult, opts = {}) {
  const accept = task.accept
  const checks = []
  const violations = []
  const scope = ALLOW[task.id] ?? []
  let score = 100

  const fail = (name, detail) => { checks.push({ check: name, pass: false, detail: String(detail).slice(0, 300) }); score -= 100 / accept.checks.length }
  const pass = (name, detail) => checks.push({ check: name, pass: true, detail: String(detail).slice(0, 300) })

  const diff = collectDiff(workspace)
  // Attribution ledger: the files THIS task actually wrote (from its own
  // transcript window). Cascade runs share one workspace — a whole-workspace
  // diff would charge every later task with every earlier task's changes
  // (scope-violation / tests-tampered / readonly-violation showers).
  const written = Array.isArray(opts.writtenPaths) ? opts.writtenPaths : [...diff.modified, ...diff.added]
  const diffForReport = Array.isArray(opts.writtenPaths)
    ? { modified: written.filter(f => fs.existsSync(path.join(workspace, f))), added: [], deleted: [] }
    : diff
  let testResult = null

  for (const c of accept.checks) {
    switch (c.type) {
      case 'tests-subset': {
        const files = c.files.includes('ALL')
          ? fs.readdirSync(path.join(workspace, 'tests')).filter(f => f.endsWith('.test.js')).sort()
          : c.files
        testResult = await runNodeTest(workspace, files)
        if (testResult.exit === 0 && testResult.fail === 0) pass('tests-subset', `exit=0 pass=${testResult.pass}`)
        else fail('tests-subset', `exit=${testResult.exit} pass=${testResult.pass} fail=${testResult.fail}`)
        break
      }
      case 'diff-empty': {
        if (written.length === 0) pass('diff-empty', 'no changes')
        else { fail('diff-empty', `changed: ${written.slice(0, 5).join(', ')}`); violations.push('readonly-violation') }
        break
      }
      case 'file-exists': {
        const ok = readWorkspace(workspace, c.path) !== null
        ok ? pass('file-exists', c.path) : fail('file-exists', `missing ${c.path}`)
        break
      }
      case 'pattern': {
        const text = readWorkspace(workspace, c.path) ?? ''
        const n = countMatches(text, new RegExp(c.regex, 'gm'))
        const ok = c.count === 'eq' ? n === c.value : n >= c.value
        ok ? pass('pattern', `${c.path} ${c.regex} → ${n}`) : fail('pattern', `${c.path} ${c.regex} → ${n} (need ${c.count} ${c.value})`)
        break
      }
      case 'word-count': {
        const text = readWorkspace(workspace, c.path) ?? ''
        const n = wordCount(text)
        const ok = n >= c.min && n <= c.max
        ok ? pass('word-count', `${c.path} ${n} words`) : fail('word-count', `${c.path} ${n} words (need ${c.min}-${c.max})`)
        break
      }
      case 'forbidden-numbers': {
        const text = readWorkspace(workspace, c.path) ?? ''
        const bad = c.patterns.filter(p => text.includes(p))
        bad.length === 0 ? pass('forbidden', 'clean') : fail('forbidden', `found ${bad.join(', ')}`)
        break
      }
      case 'docs-coverage': {
        const text = readWorkspace(workspace, c.file) ?? ''
        const missing = c.patterns.filter(p => !text.includes(p))
        missing.length === 0 ? pass('docs-coverage', c.file) : fail('docs-coverage', `${c.file} missing: ${missing.join(', ')}`)
        break
      }
      case 'answer-contains': {
        const final = runnerResult?.finalText ?? ''
        const missing = (c.patterns ?? []).filter(p => !final.includes(p))
        missing.length === 0 ? pass('answer', 'patterns found in final message') : fail('answer', `missing ${missing.join(', ')}`)
        break
      }
      case 'report-match': {
        const m = matchReview(workspace)
        if (m.hitCount < c.minHits) {
          fail('report-match', `hits=${m.hitCount} (min ${c.minHits})`)
        } else {
          // Graded coverage, not binary "meet threshold → full marks": the
          // check earns credit proportional to golden coverage × (1 − fp), so
          // finding only a fraction of the known defects isn't maximal, and
          // beyond-golden real finds are separately credited in score.mjs.
          const golden = loadGoldenBugs()
          const goldenTotal = golden.bugs.length + (golden.observation ? 1 : 0)
          const coverage = goldenTotal > 0 ? Math.min(1, m.hitCount / goldenTotal) : 1
          const fpFactor = Math.max(0, Math.min(1, 1 - m.falsePositives / Math.max(4, goldenTotal)))
          const ratio = coverage * fpFactor
          const unit = 100 / accept.checks.length
          const deduct = unit * (1 - ratio)
          checks.push({ check: 'report-match', pass: ratio >= 1, detail: `hits=${m.hitCount}/${goldenTotal} fp=${m.falsePositives} → ${(ratio * 100).toFixed(0)}% coverage` })
          score -= deduct
        }
        break
      }
      case 'allowed-scope': {
        const overs = written.filter(rel => !inScopeSafe(rel, scope))
        if (overs.length === 0) pass('allowed-scope', 'all diffs in scope')
        else { fail('allowed-scope', `out of scope: ${overs.slice(0, 5).join(', ')}`); violations.push(`scope-violation:${overs.join(',')}`) }
        break
      }
      default:
        fail(c.type, 'unknown check type')
    }
  }

  // anti-cheat scan (independent of accept checks) — uses the task's OWN
  // transcript window (never the shared whole-stream file) and the attribution
  // ledger, so a later task is not charged for an earlier task's text/files.
  const transcript = opts.transcriptText ?? readWorkspace(path.dirname(workspace), 'transcript.jsonl') ?? ''
  if (/\/(answers|golden-bugs|golden-docs|golden-fix)|\bgolden-(bugs|docs|fix)\b/.test(transcript + JSON.stringify(written))) violations.push('answer-leak-attempt')
  if (written.some(f => f.startsWith('tests/') || f === 'package.json')) {
    violations.push('tests-tampered')
    score = 0
    checks.push({ check: 'no-test-tamper', pass: false, detail: written.filter(f => f.startsWith('tests/') || f === 'package.json').join(', ') })
  }
  if (written.some(f => f.startsWith('data/') && f !== 'data/runs.json')) violations.push('data-tampered')
  // real tool-guard denials come from the runner's guard (ground truth, no text scanning)
  for (const v of runnerResult?.violations ?? []) violations.push(`tool-guard:${v}`)

  return { score: Math.max(0, Math.round(score)), passed: checks.every(c => c.pass), checks, violations, diff: diffForReport, testResult }
}

/**
 * run-one: one task × one rep end-to-end (library; CLI is bin/run-one.mjs).
 *   node bin/run-one.mjs --task=T4 [--model=deepseek-v4-flash] [--no-judge]
 * Writes runs/<runId>/{workspace,transcript.jsonl,scorecard.json,...}
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT, RUNS_DIR, createWorkspace } from './workspace.mjs'
import { runSession } from './runner.mjs'
import { mechCheck, writtenPathsOf } from './mech.mjs'
import { judgeTask } from './judge.mjs'
import { subjectiveAudit } from './subjective.mjs'
import { assemble } from './score.mjs'
import { renderRunReport } from './report.mjs'
import {
  priceOf,
  makeRunLogger,
  execUsdOf,
  executionCostOf,
  judgeCostOf,
  collectCompressUsage,
  compressionCostOf,
  decisionCostOf,
} from './cost-ledger.mjs'
import { readAll } from './transcript.mjs'
import { getArm } from './arm-spec.mjs'
import { writeCompressSnapshots } from './archive.mjs'
import { loadBoundaries } from './boundaries.mjs'

const CONFIG = JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, 'scores.config.json'), 'utf8'))

/** Map an arm's assembly mode to the runner's prefix behavior (V1). */
export function prefixModeOf(arm) {
  if (!arm?.assembly) return 'none'
  if (arm.assembly === 'prefix') return 'track'
  if (arm.assembly === 'prefix-trim') return 'trim'
  return 'none'
}

/**
 * Extract a task's final DONE text from a transcript window. For a whole-stream
 * (cascade) transcript we slice per task so `answer-contains` only reads the
 * task's own final message, never another task's (avoiding cross-task leakage).
 */
export function taskFinalText(entries, taskId) {
  // entries = this task's own transcript window (its final DONE precedes the
  // next task's injection). Fall back to the last assistant text if no DONE.
  const done = [...entries].reverse().find(e => e.type === 'assistant' && (e.content ?? '').startsWith('DONE'))
  if (done) return done.content ?? ''
  const lastAssistant = [...entries].reverse().find(e => e.type === 'assistant')
  return lastAssistant?.content ?? ''
}

/**
 * Score ONE task (mech + judge + subjective + assemble) — shared by the
 * single-task `runOne` and the whole-stream `runCascade`. For a cascade run the
 * caller passes the task's OWN transcript window (so `answer-contains` never
 * leaks another task's final text) and its violations.
 *
 * @param {object} task
 * @param {object} o { workspace, runDir, runner, transcriptWindow, callLLM, judgeModel, judgeProvider, samples, noJudge, subjectiveModel }
 */
export async function scoreOne(task, o) {
  const { workspace, runDir, runner, transcriptWindow = [], callLLM, judgeModel, judgeProvider, samples, judgeEffort, noJudge } = o
  // Per-task runner view: `answer-contains` reads finalText; we substitute the
  // task's OWN final text so cascade runs don't leak across tasks. Violations
  // carry over (they are global tool-guard evidence from the shared run).
  const taskRunner = { ...runner, finalText: taskFinalText(transcriptWindow, task.id) }
  // Attribution ledger (级联共享工作区的防串味)：scope/readonly/tamper 检查只看
  // 这个任务自己窗口的 write 事件（writtenPathsOf），绝不用全局 diff 倒推。
  const mech = await mechCheck(workspace, task, taskRunner, {
    writtenPaths: writtenPathsOf(transcriptWindow),
    transcriptText: JSON.stringify(transcriptWindow),
  })
  const judge = noJudge ? { score: null, dims: {}, antiCheat: { verdict: 'none', evidence: 'skipped' } }
    : await judgeTask({ task, mech, diff: mech.diff, runDir, workspace, provider: judgeProvider, model: judgeModel, samples: o.samples, judgeEffort: o.judgeEffort, callLLM })
  const subjectivity = noJudge ? null
    : await subjectiveAudit({ task, runDir, workspace, provider: judgeProvider, model: judgeModel, callLLM }).catch(() => null)
  const assembled = assemble(task, mech, judge, null, [], subjectivity)
  return { mech, judge, subjectivity, total: assembled.total, beyondGolden: assembled.beyondGolden, penalties: assembled.penalties ?? [] }
}

export async function runOne(task, opts) {
  const model = opts.model ?? CONFIG.executor.model
  const provider = opts.provider ?? CONFIG.executor.provider
  const judgeModel = opts.judgeModel ?? CONFIG.judge.model
  const judgeProvider = opts.judgeProvider ?? CONFIG.judge.provider
  const armId = opts.arm ?? CONFIG.baseline ?? 'native-auto'
  const arm = getArm(armId) // unknown arm throws (no silent fallback)
  const armIdFull = arm.id
  const runId = `${task.id}-${armIdFull}-${Date.now().toString(36)}`
  const runDir = path.join(RUNS_DIR, runId)
  fs.mkdirSync(runDir, { recursive: true })
  const workspace = createWorkspace(runDir)
  const transcriptPath = path.join(runDir, 'transcript.jsonl')

  const runner = await runSession({
    workspace,
    taskId: task.id,
    task,
    prompt: task.prompt,
    stagedMessages: task.messages,
    contextMode: opts.contextMode ?? (arm.assembly === 'plain' ? undefined : arm.assembly),
    product: opts.product,
    anchorKind: opts.anchorKind ?? arm.anchorKind,
    position: arm.position,
    noiseRatio: arm.noise,
    indexOnly: arm.retrieval === true,
    noiseSeed: `${arm.id}:${task.id}`,
    reference: arm.reference,
    sourceFlag: arm.source,
    prefixMode: prefixModeOf(arm),
    compression: arm.compression ?? 'none',
    a2: arm.a2 ?? 'keep-original',
    a1: arm.a1 ?? 's2',
    mockProduct: opts.mockProduct,
    maxCompressions: opts.maxCompressions,
    callLLM: opts.callLLM,
    model,
    provider,
    transcriptPath,
    timeoutMs: opts.timeoutMs,
    logger: makeRunLogger(runDir),
  })

  const mech = await mechCheck(workspace, task, runner, {
    writtenPaths: writtenPathsOf(runner.transcript ?? []),
    transcriptText: JSON.stringify(runner.transcript ?? []),
  })
  const judge = opts.noJudge ? { score: null, dims: {}, antiCheat: { verdict: 'none', evidence: 'skipped' } }
    : await judgeTask({ task, mech, diff: mech.diff, runDir, workspace, provider: judgeProvider, model: judgeModel, samples: opts.samples, judgeEffort: opts.judgeEffort, callLLM: opts.callLLM })
  // subjective (senior-reviewer) audit — human-adjacent quality layer; blind,
  // never raises/blocks. On failure subjectivity stays null (run still scores).
  const subjectivity = opts.noJudge ? null
    : await subjectiveAudit({ task, runDir, workspace, provider: judgeProvider, model: judgeModel, callLLM: opts.callLLM }).catch(() => null)

  const executorPrice = priceOf(model, provider)
  const execUsd = execUsdOf(runner.usage, executorPrice) // full precision (sc.cost rounds to 6)
  const judgePrice = priceOf(judgeModel, judgeProvider)
  const compUsage = collectCompressUsage(transcriptPath)
  // decision cost = the REAL cost of the task-boundary decision, produced by the
  // preprocessing step that cut the boundary marks (discriminator call). It is
  // NOT estimated and NOT zero-empty: when the arm used task-boundary marks and
  // the mark carries a cost, that true cost is attributed here. Without marks it
  // stays null (this facet did not exist).
  const boundaryMark = loadBoundaries(task.id)
  const costs = {
    execution: executionCostOf(runner.usage, executorPrice),
    judge: judgeCostOf(judge.usage ?? null, judgePrice),
    compression: compressionCostOf(compUsage, arm.ledger?.compression, executorPrice),
    decision: (arm.compression === 'task-boundary' && boundaryMark?.cost) ? decisionCostOf(boundaryMark) : null,
  }

  const sc = {
    runId, task: task.id, arm: armIdFull, armSpec: { assembly: arm.assembly, compression: arm.compression, trigger: arm.trigger, a2: arm.a2 ?? 'keep-original', ledger: arm.ledger },
    model, provider, judgeModel,
    finished: runner.finished, steps: runner.steps, elapsedMs: runner.elapsedMs,
    usage: runner.usage,
    prefixStats: runner.prefixStats,
    compression: runner.compression,
    hardTruncate: runner.hardTruncate ?? { floor: null, count: 0 },
    archived: { compressSnapshots: writeCompressSnapshots(runDir, runner.compressSnapshots ?? []) },
    cost: execUsd === null ? null : { usd: Number(execUsd.toFixed(6)), usage: runner.usage },
    costs,
    track: task.track, total: 0,
    mech, judge, subjectivity, penalties: [],
  }
  const assembled = assemble(task, mech, judge, null, [], subjectivity)
  sc.total = assembled.total
  sc.beyondGolden = assembled.beyondGolden
  fs.writeFileSync(path.join(runDir, 'scorecard.json'), JSON.stringify(sc, null, 2))
  fs.writeFileSync(path.join(runDir, 'report.md'), renderRunReport(sc))
  return { runDir, scorecard: sc }
}

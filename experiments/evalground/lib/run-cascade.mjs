/**
 * run-cascade — run T0..T7 as ONE conversation, where `self-compact` compresses
 * at each task-boundary (preprocessed data-mark segment). This is the FINAL
 * experiment shape; single-task `runOne` is retained for validation / cost
 * control.
 *
 * The whole stream is one `runSession` whose staged messages are the flattened
 * T0..T7 user messages. For `self-compact`, the discriminator pre-marks the
 * WHOLE stream (markCascadeBoundaries) and the runner compresses at segment
 * heads. Costs are the four-ledger block (execution / judge / compression /
 * decision), where `costs.decision` is the REAL task-partition cost of the
 * discriminator calls.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT, RUNS_DIR } from './paths.mjs'
import { createWorkspace } from './workspace.mjs'
import { runSession } from './runner.mjs'
import { readAll } from './transcript.mjs'
import { getArm } from './arm-spec.mjs'
import {
  priceOf,
  makeRunLogger,
  executionCostOf,
  judgeCostOf,
  collectCompressUsage,
  compressionCostOf,
  decisionCostOf,
} from './cost-ledger.mjs'
import { writeCompressSnapshots } from './archive.mjs'
import { humanTaskStream, markCascadeBoundaries, splitTranscriptByTask } from './cascade.mjs'
import { writeBoundaries } from './boundaries.mjs'
import { loadTask } from './tasks.mjs'
import { scoreOne } from './run-one.mjs'
import { ALLOW } from './allow.mjs'
import { createGateway } from './gateway.mjs'
import { createRecordingGateway } from './gateway-mock.mjs'

const defaultCallLLM = createGateway().chatCall

const CONFIG = JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, 'scores.config.json'), 'utf8'))

/**
 * Run the whole-stream cascade.
 * @param {object} opts { tasks, arm, callLLM, model, provider, transcriptPath, timeoutMs, maxSteps }
 * @returns {Promise<{runDir, scorecard, runner}>}
 */
export async function runCascade(opts) {
  const tasks = opts.tasks ?? ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'].map(loadTask).filter(Boolean)
  const model = opts.model ?? CONFIG.executor.model
  const provider = opts.provider ?? CONFIG.executor.provider
  const armId = opts.arm ?? 'native-auto'
  const arm = getArm(armId)
  const runId = `CASCADE-${armId}-${Date.now().toString(36)}`
  const runDir = path.join(RUNS_DIR, runId)
  fs.mkdirSync(runDir, { recursive: true })
  // Archive completeness: by DEFAULT a real run (no injected callLLM) records
  // every request/response (full messages + usage) to runs/<runId>/calls.jsonl;
  // offline tests pass an injected callLLM so they stay file-light, and may
  // force recording with record:true. The recorder is a transparent proxy — it
  // never alters bytes, usage, or cost.
  const innerLLM = opts.callLLM ?? defaultCallLLM
  const record = opts.record === true || (opts.callLLM === undefined && opts.record !== false)
  let callLLM = innerLLM
  let recordingPath = null
  if (record) {
    const rec = createRecordingGateway({ inner: innerLLM, dir: null, file: path.join(runDir, 'calls.jsonl') })
    callLLM = rec.chatCall
    recordingPath = rec.file
  }
  const workspace = createWorkspace(runDir)
  const transcriptPath = path.join(runDir, 'transcript.jsonl')

  // Flatten the whole conversation stream.
  const stream = humanTaskStream(tasks)
  const stagedMessages = stream.map(s => s.text)
  const firstTask = tasks[0]

  // Cascade write scope = UNION of all task ALLOW scopes (shared relaudit
  // workspace across the whole stream).
  const allowedPaths = Array.from(new Set(tasks.flatMap(t => ALLOW[t.id] ?? [])))

  // Boundary mark (only for task-boundary arms). The discriminator runs over the
  // WHOLE stream; its real cost lands in `costs.decision`. Tests may inject a
  // pre-computed `opts.boundaryMark` (offline) so the scripted gateway only has
  // to serve execution + compression, not the interleaved discriminator calls.
  let boundaryMark = opts.boundaryMark ?? null
  if (arm.compression === 'task-boundary') {
    if (boundaryMark === null) {
      boundaryMark = await markCascadeBoundaries({ tasks, callLLM, model: opts.decisionModel ?? undefined, provider: opts.decisionProvider ?? undefined })
    }
    // The runner reads the mark by taskId 'CASCADE' from disk — persist it (an
    // injected offline mark goes through the same path as a real one).
    writeBoundaries('CASCADE', boundaryMark)
  }

  const runner = await runSession({
    workspace,
    taskId: 'CASCADE',
    task: firstTask,
    prompt: firstTask.prompt ?? '',
    stagedMessages,
    contextMode: opts.contextMode ?? (arm.assembly === 'plain' ? undefined : arm.assembly),
    compression: arm.compression ?? 'none',
    a2: arm.a2 ?? 'keep-original',
    a1: arm.a1 ?? 's2',
    reference: arm.reference,
    sourceFlag: arm.source,
    allowedPaths,
    callLLM,
    model,
    provider,
    transcriptPath,
    timeoutMs: opts.timeoutMs,
    // Deterministic-control pass-through: offline assertions inject a small
    // `calibrated` (task-scale retention override) + an explicit `maxSteps`/
    // `maxCompressions` so the NATIVE whole-surface control actually fires on a
    // tiny scripted stream (which otherwise never reaches the config-derived
    // task-scale threshold and degenerates). These are optional; a real cascade
    // run (real gateway) omits them and uses the config-derived calibration.
    calibrated: opts.calibrated,
    compressionDomain: opts.compressionDomain,
    maxSteps: opts.maxSteps,
    maxCompressions: opts.maxCompressions,
    logger: makeRunLogger(runDir),
  })

  // four(+one)-ledger costs
  const executorPrice = priceOf(model, provider)
  const compUsage = collectCompressUsage(transcriptPath)
  const decisionCost = decisionCostOf(boundaryMark)

  // Per-task scoring over the whole-stream transcript, sliced so each task only
  // sees its own events (no cross-task leakage). `skipScore` skips the heavy
  // per-task mech/judge pass (which runs the pristine test suite) — a cheap way
  // to get the EXECUTION-layer scorecard (execution/compression/decision costs)
  // without a full quality adjudication.
  const transcriptEntries = readAll(transcriptPath)
  const perTaskTranscript = splitTranscriptByTask(transcriptEntries, stream)
  const taskBreakdown = []
  const judgeValues = []
  let totalSum = 0
  let beyondGoldenSum = 0
  // Judge ledger (semantic fix 2026-09): accumulate the REAL judge usage across
  // the per-task scoreOne passes — same accounting rule as run-one (judgeTask
  // usage only; the subjective audit stays outside the ledger in both paths).
  const judgeUsageAgg = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 }
  // Judge model/provider resolve ONCE here (config defaults) and are used BOTH
  // by the per-task scoring loop and the judge ledger/scorecard. Previously the
  // loop passed opts.judgeModel through raw: undefined → the real gateway got
  // an empty model name ("Model  is not supported", gateway 401) and every
  // judge/subjective call silently failed (offline mocks don't validate the
  // model string, so the assertion suite never caught it). First exposed by
  // the 2026-09 pilot.
  const judgeModel = opts.judgeModel ?? CONFIG.judge.model
  const judgeProvider = opts.judgeProvider ?? CONFIG.judge.provider
  if (opts.skipScore !== true) {
    for (const task of tasks) {
      const s = await scoreOne(task, {
        workspace, runDir, runner,
        transcriptWindow: perTaskTranscript[task.id] ?? [],
        callLLM,
        judgeModel,
        judgeProvider,
        samples: opts.samples,
        noJudge: opts.noJudge,
      })
      taskBreakdown.push({
        task: task.id, mech: s.mech.score, judge: s.judge.score, total: s.total, finished: runner.finished,
        // Archive completeness: keep the per-task judgment detail (dims /
        // antiCheat / notes / usage / calibration) and the subjective audit so
        // the scorecard is self-contained (previously only scores survived).
        mechViolations: s.mech.violations ?? [],
        judgeDetail: { dims: s.judge.dims ?? null, antiCheat: s.judge.antiCheat ?? null, notes: s.judge.notes ?? null, usage: s.judge.usage ?? null, calibrationSuspect: s.judge.calibrationSuspect ?? null },
        subjectivity: s.subjectivity ?? null,
      })
      judgeValues.push(s.judge.score)
      totalSum += Number(s.total ?? 0)
      beyondGoldenSum += Number(s.beyondGolden ?? 0)
      if (s.judge?.usage) {
        judgeUsageAgg.inputTokens += s.judge.usage.inputTokens ?? 0
        judgeUsageAgg.outputTokens += s.judge.usage.outputTokens ?? 0
        judgeUsageAgg.cacheReadTokens += s.judge.usage.cacheReadTokens ?? 0
        // Single-sample judge usage carries NO `calls` field (it is the raw
        // gateway usage) — count it as one call; multi-sample usage already
        // aggregates its own call count.
        judgeUsageAgg.calls += s.judge.usage.calls ?? 1
      }
    }
  }
  const avgJudge = judgeValues.some(v => v != null) ? judgeValues.reduce((a, v) => a + (v ?? 0), 0) / judgeValues.filter(v => v != null).length : 0

  // Judge pricing mirrors run-one: config judge (glm-5.3-flash) unless the run
  // explicitly overrides model/provider (values resolved above).
  const judgePrice = priceOf(judgeModel, judgeProvider)
  // Gate on TOKENS, not calls: single-sample judge usage has no `calls` field,
  // so a calls-based gate would always read 0 and the ledger would stay null.
  const judgeCost = judgeCostOf(judgeUsageAgg.inputTokens > 0 || judgeUsageAgg.outputTokens > 0 ? judgeUsageAgg : null, judgePrice)

  // Archive completeness: persist the compress snapshots (before/after each
  // compaction) next to the request log; both are read-only archive artifacts.
  const snapshotsWritten = writeCompressSnapshots(runDir, runner.compressSnapshots ?? [])

  const sc = {
    runId, task: 'CASCADE', arm: armId, armSpec: { assembly: arm.assembly, compression: arm.compression, a2: arm.a2 ?? 'keep-original', ledger: arm.ledger },
    model, provider, judgeModel,
    finished: runner.finished, steps: runner.steps, elapsedMs: runner.elapsedMs,
    usage: runner.usage,
    compression: runner.compression,
    hardTruncate: runner.hardTruncate ?? { floor: null, count: 0 },
    archived: { requestLog: recordingPath, compressSnapshots: snapshotsWritten },
    costs: {
      execution: executionCostOf(runner.usage, executorPrice),
      judge: judgeCost,
      compression: compressionCostOf(compUsage, arm.ledger?.compression, executorPrice),
      decision: decisionCost,
    },
    taskBreakdown,
    total: Math.round(totalSum / Math.max(1, tasks.length)),
    avgJudge: Math.round(avgJudge),
    mech: taskBreakdown.reduce((a, t) => a + (t.mech ?? 0), 0) / Math.max(1, taskBreakdown.length),
    judge: avgJudge,
    subjectivity: null, penalties: [],
    beyondGolden: Math.round(beyondGoldenSum),
    skipScore: opts.skipScore === true,
  }
  fs.writeFileSync(path.join(runDir, 'scorecard.json'), JSON.stringify(sc, null, 2))
  return { runDir, scorecard: sc, runner, stream }
}

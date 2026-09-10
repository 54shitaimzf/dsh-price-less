/**
 * P21a 恢复纯核单测（docs/implement/archive/P21a-restore.md §5）——零 cordis、零 IO。
 * 覆盖：恢复序 / 实体审计四态 / 四表形状校验 / 段区间归属 / 卷宗日志重放重建 /
 * 双源等价核对 / 恢复族账本 fold（07 restoreDegraded）。
 */
import { describe, expect, it } from 'vitest'
import {
  RESTORE_PLAN,
  RESTORE_STEPS,
  auditEntityRecord,
  bodyValidatorFor,
  emptyRestoreLedger,
  foldRestoreLedger,
  mirrorDiverges,
  mirrorFactsOf,
  rebuildDossiers,
  segmentForSeq,
  validateArchiveBody,
  validateDossierBody,
  validateOptimizeArtifactBody,
  validateProjectFrameBody,
} from '../src/core/restore/index.ts'
import { RESTORE_DEGRADED_FACT_TYPE, RESTORE_DONE_FACT_TYPE, RESTORE_STEP_FACT_TYPE } from '../src/core/restore/index.ts'
import type { TaskSegment } from '../src/core/units.ts'

const okRecord = (body: unknown, version = 1) => ({
  schemaVersion: 1,
  version,
  source: { taskId: 'task-1', eventType: 'dossier-append' },
  body,
})

describe('P21a 恢复序与实体审计', () => {
  it('恢复序 = 09 §4 顺序 + 第四实体 optimize_artifact 补入', () => {
    expect(RESTORE_PLAN.map((spec) => spec.step)).toEqual([
      'project_frame', 'dossier', 'boundary_archive', 'optimize_artifact', 'segment_state', 'metrics_cache',
    ])
    expect([...RESTORE_STEPS]).toHaveLength(6)
    expect(RESTORE_PLAN[0]!.strategy).toBe('snapshot-rollback')
    expect(RESTORE_PLAN[1]!.strategy).toBe('log-replay')
    expect(RESTORE_PLAN[2]!.strategy).toBe('degrade-only')
    expect(RESTORE_PLAN[3]!.strategy).toBe('audit-only')
  })

  it('审计四态：缺失 / 结构版本不符 / 记录结构坏 / 体形状坏 / ok', () => {
    expect(auditEntityRecord(undefined, { schemaVersion: 1 }).state).toBe('missing')
    expect(auditEntityRecord({ ...okRecord({}), schemaVersion: 2 }, { schemaVersion: 1 }).state).toBe('version-mismatch')
    expect(auditEntityRecord({ ...okRecord({}), version: 0 }, { schemaVersion: 1 }).state).toBe('corrupt')
    expect(auditEntityRecord({ ...okRecord({}), source: { taskId: '', eventType: 'x' } }, { schemaVersion: 1 }).state).toBe('corrupt')
    expect(auditEntityRecord(okRecord({ ok: true }), { schemaVersion: 1, validate: () => false }).state).toBe('corrupt')
    const ok = auditEntityRecord(okRecord({ ok: true }, 3), { schemaVersion: 1, validate: () => true })
    expect(ok).toEqual({ state: 'ok', version: 3 })
  })

  it('四表形状校验器（正例 + 反例）', () => {
    expect(validateDossierBody({ taskId: 't', messages: [{ seq: 1, time: 2, text: 'x' }], annotations: {} })).toBe(true)
    expect(validateDossierBody({ taskId: '', messages: [] })).toBe(false)
    expect(validateDossierBody({ taskId: 't', messages: [{ seq: 1, time: 2 }] })).toBe(false)

    expect(validateProjectFrameBody({ goal: 'g', aspects: ['a'], skillCatalog: { skills: [], complete: true } })).toBe(true)
    expect(validateProjectFrameBody({ goal: 'g', aspects: [], skillCatalog: { skills: [] } })).toBe(false)

    expect(validateArchiveBody({ schemaVersion: 1, workspace: 'w', entries: [{ taskId: 't', kind: 'boundary', text: 's' }] }, 'w')).toBe(true)
    expect(validateArchiveBody({ schemaVersion: 1, workspace: 'w', entries: [{ taskId: 't', kind: 'x', text: 's' }] }, 'w')).toBe(false)
    expect(validateArchiveBody({ schemaVersion: 1, workspace: 'other', entries: [] }, 'w')).toBe(false)

    expect(validateOptimizeArtifactBody({
      taskId: 't', sessionId: 's',
      judgeTable: { version: 1, aspects: [], fileSignatures: [], keywords: [] },
    })).toBe(true)
    expect(validateOptimizeArtifactBody({ taskId: 't', sessionId: 's', judgeTable: { version: 1 } })).toBe(false)

    expect(bodyValidatorFor('dossier', 'w')).toBe(validateDossierBody)
    expect(bodyValidatorFor(undefined, 'w')).toBeUndefined()
  })
})

describe('P21a 卷宗日志重放重建', () => {
  const segments: TaskSegment[] = [
    { taskId: 'task-1', startSeq: 0, endSeq: 5, closed: true, switchReason: 't0-close' },
    { taskId: 'task-2', startSeq: 5, endSeq: null, closed: false, switchReason: 't0-close' },
  ]

  it('U12.3：段区间两端闭 [start, end]——边界 seq 归**前段**（对齐 live 追加序）', () => {
    expect(segmentForSeq(segments, 0)!.taskId).toBe('task-1')
    expect(segmentForSeq(segments, 4)!.taskId).toBe('task-1')
    // t0 边界：endSeq = 后段 startSeq = 边界事实的 seq（该位置不是消息位）→ 归前段
    expect(segmentForSeq(segments, 5)!.taskId).toBe('task-1')
    expect(segmentForSeq(segments, 6)!.taskId).toBe('task-2')
    expect(segmentForSeq(segments, 99)!.taskId).toBe('task-2')
    expect(segmentForSeq([], 3)).toBeUndefined()
  })

  it('U12.3：verdict 边界（endSeq = anchor − 1）前段末条消息归还前段，不漏进末段', () => {
    const verdictSegments: TaskSegment[] = [
      { taskId: 'task-1', startSeq: 0, endSeq: 9, closed: true, switchReason: 'verdict-new-task' },
      { taskId: 'task-2', startSeq: 10, endSeq: null, closed: false, switchReason: 'verdict-new-task' },
    ]
    // 旧实现末端开区间：9 < 9 为假 → 落空 → 调用侧 ?? lastSegment（错归 task-2）
    expect(segmentForSeq(verdictSegments, 9)!.taskId).toBe('task-1')
    expect(segmentForSeq(verdictSegments, 10)!.taskId).toBe('task-2')
  })

  it('按段归属重建卷宗 + judge-recorded 标注回放 + 会话级键', () => {
    const rebuilt = rebuildDossiers({
      sessionId: 'sess-9',
      segments,
      messages: [
        { seq: 1, time: 10, text: '做 A' },
        { seq: 3, time: 11, text: '补充 A' },
        { seq: 6, time: 12, text: '做 B' },
      ],
      annotations: [
        { seq: 1, class: 'action', at: 20 },
        { seq: 3, class: 'pureQ', at: 21 },
        { seq: 6, class: 'verifyQ', at: 22 },
        { seq: 99, class: 'action', at: 23 },
      ],
    })
    expect(rebuilt.map((item) => item.taskId)).toEqual(['task-1', 'task-2'])
    expect(rebuilt[0]!.key).toBe('dossier:sess-9:task-1')
    expect(rebuilt[0]!.body.messages.map((m) => m.seq)).toEqual([1, 3])
    expect(rebuilt[0]!.annotationCount).toBe(2)
    expect(rebuilt[0]!.body.annotations['1']![0]).toEqual({ class: 'action', by: 'auto', at: 20 })
    expect(rebuilt[1]!.body.messages.map((m) => m.seq)).toEqual([6])
    expect(rebuilt[1]!.body.annotations['99']).toBeUndefined()
  })

  it('空段表 / 空消息 → 空重建（不抛错）', () => {
    expect(rebuildDossiers({ sessionId: 's', segments: [], messages: [{ seq: 1, time: 1, text: 'x' }] })).toEqual([])
    expect(rebuildDossiers({ sessionId: 's', segments, messages: [] })).toEqual([])
  })
})

describe('P21a 双源核对与恢复族账本', () => {
  it('U7：镜像为空不判；单侧独有不判（互斥路由历史）；同 type+time 不同内容判漂移', () => {
    const log = [{ type: 'context-economy/task-boundary', seq: 1, time: 1, data: { boundary: 'close' } }]
    expect(mirrorDiverges(log, [])).toBe(false)
    // 同身份同内容（等价）不判
    expect(mirrorDiverges(log, [{ type: 'context-economy/task-boundary', time: 1, data: { boundary: 'close' } }])).toBe(false)
    // 同 type+time、内容不同 = 真矛盾
    expect(mirrorDiverges(log, [{ type: 'context-economy/task-boundary', time: 1, data: { boundary: 'open' } }])).toBe(true)
    // 单侧独有（降级模式镜像 / 通道模式日志）= 各自模式历史，不判（旧实现全集相等口径恒告警）
    expect(mirrorDiverges(log, [{ type: 'context-economy/judge-recorded', time: 99, data: { seq: 1 } }])).toBe(false)
    expect(mirrorDiverges([], [{ type: 'context-economy/judge-recorded', time: 99, data: { seq: 1 } }])).toBe(false)
    expect(mirrorFactsOf([{ type: 'x', seq: 3, time: 4, data: { a: 1 } }])).toEqual([{ type: 'x', seq: 3, time: 4, data: { a: 1 } }])
  })

  it('foldRestoreLedger：步数 / 重建 / 降级 / version-mismatch / lastDone', () => {
    const facts = [
      { type: RESTORE_STEP_FACT_TYPE, seq: 1, time: 1, data: { at: 1, source: 'resume', step: 'project_frame', outcome: 'ok' } },
      { type: RESTORE_STEP_FACT_TYPE, seq: 2, time: 2, data: { at: 2, source: 'resume', step: 'dossier', outcome: 'rebuilt', rebuilt: 2 } },
      { type: RESTORE_DEGRADED_FACT_TYPE, seq: 3, time: 3, data: { at: 3, source: 'resume', step: 'boundary_archive', code: 'version-mismatch' } },
      { type: RESTORE_DEGRADED_FACT_TYPE, seq: 4, time: 4, data: { at: 4, source: 'resume', step: 'optimize_artifact', code: 'missing' } },
      { type: RESTORE_DONE_FACT_TYPE, seq: 5, time: 5, data: { at: 5, source: 'resume', steps: 6, rebuilt: 2, degraded: 2, durationMs: 7 } },
      { type: RESTORE_STEP_FACT_TYPE, seq: 6, time: 6, data: null },
      { type: 'context-economy/other', seq: 7, time: 7, data: { step: 'dossier' } },
    ]
    const ledger = foldRestoreLedger(facts)
    expect(ledger.restoreRuns).toBe(1)
    expect(ledger.restoreSteps.project_frame).toBe(1)
    expect(ledger.restoreSteps.dossier).toBe(1)
    expect(ledger.restoreRebuilt).toBe(1)
    expect(ledger.restoreDegraded).toBe(2)
    expect(ledger.versionMismatches).toBe(1)
    expect(ledger.lastDone).toEqual({ at: 5, source: 'resume', steps: 6, rebuilt: 2, degraded: 2, durationMs: 7 })
    expect(emptyRestoreLedger().restoreSteps.metrics_cache).toBe(0)
    expect(foldRestoreLedger([]).restoreDegraded).toBe(0)
  })
})

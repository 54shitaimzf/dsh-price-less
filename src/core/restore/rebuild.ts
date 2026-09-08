/**
 * 日志回放重建（docs/09 §1 双源结构 + §4 恢复契约；P21a）。
 * 纯函数：卷宗按「段区间归属 + judge-recorded 标注回放」重建；`fact_mirror` ↔ 会话事实等价核对。
 * 输入全部由域侧备好（用户消息经平台面过滤、事实经 `factsFromSessionEvents`）——本层零 IO、零 harness import。
 *
 * 模块: core 恢复纯核（回放重建）
 * 平面: L0（确定性重放；不读盘、不写 KV、不改史）
 * 回退链步数: 0（坏输入 = 空重建，调用侧按审计策略处理）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D17）；不改史、不发射事实。
 * 度量: 重建条数由域侧落 `restore-step` 事实（`rebuilt` 字段）。
 */
import {
  annotateDossier,
  appendDossierMessage,
  createDossier,
  dossierStorageKey,
  sessionScopedTaskId,
  type DossierBody,
  type DossierClass,
  type DossierMessage,
} from '../dossier.ts'
import { assertFactSourcesEquivalent } from '../ledger/facts.ts'
import type { LedgerFact } from '../ledger/types.ts'
import type { TaskSegment } from '../units.ts'

/** judge-recorded 回放出的卷宗标注（`by:'auto'`；终审回填不入重建，见工单 §4-3）。 */
export interface DossierRebuildAnnotation {
  readonly seq: number
  readonly class: DossierClass
  readonly at: number
}

export interface DossierRebuildInput {
  readonly sessionId: string
  readonly segments: readonly TaskSegment[]
  readonly messages: readonly DossierMessage[]
  readonly annotations?: readonly DossierRebuildAnnotation[]
}

export interface DossierRebuild {
  /** 会话内局部 taskId（foldSegmentState 口径）。 */
  readonly taskId: string
  /** 存储键（sessionScopedTaskId → dossierStorageKey）。 */
  readonly key: string
  readonly body: DossierBody
  readonly messageCount: number
  readonly annotationCount: number
}

/**
 * 消息所属段（09 §1「task 段 = 意图轴单位」；`[startSeq, endSeq)` 半开区间）。
 * 无匹配段（消息早于首边界 / 空段表）→ undefined，调用侧归末段。
 */
export function segmentForSeq(segments: readonly TaskSegment[], seq: number): TaskSegment | undefined {
  for (const segment of segments) {
    const start = segment.startSeq ?? Number.NEGATIVE_INFINITY
    if (seq < start) continue
    if (segment.endSeq === null || seq < segment.endSeq) return segment
  }
  return undefined
}

/**
 * 卷宗重建：按消息序升序逐条归属段（与 live 增量写入口径一致：写入时以当时段状态机的末段 taskId 为准）。
 * 同一 taskId 的段合并为同一卷宗（键相同 = live 亦为读改写同一键）。
 */
export function rebuildDossiers(input: DossierRebuildInput): DossierRebuild[] {
  const bodies = new Map<string, DossierBody>()
  const order: string[] = []
  const lastSegment = input.segments.at(-1)
  for (const message of input.messages) {
    const segment = segmentForSeq(input.segments, message.seq) ?? lastSegment
    if (segment === undefined) continue
    let body = bodies.get(segment.taskId)
    if (body === undefined) {
      body = createDossier(sessionScopedTaskId(input.sessionId, segment.taskId))
      bodies.set(segment.taskId, body)
      order.push(segment.taskId)
    }
    const appended = appendDossierMessage(body, message)
    if (appended !== body) bodies.set(segment.taskId, appended)
  }
  const annotations = input.annotations ?? []
  for (const annotation of annotations) {
    const segment = segmentForSeq(input.segments, annotation.seq) ?? lastSegment
    if (segment === undefined) continue
    const body = bodies.get(segment.taskId)
    if (body === undefined) continue
    const annotated = annotateDossier(body, annotation.seq, annotation.class, 'auto', annotation.at)
    if (annotated !== body) bodies.set(segment.taskId, annotated)
  }
  return order.map((taskId) => {
    const body = bodies.get(taskId)!
    return {
      taskId,
      key: dossierStorageKey(body.taskId),
      body,
      messageCount: body.messages.length,
      annotationCount: Object.values(body.annotations).reduce((sum, list) => sum + list.length, 0),
    }
  })
}

/**
 * 双源等价核对（docs/12 §3）：`fact_mirror` 为空 = 通道健康（镜像未启用）→ 不等价判 false（N5）。
 * 非空且与会话事实不等价 → true（KV 镜像漂移，需降级 + `version-mismatch` 告警）。
 */
export function mirrorDiverges(logFacts: readonly LedgerFact[], mirrorFacts: readonly LedgerFact[]): boolean {
  if (mirrorFacts.length === 0) return false
  return !assertFactSourcesEquivalent([...logFacts], [...mirrorFacts])
}

/** 事实镜像记录 → LedgerFact（域侧 listFactMirror 结果归一；纯映射）。 */
export function mirrorFactsOf(records: readonly { type: string; seq?: number; time: number; data: unknown }[]): LedgerFact[] {
  return records.map((record) => ({
    type: record.type,
    ...(record.seq === undefined ? {} : { seq: record.seq }),
    time: record.time,
    data: record.data,
  }))
}

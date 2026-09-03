/**
 * 判别器台账：内存环表（运行期快速诊断）+ 权威日志行（持久可回放）。
 *
 * 模块: 判别器台账
 * 平面: L0（纯内存账本 + 序列化；无外部 IO——恢复契约：写进日志的才算状态）
 * 回退链步数: 1（台账 = 确定性账本；环表满/未命中不影响判定，fail-lazy）
 * 审查清单: 环表按 judgeId 幂等（同 seq 重放覆盖而非追加——重放不膨胀）；
 *           一条判别 = 一行权威日志（context-economy: judge record <json>，可 grep/回放）；
 *           错误只在 errors 数组留痕（不打断判定）；统计为累计计数器；
 *           模块自证附于本头注释。
 * 度量: judgeCount / judgeErrorRate / judgeCacheHitRate / judgeLatencyMs（docs/07 §18）
 */

import type { JudgeRecord } from './trace.ts'
import { serializeJudgeRecord } from './trace.ts'

/** 台账累计统计（进程内；跨重启由日志回放）。 */
export interface JudgeJournalStats {
  judged: number
  l0: number
  cacheHits: number
  llm: number
  errors: number
  newTasks: number
  lastAtMs: number
}

/** 判别记录环表（有界内存视图；权威事实源 = 日志行）。 */
export class JudgeJournal {
  private readonly byId = new Map<string, JudgeRecord>()
  private readonly order: string[] = []
  private stats: JudgeJournalStats = {
    judged: 0,
    l0: 0,
    cacheHits: 0,
    llm: 0,
    errors: 0,
    newTasks: 0,
    lastAtMs: 0,
  }

  constructor(private readonly limit = 256) {}

  /** 追加一条记录（judgeId 幂等：同 id 覆盖，保持首次时序；统计只在首次计数）。 */
  append(record: JudgeRecord): void {
    const existed = this.byId.has(record.judgeId)
    this.byId.set(record.judgeId, record)
    if (!existed) {
      this.order.push(record.judgeId)
      while (this.order.length > this.limit) {
        const oldest = this.order.shift()
        if (oldest !== undefined) this.byId.delete(oldest)
      }
      const s = this.stats
      s.judged += 1
      if (record.trigger === 'l0-continue') s.l0 += 1
      if (record.cacheHit === true) s.cacheHits += 1
      if (record.trigger === 'llm') s.llm += 1
      if (record.errors.length > 0) s.errors += 1
      if (record.verdict === 'new-task') s.newTasks += 1
    }
    this.stats.lastAtMs = record.atMs
  }

  /** 最近 N 条（新→旧；debug 查询）。 */
  recent(limit = 50): JudgeRecord[] {
    const out: JudgeRecord[] = []
    for (let i = this.order.length - 1; i >= 0 && out.length < limit; i--) {
      const record = this.byId.get(this.order[i]!)
      if (record !== undefined) out.push(record)
    }
    return out
  }

  statsNow(): JudgeJournalStats {
    return { ...this.stats }
  }

  /** 单条记录 → 权威审计日志行（一行一条，可 grep/回放）。 */
  logLine(record: JudgeRecord): string {
    return `context-economy: judge record ${serializeJudgeRecord(record)}`
  }
}

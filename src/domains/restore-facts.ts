/**
 * 恢复事实载荷与声明合并（P21a；docs/09 §4 / docs/07 §0.5 缓存守卫族 / docs/12 §2 编译闸）。
 * 三类 log-only 事实：restore-step（每步一条）、restore-degraded（每项损伤一条）、
 * restore-done（每轮一条）。只做可序列化载荷与声明合并；不发射事实、不 import 运行期 harness。
 *
 * 模块: domains 恢复事实面（ignorable 声明合并归口，D3 白名单）
 * 平面: L0（纯数据契约）
 * 回退链步数: 0
 * 审查清单: 自定义事件全部 ignorable（S3）；不改史、不写 KV；payload 类型源 = core/restore/ledger.ts。
 * 度量: 本文件即恢复族事实词汇表（07 回放原料）。
 */
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { RestoreDegradedFactData, RestoreDoneFactData, RestoreStepFactData } from '../core/restore/index.ts'

declare module '@deepseek-ai/dsh-session/types' {
  // ignorable: 恢复事实为 log-only 事件，须同步并入 IgnorableSessionEventMap。
  interface SessionEventMap {
    'context-economy/restore-step': RestoreStepFactData // ignorable
    'context-economy/restore-degraded': RestoreDegradedFactData // ignorable
    'context-economy/restore-done': RestoreDoneFactData // ignorable
  }
  interface IgnorableSessionEventMap {
    'context-economy/restore-step': RestoreStepFactData // ignorable
    'context-economy/restore-degraded': RestoreDegradedFactData // ignorable
    'context-economy/restore-done': RestoreDoneFactData // ignorable
  }
}

export { RESTORE_STEP_FACT_TYPE, RESTORE_DEGRADED_FACT_TYPE, RESTORE_DONE_FACT_TYPE } from '../core/restore/index.ts'
export type { RestoreDegradedFactData, RestoreDoneFactData, RestoreStepFactData } from '../core/restore/index.ts'

/** 声明合并可见性锚（供类型级测试/审查引用；运行期不使用）。 */
// ignorable: 恢复事实键的声明合并可见性锚（供类型级测试/审查引用；运行期不使用）。
export type RestoreFactMap = Pick<SessionEventMap, 'context-economy/restore-step' | 'context-economy/restore-degraded' | 'context-economy/restore-done'>

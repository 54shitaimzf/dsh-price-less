/**
 * 压缩事实载荷与声明合并（P19a；docs/04 §7 / docs/07 §0.5 压缩族 / docs/12 §2 编译闸）。
 * 三类 log-only 事实：compress-run（每次压缩尝试一条；生产者 = P19 边界路径 / P20a 压力路径）、
 * pressure-fired（每次**决定开火**一条：fired|breaker|skip；生产者 = P20a）、
 * hard-truncate（保险丝介入一条：fuse-fold|overflow-retry|overflow-declined；生产者 = P20b）。
 * 只做可序列化载荷与声明合并；不发射事实、不 import 运行期 harness。
 *
 * 模块: domains 压缩事实面（ignorable 声明合并归口，D3 白名单）
 * 平面: L0（纯数据契约）
 * 回退链步数: 0
 * 审查清单: 自定义事件全部 ignorable（S3）；不改史、不写 KV；payload 类型源 = core/compress/ledger.ts。
 * 度量: 本文件即压缩族调用事实词汇表（07 回放原料）。
 */
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { CompactProgressFactData, CompressRunFactData } from '../core/compress/ledger.ts'
import type { PressureFireFactData } from '../core/compress/pressure.ts'
import type { HardTruncateFactData } from '../core/compress/fuse.ts'

declare module '@deepseek-ai/dsh-session/types' {
  // ignorable: 压缩调用事实为 log-only 事件，须同步并入 IgnorableSessionEventMap。
  interface SessionEventMap {
    'context-economy/compress-run': CompressRunFactData // ignorable
    'context-economy/pressure-fired': PressureFireFactData // ignorable
    'context-economy/hard-truncate': HardTruncateFactData // ignorable
    'context-economy/compact-progress': CompactProgressFactData // ignorable
  }
  interface IgnorableSessionEventMap {
    'context-economy/compress-run': CompressRunFactData // ignorable
    'context-economy/pressure-fired': PressureFireFactData // ignorable
    'context-economy/hard-truncate': HardTruncateFactData // ignorable
    'context-economy/compact-progress': CompactProgressFactData // ignorable
  }
}

export { COMPRESS_RUN_FACT_TYPE } from '../core/compress/ledger.ts'
export { PRESSURE_FIRED_FACT_TYPE } from '../core/compress/pressure.ts'
export { HARD_TRUNCATE_FACT_TYPE } from '../core/compress/fuse.ts'
export { COMPACT_PROGRESS_FACT_TYPE } from '../core/compress/ledger.ts'
export type { CompressRunFactData } from '../core/compress/ledger.ts'
export type { PressureFireFactData } from '../core/compress/pressure.ts'
export type { HardTruncateFactData } from '../core/compress/fuse.ts'
export type { CompactProgressFactData } from '../core/compress/ledger.ts'

/** 声明合并可见性锚（供类型级测试/审查引用；运行期不使用）。 */
// ignorable: 压缩调用事实键的声明合并可见性锚（供类型级测试/审查引用；运行期不使用）。
export type CompressFactMap = Pick<SessionEventMap, 'context-economy/compress-run' | 'context-economy/pressure-fired' | 'context-economy/hard-truncate' | 'context-economy/compact-progress'>

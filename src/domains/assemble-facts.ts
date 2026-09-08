/**
 * 装配事实载荷与声明合并（P17b；docs/04 §7 / docs/07 §0.5 压缩族 / docs/12 §2 编译闸）。
 * 一类 log-only 事实：assemble-run（每次装配一条；注入与档案落盘归 P19）。
 * 只做可序列化载荷与声明合并；不发射事实、不 import 运行期 harness。
 *
 * 模块: domains 装配事实面（ignorable 声明合并归口，D3 白名单）
 * 平面: L0（纯数据契约）
 * 回退链步数: 0
 * 审查清单: 自定义事件全部 ignorable（S3）；不改史、不写 KV；payload 类型源 = core/assemble/ledger.ts。
 * 度量: 本文件即压缩族事实词汇表（07 回放原料）。
 */
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { AssembleRunFactData } from '../core/assemble/ledger.ts'

declare module '@deepseek-ai/dsh-session/types' {
  // ignorable: 装配事实为 log-only 事件，须同步并入 IgnorableSessionEventMap。
  interface SessionEventMap {
    'context-economy/assemble-run': AssembleRunFactData // ignorable
  }
  interface IgnorableSessionEventMap {
    'context-economy/assemble-run': AssembleRunFactData // ignorable
  }
}

export { ASSEMBLE_RUN_FACT_TYPE } from '../core/assemble/ledger.ts'
export type { AssembleRunFactData } from '../core/assemble/ledger.ts'

/** 声明合并可见性锚（供类型级测试/审查引用；运行期不使用）。 */
// ignorable: 装配事实键的声明合并可见性锚（供类型级测试/审查引用；运行期不使用）。
export type AssembleFactMap = Pick<SessionEventMap, 'context-economy/assemble-run'>

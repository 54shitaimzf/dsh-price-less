/**
 * 剪切事实载荷与声明合并（P15b/P16；docs/03 §3/§6 / docs/07 §0.5 / docs/12 §2 编译闸）。
 * 四类 log-only 事实：shear-applied（每次落刀）/ shear-decision（hold）/
 * shear-error（执行失败，零重试）/ shear-run-plan（星标剪切清单 = 吸收证明 + 结论来源，P16）。
 * 只做可序列化载荷与去 undefined 构造；不发射事实、不 import 运行期 harness。
 *
 * 模块: domains 剪切事实面（ignorable 声明合并唯一归口，D3 白名单）
 * 平面: L0（纯数据契约）
 * 回退链步数: 0
 * 审查清单: 自定义事件全部 ignorable（S3）；不改史、不写 KV；payload 类型源 = core/shear/ledger.ts。
 * 度量: 本文件即剪切族事实词汇表（07 回放原料）。
 */
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { ShearAppliedFactData, ShearDecisionFactData, ShearErrorFactData, ShearRunPlanFactData } from '../core/shear/ledger.ts'

declare module '@deepseek-ai/dsh-session/types' {
  // ignorable: 剪切事实为 log-only 事件，须同步并入 IgnorableSessionEventMap。
  interface SessionEventMap {
    'context-economy/shear-applied': ShearAppliedFactData // ignorable
    'context-economy/shear-decision': ShearDecisionFactData // ignorable
    'context-economy/shear-error': ShearErrorFactData // ignorable
    'context-economy/shear-run-plan': ShearRunPlanFactData // ignorable
  }
  interface IgnorableSessionEventMap {
    'context-economy/shear-applied': ShearAppliedFactData // ignorable
    'context-economy/shear-decision': ShearDecisionFactData // ignorable
    'context-economy/shear-error': ShearErrorFactData // ignorable
    'context-economy/shear-run-plan': ShearRunPlanFactData // ignorable
  }
}

export {
  SHEAR_APPLIED_FACT_TYPE,
  SHEAR_DECISION_FACT_TYPE,
  SHEAR_ERROR_FACT_TYPE,
  SHEAR_RUN_PLAN_FACT_TYPE,
} from '../core/shear/ledger.ts'
export type { ShearAppliedFactData, ShearAppliedTier, ShearDecisionFactData, ShearErrorFactData, ShearRunPlanFactData } from '../core/shear/ledger.ts'

export { compactFact } from '../core/ledger/facts.ts'

/** 声明合并可见性锚（供类型级测试/审查引用；运行期不使用）。 */
// ignorable: 四型事实键的声明合并可见性锚（供类型级测试/审查引用；运行期不使用）。
export type ShearFactMap = Pick<SessionEventMap, 'context-economy/shear-applied' | 'context-economy/shear-decision' | 'context-economy/shear-error' | 'context-economy/shear-run-plan'>

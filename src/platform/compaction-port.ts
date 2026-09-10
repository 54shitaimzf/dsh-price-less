/**
 * U17 取代路线的**服务缝**：本插件向 preset 域里的薄 provider 暴露的 host 平面合同。
 *
 * 为什么必须有它（§87 §6 + §89 的机制结论）：`ctx.compaction` 在 preset 的**作用域隔离组**内
 * （`presets/standard/agent.cordis.yml:138-143` 的 `isolate: {compaction: true, toolResultPruner: true}`），
 * 而同组的 `command-compact` 解析的是**组内**实例 ⇒ host 平面直接实现 `ctx.compaction` 不被任何人解析；
 * host 平面注册 `compact` 命令也赢不了（命令解析是 scoped 遮蔽 global）。所以"用本插件取代原生压缩"
 * 只能发生在 preset 域内：组内换上一个薄 provider，它把活委派回 host 平面的压缩域——而委派需要一个
 * **在 isolate 之外**的服务名。`isolate` 只隔离**列名**服务，其余名字照常沿 fiber 链向上解析到 host
 * 平面（`boot/app-boot/tests/config-reload.spec.ts:399-438`：组内 provider 的服务留在组内 realm，
 * 根 realm 取不到；反过来未被列名的服务从组内可见）。
 *
 * 本文件只有**形状与名字**，零运行时依赖：harness import 全为 type-only（编译期擦除），
 * 因而域侧 import 它不会把 harness 运行时拖进纯核路径。
 *
 * 模块: platform 压缩服务缝（host 平面合同）
 * 平面: L0（形状声明与名字唯一构造点；无逻辑、无 IO、无服务读取）
 * 回退链步数: 不适用（纯类型 + 常量；消费侧的降级在 provider-entry.ts 单点）
 * 审查清单: 不 import core/domains；不写会话、不发事实；名字只在此构造。
 * 度量: 无 07 字段（服务缝自身不落账；落账由 host 平面压缩域照常完成）。
 */
import type { Session } from '@deepseek-ai/dsh-session'

/** host 平面服务名（唯一构造点：`index.ts` 发布它与 provider-entry 解析它共用本常量）。 */
export const CONTEXT_ECONOMY_SERVICE = 'contextEconomy'

/**
 * 一次成功落刀的**官方形状**结果。
 *
 * 契约要 8 个必填字段（`dsh-compaction/src/types.ts:96-120`），此处按**逐字段同形**承载，
 * 但刻意**不 import harness 类型**：域只回传数据，与官方 `CompactionResult` 的对齐由薄 provider
 * 单点完成（`summary` 以文本承载，由 provider 包成一个 `text` 块）。
 */
export interface CompactionProduct {
  readonly compactionId: string
  /** 事务**开标记**事件的 seq。 */
  readonly startSeq: number
  readonly summarySeq: number
  readonly endSeq: number
  readonly summaryText: string
  readonly shadowedRange: { readonly start: number; readonly end: number }
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
}

/**
 * 显式压缩（空闲手动）的结果：成功给产物，失败给**可读原因**。
 *
 * 失败**必须**是可读原因而不是异常：命令面要用它回复人类（`/compact` 的 handler 只有拿到
 * 结果或 `ManualCompactionError` 才能给出可操作的答复），而"没得压"是正常结局不是故障。
 */
export type CompactionOutcome =
  | { readonly ok: true; readonly result: CompactionProduct }
  | { readonly ok: false; readonly reason: string }

/**
 * host 平面压缩面：薄 provider 在 isolate 组内解析它（组内**只**隔离 `compaction`/`toolResultPruner`）。
 *
 * 刻意只暴露一个方法：provider 的自动触发路径（`compactIfNeeded`）一律 decline（自动触发在
 * host 平面已拥有，见 provider-entry.ts），所以缝上不需要第二个入口。`compactRegion` 同理——
 * 官方契约里没有任何调用方，见 provider-entry.ts 的说明。
 */
export interface CompactionHostFace {
  /**
   * 空闲显式压缩：压本会话一段历史，成功给产物、失败给可读原因。
   *
   * **不变量**：调用方必须已经用 `agent.runMaintenance` 取得轮间独占（本域的事务是
   * `turn: null` 的轮间独立括号，harness 属主守卫要求此刻确无开轮）。本面**不做**该守卫——
   * 它只认 `Session`，守卫属于平台侧 provider 的职责，因为只有那里拿得到 `agent`。
   */
  compactNow(session: Session): Promise<CompactionOutcome>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 见 {@link CompactionHostFace}；由插件 `apply()` 在 host 平面发布（isolate 组内可见）。 */
    contextEconomy: CompactionHostFace
  }
}

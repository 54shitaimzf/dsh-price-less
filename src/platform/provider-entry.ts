/**
 * U17 取代路线的**薄 provider**：本插件作为 `ctx.compaction` 的实现，挂在 preset 的
 * `isolate: {compaction: true}` 组内（组内不再有 `compaction-basic`，`command-compact` 保留）。
 *
 * 为什么是这个形态（§87 §6 + §89 的机制结论）：组内的 `command-compact` 解析的是**组内**的
 * `compaction` 实例，所以 host 平面实现 `ctx.compaction` 不被任何人解析；反过来，本文件在组内
 * 注册 `compaction`，而**未被 isolate 列名**的服务（`contextEconomy`）照常沿 fiber 链向上解析到
 * host 平面，于是本 provider 把活委派回 host 平面的压缩域（见 `./compaction-port.ts`）。
 *
 * 三条刻意的决定：
 * ① `compactNow` = `agent.runMaintenance(() => host.compactNow(session))`。空闲手动压缩在**轮外**
 *    发生，而本域的事务是 `turn: null` 的轮间独立括号，harness 属主守卫要求此刻确无开轮——
 *    `runMaintenance` 同时取得该独占并闩住后续唤醒（契约 `ManualCompactAgentContext` 明写）。
 *    provider 只做**一次**映射：`CompactionProduct` → 官方 8 字段，换算单点在这里。
 * ② `compactIfNeeded` 一律返回 `null`。它的**唯一**调用方是 `compaction-basic` 自己在"步准入"与
 *    "请求失败"两个瀑布上注册的钩子，而本 provider 的存在前提正是"组里没有 compaction-basic"
 *    ⇒ 这些钩子不会注册；本插件的自动触发（task 边界 + 35% 压力阀门 + 溢出保险丝）在 host 平面
 *    早已拥有。在这里再实现一遍 = 双触发（同一轮压两次、两条 `compress-run`）。
 * ③ `compactRegion` 明确拒绝。全仓唯一调用方同样是 `compaction-basic`（它自己的内部路径），
 *    host 平面的压缩只从 **task 段与压力水位**选区间（装配器/档案/事务全部以段为输入），没有
 *    "按任意 seq 区间强制压缩"的入口；与其用错的区间静默替换史，不如**响亮失败**（不改史的失败
 *    才是朝用户数据安全侧的失败）。
 *
 * 模块: platform 压缩服务缝的 provider 半边（preset 域内的挂载物）
 * 平面: L0~L1（把服务调用转成 host 平面调用；无选段、无 prompt、无装配逻辑）
 * 回退链步数: 1（host 面缺失 → `ManualCompactionError('busy')`；域侧失败 → 可读原因/明确分类）
 * 审查清单: 不 import core/domains；不改史、不 append、不发事实；只经 host 面委派。
 * 度量: 无自有 07 字段——落刀照常由 host 平面压缩域发 `compress-run` 事实（本层零计量）。
 */
import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
  type CompactionAgentContext,
  type CompactionResult,
  type CompactionTrigger,
  type ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  CONTEXT_ECONOMY_SERVICE,
  type CompactionHostFace,
  type CompactionProduct,
} from './compaction-port.ts'

export const name = 'dsh-price-less-provider'

/**
 * host 面缺失时**不是**崩溃而是"当前不可用"：只有 `contextEconomy` 未被发布时才会走到
 * （profile 未加载本插件却挂了本 preset 的 provider 行），此时挂载期就会如实报"waiting for
 * contextEconomy"（`agent-presets/src/mount.ts` 的 `inactiveRows`），这里只是运行期的第二道明确答复。
 */
const HOST_MISSING = 'context-economy: host-plane compaction face (contextEconomy) is unavailable'

/**
 * "没有可压的东西"= 官方契约里的 `null`，不是失败。
 *
 * `compactNow` 的契约明写"return `null` when no safe useful range exists"，`/compact` 对 `null`
 * 回复"No compactable history yet."——这些原因正是"此刻无可压"，报成错误会让人以为出了问题。
 * 其余原因（LLM/缩水/存储/事务/区间失效）才是失败，必须分类作答。
 */
const NOTHING_TO_COMPACT: ReadonlySet<string> = new Set([
  'no-session',
  'no-task',
  'range-empty',
  'no-units',
  'already-compacted',
  'no-next-boundary',
])

/**
 * 域侧可读原因 → 官方失败分类（人话由 `command-compact` 按分类渲染，故分类要贴近真实原因）。
 * @param reason - 压缩域给出的可读原因（`CompactionOutcome.reason`）。
 * @returns 官方枚举里最贴近的一项。
 */
function classifyFailure(reason: string): 'busy' | 'changed' | 'summary' | 'commit' | 'persistence' {
  if (reason === 'disposed') return 'busy'
  if (reason === 'storage') return 'persistence'
  if (reason.startsWith('txn-')) return 'commit'
  if (reason === 'llm-unavailable' || reason === 'parse' || reason === 'schema' || reason === 'shrink') return 'summary'
  return 'changed'
}

/**
 * 域产物 → 官方结果契约（`dsh-compaction/src/types.ts:96-120`，8 个必填字段）。
 *
 * `SessionSeq(x)` 是**校验构造器**（非负安全整数，否则抛）：这里刻意用它而不是裸 cast，
 * 让"本插件回传的 seq 是不是真 seq"在 provider 边界就被查一次。
 * @param product - 域侧产物。
 * @param sourceCommandId - 发起本次压缩的命令身份（手动路径有、自动路径无）。
 * @returns 官方形状的结果。
 */
function toResult(product: CompactionProduct, sourceCommandId?: CommandId): CompactionResult {
  return {
    compactionId: CompactionId(product.compactionId),
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    startSeq: SessionSeq(product.startSeq),
    summarySeq: SessionSeq(product.summarySeq),
    endSeq: SessionSeq(product.endSeq),
    summary: [{ type: 'text', text: product.summaryText }],
    shadowedRange: { start: SessionSeq(product.shadowedRange.start), end: SessionSeq(product.shadowedRange.end) },
    shadowedSeqs: product.shadowedSeqs.map((seq) => SessionSeq(seq)),
    shadowedTokenCount: product.shadowedTokenCount,
  }
}

/**
 * 本插件的压缩引擎：把 `ctx.compaction` 的显式入口委派回 host 平面的压缩域。
 *
 * 注册位置由 preset 决定：行必须与 `command-compact` 同在 `isolate: {compaction: true}` 组内，
 * 否则（放在组外或 host 平面）注册的实例不会被组内的命令解析到。
 */
export class PriceLessCompactionEngine extends CompactionEngine {
  /**
   * `contextEconomy` 是 host 平面发布的服务（`src/index.ts` 的 `apply()`）。
   * 只声明这一个依赖：本 provider 不碰 llm/tokenMeter/sessions——计量与路由都在 host 平面那侧。
   */
  static inject = [CONTEXT_ECONOMY_SERVICE]

  /** host 面；缺失 → `undefined`（调用点各自给出明确答复，不抛裸 TypeError）。 */
  private host(): CompactionHostFace | undefined {
    return this.ctx.get(CONTEXT_ECONOMY_SERVICE)
  }

  /**
   * 自动触发一律 decline——理由见文件头 ②：真正的自动路径在 host 平面，这里返回 `null` 是
   * 契约允许的"无需/无法压缩"，不是失败（返回非 null 反而会与 host 平面双触发）。
   */
  override async compactIfNeeded(
    _agent: CompactionAgentContext,
    _trigger: CompactionTrigger,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    return null
  }

  /**
   * 空闲显式压缩（`/compact` 的后端）。契约要求：先取得轮间独占再动异步，命中即回官方结果，
   * 无可用区间回 `null`，失败抛分类明确的 `ManualCompactionError`。
   */
  override async compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return await agent.runMaintenance(async (agentSignal) => {
        const operation = AbortSignal.any([agentSignal, signal])
        operation.throwIfAborted()
        const face = this.host()
        if (face === undefined) throw new ManualCompactionError('busy', HOST_MISSING)
        const outcome = await face.compactNow(agent.session)
        if (!outcome.ok) {
          if (NOTHING_TO_COMPACT.has(outcome.reason)) return null
          throw new ManualCompactionError(
            classifyFailure(outcome.reason),
            `context-economy: explicit compaction declined (${outcome.reason})`,
          )
        }
        // 落刀之后**不再**查中止：产物已进日志，此时报"取消"会让人类以为白压了。
        return toResult(outcome.result, sourceCommandId)
      })
    } catch (error: unknown) {
      if (error instanceof ManualCompactionError) throw error
      // 中止优先于一切包装（契约：an aborted request preserves its exact abort reason）。
      signal.throwIfAborted()
      throw new ManualCompactionError(
        'busy',
        'context-economy: manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /**
   * 拒绝强制区间压缩（理由见文件头 ③）。**必须响亮**：静默压错区间比不压危险得多。
   * @throws 恒抛；本插件没有"按任意 seq 区间强制压缩"的入口。
   */
  override async compactRegion(
    _start: SessionSeq,
    _end: SessionSeq,
    _agent: CompactionAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    signal?.throwIfAborted()
    throw new Error(
      'dsh-price-less: compactRegion is not implemented — this provider compacts only ranges it selects '
      + 'itself (task boundaries and pressure watermarks) and exposes no forced-range entry; '
      + 'use compactNow for idle manual compaction',
    )
  }
}

export default PriceLessCompactionEngine

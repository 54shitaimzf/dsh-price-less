/**
 * 辅助 LLM 端口（H12 契约锚；P5 补齐 stream/usage 回执）。
 *
 * 宿主现状（docs/12 §1 C2）：`GenerateOptions.purpose` 仅
 * `'compaction' | 'session-title'`，且该 interface 的属性不能经声明合并宽化
 * （TS2717）。本文件因此建立**插件侧类型适配单点**：判别/断面/压缩的 purpose
 * 先走 `CeAuxPurpose` 本地词汇，`toHarnessGenerateOptions` 是唯一向宿主类型的
 * 收窄点（cast 只许出现在这里，D6 断言锁定）。
 * 运行期语义：DeepSeek adapter 只对 `compaction`/`session-title` 有特殊策略，
 * 未知 purpose 不会改变 wire 请求形状；度量分账由本插件按调用侧 purpose 记录，
 * 不依赖 wire 回显。宿主将来宽化 union 后删除本地适配层即可。
 *
 * 模块: platform 辅助 LLM 端口（唯一 harness 触点层）
 * 平面: L0（类型适配 + 流透传 + usage 回执；无模型、无机制逻辑）
 * 回退链步数: 1（服务缺失 → CE_LLM_UNAVAILABLE 终止块，调用侧 fail-lazy，不抛）
 * 审查清单: 零 cordis 运行时 import；cast 仅存在于 toHarnessGenerateOptions；
 *           本文件不发起机制调用（调用编排归 P10/P11/P18）。
 * 度量: usage 回执形状（docs/07 §2/§5、docs/06 §4/§6）；入账归后续工单。
 */

import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
// Type-only：拉入 dsh-llm 的 Context merge（ctx.llm 服务键）。
import type {} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'

/** 插件辅助调用 purpose 词汇（host 未宽化前只活在 platform/llm.ts；docs/12 §1 C2）。 */
export const CE_AUX_PURPOSES = [
  'context-economy-judge',
  'context-economy-optimize',
  'context-economy-compaction',
] as const

export type CeAuxPurpose = (typeof CE_AUX_PURPOSES)[number]

/** 宿主已支持 purpose 与插件自定义 purpose 的并集（插件侧宽化形态）。 */
export type CePurpose = CeAuxPurpose | 'compaction' | 'session-title'

/** 辅助调用选项：除 purpose 宽化外，与宿主 GenerateOptions 完全同构。 */
export type CeGenerateOptions = Omit<GenerateOptions, 'purpose'> & { purpose?: CePurpose }

/**
 * 插件侧唯一 cast 点：把宽化 purpose 选项收窄为宿主 GenerateOptions。
 * 宿主 adapter 对未知 purpose 无特殊策略；该值仍会传给 request extension 面。
 */
export function toHarnessGenerateOptions(options: CeGenerateOptions): GenerateOptions {
  return options as GenerateOptions
}

/** dsh-llm 的最小调用面（P5 端口消费；此处只声明，不发调用）。 */
export interface CeLlmStreamService {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** 解析 llm 服务（可选能力；未装配 → undefined，调用侧 fail-lazy）。 */
export function resolveLlmService(ctx: Pick<Context, 'llm'>): CeLlmStreamService | undefined {
  return ctx.llm
}

/** 插件侧 usage 回执（与 core/ledger TokenUsageLike 结构同构；可选键缺失时省略）。 */
export interface CeLlmUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** 一次辅助调用的 usage 回执：调用侧 purpose + 请求路由 + 用量。 */
export interface CeLlmUsageReceipt {
  /** 与请求一致（宽化词汇：CE_AUX_PURPOSES 三值 ∪ 宿主两值）。 */
  purpose?: CePurpose
  provider: string
  model: string
  usage: CeLlmUsage
}

export interface CeLlmStreamHooks {
  /** usage 块首次到达时单次回调；无 usage 不回调。 */
  onUsage?: (receipt: CeLlmUsageReceipt) => void
  /** fail-lazy 诊断通道；未提供时仅以终止块表达失败（不静默）。 */
  logger?: { warn: (...args: unknown[]) => void }
}

/** TokenUsage → CeLlmUsage 纯映射；可选字段缺失时省略键；零算术、零估算。 */
export function toCeLlmUsage(usage: TokenUsage): CeLlmUsage {
  const result: CeLlmUsage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  }
  if (usage.totalTokens !== undefined) result.totalTokens = usage.totalTokens
  if (usage.cacheReadTokens !== undefined) result.cacheReadTokens = usage.cacheReadTokens
  if (usage.cacheWriteTokens !== undefined) result.cacheWriteTokens = usage.cacheWriteTokens
  if (usage.reasoningTokens !== undefined) result.reasoningTokens = usage.reasoningTokens
  return result
}

/**
 * 辅助 LLM 调用端口：resolveLlmService → toHarnessGenerateOptions → llm.stream。
 * 服务缺失：warn + yield CE_LLM_UNAVAILABLE 终止块（fail-lazy，不抛）。
 * usage 回执：首个 usage 块触发 hooks.onUsage 一次；流块全部原样透传。
 */
export async function* streamCeLlm(
  ctx: Pick<Context, 'llm'>,
  options: CeGenerateOptions,
  hooks?: CeLlmStreamHooks,
): AsyncIterable<StreamChunk> {
  const service = resolveLlmService(ctx)
  if (service == null) {
    hooks?.logger?.warn('context-economy: llm service unavailable (fail-lazy)')
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'context-economy: llm service unavailable (fail-lazy)',
          code: 'CE_LLM_UNAVAILABLE',
        },
      },
    }
    return
  }

  let usageSeen = false
  for await (const chunk of service.stream(toHarnessGenerateOptions(options))) {
    if (chunk.type === 'usage' && !usageSeen) {
      usageSeen = true
      hooks?.onUsage?.({
        purpose: options.purpose,
        provider: options.provider,
        model: options.model,
        usage: toCeLlmUsage(chunk.usage),
      })
    }
    yield chunk
  }
}

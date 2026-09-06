/**
 * 辅助 LLM 端口（H12 契约锚；P5 在此补齐 stream/usage 回执）。
 *
 * 宿主现状（docs/12 §1 C2）：`GenerateOptions.purpose` 仅
 * `'compaction' | 'session-title'`，且该 interface 的属性不能经声明合并宽化
 * （TS2717）。本文件因此建立**插件侧类型适配单点**：判别/断面/压缩的 purpose
 * 先走 `CeAuxPurpose` 本地词汇，`toHarnessGenerateOptions` 是唯一向宿主类型的
 * 收窄点（cast 只许出现在这里，后续可由 D 族断言锁定）。
 * 运行期语义：DeepSeek adapter 只对 `compaction`/`session-title` 有特殊策略，
 * 未知 purpose 不会改变 wire 请求形状；度量分账由本插件按调用侧 purpose 记录，
 * 不依赖 wire 回显。宿主将来宽化 union 后删除本地适配层即可。
 *
 * 模块: platform 辅助 LLM 端口（唯一 harness 触点层）
 * 平面: L0（类型适配 + 服务解析；无模型、无机制逻辑）
 * 回退链步数: 1（失败默认保留——服务缺失时调用侧走 fail-lazy，本层不代理行为）
 * 审查清单: 零 cordis 运行时 import；cast 仅存在于 toHarnessGenerateOptions；
 *           本文件不发起任何 LLM 调用（调用编排归 P5）。
 * 度量: 无新增（usage 回执记账随 P5 落位，字段见 docs/07）。
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
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
export function resolveLlmService(ctx: Context): CeLlmStreamService | undefined {
  return ctx.llm
}

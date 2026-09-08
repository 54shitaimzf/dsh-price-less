/**
 * 两模式压缩 prompt 组装（docs/04 §2 边界 / §3 压力；docs/11 §4 提示词纪律；P18）。
 * 静态模板在前、实例参数在后；压缩器输入尾部机械追加单元清单（04 §2）。
 * 模板内零预算数字——"禁止任何预算计算"是硬规则（模型零算术；计量/裁剪/取真归 harness）。
 *
 * 模块: core 压缩调用纯核（prompt 组装）
 * 平面: L0（确定性字符串组装；零模型、零 IO）
 * 回退链步数: 0（渲染不失败；产物解析失败语义在 product.ts）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D13）；不读盘、不写事实、不改史。
 * 度量: regionTokens 由本层机械计量（07 压缩族事实面；不进模型视野）。
 */
import { renderUnitList } from '../assemble/assemble.ts'
import type { ArchiveEntry, AssembleUnit } from '../assemble/types.ts'
import { estimateTokens } from '../ledger/fold.ts'
import {
  COMPRESS_PROMPT_VERSION,
  DEFAULT_COMPRESS_POLICY,
  type CompressMode,
  type CompressPolicy,
  type CompressPromptInput,
  type CompressPromptRender,
} from './types.ts'

/** 边界 persona（静态常量；逐字节固定）。 */
export const COMPRESS_BOUNDARY_HEAD = [
  '你是上下文压缩器。你不是执行者，也不继续该任务。',
  '本消息中 <闭合段原文> 是一段已经完成的工作；你的唯一职责是把它压成一份可供后续任务直接使用的档案。',
].join('\n')

/** 边界硬规则（04 §2 / F9：总述零事实 + 分步带引用 + 热尾承载全部事实）。 */
export const COMPRESS_BOUNDARY_RULES = [
  '硬规则（逐条遵守）：',
  '1. 只压缩 <闭合段原文> 这一段。<已归档检查点> 是既有字节：原样续传，绝不重写、绝不并入新结构。',
  '2. 只输出一个 JSON 对象：无正文、无代码块围栏、无解释、无元注释。',
  '3. gist = 总述：只写总目标与改动方向，≤80 字，**零事实**——不写路径、版本号、数字、命令、引号内文本。',
  '4. steps = 总目标的落地过程，按发生顺序（不是按类别拆分）；type ∈ plan|impl|verify|decide|note；每条 ≤120 字；',
  '   refs = 该步依赖的热尾条目序号（hotTail 数组下标 + 1；没有依赖就省略）；不要算预算、不要凑数量。',
  '5. 所有事实（路径、版本、行号、命令、数值、错误串、引号内文本）一律放进 hotTail——那里逐字保真。',
  '6. hotTail = 下一个任务开工真正要用的任务材料，按重要性降序申报；每项 = 1 条指针 : 1 条内容；禁止任何预算计算。',
  '7. hotTail 每项 = {"unitId":"<清单 ID>","coord":{"path":"...","version":N,"lineRange":{"start":a,"end":b}},"fact":"逐字摘抄（可选）"}；',
  '   coord 仅文件类单元可带；fact 必须是该单元原文的逐字子串（机器校验，不匹配即丢弃）。',
  '8. coord 的 path 与 version 只能从 <单元清单> 抄写（选坐标不造坐标）；行号用你见过的版本；不确定就省略 lineRange。',
].join('\n')

export const COMPRESS_BOUNDARY_OUTPUT = [
  '输出 JSON 形状（严格）：',
  '{"gist":"...","steps":[{"type":"plan|impl|verify|decide|note","text":"...","refs":[1,3]}],"hotTail":[{"unitId":"...","coord":{"path":"...","version":1,"lineRange":{"start":1,"end":10}},"fact":"可选逐字摘抄"}]}',
].join('\n')

/** 压力 persona（静态常量）。 */
export const COMPRESS_PRESSURE_HEAD = [
  '你是上下文压缩器，运行在一个尚未结束的任务中。你不是执行者。',
  '本消息中 <折叠区原文> 是已经做过的部分；你的职责是折出一份进行时检查点，让同一个任务能接着往下做。',
].join('\n')

/** 压力硬规则（04 §3：检查点 + 缝；不宣称最终事实）。 */
export const COMPRESS_PRESSURE_RULES = [
  '硬规则（逐条遵守）：',
  '1. 只压缩 <折叠区原文>。<已归档检查点> 是既有字节：原样续传，绝不重写、绝不并入新结构。',
  '2. 只输出一个 JSON 对象：无正文、无代码块围栏、无解释、无元注释。',
  '3. 检查点受众 = 当前任务的自己：progress（已完成到哪）/ currentState（现在什么为真）/ nextStep（下一步）/ liveConstraints（仍然生效的约束）。这是进行时状态，不宣称最终事实。',
  '4. cutPoint = 最后一个子任务的起点，只能从 <单元清单> 选 unitId；缝必须落在单元边界，不得切开 tool_call 与其 tool_result 对。',
  '5. 路径、版本号、命令、数值、错误串逐字保留；不嵌原文、不写元注释。',
  '6. 不申报热尾（热尾申报是边界压缩器专属产出）。',
].join('\n')

export const COMPRESS_PRESSURE_OUTPUT = [
  '输出 JSON 形状（严格）：',
  '{"checkpoint":{"progress":"...","currentState":"...","nextStep":"...","liveConstraints":["..."]},"cutPoint":{"unitId":"..."}}',
].join('\n')

/** 机制 A 续传面：旧检查点逐条原样列出（stub 不可重压律；空链 = 空串）。 */
export function renderPriorChain(entries: readonly ArchiveEntry[]): string {
  if (entries.length === 0) return ''
  const body = entries.map((entry) => `--- ${entry.taskId} ---\n${entry.text}`).join('\n\n')
  return `<已归档检查点（原样续传，禁止改写）>\n${body}\n</已归档检查点>`
}

/** 单元清单（04 §2 机械追加；上限 >0 时保留最近单元 + 计数，0 = 不限）。 */
export function compressUnitList(
  units: readonly AssembleUnit[],
  policy: CompressPolicy = DEFAULT_COMPRESS_POLICY,
): { text: string; listed: number; omitted: number } {
  const cap = policy.maxUnitListEntries
  const listed = cap > 0 && units.length > cap ? units.slice(units.length - cap) : units
  return { text: renderUnitList(listed), listed: listed.length, omitted: units.length - listed.length }
}

function renderPrompt(mode: CompressMode, input: CompressPromptInput): CompressPromptRender {
  const policy = input.policy ?? DEFAULT_COMPRESS_POLICY
  const boundary = mode === 'boundary'
  const priorChain = input.priorChain ?? []
  const list = compressUnitList(input.units, policy)
  const sections = [
    boundary ? COMPRESS_BOUNDARY_HEAD : COMPRESS_PRESSURE_HEAD,
    boundary ? COMPRESS_BOUNDARY_RULES : COMPRESS_PRESSURE_RULES,
    boundary ? COMPRESS_BOUNDARY_OUTPUT : COMPRESS_PRESSURE_OUTPUT,
    renderPriorChain(priorChain),
    `${boundary ? '<闭合段原文>' : '<折叠区原文>'}\n${input.regionText}`,
    list.text === '' ? '' : `<单元清单>\n${list.text}\n</单元清单>`,
  ].filter((part) => part !== '')
  return {
    mode,
    version: COMPRESS_PROMPT_VERSION,
    prompt: sections.join('\n\n'),
    regionTokens: estimateTokens(input.regionText, policy.density),
    unitCount: input.units.length,
    listedUnits: list.listed,
    omittedUnits: list.omitted,
    priorChainCount: priorChain.length,
  }
}

export function renderBoundaryPrompt(input: CompressPromptInput): CompressPromptRender {
  return renderPrompt('boundary', input)
}

export function renderPressurePrompt(input: CompressPromptInput): CompressPromptRender {
  return renderPrompt('pressure', input)
}

/**
 * 判别器 prompt 模板（生产固化）与输入窗组装（v6 冻结口径）。
 *
 * 模块: 判别器提示词面
 * 平面: L0（确定性模板常量 + 纯函数裁剪；模板在前、实例参数在后——字节稳定）
 * 回退链步数: 1（模板版本 = 版本化常量；未注册版本回退 v2.2 并记 config 错误）
 * 审查清单: 模板与 datasets/prompt-discriminator-v2.2.txt 逐字节同源（定稿）；
 *           窗口口径与 phase_b_prep.mjs 冻结完全同构（测试口径 = 生产口径）：
 *           anchor ≤350 / 每条 patch ≤350 / target ≤800（头 600 尾 200，中缀截断标记）；
 *           裁剪只做头尾截断、不改写内容（用户原文逐字保留——宪法）；
 *           占位符替换用 split/join（不误伤规则文本内的其他花括号）；
 *           模块自证附于本头注释。
 * 度量: judgeInputTokens / windowChars（docs/07 §18）
 */

/** 窗口长度阀（v5/v6 冻结口径，scripts/phase_b_prep.mjs 同源）。 */
export const DISC_WINDOW_CAPS = {
  anchor: 350,
  patch: 350,
  target: 800,
  targetHead: 600,
  targetTail: 200,
  /** 段内窗口 patch 条数（实验"最近 2 条"固定口径；引擎 historyWindow 默认与此一致）。 */
  patches: 2,
} as const

/** 头截断（保留前 cap 字符 + 截断标记；与冻结 clampHead 逐字符一致）。 */
export function clampWindowHead(text: string, cap: number): string {
  const t = String(text)
  return t.length <= cap ? t : `${t.slice(0, cap)}\n…[truncated]…`
}

/** 目标截断（头 head + 尾 tail + 中缀截断标记；与冻结 clampTarget 逐字符一致）。 */
export function clampWindowTarget(text: string): string {
  const t = String(text)
  if (t.length <= DISC_WINDOW_CAPS.target) return t
  return `${t.slice(0, DISC_WINDOW_CAPS.targetHead)}\n…[truncated]…\n${t.slice(-DISC_WINDOW_CAPS.targetTail)}`
}

/** 待渲染窗（已应用长度阀；纯数据）。 */
export interface DiscWindow {
  anchor: string
  patches: string[]
  target: string
}

/**
 * 组装输入窗（应用冻结长度阀，逐字保留用户内容）。
 * @param patches - 时间升序的段内历史用户消息；内部取最近 N 条（默认 2，v6 口径）。
 */
export function buildDiscWindow(
  anchor: string,
  patches: readonly string[],
  target: string,
  patchWindow: number = DISC_WINDOW_CAPS.patches,
): DiscWindow {
  return {
    anchor: clampWindowHead(anchor, DISC_WINDOW_CAPS.anchor),
    patches: patches
      .map(patch => clampWindowHead(patch, DISC_WINDOW_CAPS.patch))
      .slice(-patchWindow),
    target: clampWindowTarget(target),
  }
}

/** 生产 prompt 模板表（v1→v2→v2.1→v2.2 四代已验证，生产锁定 v2.2——phase-b-v22.md 定稿）。 */
export const DISC_PROMPTS: Readonly<Record<'v2.2', string>> = {
  'v2.2': `你是会话任务边界判别器。用户消息是任务边界的唯一来源。对 <target> 判定相对任务上下文是否开启新任务。只输出一个 JSON 对象：{"decision":"new_task"|"continue"}，无其他文本。

判定参照：
- 任务上下文 = <anchor> 与 <history> 补丁构成的连续推进；<history> 中最近一条用户消息是任务的最新进展，为主要参照；<anchor> 是更早背景。
- 以下先决排除（任一命中即判 continue，不再往下检查）。

先决排除：
1) 言说层：target 是追问/澄清/报错/汇报/粘贴工具输出或日志/讲解/质询/观点交流/方案设计/评估标准/方法或规则讨论/根因讨论。这类内容是当前工作的言说层，与讨论对象是否变化无关。
2) 收尾层：同一任务的收口/清理残余与过期内容/更新文档/审计/复盘。
3) 无法确定。

以上均不命中才进入以下检查（命中任一 = new_task）：
4) 宣布/承诺/命令链：target 含发起性语句（"我打算"/"我希望你先"/"接下来需要你"/"交给你N个任务"/"先给我创建"/"咱们测试一下"/"准备做"/"开始做"/"现在动手"/"再来一次并"等）且带明确实操目标（做/创建/测试/落地/实现/重构/审查/验证/嵌入等）——这是用户发动新工作的信号，即使句中也包含讨论或说明。只有"打算/想"而无具体目标动作的不算。
5) 换意图：target 用户要做的事（目标产物/命令/决定）与任务上下文不同，不是同一件事的推进。注意：讨论、讲解、方案、评估标准、观点、方法属于言说层（已排除），其话题变化不算换意图。
6) 换对象：target 针对的工作对象（文件/项目/产物/工具/代码库）变化；测试或审查的对象主题变化也算对象变化（如从测判别器准确率转为测embedding性能）。讨论中被提及的概念对象不算工作对象。
7) 换域：领域/项目/主题域真实变化（如从缓存机制跳到文件治理）。
8) 换形态：任务上下文内一直是言说推进（讨论/理解/咨询/建议），target 首次出现实操动词（挑选/跑/判定/init/创建/落地/训练/验证/审查/写代码/建项等），即"说→做"。注意：上下文已有实操（找/搜/写/测），target 继续实操属于执行链内的子步骤，不是换形态。
9) 中止重开：否定整个任务目标 + 明确新命令；方案细节的否定与迭代属于同一任务的讨论，不算。

否则 = continue，包括：同一工作进行、细化、推进、对工作本身的讨论等。

<anchor>{ANCHOR}</anchor>
<history>{PATCHES}</history>
<target>{TARGET}</target>`,
}

/** 默认生产版本（v2.2 定稿——phase-b-v22.md §5；配置未识别版本时回退到此并记 config 错误）。 */
export const DISC_PROMPT_DEFAULT_VERSION = 'v2.2' as const

/** 支持的生产 prompt 版本集合。 */
export type DiscPromptVersion = keyof typeof DISC_PROMPTS

/**
 * 渲染判别提示词（模板在前、实例参数在后——字节稳定）。
 * @returns 渲染结果；版本未注册（配置漂移）→ undefined（调用方降级 + 记录 config 错误）。
 */
export function renderDiscPrompt(version: string, window: DiscWindow): string | undefined {
  const template = DISC_PROMPTS[version as DiscPromptVersion]
  if (template === undefined) return undefined
  const patches = window.patches.join('\n')
  return template.split('{ANCHOR}').join(window.anchor)
    .split('{PATCHES}').join(patches)
    .split('{TARGET}').join(window.target)
}

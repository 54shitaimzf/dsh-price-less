/**
 * 判别器（任务边界语义判定）模型预设表 + 能力矩阵（版本化只读常量）。
 *
 * 模块: 判别器配置面（docs/12 §5 子开关之外的新增面——模型选择面）
 * 平面: L0（确定性数据表；模型只负责判定语义，不负责选择）
 * 回退链步数: 0（常量表，无 LLM 参与）
 *
 * 版本协议: DISC_PRESETS_V1 / DISC_CAPABILITIES_V1（docs/09；单一事实源 =
 * 本文件 + reports/phase-b-effort-support.md 账本，两处同源不许漂移）。
 *
 * 数据来源（全部为已落盘实测账本，非推测）:
 * - 模型效果: reports/phase-b-v22.md（52 条 DSH 真实会话样本，三模型三意图面板）
 * - 综合成本: reports/phase-b-total-cost.md（饱和成本/错误机会成本/双判否决）
 * - 思考强度支持（本轮）: reports/phase-b-effort-support.md——官方 API 文档 +
 *   声明路径实测（low≈58 字符 vs max≈262 字符思考，6 样本分布稳定）；
 *   GLM 经网关实测无效；gateway 对 minimax/hy3/qwen/mimo 无 effort 转译分支。
 *
 * 诚实边界:
 * - effort 只列"显式发送且实测改变模型行为"的档位；'off' 退化为"不发送
 *   参数"（DSH 语义，非真关思考）——不进入能力表。
 * - 未验证组合不传参（确定性优先：宁可默认档，不发伪参数）。
 */

export type DiscPresetId = 'minimax' | 'hy3' | 'v4-low'

/** 判别器调用参数（materialize 后的最终形状）。 */
export interface DiscCallConfig {
  provider: string
  model: string
  promptVersion: 'v1' | 'v2' | 'v2.1' | 'v2.2'
  temperature: number
  maxTokens: number
  /** 'none' = 不发送 reasoningEffort（默认档）；其余为实测有效档位。 */
  effort: 'none' | 'low' | 'high' | 'max'
}

/** 一个预设 = 一份可直接套用的调用参数（"一键应用"的数据源）。 */
export interface DiscPreset {
  /** 预设名（UI 展示）。 */
  name: string
  /** 一句话定位（不暴露测试细节；只给语义与取舍）。 */
  pitch: string
  config: DiscCallConfig
}

/**
 * 模型预设表 v1（版本化；改数据 = 升版本，禁止原地改）。
 *
 * 全局默认 = 'minimax'（综合最优：准确率与切换召回双高 + 成本中间档；
 * 详见 reports/phase-b-total-cost.md 最终推荐）。
 */
export const DISC_PRESETS: Record<DiscPresetId, DiscPreset> = {
  minimax: {
    name: 'MiniMax M3（推荐默认）',
    pitch: '综合最优：语义判定精度与任务切换召回双高，成本居中；判别器主判。',
    config: {
      provider: 'opencode-go',
      model: 'minimax-m3',
      promptVersion: 'v2.2',
      temperature: 0,
      maxTokens: 400,
      effort: 'none',
    },
  },
  hy3: {
    name: 'Hy3（零误切）',
    pitch: '每判成本最低、误切最少（保守型产品推荐）；任务切换召回弱于默认档。',
    config: {
      provider: 'opencode-go',
      model: 'hy3',
      promptVersion: 'v2.2',
      temperature: 0,
      maxTokens: 200,
      effort: 'none',
    },
  },
  'v4-low': {
    name: 'DeepSeek V4 Flash · low（平衡档）',
    pitch: '思考强度压至最低（实测低档 58 字符 vs 满档 262），切换召回优于 hy3；'
      + '每判成本约 2.2 倍默认档（峰值计价），仅作自选。',
    config: {
      provider: 'opencode-go-v4',
      model: 'deepseek-v4-flash',
      promptVersion: 'v2.2',
      temperature: 0,
      maxTokens: 400,
      effort: 'low',
    },
  },
}

/** 默认预设（全局默认配置 = 综合最好）。 */
export const DEFAULT_DISC_PRESET: DiscPresetId = 'minimax'

/**
 * 判别调用单价表 v1（USD / 1M tokens；来源 = reports/phase-b-total-cost.md 账本，
 * 与本文件预设的 provider@model 对齐）。缺失条目 → 成本记 null（诚实：无可信单价不算）。
 * 注意 v4 走网关=峰值 2x 计价（此表用 off-peak 价；网关计价在账本另注）。
 */
export interface DiscPricing {
  inputUsdPerM: number
  outputUsdPerM: number
  cacheReadUsdPerM: number
}

export const DISC_PRICING: Readonly<Record<string, DiscPricing>> = {
  'opencode-go@minimax-m3': { inputUsdPerM: 0.30, outputUsdPerM: 1.20, cacheReadUsdPerM: 0.06 },
  'opencode-go@hy3': { inputUsdPerM: 0.14, outputUsdPerM: 0.58, cacheReadUsdPerM: 0.035 },
  // off-peak；峰值（网关 2x）为 0.44 / 1.32 / 0.014——账本另有峰值口径。
  'opencode-go-v4@deepseek-v4-flash': { inputUsdPerM: 0.22, outputUsdPerM: 0.66, cacheReadUsdPerM: 0.007 },
}

/** 成本分解（细项 USD；billed input = 未缓存输入 + 缓存读，各自单价）。 */
export interface JudgeCost {
  /** 合计（USD，6 位小数）。 */
  usd: number
  inputUsd: number
  outputUsd: number
  cacheReadUsd: number
}

/**
 * 单次判别成本估算（纯函数，确定性）。
 * 输入 = DSH TokenUsage 语义：inputTokens 未缓存、cacheReadTokens 单独、outputTokens。
 * 单价缺失 → 返回 null（不猜价——诚实边界）。
 */
export function estimateJudgeCost(usage: {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
} | undefined, pricing: DiscPricing | undefined): JudgeCost | null {
  if (usage === undefined || pricing === undefined) return null
  const inputUsd = (usage.inputTokens ?? 0) / 1e6 * pricing.inputUsdPerM
  const outputUsd = (usage.outputTokens ?? 0) / 1e6 * pricing.outputUsdPerM
  const cacheReadUsd = (usage.cacheReadTokens ?? 0) / 1e6 * pricing.cacheReadUsdPerM
  const usd = inputUsd + outputUsd + cacheReadUsd
  return { usd, inputUsd, outputUsd, cacheReadUsd }
}

/**
 * 模型能力记录：该模型的 effort 显式档位（实测/官方文档验证）。
 *
 * 两层语义（跨版本自动适配的分层，reports/phase-b-effort-support.md §8）:
 * - 本表的 effortLevels 是「行为验证层」——显式发送且实测改变模型行为
 *   的档位；只有人工复核（升级/网关变更）才更新，是**保守上限**。
 * - 「发送许可层」始终来自运行时查 `llm.resolveModelInfo(...).reasoning.efforts`
 *   （DSH 当前视角，自动跟随适配器/配置/网关能力变化）。
 * - 最终发送 = 两层交集（见 sanitizeEffort）；交集外一律不发送（默认档）。
 */
export interface DiscModelCapability {
  /** 显式发送且实测改变模型行为（或官方文档+代码双证）的档位；空 = 不传。 */
  effortLevels: ReadonlyArray<'low' | 'high' | 'max'>
  /** 验证途径: 'measured'（本机实测）/ 'official-api'（官方文档+适配器代码）/ 'none'。 */
  verifiedBy: 'measured' | 'official-api' | 'none'
  /** 一句话事实（不写测试细节）。 */
  note: string
}

/**
 * 能力矩阵 v1。
 *
 * 调用层的纪律（兼容性修复核心）:
 * 1. 只对能力表里有档位的 provider@model 发送 reasoningEffort；
 * 2. 其余一律"不发送"（default 档），不因配置里存在 effort 而强行传参；
 * 3. 'off' 不在能力表——DSH 侧 off=省略参数，不是关闭思考。
 */
export const DISC_CAPABILITIES: Readonly<Record<string, DiscModelCapability>> = {
  'opencode-go-v4@deepseek-v4-flash': {
    effortLevels: ['low', 'high', 'max'],
    verifiedBy: 'measured',
    note: '声明路径 + 网关转译实测生效；low 档思考约压缩至 1/4。off 值会报错（网关透传，上游不认）。',
  },
  'deepseek-official@deepseek-v4-flash': {
    effortLevels: ['low', 'high', 'max'],
    verifiedBy: 'official-api',
    note: '官方 API 原生 thinking 支持（low/high/max；medium/xhigh 映射 high）；思考模式下 temperature 无效。',
  },
  'deepseek-official@deepseek-v4-flash-vision-exp': {
    effortLevels: ['low', 'high', 'max'],
    verifiedBy: 'official-api',
    note: '官方 API（当前主模型档位）。',
  },
  'opencode-go-glm53@glm-5.3-flash': {
    effortLevels: [],
    verifiedBy: 'none',
    note: '声明路径实测 max/默认/off 思考长度无差异——网关未转译 GLM 或模型对档位不敏感；不传。',
  },
  'opencode-go-glm53@glm-5.3': {
    effortLevels: [],
    verifiedBy: 'none',
    note: '同 glm-5.3-flash（未单独实测，按同一网关分支结论处理）。',
  },
  // 发现路径（opencode-go）：DSH 对无声明模型不发送推理参数；minimax-m3 虽被
  // pi-ai 内置目录标记档位（off/minimal/low/medium/high，resolveModelInfo 可见），
  // 但网关无 minimax 转译分支且模型直出（无 thinking 流）——实测层仍判不支持。
  'opencode-go@*': {
    effortLevels: [],
    verifiedBy: 'none',
    note: '动态发现目录：无手工声明（大部分模型 DSH 视为非推理）；minimax-m3 有 pi-ai 内置声明但网关未实测转译、直出型无需求；不发送。',
  },
}

/**
 * 自动适配核心（纯函数，无环境依赖，可单测）。
 *
 * 最终发送档位 = 运行时发送许可 ∩ 实测验证层：
 * - 运行时许可：`llm.resolveModelInfo(provider, model).reasoning.efforts`
 *   （DSH 当前视角；适配器/配置/网关能力变化时**自动更新**，无需改代码）；
 * - 实测验证层：本文件 DISC_CAPABILITIES.effortLevels（人工复核才变）；
 * - 两层交集外的请求档位一律降为 'none'（不发送 = 模型默认档，安全）。
 *
 * 使用（生产判别器接入时）:
 *   const info = await ctx.llm.resolveModelInfo(provider, model)
 *   const effort = sanitizeEffort(info.reasoning?.efforts?.map(e => e.id),
 *     requestedEffort, DISC_CAPABILITIES[`${provider}@${model}`]?.effortLevels)
 */
export function sanitizeEffort(
  runtimeEfforts: ReadonlyArray<string> | undefined,
  requested: DiscCallConfig['effort'],
  verified: ReadonlyArray<'low' | 'high' | 'max'> | undefined,
): DiscCallConfig['effort'] {
  if (requested === 'none') return 'none'
  if (
    runtimeEfforts !== undefined
    && runtimeEfforts.includes(requested)
    && verified !== undefined
    && (verified as ReadonlyArray<string>).includes(requested)
  ) {
    return requested
  }
  return 'none'
}

/**
 * 应用预设 + 手动覆盖 → 最终调用参数（纯函数，确定性）。
 *
 * 覆盖对象中的 undefined 字段会被过滤（不覆盖预设值——配置区可选字段缺省 =
 * 跟随预设；防止 `{...base, ...{effort: undefined}}` 把预设值冲成 undefined）。
 *
 * 关联: config.ts 的 discriminator.preset / *.override 字段。
 */
export function materializeDiscCallConfig(
  preset: DiscPresetId,
  overrides: Partial<DiscCallConfig> | undefined = undefined,
): DiscCallConfig {
  const base = DISC_PRESETS[preset]?.config
  if (!base) throw new Error(`unknown discriminator preset: ${preset}`)
  const clean: Partial<DiscCallConfig> = {}
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== undefined) (clean as Record<string, unknown>)[key] = value
  }
  return { ...base, ...clean }
}

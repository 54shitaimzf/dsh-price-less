/**
 * 插件配置 schema（schemastery，与 DSH 插件 Config 惯例一致）——模板态最小形状。
 *
 * 配置面保留模型路由覆盖、R2 自动断面总开关与辅助调用推理档：
 * - discriminator.provider / model：client 模型路由选择器的暂存目标；
 * - discriminator.auto：自动断面总开关，默认 false（关闭时零成本不挂载行为）；
 * - discriminator.reasoningEffort：判别/★ 辅助调用的推理档，缺省 = 跟随模型默认（P14f）。
 * client/field-model.ts 与 host schema 手工同步对（client 禁止 import host src）。
 *
 * 模块: 插件配置
 * 平面: L0（配置解析）
 * 回退链步数: 1（用户可控指令——配置即用户显式规则）
 */

import z from 'schemastery'

export interface Config {
  /** 剪切层开关区（docs/11 §6：工具剪切 + 对话剪切总开关）。 */
  shear: {
    /** 工具剪切总开关（默认 true；关闭后各档零行为）。 */
    enabled: boolean
  }
  /** 压缩域配置区（docs/11 §6 装配开关；P19 落位边界路径）。 */
  compression: {
    /** 边界路径总开关（task 闭合触发；默认 true）。 */
    boundary: boolean
    /** 压力路径总开关（生产者 = P20a；默认 true）。 */
    pressure: boolean
    /**
     * 压力阀门比例（P20c 用户裁定 2026-09-09）：压力触发 = 比例 × 主模型上下文窗口。
     * 默认 0.35（模型能力在窗口约 35% 后下降）；不变量 0 < ratio < 1。
     */
    pressureRatio: number
    /** 假定窗口（主模型未声明窗口时的比例基准；docs/04 §5 修订）。 */
    domainTokens: number
    /** 热尾保留预算（绝对设计值 10K；docs/04 §5）。 */
    retainTokens: number
    /** 末位绝对安全网（窗口与假定窗口都不可用时启用）；不变量 retain < threshold。 */
    thresholdTokens: number
    /** 档案区硬帽（F9 绝对设计值 10K，与热尾 10K 分列；docs/04 §6）。 */
    archiveCapTokens: number
  }
  /** 判别器/引擎配置区。 */
  discriminator: {
    /** 模型路由（可选；空 = 跟随会话路由）。 */
    provider?: string
    model?: string
    /** 自动断面总开关；默认 false，开启后逐消息执行 T0→L0→L1→对表→LLM→fail-lazy。 */
    auto: boolean
    /**
     * 辅助调用（判别 / ★ 断面）推理档（P14f）：adapter 词汇（off/low/medium/high/max…）。
     * 缺省 = 跟随模型默认（不覆盖）——关闭思考可能明显影响任务边界判断与改写质量，故不默认强制。
     */
    reasoningEffort?: string
  }
}

export const Config = z.object({
  shear: z.object({
    enabled: z.boolean().default(true),
  }),
  compression: z.object({
    boundary: z.boolean().default(true),
    pressure: z.boolean().default(true),
    pressureRatio: z.number().default(0.35),
    domainTokens: z.number().default(125000),
    retainTokens: z.number().default(10000),
    thresholdTokens: z.number().default(100000),
    archiveCapTokens: z.number().default(10000),
  }),
  discriminator: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    auto: z.boolean().default(false),
    reasoningEffort: z.string().min(1),
  }),
})

/** 配置默认值（与 schema 默认同源；部分 config 对象装配路径的兜底）。 */
export const CONFIG_DEFAULTS = {
  shear: {
    enabled: true,
  },
  compression: {
    boundary: true,
    pressure: true,
    pressureRatio: 0.35,
    domainTokens: 125000,
    retainTokens: 10000,
    thresholdTokens: 100000,
    archiveCapTokens: 10000,
  },
  discriminator: {
    auto: false,
  },
} satisfies Config

/** 辅助调用推理档设置：未配置 / 空串 = 跟随模型默认（返回 undefined，调用侧不覆盖）。 */
export function reasoningEffortSetting(config: Config): string | undefined {
  const value = config.discriminator?.reasoningEffort
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 压缩域不变量（docs/04 §5 硬规则 + P20c）：
 * retain < threshold 且两者为正；压力阀门比例 ∈ (0, 1)（且必须 < 保险丝地板 0.8）。
 */
export function compressionInvariantOk(compression: Config['compression']): boolean {
  return Number.isFinite(compression.retainTokens) && Number.isFinite(compression.thresholdTokens)
    && compression.retainTokens > 0
    && compression.thresholdTokens > compression.retainTokens
    && Number.isFinite(compression.pressureRatio)
    && compression.pressureRatio > 0
    && compression.pressureRatio < 0.8
}

/** 把"可能部分"的 config 补全成完整形状（shear/compression/discriminator 深合并）。 */
export function resolveConfig(config: Partial<Config> | undefined): Config {
  const compression = { ...CONFIG_DEFAULTS.compression, ...(config?.compression ?? {}) }
  return {
    ...CONFIG_DEFAULTS,
    ...(config ?? {}),
    shear: {
      ...CONFIG_DEFAULTS.shear,
      ...(config?.shear ?? {}),
    },
    // 不变量违例 → 回退设计值（失败方向 = 正典标定，不猜用户意图）。
    compression: compressionInvariantOk(compression)
      ? compression
      : { ...CONFIG_DEFAULTS.compression },
    discriminator: {
      ...CONFIG_DEFAULTS.discriminator,
      ...(config?.discriminator ?? {}),
    },
  }
}

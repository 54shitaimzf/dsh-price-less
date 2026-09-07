/**
 * 插件配置 schema（schemastery，与 DSH 插件 Config 惯例一致）——模板态最小形状。
 *
 * 配置面保留模型路由覆盖与 R2 自动断面总开关：
 * - discriminator.provider / model：client 模型路由选择器的暂存目标；
 * - discriminator.auto：自动断面总开关，默认 false（关闭时零成本不挂载行为）。
 * client/field-model.ts 与 host schema 手工同步对（client 禁止 import host src）。
 *
 * 模块: 插件配置
 * 平面: L0（配置解析）
 * 回退链步数: 1（用户可控指令——配置即用户显式规则）
 */

import z from 'schemastery'

export interface Config {
  /** 判别器/引擎配置区。 */
  discriminator: {
    /** 模型路由（可选；空 = 跟随会话路由）。 */
    provider?: string
    model?: string
    /** 自动断面总开关；默认 false，开启后逐消息执行 T0→L0→L1→对表→LLM→fail-lazy。 */
    auto: boolean
  }
}

export const Config = z.object({
  discriminator: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    auto: z.boolean().default(false),
  }),
})

/** 配置默认值（与 schema 默认同源；部分 config 对象装配路径的兜底）。 */
export const CONFIG_DEFAULTS = {
  discriminator: {
    auto: false,
  },
} satisfies Config

/** 把"可能部分"的 config 补全成完整形状（discriminator 深合并）。 */
export function resolveConfig(config: Partial<Config> | undefined): Config {
  return {
    ...CONFIG_DEFAULTS,
    ...(config ?? {}),
    discriminator: {
      ...CONFIG_DEFAULTS.discriminator,
      ...(config?.discriminator ?? {}),
    },
  }
}

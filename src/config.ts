/**
 * 插件配置 schema（schemastery，与 DSH 插件 Config 惯例一致）——模板态最小形状。
 *
 * 清退后仅保留设置 UI 壳赖以挂载与安全保存的最小字段集：
 * - discriminator.mode：client 卡片钉住的模式行（FieldRow 顶部常驻）；
 * - discriminator.provider / model：client 模型路由选择器（ModelRouteSelector）
 *   的暂存目标——host schema 必须认识这两个键，暂存保存才安全。
 * 三者与 client/field-model.ts 的 3 个保留 spec 一一对应（手工同步对，client
 * 侧禁止 import host src——跨域打包约束，见 field-model.ts 头注）。
 *
 * 重设计时在此按 docs/ 设计文档扩回完整配置区（清退前完整 schema 见 git 历史）。
 *
 * 模块: 插件配置
 * 平面: L0（配置解析）
 * 回退链步数: 1（用户可控指令——配置即用户显式规则）
 */

import z from 'schemastery'

export interface Config {
  /** 判别器/引擎模式区（重设计的引擎挂载开关占位；off = 不挂载任何行为）。 */
  discriminator: {
    /** off=不挂载（默认，零成本）；observe=只读观测；active=生效。 */
    mode: 'off' | 'observe' | 'active'
    /** 模型路由（可选；空 = 跟随会话路由）。 */
    provider?: string
    model?: string
  }
}

export const Config = z.object({
  discriminator: z.object({
    mode: z.union(['off', 'observe', 'active'] as const).default('off'),
    provider: z.string().min(1),
    model: z.string().min(1),
  }),
})

/** 配置默认值（与 schema .default() 双源同值；部分 config 对象装配路径的兜底）。 */
export const CONFIG_DEFAULTS = {
  discriminator: {
    mode: 'off',
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

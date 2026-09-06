/**
 * 插件配置 schema（schemastery，与 DSH 插件 Config 惯例一致）——模板态最小形状。
 *
 * 模板态仅保留设置 UI 壳赖以挂载与安全保存的最小字段集：
 * - discriminator.provider / model：client 模型路由选择器（ModelRouteSelector）
 *   的暂存目标——host schema 必须认识这两个键，暂存保存才安全。
 * 二者与 client/field-model.ts 的 2 个保留 spec 一一对应（手工同步对，client
 * 侧禁止 import host src——跨域打包约束，见 field-model.ts 头注）。
 *
 * 观察模式设置项（off/observe/active）已按用户定调清理：实际设置面不存在
 * 观察模式；机制开关随 R2 工单按 docs/11 §6 落位（boolean 门控）。
 * 重设计时在此按 docs/ 设计文档扩回完整配置区（清退前完整 schema 见 git 历史）。
 *
 * 模块: 插件配置
 * 平面: L0（配置解析）
 * 回退链步数: 1（用户可控指令——配置即用户显式规则）
 */

import z from 'schemastery'

export interface Config {
  /** 判别器/引擎配置区（当前仅模型路由覆盖占位；机制开关随 R2 落位）。 */
  discriminator: {
    /** 模型路由（可选；空 = 跟随会话路由）。 */
    provider?: string
    model?: string
  }
}

export const Config = z.object({
  discriminator: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  }),
})

/** 配置默认值（与 schema 默认同源；部分 config 对象装配路径的兜底）。 */
export const CONFIG_DEFAULTS = {
  discriminator: {},
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

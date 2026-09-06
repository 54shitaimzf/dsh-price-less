/**
 * @dsh-external/dsh-context-economy — 模板态最小入口（清退重建起点）。
 *
 * 插件主体已清退至 git 历史（清退前完整快照见 §29.14 追记所引提交段）；
 * 本文件 = dev_scaffold 模板规范的最小可装填形态：manifest + settings 段注册，
 * 供设置 UI 壳（client/，组件与交互设计全保留）挂载与二次开发。
 *
 * 模块: 主插件入口（模板态）
 * 平面: L0（装配注册；无模型、无能力域逻辑）
 * 回退链步数: 1（配置即用户显式规则）
 * 审查清单: settings 注册经 registerContextEconomySettings（settings 服务未装配
 *           时静默跳过，headless 不阻塞）；资源注册挂 ctx.effect（卸载即净）；
 *           无任何隐藏行为——重设计按 docs/ 设计文档从本骨架重建。
 * 度量: 无（能力域度量字段语义见 docs/07，随重建恢复）
 */

import type { Context } from '@deepseek-ai/cordis'
import { type Config as ConfigShape } from './config.ts'
import { registerContextEconomySettings } from './settings.ts'

export const name = '@dsh-external/dsh-context-economy'

export function apply(ctx: Context, config: Partial<ConfigShape>): void {
  ctx.logger.info('context-economy: applying (template state)')

  // settings 段注册：配置权威源 = settings scope（用户层 > 装配 base > schema 默认）。
  // 这条注册是 client 设置卡挂载的前提（shell.available）；首次注册触发一次 onChange。
  registerContextEconomySettings(ctx, config, {
    onChange: () => ctx.logger.info('context-economy: config updated'),
  })
}

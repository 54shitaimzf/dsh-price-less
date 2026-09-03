/**
 * 插件配置的 settings 注册（GUI 配置卡片的数据通道，docs/12 §5 装配数据流）。
 *
 * 模块: 配置 settings 段
 * 平面: L0（注册 + 配置解析；无模型）
 * 回退链步数: 1（用户可控指令——settings 用户层即用户显式规则）
 *
 * 职责：把插件配置注册为 DSH settings namespace（'context-economy'），
 * 使「设置 → 插件 → 可配置」标签能展示本插件卡片（client 半边在
 * 浏览器注册同名 key 的 slot，见 client/）；配置权威源 = settings scope
 * （用户层 > 装配 base > schema 默认），与 bash-local 的
 * installSettingsSection 用法同构。
 *
 * 关键语义（settings/src/index.ts installSettingsSection）：
 * - setSource 注册时设一次 `() => scope.get()` 闭包——此后每次调用都实时
 *   返回当前已解析值（动态，无需在 onChange 重复设源）；
 * - settings 服务脱离时 disposer 把 setSource 回退为 `() => entry`（装配
 *   base），配置自动回到装配值——消费方因此永不持有一个失效来源；
 * - onChange 用于"值变了需要重建资源"的响应（本插件 = mode 切换重挂判别器）。
 *
 * 审查清单: settings 服务未装配时静默跳过（installSettingsSection 内部
 *           ctx.inject(['settings'])）；fiber 效应（卸载即净）；
 *           枚举/范围约束在 config.ts schema（z.union/z.number 边界）；
 *           能力矩阵交集校验留在运行期（sanitizeEffort，DISC_CAPABILITIES）——
 *           GUI 保存以 schema 为边界，运行时二次校验（不重复实现矩阵逻辑）。
 * 度量: 无新增（配置变更可经判账号本 call 字段观测，docs/07 §18.1）
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config, type Config as ConfigShape } from './config.ts'
import { resolveConfig } from './config.ts'

/** 本插件配置的 settings namespace（client 卡片按其注册同名 key）。 */
export const CONTEXT_ECONOMY_SETTINGS_NS = settingsNamespace('context-economy')

/** 配置变更通知（mode 等需要重建资源的变更 → 重挂判别器）。 */
export interface ContextEconomySettingsHooks {
  /** settings 文档变更后回调（含注册时首次、与 settings 脱离回退 base 后）。 */
  onChange: () => void
}

/**
 * 注册配置 settings 段；返回当前权威配置的读取函数。
 *
 * @param entry - 装配 base（resolveConfig 完整形状；settings 未挂/脱离时使用）。
 * @param hooks - 变更通知。
 * @returns `() => ConfigShape`——动态读取函数，调用即取 settings scope 当前值。
 */
export function registerContextEconomySettings(
  ctx: Context,
  entry: Partial<ConfigShape>,
  hooks: ContextEconomySettingsHooks,
): () => ConfigShape {
  const resolved = resolveConfig(entry)
  let source: () => ConfigShape = () => resolved
  installSettingsSection(ctx, CONTEXT_ECONOMY_SETTINGS_NS, Config, resolved, {
    setSource: (current) => {
      // schemastery 泛型 T = Schema 形状（字段可空 ObjectS），与装配层必填 Config 接口
      // 不同形——bash-local 同款处理（setSource 收到的 current 实为 `() => 已解析完整配置`）。
      source = current as unknown as () => ConfigShape
    },
    onChange: hooks.onChange,
  })
  return () => source()
}
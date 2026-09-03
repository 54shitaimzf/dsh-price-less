/**
 * 主插件配置 schema（schemastery，与 DSH 插件 Config 惯例一致）。
 *
 * 模块: task 记忆插件配置
 * 平面: L0（配置解析）
 * 回退链步数: 1（用户可控指令——配置即用户显式规则）
 *
 * v0.2.0-s7：移除边界语义票全套配置（embeddingTier/taskEmbeddingThreshold/embeddingModel/
 * embeddingEndpoint/embeddingModelDir/embeddingVendorDir）。embedding 降级为 `EmbeddingPort`
 * 端口接口空壳（零成本、off 档），为「映射检索」留门；本插件不再携带模型/vendor 运行时。
 *
 * v0.2.0-s8：新增判别器模型配置区（discriminator）——preset 一键应用（枚举选择即
 * 套用内置预设）+ 高级手动覆盖 + 能力矩阵约束（reports/phase-b-effort-support.md）；
 * 全局默认 = 'deepseek'（官方 API 直连；2026-09 传输层切换，presets V2）。
 *
 * v0.4.0：判别器接入主循环（docs/07 §18）——判别器配置区扩展为运行时形态：
 * mode（off/observe/active，**默认 off = 不挂载**：零成本，observe/active 由用户显式开启）
 * + 运行时容错参数
 * （maxConcurrency/timeoutMs/cacheLimit/journalLimit/historyWindow/messageExcerptChars）。
 * 新增配置均含默认值；resolveConfig 深合并兜底（任何装配路径不崩，docs/12 §5）。
 */

import z from 'schemastery'

/** 判别器配置区（运行时形态；默认值在 schema 与 CONFIG_DEFAULTS 双源同值）。 */
export interface DiscriminatorConfig {
  /** 运行模式：off=不挂载（**默认**，零成本）；observe=只读观测（只记账零行为影响）；active=额外发 verdict 事件。 */
  mode: 'off' | 'observe' | 'active'
  /** 预设（一键应用）：deepseek（默认，官方 API 直连）/ deepseek-low（低思考档）。 */
  preset: 'deepseek' | 'deepseek-low'
  /** 判据版本（默认 v2.2，定稿；未注册版本运行时回退 v2.2 并记录）。 */
  promptVersion: 'v1' | 'v2' | 'v2.1' | 'v2.2'
  /** 高级覆盖：provider（不填 = 跟随预设；能力矩阵外的组合不发送无效参数）。 */
  provider?: string
  /** 高级覆盖：model。 */
  model?: string
  /** 采样温度。默认 0；注意 DeepSeek 官方 API 在思考模式下忽略 temperature。 */
  temperature?: number
  /** 输出上限（软限制：推理型模型的 reasoning token 不计入，实测）。 */
  maxTokens?: number
  /** 思考强度：none=不发送（默认档）；low/high/max=仅能力矩阵验证过的组合生效。 */
  effort?: 'none' | 'low' | 'high' | 'max'
  /** 判别并发上限（1–16；超出排队，队列满即跳过并记 overload）。 */
  maxConcurrency: number
  /** 单次判别超时（ms；1000–60000；超时 → fail-lazy continue）。 */
  timeoutMs: number
  /** L1 精确键缓存容量（0=关闭；键含配置面，重放防重不降语料调用）。 */
  cacheLimit: number
  /** 账号台账环表容量（16–1000）。 */
  journalLimit: number
  /** 段内历史窗口条数（0–6；口径与实验 v6 冻结一致 = 2）。 */
  historyWindow: number
  /** 判别记录中目标消息原文摘录长度（0=不留原文摘录；80 默认）。 */
  messageExcerptChars: number
  /**
   * 判别台账/IO 日志落盘目录。空 = 默认 `~/.dsh/context-economy/`。
   * 落盘内容：judge-records.jsonl（**常开**，含 usage/cost——可回放账本）+ judge-io.jsonl
   * （仅 debugIo=true 时写输入 prompt 与模型输出原样）。落盘失败自动降级为仅日志（fail-lazy）。
   */
  journalPath: string
  /** 输入/输出原始日志落盘开关（judge-io.jsonl；默认关——原始 prompt 与输出含大量文本）。 */
  debugIo: boolean
}

export interface Config {
  /** 判界引擎开关（子开关；沿用 docs/12 §5 既定 ID）。 */
  sub2IntentMapping: boolean
  /** 压缩驱动选择：'native'（原生 compactRegion，当前默认）/ 'task-partitioned'（自研：近因保留尾 + 冷区闭合任务整压 + digest 缓存/L3 落盘）。 */
  compressionDriver: 'native' | 'task-partitioned'
  /** task 结束触发压缩的开关。 */
  taskCompression: boolean
  /** 上下文溢出恢复接管开关（compaction-basic auto:false 后由本插件兜底）。 */
  overflowRecovery: boolean
  /** 近因保留尾阈值（token）。A3 统一策略：近因尾内逐字保留、边界无关。默认 0 待验证集标定（docs/08）。 */
  retainTokens: number
  /** 摘要区/单 task digest 的预算比例占 contextWindow（docs/02 §3.2 摘要区上限；默认 0.2）。 */
  taskDigestBudgetRatio: number
  /** 摘要缓存容量（LRU；0=关闭缓存）。 */
  taskDigestCacheLimit: number
  /** 同 task 二次归档策略：true=合并（保留仍真），false=拒绝。 */
  taskDigestMergeOnReopen: boolean
  /** 摘要器 provider/model（可选；空串 = 跟随会话路由）。 */
  taskDigestProvider: string
  taskDigestModel: string
  /** 摘要落盘目录（空 = 默认 ~/.dsh/context-economy/knowledge.json）。 */
  taskDigestJournalPath: string
  /** 判别器模型配置区（preset 一键应用 + 高级覆盖 + 运行时形态）。 */
  discriminator: DiscriminatorConfig
}

export const Config = z.object({
  sub2IntentMapping: z.boolean().default(true),
  compressionDriver: z.union(['native', 'task-partitioned'] as const).default('native'),
  taskCompression: z.boolean().default(true),
  overflowRecovery: z.boolean().default(true),
  retainTokens: z.number().step(1).min(0).default(0),
  taskDigestBudgetRatio: z.number().min(0).max(1).default(0.2),
  taskDigestCacheLimit: z.number().step(1).min(0).default(256),
  taskDigestMergeOnReopen: z.boolean().default(true),
  taskDigestProvider: z.string().default(''),
  taskDigestModel: z.string().default(''),
  taskDigestJournalPath: z.string().default(''),
  discriminator: z.object({
    mode: z.union(['off', 'observe', 'active'] as const).default('off'),
    preset: z.union(['deepseek', 'deepseek-low'] as const).default('deepseek'),
    promptVersion: z.union(['v1', 'v2', 'v2.1', 'v2.2'] as const).default('v2.2'),
    provider: z.string().min(1),
    model: z.string().min(1),
    temperature: z.number().step(0.1).min(0).max(1),
    maxTokens: z.number().step(1).min(100).max(2000),
    effort: z.union(['none', 'low', 'high', 'max'] as const),
    maxConcurrency: z.number().step(1).min(1).max(16).default(4),
    timeoutMs: z.number().step(1).min(1000).max(60000).default(15000),
    cacheLimit: z.number().step(1).min(0).max(5000).default(1024),
    journalLimit: z.number().step(1).min(16).max(1000).default(256),
    historyWindow: z.number().step(1).min(0).max(6).default(2),
    messageExcerptChars: z.number().step(1).min(0).max(200).default(80),
    journalPath: z.string().default(''),
    debugIo: z.boolean().default(false),
  }),
})

/**
 * 配置字段默认值（与上面 schemastery `.default()` 保持一致，双源防漂移见
 * tests/config-defaults.spec.ts）。独立导出，供 apply 在任何"未经过 schemastery
 * 应用默认值"的装配路径下兜底——插件可能被 include/loader 以部分 config 对象
 * 加载（如空 `{}`），此时 `.default()` 不会触发，直接访问 config.xxx 会得到 undefined。
 */
export const CONFIG_DEFAULTS = {
  sub2IntentMapping: true,
  compressionDriver: 'native',
  taskCompression: true,
  overflowRecovery: true,
  retainTokens: 0,
  taskDigestBudgetRatio: 0.2,
  taskDigestCacheLimit: 256,
  taskDigestMergeOnReopen: true,
  taskDigestProvider: '',
  taskDigestModel: '',
  taskDigestJournalPath: '',
  discriminator: {
    mode: 'off',
    preset: 'deepseek',
    promptVersion: 'v2.2',
    maxConcurrency: 4,
    timeoutMs: 15000,
    cacheLimit: 1024,
    journalLimit: 256,
    historyWindow: 2,
    messageExcerptChars: 80,
    journalPath: '',
    debugIo: false,
  },
} satisfies Config

/** 把"可能部分"的 config 补全成完整形状（缺省字段用 CONFIG_DEFAULTS 填充；discriminator 深合并）。 */
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

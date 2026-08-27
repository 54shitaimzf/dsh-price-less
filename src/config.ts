/**
 * 主插件配置 schema（schemastery，与 DSH 插件 Config 惯例一致）。
 *
 * 模块: task 记忆插件配置
 * 平面: L0（配置解析）
 * 回退链步数: 1（用户可控指令——配置即用户显式规则）
 */

import z from 'schemastery'

export interface Config {
  /** 判界引擎开关（子开关；沿用 docs/12 §5 既定 ID）。 */
  sub2IntentMapping: boolean
  /** 压缩驱动选择：'native'（原生 compactRegion）——后续自研实现换值即换驱动。 */
  compressionDriver: 'native'
  /** 语义票档位：'off' 机械判定；'lite' 插件内嵌轻量档（打包即离线，默认首选）；
   * 'local' 外部 Ollama 顶配档（experimental，需自行安装服务）。 */
  embeddingTier: 'off' | 'local' | 'lite'
  /**
   * 语义漂移阈值（docs/12 §5 契约 ID taskEmbeddingThreshold，默认 0.5）：
   * cosine(当前消息, task 锚) 低于该值 = 语义离开当前 task → 边界候选。
   */
  taskEmbeddingThreshold: number
  /** 本地 embedding 模型（'local' = Ollama 模型名；'lite' = 模型目录名）。 */
  embeddingModel: string
  /** Ollama 服务端点（'local' 档）。 */
  embeddingEndpoint: string
  /** 'lite' 档模型目录（空 = 插件包 models/<embeddingModel>，打包即离线）。 */
  embeddingModelDir: string
  /** 'lite' 档运行时根（空 = 插件包 vendor/embedding-runtime，与主包隔离）。 */
  embeddingVendorDir: string
  /** task 结束触发压缩的开关。 */
  taskCompression: boolean
  /** 上下文溢出恢复接管开关（compaction-basic auto:false 后由本插件兜底）。 */
  overflowRecovery: boolean
}

export const Config = z.object({
  sub2IntentMapping: z.boolean().default(true),
  compressionDriver: z.string().default('native'),
  embeddingTier: z.string().default('off'),
  taskEmbeddingThreshold: z.number().default(0.5),
  embeddingModel: z.string().default('granite-embedding-97m-multilingual-r2'),
  embeddingEndpoint: z.string().default('http://localhost:11434'),
  embeddingModelDir: z.string().default(''),
  embeddingVendorDir: z.string().default(''),
  taskCompression: z.boolean().default(true),
  overflowRecovery: z.boolean().default(true),
})

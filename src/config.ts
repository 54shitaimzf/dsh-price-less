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
  /** 语义票档位：'off' 机械判定；'local' 本地 embedding（Ollama /api/embed）。 */
  embeddingTier: 'off' | 'local'
  /**
   * 语义漂移阈值（docs/12 §5 契约 ID taskEmbeddingThreshold，默认 0.5）：
   * cosine(当前消息, task 锚) 低于该值 = 语义离开当前 task → 边界候选。
   */
  taskEmbeddingThreshold: number
  /** 本地 embedding 模型（Ollama 模型名；默认 Qwen3-Embedding-0.6B）。 */
  embeddingModel: string
  /** Ollama 服务端点。 */
  embeddingEndpoint: string
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
  embeddingModel: z.string().default('qwen3-embedding:0.6b'),
  embeddingEndpoint: z.string().default('http://localhost:11434'),
  taskCompression: z.boolean().default(true),
  overflowRecovery: z.boolean().default(true),
})

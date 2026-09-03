/**
 * Embedding 端口接口（零成本空壳，off 档）。
 *
 * v0.2.0-s7：边界语义票全套（SemanticVoteProvider/EmbeddingVoteProvider/lite+local 端口/
 * createVoteProvider）已随实验清理移除——探针 probe19–21 判死"embedding 用于任务边界"，
 * v0.3.0 起机械判界亦整体退役（docs/07 §16），任务边界改由判别器（语义判定）承担。
 * 此处**仅保留 `EmbeddingPort` 端口接口**作为最小契约，
 * 供「映射检索」（docs/15 寻址：意图→坐标）将来接入 embedding 实现时使用。
 * 本插件不再携带模型/vendor 运行时（`files` 已去除 models/、vendor/），
 * embedding 处于"零成本、off 档"空壳状态。
 *
 * 模块: embedding 端口接口（映射检索留门）
 * 平面: L0（类型契约，无实现/无模型调用）
 * 回退链步数: 4（本地 embedding——仅当映射检索域实现时才有实际代码）
 * 审查清单: 纯类型 + 纯函数；无 IO/无模型调用/无状态副作用；不读 event.time；
 *           本文件不携带任何运行时 embedding 实现（提供方随映射检索域补装配）。
 * 度量: 映射检索命中率随本端口接入后观测（docs/07 mappingHit）。
 */

/** embedding 端口的最小形状（可注入 fetch/假端口供测试）。
 * 实现方：映射检索域（docs/15）接入时的 Ollama/lite 端口。 */
export interface EmbeddingPort {
  embed(input: string | string[]): Promise<number[][]>
}

/** 余弦相似度（纯函数，测试可测；映射检索/相似度门控共用）。 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

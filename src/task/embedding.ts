/**
 * 语义票提供域：本地 embedding（回退链第 4 步，docs/11）。
 *
 * 模块: 语义票 provider
 * 平面: L1（本地 embedding 模型 = 最小模型断面，docs/01 平面分层）
 * 回退链步数: 4（本地 embedding；两档端口：
 *            'lite' = 插件内嵌 granite-embedding-97m-multilingual-r2（93.3MB q8，
 *            transformers.js + onnxruntime-node，CPU），打包即离线、零外部服务；
 *            'local' = 外部 Ollama 服务（顶配档，experimental）；
 *            'off' = provider 缺位 → 机械降级，见 boundary.decideBoundaryWithSemantic）
 * 审查清单: provider 无状态副作用（向量缓存内存级）；模型版本随 artifact 落盘
 *           （docs/09：LLM 产物复用必须先版本化落盘）；失败 fail-lazy（返回 null，
 *           fold 走机械底线，绝不抛错打断 step）；不读 event.time；
 * 度量: semanticVoteLatency / semanticVoteRate / artifactHits（docs/07）。
 */

/** 语义票提供方接口：计算"当前用户消息 vs task 宣言锚"的余弦相似度（-1..1）。 */
export interface SemanticVoteProvider {
  /** 同步语义票；失败/缺模型返回 null（机械降级），绝不抛错。 */
  score(currentText: string, anchorText: string): Promise<number | null>
}

/** 余弦相似度（纯函数，测试可测）。 */
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

/**
 * embedding 端口的最小形状（可注入 fetch/假端口供测试）。
 * 实现方：OllamaEmbeddingPort（外部服务顶配档）/ LiteEmbeddingPort（进程内轻量档）。
 */
export interface EmbeddingPort {
  embed(input: string | string[]): Promise<number[][]>
}

/**
 * lite 档（插件内嵌运行时）选项：
 * modelDir = 含 config.json/tokenizer.json/onnx/model_quantized.onnx 的本地目录
 * （默认插件包 models/<model>，打包即离线可用）；
 * vendorDir = 含 node_modules/@huggingface/transformers 的独立运行时根
 * （默认插件包 vendor/embedding-runtime——与主包 peer 依赖完全隔离）。
 */
export interface LiteEmbeddingOptions {
  modelDir: string
  vendorDir?: string
  /** 截断长度（granite-97m-r2 支持 32K；语义票场景 2048 足够）。 */
  maxLength?: number
}

/**
 * 进程内 lite 端口：transformers.js + onnxruntime-node（CPU），零外部服务。
 * 懒加载：首次 embed 时加载模型（~1-3s CPU），之后 384 维向量 ~30-80ms/条。
 * 失败：抛错（provider 捕获 → null → 机械降级）；不在本处缓存失败（每新 seq 重试）。
 */
export class LiteEmbeddingPort implements EmbeddingPort {
  private extractorPromise: Promise<unknown> | null = null

  constructor(private readonly opts: LiteEmbeddingOptions) {}

  private async extractor(): Promise<unknown> {
    this.extractorPromise ??= this.createExtractor()
    return this.extractorPromise
  }

  private async createExtractor(): Promise<unknown> {
    const { createRequire } = await import('node:module')
    const { fileURLToPath } = await import('node:url')
    const vendorRoot = this.opts.vendorDir ?? fileURLToPath(new URL('../../vendor/embedding-runtime', import.meta.url))
    const require = createRequire(import.meta.url)
    let entry: string
    try {
      // Node 文本推理用 CJS 构建（ESM 构建的 node:fs 互操作不可用）；
      // sharp 为图像工具硬依赖——本运行时仅文本，以存根满足 require。
      entry = require.resolve('@huggingface/transformers', { paths: [vendorRoot] })
    } catch (error: unknown) {
      throw new Error(
        `lite embedding runtime missing at ${vendorRoot} (run: npm install --prefix vendor/embedding-runtime): `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const mod = require(entry) as {
      pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>
      env?: { useFS: boolean; allowLocalModels: boolean }
    }
    if (typeof mod.pipeline !== 'function') {
      throw new Error('lite embedding runtime does not export pipeline()')
    }
    // Node 下显式走 FileSystem 后端（默认未开 → 本地路径会被当 URL fetch）。
    if (mod.env !== undefined) {
      mod.env.useFS = true
      mod.env.allowLocalModels = true
    }
    return mod.pipeline('feature-extraction', this.opts.modelDir, {
      dtype: 'q8',
      local_files_only: true,
    })
  }

  async embed(input: string | string[]): Promise<number[][]> {
    const extractor = await this.extractor()
    const texts = Array.isArray(input) ? input : [input]
    const run = extractor as (texts: string[], options: Record<string, unknown>) => Promise<{
      data: Float32Array | number[]
      dims: number[]
    }>
    const output = await run(texts, {
      pooling: 'cls',
      normalize: true,
      max_length: this.opts.maxLength ?? 2048,
      truncation: 'longest_first',
    })
    const dims = output.dims
    const width = dims.at(-1) ?? 0
    const rows = dims.length === 2 ? dims[0] : 1
    const data = output.data
    const vectors: number[][] = []
    for (let i = 0; i < rows; i += 1) {
      vectors.push(Array.from(data.slice(i * width, (i + 1) * width)))
    }
    return vectors
  }
}

/** 默认端口：宿主 Node 18+ 原生 fetch 调 Ollama。 */
export class OllamaEmbeddingPort implements EmbeddingPort {
  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    private readonly fetchImpl: (input: string, init: RequestInit) => Promise<Response> = fetch,
  ) {}

  async embed(input: string | string[]): Promise<number[][]> {
    const response = await this.fetchImpl(`${this.endpoint}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input }),
    })
    if (!response.ok) {
      throw new Error(`ollama embed failed: HTTP ${response.status}`)
    }
    const body = (await response.json()) as { embeddings?: number[][] }
    if (!Array.isArray(body.embeddings) || body.embeddings.length === 0) {
      throw new Error(`ollama embed returned no embeddings for ${this.model}`)
    }
    return body.embeddings
  }
}

/** 通用语义票 provider（内存向量缓存：同文本只算一次；失败 → null）。 */
export class EmbeddingVoteProvider implements SemanticVoteProvider {
  private readonly cache = new Map<string, number[]>()

  constructor(
    private readonly port: EmbeddingPort,
    private readonly logger: { warn?: (message: string) => void } = {},
  ) {}

  async score(currentText: string, anchorText: string): Promise<number | null> {
    const current = await this.vector(this.cache, currentText)
    if (current === undefined) return null
    const anchor = await this.vector(this.cache, anchorText)
    if (anchor === undefined) return null
    return cosineSimilarity(current, anchor)
  }

  /** 单文本向量（缓存命中直接回；失败返回 undefined = 无票）。 */
  private async vector(cache: Map<string, number[]>, text: string): Promise<number[] | undefined> {
    const hit = cache.get(text)
    if (hit !== undefined) return hit
    try {
      const vectors = await this.port.embed(text)
      const vec = vectors[0]
      cache.set(text, vec)
      return vec
    } catch (error: unknown) {
      this.logger.warn?.(`task-memory: embedding vote failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
}

/** 兼容别名：早期以 Ollama 命名（端口换后保留导出，避免破坏既有引用）。 */
export { EmbeddingVoteProvider as OllamaVoteProvider }

/** 投票方工厂选项。 */
export interface VoteProviderOptions {
  /** 'local'：外部 Ollama 服务（顶配档，experimental）；'lite'：插件内嵌轻量档。 */
  tier: 'off' | 'local' | 'lite'
  /** 'local' 用：Ollama 端点。 */
  endpoint?: string
  /** 'local' 用：Ollama 模型名。 */
  model?: string
  /** 'lite' 用：本地模型目录（打包即离线）。 */
  modelDir?: string
  /** 'lite' 用：transformers.js 运行时根（vendor 隔离目录）。 */
  vendorDir?: string
}

/** 投票方工厂：'off' → null（机械降级）；'local' → Ollama；'lite' → 插件内嵌。 */
export function createVoteProvider(
  tier: string,
  opts: VoteProviderOptions,
  logger?: { warn?: (message: string) => void },
): SemanticVoteProvider | null {
  if (tier === 'local') {
    return new EmbeddingVoteProvider(
      new OllamaEmbeddingPort(opts.endpoint ?? 'http://localhost:11434', opts.model ?? 'qwen3-embedding:0.6b'),
      logger ?? {},
    )
  }
  if (tier === 'lite') {
    const modelDir = opts.modelDir ?? ''
    if (modelDir.length === 0) return null
    return new EmbeddingVoteProvider(
      new LiteEmbeddingPort({ modelDir, vendorDir: opts.vendorDir }),
      logger ?? {},
    )
  }
  return null
}

/**
 * 语义票版本化 artifact 存储（docs/09 版本协议：LLM 产物复用必须先版本化落盘）。
 * 布局：<root>/<sessionId>/votes/<messageSeq>.json
 *   { model, anchorSeq, anchorHash, score, createdAt }
 * 恢复：会话重建时按 sessionId 预读票表 → 与 live 判定一致（字节可复现的投票输入）。
 */
export class VoteArtifactStore {
  constructor(
    private readonly root: string,
    private readonly pathImpl: {
      join: (...parts: string[]) => string
      mkdir: (path: string) => Promise<unknown>
      write: (path: string, content: string) => Promise<unknown>
      read: (path: string) => Promise<string>
      list: (path: string) => Promise<string[]>
      exists: (path: string) => Promise<boolean>
    },
  ) {}

  /** 写一张票（幂等：已存在同 seq 文件则跳过——同一判据同一票）。 */
  async save(
    sessionId: string,
    messageSeq: number,
    anchorSeq: number,
    anchorText: string,
    score: number,
    model: string,
  ): Promise<void> {
    const dir = this.pathImpl.join(this.root, sessionId, 'votes')
    await this.pathImpl.mkdir(dir)
    const file = this.pathImpl.join(dir, `${messageSeq}.json`)
    const payload = JSON.stringify({
      model,
      anchorSeq,
      anchorHash: hashText(anchorText),
      score,
      createdAt: Date.now(),
    })
    // 只写新票：相同 session+seq 的判据（文本+模型）固定，先写为准。
    if (await this.pathImpl.exists(file)) return
    await this.pathImpl.write(file, payload)
  }

  /** 读取一个会话的全部已落盘票（'messageSeq → score'）。 */
  async loadAll(sessionId: string): Promise<Map<number, number>> {
    const dir = this.pathImpl.join(this.root, sessionId, 'votes')
    const out = new Map<number, number>()
    if (!(await this.pathImpl.exists(dir))) return out
    for (const name of await this.pathImpl.list(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = await this.pathImpl.read(this.pathImpl.join(dir, name))
        const parsed = JSON.parse(raw) as { score?: number }
        const seq = Number(name.replace(/\.json$/, ''))
        if (typeof parsed.score === 'number' && Number.isInteger(seq)) out.set(seq, parsed.score)
      } catch {
        // 單票损坏：跳过（不影响其他票与机械底线）。
      }
    }
    return out
  }
}

/** 简短文本 hash（非加密，仅作锚身份记录用）。 */
export function hashText(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 系统注入用户消息（checkpoint/提醒/任务通知等）——语义票应跳过（仅用户意图可投票）。 */
export function isSystemInjectedUserText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('This is an automatically generated checkpoint')
    || trimmed.startsWith('<system-reminder>')
    || trimmed.startsWith('Current runtime context.')
    || trimmed.startsWith('The available skill catalog changed')
    || trimmed.startsWith('Updated instructions from: AGENTS.md')
    || trimmed.startsWith('The approval policy changed')
    || trimmed.startsWith('background job')
    || trimmed.startsWith('You are repeating the exact same tool call')
    || trimmed.startsWith('Router: classify this task')
}

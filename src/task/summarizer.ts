/**
 * task 摘要器（回退链第 6 级：最小断面摘要）。把 schema 指令作为最后一条 user 消息追加到
 * 会话自身前缀之后（docs/06 前缀对齐——复用缓存前缀，不失效），产出结构化 `TaskDigest`。
 *
 * 摘要器接口化：`DigestSummarizer` 是注入点（测试/离线 harness 注 mock；生产用 LLM 实现）。
 * 输出 `DigestSummaryResult` 的两半：
 *  - `digest`：结构化摘要（L3 落盘 + 缓存用）；
 *  - `summary`：可见检查点内容块（其实为 `digestToMarkdown(digest)`，替换历史 span 用）。
 *
 * JSON 解析失败（fail-lazy）：不丢内容——用 `emptyDigest`，`summary` 回退为模型原文（截断），
 * 保证"宁可留原始信息，不因解析失败丢上下文"。
 *
 * 模块: task 摘要器
 * 平面: L1（模型最小断面 = 回退链第 6 级；解析/回退为 L0 纯规则）
 * 回退链步数: 6（LLM 摘要 = 最小断面）
 * 审查清单: 摘要调用复用会话前缀（缓存命中）；失败安全 fail-lazy（解析失败回退原文，不抛错打断 step）；
 *           无副作用（不写存储——落盘归 driver）；可无 harness 单测（注 mock/纯函数）。
 * 度量: 摘要器成本经 compaction/summary 事件（usage）观测（docs/07）。
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  DIGEST_INSTRUCTION,
  DIGEST_SCHEMA_VERSION,
  emptyDigest,
  isValidDigest,
  digestToMarkdown,
  type TaskDigest,
} from './digest-schema.ts'
export { DIGEST_INSTRUCTION } from './digest-schema.ts'

/** 摘要器输入：会话自身前缀（system/tools）+ 被压 span 的派生消息。 */
export interface DigestSummarizerInput {
  system?: string
  tools?: readonly ToolSchema[]
  messages: readonly Message[]
}

/** 摘要器输出：结构化 digest + 可见检查点内容块 + 调用封套。 */
export interface DigestSummaryResult {
  digest: TaskDigest
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
  llmStreamCall: boolean
}

/** 摘要器端口（注入点）。 */
export interface DigestSummarizer {
  summarize(input: DigestSummarizerInput, agent: Agent, signal?: AbortSignal): Promise<DigestSummaryResult>
}

/** 从摘要器输出构建"缓存命中"结果（不调用 LLM；provider/model 记空，llmStreamCall=false）。 */
export function cachedDigestResult(digest: TaskDigest): DigestSummaryResult {
  return {
    digest,
    summary: [{ type: 'text', text: digestToMarkdown(digest) }],
    provider: '',
    model: '',
    llmStreamCall: false,
  }
}

/** 从模型原文剥离可能存在的 markdown 代码围栏，返回内层 JSON 文本。 */
export function stripFences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const lines = trimmed.split('\n')
  const body = lines.filter((line, i) => !(line.trim().startsWith('```') && (i === 0 || i === lines.length - 1)))
  return body.join('\n').trim()
}

/**
 * 解析模型输出为 `TaskDigest`（严格 schema）；无效返回 null。
 * `taskId/taskAnchor/schemaVersion/createdAtMs` 由调用方兜底补齐（模型不填这些）。
 */
export function parseDigestJson(
  text: string,
  taskId: string,
  taskAnchor: string,
  schemaVersion = DIGEST_SCHEMA_VERSION,
  nowMs = Date.now(),
): TaskDigest | null {
  let raw: unknown
  try {
    raw = JSON.parse(stripFences(text))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  const candidate = {
    taskId,
    schemaVersion,
    taskAnchor,
    purpose: typeof v.purpose === 'string' ? v.purpose : '',
    decisions: toStringArray(v.decisions),
    artifacts: toArtifacts(v.artifacts),
    touchedFiles: toStringArray(v.touchedFiles),
    pending: toStringArray(v.pending),
    triedRejected: toStringArray(v.triedRejected),
    verbatimSpans: toStringArray(v.verbatimSpans),
    createdAtMs: nowMs,
  }
  return isValidDigest(candidate) ? candidate : null
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
}

function toArtifacts(value: unknown): TaskDigest['artifacts'] {
  if (!Array.isArray(value)) return []
  const out: TaskDigest['artifacts'] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const a = item as Record<string, unknown>
    if (typeof a.file !== 'string') continue
    const symbols = Array.isArray(a.symbols) ? a.symbols.filter((x): x is string => typeof x === 'string') : []
    let lineRange: [number, number] | null = null
    if (Array.isArray(a.lineRange) && a.lineRange.length === 2
      && typeof a.lineRange[0] === 'number' && typeof a.lineRange[1] === 'number') {
      lineRange = [a.lineRange[0], a.lineRange[1]]
    }
    out.push({ file: a.file, symbols, lineRange, note: typeof a.note === 'string' ? a.note : '' })
  }
  return out
}

/** 解析失败的回退：保留模型原文为可见检查点（不丢内容），digest 用空壳。 */
function fallbackResult(rawText: string, taskId: string, taskAnchor: string): DigestSummaryResult {
  const capped = rawText.length > 4000 ? `${rawText.slice(0, 4000)}\n…(truncated)` : rawText
  return {
    digest: emptyDigest(taskId, taskAnchor),
    summary: [{ type: 'text', text: capped }],
    provider: '',
    model: '',
    llmStreamCall: false,
  }
}

/** LLM 后端摘要器：复用会话前缀 + 追加 schema 指令，解析 JSON 为 digest。 */
export class LlmDigestSummarizer implements DigestSummarizer {
  constructor(
    private readonly ctx: Context,
    private readonly target: { provider: string; model: string },
    private readonly logger: Pick<Context['logger'], 'warn' | 'info'> = { warn: () => {}, info: () => {} },
  ) {}

  async summarize(input: DigestSummarizerInput, agent: Agent, signal?: AbortSignal): Promise<DigestSummaryResult> {
    const injected = this.target
    const latest = agent.session.requestHeader()?.config
    const target = injected.provider.length > 0 && injected.model.length > 0
      ? injected
      : latest !== undefined && latest.provider.length > 0 && latest.model.length > 0
        ? { provider: latest.provider, model: latest.model }
        : agent.options.provider !== undefined && agent.options.provider.length > 0
          && agent.options.model !== undefined && agent.options.model.length > 0
          ? { provider: agent.options.provider, model: agent.options.model }
          : undefined
    if (target === undefined) {
      throw new Error(
        'no provider/model for task digest summarization: set taskDigestProvider/taskDigestModel, or route a request',
      )
    }

    const assembler = new BlockAssembler()
    const messages: Message[] = [
      ...input.messages,
      createUserMessage({        content: [{ type: 'text', text: DIGEST_INSTRUCTION }],
        source: { kind: 'plugin', plugin: '@dsh-external/dsh-context-economy' },
      }),
    ]
    const options: GenerateOptions = {
      provider: target.provider,
      model: target.model,
      messages,
      ...input.system === undefined ? {} : { system: input.system },
      ...input.tools === undefined ? {} : { tools: [...input.tools] },
      maxTokens: 1000,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...signal === undefined ? {} : { signal },
    }
    let rawOutput: ContentBlock[] = []
    try {
      for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
      rawOutput = assembler.blocks()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn(`task-digest: summarization failed: ${message}`)
      throw error
    }

    const rawText = rawOutput.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text).join('')
    if (rawText.trim().length === 0) {
      throw new Error('task-digest: summarization produced no text')
    }
    const taskId = extractTaskId(input.messages)
    const anchor = extractAnchor(input.messages)
    const parsed = parseDigestJson(rawText, taskId, anchor)
    if (parsed === null) {
      this.logger.warn('task-digest: JSON digest parse failed — falling back to raw text checkpoint')
      return fallbackResult(rawText, taskId, anchor)
    }
    return {
      digest: parsed,
      summary: [{ type: 'text', text: digestToMarkdown(parsed) }],
      provider: target.provider,
      model: target.model,
      maxTokens: 1000,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
      llmStreamCall: true,
    }
  }
}

/** 从第一个 user 消息的内容里推断 taskId（段头原文太长 → 截断为锚）。 */
function extractTaskId(messages: readonly Message[]): string {
  return extractAnchor(messages) || `task-DIGEST`
}

/** 从第一个 user 消息取段头原文（锚）。 */
function extractAnchor(messages: readonly Message[]): string {
  const first = messages.find(m => m.role === 'user')
  const text = first?.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text).join('')
  return text ?? ''
}

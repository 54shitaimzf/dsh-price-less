/**
 * 指挥半边：在 agent/pre-step（开放 turn、平衡边界已就绪）读投影状态，
 * 对已关闭且未压缩的 task 驱动原生压缩；并在上下文溢出时接管自动恢复。
 *
 * 模块: task 压缩指挥
 * 平面: L0（状态读取 + 分支）+ L1（压缩触发 = 原生引擎的 LLM 摘要，属回退链第 6 级）
 * 回退链步数: 2（代码分支：状态读取 + 范围选择）→ 6（原生压缩 = 最小断面摘要）
 * 审查清单: 信号取自投影状态（日志 fold）；压缩失败安全（fail-lazy，绝不抛错打断 step）；
 *           CompressionDriver 接口为"替换压缩"留缝（后续自研实现即换驱动）；
 * 度量: roundsPerTask / taskSwitchRate / compaction/* 事件（docs/07）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionEngine, CompactionResult } from '@deepseek-ai/dsh-compaction'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContextEconomyTaskState, SemanticVoteTable, TaskRecord } from './types.ts'
import { selectCompressibleRange, type CompressibleRange } from './range.ts'
import { emitTaskBoundary, emitTaskCompacted } from './graph-hook.ts'
import type { TaskBoundarySignal } from './events.ts'
import { isSystemInjectedUserText, type SemanticVoteProvider } from './embedding.ts'
import { userMessageText } from './boundary.ts'
import { TASK_PROJECTION_KEY } from './types.ts'

/** node:fs/promises 的 VoteArtifactStore 默认端口（宿主 Node 运行时；/ 分隔符 Windows 亦可）。 */
const defaultPathImpl = {
  async mkdir(p: string) { await (await import('node:fs/promises')).mkdir(p, { recursive: true }) },
  async write(p: string, content: string) { await (await import('node:fs/promises')).writeFile(p, content, 'utf-8') },
  async read(p: string) { return (await import('node:fs/promises')).readFile(p, 'utf-8') },
  async list(p: string) { return (await import('node:fs/promises')).readdir(p) },
  async exists(p: string) {
    try { await (await import('node:fs/promises')).stat(p); return true } catch { return false }
  },
  join(...parts: string[]) { return parts.join('/') },
}

/** 压缩驱动接口（替换缝：现在 = 原生 compactRegion；后续自研 = 新实现）。 */
export interface CompressionDriver {
  /** 对已关闭 task 的范围触发一次压缩；返回压缩结果（或 null 表示跳过）。 */
  trigger(
    task: TaskRecord,
    range: CompressibleRange,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult | null>
}

/** 原生压缩驱动：包 compactRegion + 失败分类（busy/changed 记日志后放弃）。 */
export class NativeCompressionDriver implements CompressionDriver {
  constructor(
    private readonly compaction: CompactionEngine,
    private readonly logger: Pick<Context['logger'], 'warn' | 'info'> = {
      warn: () => {},
      info: () => {},
    },
  ) {}

  async trigger(
    task: TaskRecord,
    range: CompressibleRange,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult | null> {
    try {
      const result = await this.compaction.compactRegion(range.start, range.end, {
        session: agent.session,
        options: agent.options,
      } as Parameters<CompactionEngine['compactRegion']>[2], signal)
      if (result !== null) {
        this.logger.info(
          `task-memory: compacted task=${task.taskId} range=${range.start}..${range.end} `
          + `shadowedTokens=${result.shadowedTokenCount}`,
        )
      }
      return result
    } catch (error: unknown) {
      // fail-lazy：busy/changed/无开放 turn 均为预期失败——记录后放弃本 task，下一边界再试。
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn(`task-memory: compaction skipped for task=${task.taskId}: ${message}`)
      return null
    }
  }
}

/** 指挥半边依赖注入形状。 */
export interface OrchestratorDeps {
  readonly ctx: Context
  readonly sessionProjections: {
    stateOf(session: Session, key: string): ContextEconomyTaskState | undefined
  }
  readonly compaction?: CompactionEngine
  readonly driver?: CompressionDriver
  /** 语义票 provider（<embeddingTier>'off' 时缺省 = 无投票，机械判定）。 */
  readonly votes?: SemanticVoteProvider
  /** 语义票表决表（与投影 factory 共享同一实例；fold 只读，本处写入）。 */
  readonly votesTable?: SemanticVoteTable
  /** 语义票落盘根目录（缺省跳过 artifact——仅内存票）。 */
  readonly artifactRoot?: string
  /** 语义模型标识（artifact 记录用）。 */
  readonly voteModel?: string
}

/**
 * 在 agent/pre-step 上注册指挥逻辑（effect：disposer 随 fiber 清理）。
 */
export function registerOrchestrator(deps: OrchestratorDeps): () => void {
  const { ctx, sessionProjections } = deps
  const driver = deps.driver ?? (deps.compaction !== undefined
    ? new NativeCompressionDriver(deps.compaction, ctx.logger as never)
    : undefined)

  let lastBoundarySeqSeen = -1

  // —— 语义票投票状态（每会话）——
  const votedSeqs = new Map<string, Set<number>>()
  const artifactCache = new Map<string, Map<number, number>>()

  /** 取会话最近一条非系统注入的用户消息（seq + 文本）。 */
  function lastUserMessage(session: Session): { seq: number; text: string } | null {
    const events = session.events as readonly SessionEvent[]
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]!
      if (ev.type !== 'user/message') continue
      if (ev.surfaceOp !== undefined && ev.surfaceOp !== 'append') continue
      const text = userMessageText(ev)
      if (isSystemInjectedUserText(text)) continue
      return { seq: ev.seq, text }
    }
    return null
  }

  /**
   * 语义票（每个新用户消息一次；三源闭合：内存票 → 已落盘 artifact → provider 现算）。
   * 失败全链 fail-lazy：无票 = 机械底线，绝不抛错打断 step。
   */
  async function voteOnce(session: Session, state: ContextEconomyTaskState): Promise<void> {
    if (deps.votes === undefined || deps.votesTable === undefined) return
    if (state.current === null) return
    const currentTask = state.tasks.find(task => task.taskId === state.current!.taskId)
    if (currentTask === undefined) return
    const msg = lastUserMessage(session)
    if (msg === null) return
    const sessionId = session.header.id

    let voted = votedSeqs.get(sessionId)
    if (voted === undefined) {
      voted = new Set<number>()
      votedSeqs.set(sessionId, voted)
    }
    if (voted.has(msg.seq)) return

    // 1) artifact 预读（恢复路径：同判据同票，重建一致性）。
    let cached = artifactCache.get(sessionId)
    if (cached === undefined) {
      cached = new Map<number, number>()
      artifactCache.set(sessionId, cached)
      if (deps.artifactRoot !== undefined) {
        try {
          const { VoteArtifactStore } = await import('./embedding.ts')
          const store = new VoteArtifactStore(deps.artifactRoot, defaultPathImpl)
          for (const [seq, score] of await store.loadAll(sessionId)) cached.set(seq, score)
        } catch {
          // artifact 读失败：走现算（仅丢缓存，不抛错）。
        }
      }
    }
    if (cached.has(msg.seq)) {
      voted.add(msg.seq)
      deps.votesTable.set(msg.seq, cached.get(msg.seq)!)
      return
    }

    // 2) provider 现算（Ollama；失败 → null 不写票 = 本回合机械判定，fail-lazy）。
    const score = await deps.votes.score(msg.text, currentTask.anchorText)
    voted.add(msg.seq)
    if (score === null) return
    deps.votesTable.set(msg.seq, score)
    // 3) 版本化落盘（docs/09；失败仅记日志，不影响判定）。
    if (deps.artifactRoot !== undefined) {
      try {
        const { VoteArtifactStore } = await import('./embedding.ts')
        const store = new VoteArtifactStore(deps.artifactRoot, defaultPathImpl)
        await store.save(sessionId, msg.seq, currentTask.startSeq, currentTask.anchorText, score, deps.voteModel ?? '')
      } catch (error: unknown) {
        ctx.logger.warn(`task-memory: vote artifact save failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const disposePreStep = ctx.on(
    'agent/pre-step',
    async ({ agent, signal }, next) => {
      // 1) 读取投影状态（经 stateOf；key 未注册时直接放行——headless 弹性）。
      const state = sessionProjections.stateOf(agent.session, TASK_PROJECTION_KEY)
      if (state === undefined) return next()

      // 1.5) 语义票（异步；不阻塞 step 主链——失败/缺票均 fail-lazy）。
      await voteOnce(agent.session, state)

      if (driver === undefined) return next()

      // 2) 边界信号发射（每次状态推进都检一次 lastBoundary；幂等由 seq 门控）。
      if (state.lastBoundary !== null && state.lastBoundarySeq !== null
        && state.lastBoundarySeq > lastBoundarySeqSeen) {
        lastBoundarySeqSeen = state.lastBoundarySeq
        const signal: TaskBoundarySignal = {
          sessionId: agent.id,
          taskId: state.lastBoundary.taskId,
          kind: state.lastBoundary.kind,
          evidence: state.lastBoundary.evidence,
        }
        emitTaskBoundary(ctx, agent.session, signal)
      }

      // 3) 找到「已关闭 + 未压缩」的 task，逐个驱动压缩（本轮先处理最近一个）。
      const pending = state.tasks.find(task => (
        task.status === 'closed' && !state.compactedTaskIds.includes(task.taskId)
      ))
      if (pending === undefined) return next()

      const range = selectCompressibleRange(pending, agent.session.surface.nodes, {
        session: agent.session,
      })
      if (range === null) return next()

      // 4) 驱动压缩（不阻塞 step：失败 → fail-lazy 返回 next；成功 → 发信号）。
      const result = await driver.trigger(pending, range, agent, signal)
      if (result !== null) {
        emitTaskCompacted(ctx, {
          sessionId: agent.id,
          taskId: pending.taskId,
          compactionId: String(result.compactionId),
          shadowedTokenCount: result.shadowedTokenCount,
        })
      }
      return next()
    },
    { global: true, prepend: true },
  )

  // 5) 溢出恢复接管（auto:false 后原生 request-error 钩子停用；本插件兜底）。
  const disposeOverflow = ctx.on(
    'agent/request-error',
    async ({ agent, failure, signal }, next) => {
      if (deps.compaction === undefined) return next()
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      try {
        await deps.compaction.compactIfNeeded(
          { session: agent.session, options: agent.options } as never,
          'context-overflow',
          signal,
        )
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`task-memory: overflow recovery failed: ${message}`)
      }
      return next()
    },
    { global: true, prepend: true },
  )

  return () => {
    disposePreStep()
    disposeOverflow()
  }
}

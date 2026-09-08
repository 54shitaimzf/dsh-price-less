/**
 * P13 命令面（docs/10 §2 / docs/11 §2 domains/commands.ts）。
 * 注册 /task、/init、/optimize-prompt；只经注入 emit 发射事实，不直接写会话日志。
 * domains 允许 import core + platform；命令服务仅 type-only harness import。
 */
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { parseT0Command } from '../core/t0.ts'
import { factsFromSessionEvents, TASK_BOUNDARY_FACT_TYPE } from '../core/ledger/facts.ts'
import type { LedgerFact, LedgerSessionEvent } from '../core/ledger/types.ts'
import { foldSegmentState } from '../core/units.ts'
import { createProjectFrame, projectFrameStorageKey, type ProjectFrameBody } from '../core/prefix.ts'
import { createDossier, dossierStorageKey, foldDossierLedger, sessionScopedTaskId, type DossierBody } from '../core/dossier.ts'
import { streamCeLlm, type CeGenerateOptions } from '../platform/llm.ts'
import { emitCeFact } from '../platform/logger.ts'
import { listSkillCatalog } from '../platform/skills.ts'
import type { ContextEconomyStorage } from '../platform/storage.ts'
import { readSessionModel, type CeLogger } from '../platform/events.ts'
import type { Config as ConfigShape } from '../config.ts'
import { clampInitGoal, parseInitOutput, renderInitPrompt } from '../core/init.ts'
import { buildTaskBoundaryData } from './task-facts.ts'

// 默认辅助模型 = 当前主对话模型（2026-09-08 定；设置卡可覆盖，缺省时优先跟随会话当前模型）。
const DEFAULT_INIT_MODEL = { provider: 'deepseek-official', model: 'deepseek-v4.1-flash-expires-on-0910' }
const PENDING_INIT_LIMIT = 32

export interface CommandFaceDeps {
  commandsCtx: Pick<Context, 'commands'>
  storage: ContextEconomyStorage
  getConfig: () => ConfigShape
  logger: CeLogger
  workspace?: string
  now?: () => number
  skillsCtx?: Pick<Context, 'skills' | 'logger'>
  llmCtx?: Pick<Context, 'llm'>
  manualOptimize?: (session: Session, rawInput: string) => CommandResult | Promise<CommandResult>
  emitFact?: (session: Session, type: string, data: unknown, logger?: CeLogger) => void
}

export interface CommandFace {
  dispose(): void
  stats(): { pendingInits: number; taskCommands: number; initCommands: number; optimizeCommands: number }
}

interface PendingInit {
  goal: string
  aspects: string[]
  time: number
}

export function resolveInitModel(
  config: ConfigShape,
  sessionModel?: { provider: string; model: string },
): { provider: string; model: string } {
  const provider = config.discriminator?.provider?.trim()
  const model = config.discriminator?.model?.trim()
  if (provider && model) return { provider, model }
  if (sessionModel !== undefined) return sessionModel
  return { ...DEFAULT_INIT_MODEL }
}

function sidOf(session: Session): string {
  const s = session as unknown as { header?: { id?: unknown }; id?: unknown }
  const header = s.header?.id
  return typeof header === 'string' ? header : String(s.id ?? 'session')
}

function readFacts(session: Session): LedgerFact[] {
  const snapshot = (session as unknown as { snapshotEvents?: () => readonly LedgerSessionEvent[] }).snapshotEvents
  const events = snapshot ? snapshot() : []
  return factsFromSessionEvents(events as LedgerSessionEvent[])
}

function renderTaskStatus(storage: ContextEconomyStorage, scopedTaskId: string, displayTaskId: string = scopedTaskId): CommandResult {
  const record = storage.getEntity('dossier', dossierStorageKey(scopedTaskId))
  const body: DossierBody = record ? record.body as DossierBody : createDossier(scopedTaskId)
  const ledger = foldDossierLedger(body)
  return {
    kind: 'success',
    text: [
      `当前任务：${displayTaskId}`,
      `消息数：${ledger.messageCount}`,
      `文本长度：${ledger.textLength}`,
      `标注：action=${ledger.annotationCounts.action} pureQ=${ledger.annotationCounts.pureQ} verifyQ=${ledger.annotationCounts.verifyQ}`,
      `卷宗版本：${record?.version ?? '无'}`,
      '用法：/task <描述> 或 /task close',
    ].join('\n'),
  }
}

export function mountCommandFace(deps: CommandFaceDeps): CommandFace
export function mountCommandFace(
  commandsCtx: Pick<Context, 'commands'>,
  deps: Omit<CommandFaceDeps, 'commandsCtx'>,
): CommandFace
export function mountCommandFace(
  arg1: CommandFaceDeps | Pick<Context, 'commands'>,
  arg2?: Omit<CommandFaceDeps, 'commandsCtx'>,
): CommandFace {
  const deps: CommandFaceDeps = arg2 === undefined
    ? arg1 as CommandFaceDeps
    : { ...arg2, commandsCtx: arg1 as Pick<Context, 'commands'> }
  const {
    commandsCtx,
    storage,
    getConfig,
    logger,
    workspace = process.cwd().replaceAll('\\', '/'),
    now = Date.now,
  } = deps
  const pendingInit = new Map<string, PendingInit>()
  const counters = { task: 0, init: 0, optimize: 0 }
  const disposers: Array<() => void> = []

  const emit: (session: Session, type: string, data: unknown, logger?: CeLogger) => void =
    deps.emitFact ?? ((session, type, data, log) => emitCeFact(session, type as never, data as never, log))

  const safe = async (fn: () => CommandResult | Promise<CommandResult>): Promise<CommandResult> => {
    try {
      return await fn()
    } catch (e) {
      return { kind: 'error', text: `命令执行失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  const taskHandler = (invocation: CommandInvocation): Promise<CommandResult> => safe(async () => {
    counters.task++
    const session = invocation.agent.session
    const sid = sidOf(session)
    const facts = readFacts(session)
    const segments = foldSegmentState(facts)
    const parsed = parseT0Command('/task' + invocation.rawInput)
    if (parsed.boundary === 'open') {
      const taskId = `task-${segments.segments.length + 1}`
      emit(session, TASK_BOUNDARY_FACT_TYPE, buildTaskBoundaryData({ boundary: 'open', taskId, reason: parsed.description }), logger)
      return { kind: 'success', text: `已开启任务 ${taskId}：${parsed.description}` }
    }
    if (parsed.boundary === 'close') {
      const taskId = segments.segments.at(-1)!.taskId
      emit(session, TASK_BOUNDARY_FACT_TYPE, buildTaskBoundaryData({ boundary: 'close', taskId, reason: '/task close' }), logger)
      return { kind: 'success', text: `已闭合任务 ${taskId}` }
    }
    const localTaskId = segments.segments.at(-1)!.taskId
    return renderTaskStatus(storage, sessionScopedTaskId(sid, localTaskId), localTaskId)
  })

  const initHandler = (invocation: CommandInvocation): Promise<CommandResult> => safe(async () => {
    counters.init++
    const session = invocation.agent.session
    const sid = sidOf(session)
    const raw = invocation.rawInput.trim()
    const frameKey = projectFrameStorageKey(workspace)

    if (raw === 'confirm') {
      const pending = pendingInit.get(sid)
      if (pending === undefined) return { kind: 'error', text: '没有待确认的 init 提案' }
      if (deps.skillsCtx === undefined) return { kind: 'error', text: '技能目录服务不可用，无法初始化项目帧' }
      const catalog = await listSkillCatalog(deps.skillsCtx)
      if (catalog === undefined || catalog.complete === false) {
        return { kind: 'error', text: '技能目录尚未完整，无法初始化项目帧' }
      }
      const existing = storage.getEntity('project_frame', frameKey)
      if (existing !== undefined) return { kind: 'error', text: '项目帧已存在，不能重复初始化' }
      const result = createProjectFrame(pending.goal, pending.aspects, catalog)
      await storage.putEntity(
        'project_frame',
        frameKey,
        result.body,
        {
          taskId: 'project-frame',
          eventType: 'init-frame',
          evidence: { goal: pending.goal, aspectCount: pending.aspects.length },
        },
        { baseVersion: 0 },
      )
      pendingInit.delete(sid)
      return { kind: 'success', text: `项目帧 v${result.version} 已初始化` }
    }

    if (raw === 'cancel') {
      pendingInit.delete(sid)
      return { kind: 'success', text: '已取消 init 提案' }
    }

    if (raw === '') {
      const record = storage.getEntity('project_frame', frameKey)
      if (record === undefined) {
        return { kind: 'success', text: '尚无项目帧。请运行 /init <项目目标> 发起初始化。' }
      }
      const body = record.body as ProjectFrameBody
      return {
        kind: 'success',
        text: [
          `项目帧版本：v${record.version}`,
          `目标：${body.goal}`,
          `方面：${body.aspects.length}`,
          `技能：${body.skillCatalog.skills.length}`,
        ].join('\n'),
      }
    }

    const goal = clampInitGoal(raw)
    if (goal === '') return { kind: 'error', text: '项目目标不能为空' }
    if (storage.getEntity('project_frame', frameKey) !== undefined) {
      return { kind: 'error', text: '项目帧已存在；修订经星标/设置，不在本命令范围' }
    }
    if (deps.llmCtx === undefined) return { kind: 'error', text: 'LLM 服务不可用，无法初始化项目帧' }
    const { provider, model } = resolveInitModel(getConfig(), readSessionModel(session))
    const rendered = renderInitPrompt(goal)
    let llmText = ''
    const options: CeGenerateOptions = {
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: rendered }], source: { kind: 'user' }, id: 'init' }] as never,
      purpose: 'context-economy-init',
      temperature: 0,
    }
    for await (const chunk of streamCeLlm(deps.llmCtx, options, { logger })) {
      if (chunk.type === 'text-delta') llmText += chunk.text
      if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') throw new Error('非正常结束')
    }
    const proposal = parseInitOutput(llmText)
    if (proposal === null) throw new Error('init 输出解析失败')
    if (pendingInit.size >= PENDING_INIT_LIMIT) {
      const oldest = pendingInit.keys().next().value
      if (oldest !== undefined) pendingInit.delete(oldest)
    }
    pendingInit.set(sid, { ...proposal, time: now() })
    return {
      kind: 'success',
      text: `提案已暂存：${proposal.goal}\n方面：${proposal.aspects.join('、')}\n请运行 /init confirm 确认，或 /init cancel 取消。`,
    }
  })

  const optimizeHandler = (invocation: CommandInvocation): Promise<CommandResult> => safe(async () => {
    counters.optimize++
    if (deps.manualOptimize !== undefined) {
      return deps.manualOptimize(invocation.agent.session, invocation.rawInput)
    }
    return { kind: 'error', text: '/optimize-prompt 入口已注册；完整断面由 P14b 接入后开放。' }
  })

  const definitions: CommandDefinition[] = [
    {
      name: 'task',
      description: '任务边界',
      input: { hint: '<描述> / close / 无参查看' },
      recordInput: true,
      handler: taskHandler,
    },
    {
      name: 'init',
      description: '初始化项目帧',
      input: { hint: '<项目目标> / confirm / cancel / 无参查看' },
      recordInput: true,
      handler: initHandler,
    },
    {
      name: 'optimize-prompt',
      description: '优化当前 prompt',
      input: { hint: '' },
      recordInput: false,
      handler: optimizeHandler,
    },
  ]

  for (const definition of definitions) disposers.push(commandsCtx.commands.register(definition))

  return {
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
    stats() {
      return {
        pendingInits: pendingInit.size,
        taskCommands: counters.task,
        initCommands: counters.init,
        optimizeCommands: counters.optimize,
      }
    },
  }
}

/**
 * dsh-price-less — 主插件入口（P12 自动断面接线）。
 *
 * 装配顺序：settings 注册 → H1/H7/H12 facts 事件泵 → 持久面 → 可选 llm 子 fiber 挂载自动断面。
 * llm/skills 均经 ctx.inject 子 fiber 读取，避免设为主插件硬依赖。
 */
import type { Context } from '@deepseek-ai/cordis'
import { type Config as ConfigShape } from './config.ts'
import { registerContextEconomySettings } from './settings.ts'
import { createEventPump, readSessionUserMessages } from './platform/events.ts'
import { ceLogger, registerFactMirror } from './platform/logger.ts'
import { attachDiagSink } from './platform/diag-sink.ts'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { openContextEconomyStorage, type ContextEconomyStorage } from './platform/storage.ts'
import { watchSkillCatalog, type SkillCatalogSnapshot } from './platform/skills.ts'
import { projectFrameStorageKey, reconcileProjectFrame, type ProjectFrameBody, type ProjectFrameRecord } from './core/prefix.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { BOUNDARY_JUDGE_WAIT_MS, mountAutoDiscriminator, type AutoDiscriminator } from './domains/input.ts'
import { mountShearDomain } from './domains/shear.ts'
import { mountAssembleDomain } from './domains/assemble.ts'
import { mountCompactionDomain } from './domains/compaction.ts'
import { onAgentPreStep, onAgentRequestError, onAgentSessionStart, type AgentSessionStartPayload } from './platform/agent-step.ts'
import { mountRestoreDomain } from './domains/restore.ts'
import { createMeterPort, type MeterPort } from './platform/meter.ts'
import { createFilesPort, type FilesPort } from './platform/files.ts'
import type { ToolSignatureSource } from './platform/tools.ts'
import { mountCommandFace } from './domains/commands.ts'
import { mountStarHost, readSessionId, renderPreviewCommandText } from './domains/star.ts'
import { registerStarBridge, type StarConnectionFace } from './platform/star-bridge.ts'

export const name = 'dsh-price-less'
const PROJECT_FRAME_TABLE = 'project_frame' as const

export { Config } from './config.ts'

function startStablePrefixWatch(ctx: Context, storage: ContextEconomyStorage): () => void {
  const log = ceLogger(ctx)
  const key = projectFrameStorageKey(process.cwd().replaceAll('\\', '/'))
  let missingLogged = false
  return watchSkillCatalog(ctx, (catalog: SkillCatalogSnapshot | undefined) => {
    try {
      const stored = storage.getEntity(PROJECT_FRAME_TABLE, key)
      const current: ProjectFrameRecord | undefined = stored == null
        ? undefined
        : { version: stored.version, body: stored.body as ProjectFrameBody }
      const result = reconcileProjectFrame(current, catalog, 'skill')
      if (result == null) {
        // 状态变化才记录：skill watch 每次回调都打会刷屏（实测 18 分钟 9,136 条）。
        if (!missingLogged) {
          missingLogged = true
          log.info('context-economy: prefix unavailable until init frame (skill watch active, no project_frame yet)')
        }
        return
      }
      missingLogged = false
      if (!result.rebuilt) return
      void storage.putEntity(
        PROJECT_FRAME_TABLE,
        key,
        result.body,
        {
          taskId: 'project-frame',
          eventType: 'prefix-rebuild',
          evidence: {
            cause: result.cause,
            fromVersion: result.fromVersion,
            toVersion: result.version,
            prefixTokens: result.prefixTokens,
          },
        },
        { baseVersion: stored?.version ?? 0 },
      ).catch((e: unknown) => {
        log.warn('context-economy: project frame rebuild failed (contained, fail-lazy)', e instanceof Error ? e.message : String(e))
      })
    } catch (e) {
      log.warn('context-economy: project frame reconcile failed (contained, fail-lazy)', e instanceof Error ? e.message : String(e))
    }
  })
}

export function apply(ctx: Context, config: Partial<ConfigShape>): void {
  attachDiagSink(ctx)
  const log = ceLogger(ctx)
  log.info('context-economy: applying (template state)')

  const getConfig = registerContextEconomySettings(ctx, config, {
    onChange: () => log.info('context-economy: config updated'),
  })

  const pump = createEventPump(ctx, ceLogger(ctx))
  ctx.effect(() => () => pump.dispose())

  // P15b：工具剪切调度（独立于 storage/llm——纯机械四档 + 事实发射；开关 = config.shear.enabled）。
  // N1 工具签名通道：cordis 服务必须经 inject 取得（直接读 ctx.tools 在真运行时抛
  // "cannot get property tools without inject" → 整个端口空转）。
  let toolsRef: ToolSignatureSource | undefined
  ctx.inject(['tools'], (toolsCtx) => {
    toolsRef = toolsCtx.get('tools') as ToolSignatureSource | undefined
    toolsCtx.effect(() => () => { toolsRef = undefined })
  })
  const shear = mountShearDomain(ctx, { pump, getConfig, logger: ceLogger(ctx), getTools: () => toolsRef })
  ctx.effect(() => () => shear.dispose())

  // P17b：边界装配域（盘上取真端口 H15 + 共享事务原语执行器；压缩触发/档案落盘归 P19）。
  let files: FilesPort | undefined
  ctx.inject(['fs'], (fsCtx) => {
    files = createFilesPort(fsCtx, { logger: ceLogger(fsCtx) })
    fsCtx.effect(() => () => { files = undefined })
  })
  const assemble = mountAssembleDomain({ pump, logger: ceLogger(ctx), getFiles: () => files })
  ctx.effect(() => () => assemble.dispose())

  // P19b：H7 计量端口（影子价同源；服务缺失 = 本地估算降级）。
  let meter: MeterPort | undefined
  ctx.inject(['tokenMeter'], (meterCtx) => {
    meter = createMeterPort(meterCtx)
    meterCtx.effect(() => () => { meter = undefined })
  })

  let autoDisc: AutoDiscriminator | undefined
  let stopAuto: (() => void) | undefined
  let stopPreStep: (() => void) | undefined
  let stopRequestError: (() => void) | undefined
  let stopSessionStart: (() => void) | undefined
  let restore: ReturnType<typeof mountRestoreDomain> | undefined
  // P21a：H9 在 apply() 同步注册（storage 异步打开期到达的 session-start 先进缓冲，装配后回放）。
  let restoreHandler: ((payload: AgentSessionStartPayload) => Promise<void>) | undefined
  const pendingStarts: AgentSessionStartPayload[] = []
  // U4：缓冲上界（storage 永不就绪时无界增长防护；溢出丢最旧 + warn 计数）。
  const PENDING_STARTS_LIMIT = 64
  let pendingStartsDropped = 0
  stopSessionStart = onAgentSessionStart(ctx, {
    logger: ceLogger(ctx),
    handler: (payload) => {
      if (restoreHandler === undefined) {
        pendingStarts.push(payload)
        if (pendingStarts.length > PENDING_STARTS_LIMIT) {
          pendingStarts.shift()
          pendingStartsDropped++
          ceLogger(ctx).warn('context-economy: pending session-start buffer overflow (oldest dropped)', String(pendingStartsDropped))
        }
        return
      }
      return restoreHandler(payload)
    },
  })
  let compaction: ReturnType<typeof mountCompactionDomain> | undefined
  let skillsCtx: Context | undefined
  let llmCtx: Context | undefined
  let stopCommands: (() => void) | undefined
  let starHost: ReturnType<typeof mountStarHost> | undefined
  let stopStarBridge: (() => Promise<void>) | undefined

  ctx.inject(['storageDomain'], (storageCtx) => {
    storageCtx.effect(() => {
      let storage: ContextEconomyStorage | undefined
      let stopSkillWatch: (() => void) | undefined
      let disposed = false
      const disposer = async () => {
        if (disposed) return
        disposed = true
        stopSkillWatch?.()
        stopAuto?.()
        stopPreStep?.()
        stopRequestError?.()
        stopSessionStart?.()
        restore?.dispose()
        compaction?.dispose()
        stopCommands?.()
        starHost?.dispose()
        await stopStarBridge?.()
        registerFactMirror(undefined)
        await storage?.close()
      }
      void openContextEconomyStorage(storageCtx, { logger: ceLogger(storageCtx) })
        .then((opened) => {
          if (disposed) {
            void opened.close()
            return
          }
          storage = opened
          registerFactMirror((type, data, meta) => opened.writeFactMirror(type, data, meta))
          // P21a：恢复编排（H9 恢复序；依赖 P3 四实体表 + P20 档案/检查点形态）。
          restore = mountRestoreDomain({
            storage: opened,
            logger: ceLogger(ctx),
            workspace: process.cwd().replaceAll('\\', '/'),
          })
          restoreHandler = (payload) => restore!.onSessionStart(payload).then(() => undefined)
          for (const pending of pendingStarts.splice(0)) {
            void restoreHandler(pending).catch((e: unknown) => {
              ceLogger(ctx).warn('context-economy: pending restore failed (contained, fail-lazy)', e instanceof Error ? e.message : String(e))
            })
          }
          ctx.inject(['skills'], (skillsCtx2) => {
            if (disposed) return
            // U4：重入防护（storage 服务重启重跑回调）+ fiber 卸载清理（effect）——
            // 旧行为只覆写变量，服务重载后旧 watch 判别器双挂载、pump 监听器泄漏。
            stopSkillWatch?.()
            stopSkillWatch = undefined
            skillsCtx = skillsCtx2 as Context
            stopSkillWatch = startStablePrefixWatch(skillsCtx, opened)
            ;(skillsCtx2 as Context).effect(() => () => {
              stopSkillWatch?.()
              stopSkillWatch = undefined
              skillsCtx = undefined
            })
          })
          ctx.inject(['llm'], (llmCtx2) => {
            if (disposed) return
            stopAuto?.()
            stopAuto = undefined
            llmCtx = llmCtx2 as Context
            const discriminator = mountAutoDiscriminator(llmCtx, {
              pump,
              storage: opened,
              getConfig,
              logger: ceLogger(llmCtx),
            })
            autoDisc = discriminator
            stopAuto = () => { if (autoDisc === discriminator) autoDisc = undefined; discriminator.dispose() }
            ;(llmCtx2 as Context).effect(() => () => {
              // llm fiber 卸载（服务重启/重载）→ 判别器随之卸载：不卸则每条用户消息双份判词 LLM 调用与双份事实。
              discriminator.dispose()
              if (autoDisc === discriminator) autoDisc = undefined
            })
          })
          // P19b：边界压缩域（H2 闭合触发 → 调用 → 装配 → 档案 vN → 事务替换）。
          compaction = mountCompactionDomain({
            storage: opened,
            getConfig,
            logger: ceLogger(ctx),
            assemble,
            getMeter: () => meter,
            getLlm: () => llmCtx,
            workspace: process.cwd().replaceAll('\\', '/'),
          })
          stopPreStep = onAgentPreStep(ctx, {
            logger: ceLogger(ctx),
            handler: async ({ session, turn, step }) => {
              // F2（2026-09-09）：边界压缩必须阻塞在**新任务第一条模型调用之前**——
              // 先等本轮判词落地（60s 有界；超时 fail-lazy，退回"下一 pre-step 再压"）。
              const discriminator = autoDisc
              if (discriminator !== undefined && getConfig().discriminator.auto === true) {
                const newestSeq = readSessionUserMessages(session).at(-1)?.seq
                if (newestSeq !== undefined) {
                  const outcome = await discriminator.settle(session, newestSeq, BOUNDARY_JUDGE_WAIT_MS)
                  if (outcome === 'timeout') {
                    ceLogger(ctx).warn('context-economy: boundary judge settle timed out (fail-lazy: compression deferred to next pre-step)')
                  }
                }
              }
              await compaction?.onPreStep({ session, turn, step })
            },
          })
          // P20b：H3 溢出接管（CONTEXT_WINDOW_EXCEEDED → 紧急压力折叠 → 本轮重试）。
          stopRequestError = onAgentRequestError(ctx, {
            logger: ceLogger(ctx),
            handler: ({ session, turn, step, failureCode }) => compaction?.onRequestError({ session, turn, step, failureCode }) ?? Promise.resolve('pass'),
          })
          ctx.inject(['sessions'], (sessionsCtx) => {
            if (disposed) return
            const sessions = sessionsCtx.get('sessions') as { get(id: string): Session | undefined } | undefined
            starHost?.dispose()
            starHost = undefined
            const host = mountStarHost({
              storage: opened,
              getConfig,
              logger: ceLogger(sessionsCtx),
              workspace: process.cwd().replaceAll('\\', '/'),
              skillsCtx,
              llmCtx,
              resolveSession: sessions === undefined ? undefined : (id) => sessions.get(id),
            })
            starHost = host
            ;(sessionsCtx as Context).effect(() => () => {
              host.dispose()
              if (starHost === host) starHost = undefined
            })
            ctx.inject(['connection'], (bridgeCtx) => {
              if (disposed) return
              const connection = bridgeCtx.get('connection') as StarConnectionFace | undefined
              if (connection === undefined) return
              void stopStarBridge?.()
              const stopBridge = registerStarBridge(connection, host, ceLogger(bridgeCtx))
              stopStarBridge = stopBridge
              ;(bridgeCtx as Context).effect(() => () => {
                void stopBridge()
              })
            })
          })
          ctx.inject(['commands'], (commandsCtx) => {
            if (disposed) return
            stopCommands?.()
            stopCommands = undefined
            const face = mountCommandFace({
              commandsCtx: commandsCtx as Context,
              storage: opened,
              getConfig,
              logger: ceLogger(commandsCtx),
              workspace: process.cwd().replaceAll('\\', '/'),
              skillsCtx,
              llmCtx,
              manualOptimize: async (session, rawInput) => {
                const prompt = rawInput.trim()
                if (starHost === undefined) return { kind: 'error', text: '断面服务不可用（sessions 服务缺失）' }
                if (prompt === '') return { kind: 'error', text: '用法：/optimize-prompt <prompt>' }
                const result = await starHost.preview({ sessionId: readSessionId(session), prompt })
                return result.ok
                  ? { kind: 'success', text: renderPreviewCommandText(result.value) }
                  : { kind: 'error', text: `${result.code}：${result.message}` }
              },
            })
            stopCommands = face.dispose
            ;(commandsCtx as Context).effect(() => () => {
              face.dispose()
            })
          })
        })
        .catch((e) => {
          registerFactMirror(undefined)
          ceLogger(storageCtx).warn(
            'context-economy: storage domain unavailable (contained, fail-lazy)',
            e instanceof Error ? e.message : String(e),
          )
        })
      return disposer
    })
  })
}

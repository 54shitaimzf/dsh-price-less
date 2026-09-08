/**
 * dsh-price-less — 主插件入口（P12 自动断面接线）。
 *
 * 装配顺序：settings 注册 → H1/H7/H12 facts 事件泵 → 持久面 → 可选 llm 子 fiber 挂载自动断面。
 * llm/skills 均经 ctx.inject 子 fiber 读取，避免设为主插件硬依赖。
 */
import type { Context } from '@deepseek-ai/cordis'
import { type Config as ConfigShape } from './config.ts'
import { registerContextEconomySettings } from './settings.ts'
import { createEventPump } from './platform/events.ts'
import { ceLogger, registerFactMirror } from './platform/logger.ts'
import { attachDiagSink } from './platform/diag-sink.ts'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { openContextEconomyStorage, type ContextEconomyStorage } from './platform/storage.ts'
import { watchSkillCatalog, type SkillCatalogSnapshot } from './platform/skills.ts'
import { projectFrameStorageKey, reconcileProjectFrame, type ProjectFrameBody, type ProjectFrameRecord } from './core/prefix.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { mountAutoDiscriminator } from './domains/input.ts'
import { mountShearDomain } from './domains/shear.ts'
import { mountAssembleDomain } from './domains/assemble.ts'
import { mountCompactionDomain } from './domains/compaction.ts'
import { onAgentPreStep, onAgentRequestError } from './platform/agent-step.ts'
import { createMeterPort, type MeterPort } from './platform/meter.ts'
import { createFilesPort, type FilesPort } from './platform/files.ts'
import { mountCommandFace } from './domains/commands.ts'
import { mountStarHost, readSessionId, renderPreviewCommandText } from './domains/star.ts'
import { registerStarBridge, type StarConnectionFace } from './platform/star-bridge.ts'

export const name = 'dsh-price-less'
const PROJECT_FRAME_TABLE = 'project_frame' as const

export { Config } from './config.ts'

function startStablePrefixWatch(ctx: Context, storage: ContextEconomyStorage): () => void {
  const log = ceLogger(ctx)
  const key = projectFrameStorageKey(process.cwd().replaceAll('\\', '/'))
  return watchSkillCatalog(ctx, (catalog: SkillCatalogSnapshot | undefined) => {
    try {
      const stored = storage.getEntity(PROJECT_FRAME_TABLE, key)
      const current: ProjectFrameRecord | undefined = stored == null
        ? undefined
        : { version: stored.version, body: stored.body as ProjectFrameBody }
      const result = reconcileProjectFrame(current, catalog, 'skill')
      if (result == null) {
        log.info('context-economy: prefix unavailable until init frame (skill watch active, no project_frame yet)')
        return
      }
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
  const shear = mountShearDomain(ctx, { pump, getConfig, logger: ceLogger(ctx) })
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

  let stopAuto: (() => void) | undefined
  let stopPreStep: (() => void) | undefined
  let stopRequestError: (() => void) | undefined
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
          registerFactMirror((type, data) => opened.writeFactMirror(type, data))
          ctx.inject(['skills'], (skillsCtx2) => {
            if (disposed) return
            skillsCtx = skillsCtx2 as Context
            stopSkillWatch = startStablePrefixWatch(skillsCtx, opened)
          })
          ctx.inject(['llm'], (llmCtx2) => {
            if (disposed) return
            llmCtx = llmCtx2 as Context
            stopAuto = mountAutoDiscriminator(llmCtx, {
              pump,
              storage: opened,
              getConfig,
              logger: ceLogger(llmCtx),
            }).dispose
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
            handler: ({ session, turn, step }) => compaction?.onPreStep({ session, turn, step }) ?? Promise.resolve(),
          })
          // P20b：H3 溢出接管（CONTEXT_WINDOW_EXCEEDED → 紧急压力折叠 → 本轮重试）。
          stopRequestError = onAgentRequestError(ctx, {
            logger: ceLogger(ctx),
            handler: ({ session, turn, step, failureCode }) => compaction?.onRequestError({ session, turn, step, failureCode }) ?? Promise.resolve('pass'),
          })
          ctx.inject(['sessions'], (sessionsCtx) => {
            if (disposed) return
            const sessions = sessionsCtx.get('sessions') as { get(id: string): Session | undefined } | undefined
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
            ctx.inject(['connection'], (bridgeCtx) => {
              if (disposed) return
              const connection = bridgeCtx.get('connection') as StarConnectionFace | undefined
              if (connection === undefined) return
              stopStarBridge = registerStarBridge(connection, host, ceLogger(bridgeCtx))
            })
          })
          ctx.inject(['commands'], (commandsCtx) => {
            if (disposed) return
            stopCommands = mountCommandFace({
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
            }).dispose
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

/**
 * @dsh-external/dsh-context-economy — 主插件入口（P12 自动断面接线）。
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
import { mountAutoDiscriminator } from './domains/input.ts'
import { mountCommandFace } from './domains/commands.ts'

export const name = '@dsh-external/dsh-context-economy'
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

  let stopAuto: (() => void) | undefined
  let skillsCtx: Context | undefined
  let llmCtx: Context | undefined
  let stopCommands: (() => void) | undefined

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
        stopCommands?.()
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

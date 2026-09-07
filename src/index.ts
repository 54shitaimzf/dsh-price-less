/**
 * @dsh-external/dsh-context-economy — 模板态最小入口（清退重建起点）。
 *
 * 插件主体已清退至 git 历史（清退前完整快照见 §29.14 追记所引提交段）；
 * 本文件 = dev_scaffold 模板规范的最小可装填形态：manifest + settings 段注册，
 * 供设置 UI 壳（client/，组件与交互设计全保留）挂载与二次开发。
 *
 * 模块: 主插件入口（模板态）
 * 平面: L0（装配注册；无模型、无能力域逻辑）
 * 回退链步数: 1（配置即用户显式规则）
 * 审查清单: settings 注册经 registerContextEconomySettings（settings 服务未装配
 *           时静默跳过，headless 不阻塞）；资源注册挂 ctx.effect（卸载即净）；
 *           无任何隐藏行为——重设计按 docs/ 设计文档从本骨架重建。
 * 度量: 无（能力域度量字段语义见 docs/07，随重建恢复）
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

export const name = '@dsh-external/dsh-context-economy'
export const inject = ['skills']
const PROJECT_FRAME_TABLE = 'project_frame' as const

// 入口铁律（docs/11 §1）：host 半边导出 name/Config/apply——Config = schema + interface 同名双面。
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
  // 诊断落盘 sink 最先挂载（P1.1：此后所有 named 诊断行——含本函数的引导行——均落盘）。
  // 能力缺失（测试替身）静默跳过；能力在但失败单次告警后停用——永不抛出。
  attachDiagSink(ctx)

  const log = ceLogger(ctx)
  log.info('context-economy: applying (template state)')

  // settings 段注册：配置权威源 = settings scope（用户层 > 装配 base > schema 默认）。
  // 这条注册是 client 设置卡挂载的前提（shell.available）；首次注册触发一次 onChange。
  registerContextEconomySettings(ctx, config, {
    onChange: () => log.info('context-economy: config updated'),
  })

  // H1/H7 事件面（docs/11 §2 events.ts 行）：firehose → 异步旁路队列，卸载即净。
  ctx.effect(() => {
    const pump = createEventPump(ctx, ceLogger(ctx))
    return () => pump.dispose()
  })

  // H10 持久面（docs/09 §1/§2 + docs/11 §2 storage.ts）：fail-lazy 开域；事实镜像经 logger 单点接线。
  ctx.inject(['storageDomain'], (storageCtx) => {
    storageCtx.effect(() => {
      let storage: ContextEconomyStorage | undefined
      let stopSkillWatch: (() => void) | undefined
      let disposed = false
      const disposer = async () => {
        if (disposed) return
        disposed = true
        stopSkillWatch?.()
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
          stopSkillWatch = startStablePrefixWatch(ctx, opened)
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

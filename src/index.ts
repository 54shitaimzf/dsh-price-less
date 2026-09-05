/**
 * @dsh-external/dsh-context-economy — 任务记忆插件（底座 + 输入流合并形态）。
 *
 * 职责：以会话为单位维护 task 段状态机（当前段/历史/摘要/表面位置），
 * 以段边界触发原生压缩，压缩摘要自动进段归档，
 * 段结束唤起图谱更新 hook（占位）。完全原生环境：不依赖注入器；
 * 逻辑（投影 fold/范围选择）为纯函数，无 harness 环境可测。
 *
 * 模块: 主插件入口（装配）
 * 平面: L0（装配）+ 委托给各模块（投影 L0 / 指挥 L0+L1 / 判别器 L0+L1）
 * 回退链步数: 见各模块自证
 * 审查清单: 投影注册置于 ctx.inject(['sessionProjections'], …) 回调
 *           （headless 装配不阻塞，参考 session-title 官方式）；
 *           所有监听/注册均为 fiber 效应（卸载即净）；
 *           v0.2.0-s6：边界语义票已移除；v0.3.0：机械判定层（T1 信号合议/
 *           簇迁移/todo 信号）整体退役（docs/07 §16）——边界来源 =
 *           显式指令（/task，回退链第 1 步）+ 判别器（语义判定）；
 *           v0.4.0：判别器接入主循环（docs/07 §18）——默认 observe（行为隔离），
 *           配置 mode='off' 时不挂载；装配经 resolveConfig 深合并（部分 config
 *           对象下 discriminator 默认字段不丢，防启动崩溃，docs/12 §5）；
 *           embedding 降级为 EmbeddingPort 零成本空壳（为映射检索留门）。
 * 度量: segmentsPerSession / taskSwitchRate / taskDefinitionBytes / judge*（docs/07 §18）
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'
import { Config, resolveConfig, type Config as ConfigShape } from './config.ts'
import { registerContextEconomySettings } from './settings.ts'
import { createTaskProjection } from './task/projection.ts'
import { registerOrchestrator, type TokenMeterShape } from './task/orchestrator.ts'
import { registerDiscriminator } from './discriminator/engine.ts'
import {
  TASK_PROJECTION_KEY,
  type ContextEconomyTaskState,
} from './task/types.ts'

export const name = '@dsh-external/dsh-context-economy'

export { CONFIG_DEFAULTS, resolveConfig } from './config.ts'

/** 投影状态读取接口（注入给指挥半边的最小形状）。 */
export interface TaskProjectionReader {
  stateOf(session: Session, key: string): ContextEconomyTaskState | undefined
}

/**
 * 注册投影单元（纯 fold）。置于 ctx.inject(['sessionProjections'], …)：
 * headless 装配（无投影 registry）不阻塞插件（参考 session-title 官方式）。
 */
export function registerTaskProjection(
  ctx: Context,
): void {
  const definition = createTaskProjection()
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(definition)
    projectionCtx.logger?.info?.('task-memory: projection unit registered')
  })
}

/** 模块自证模板（docs/05 §6）。 */
const COMPLIANCE_SELF_TEST = `模块: task 记忆插件
平面: L0（事件观测 + 规则 fold）+ L1（压缩触发 = 原生摘要，回退链第 6 级）
回退链步数: 1（显式 /task）→ 2（L0-continue 词表）→ 3（L1 缓存）→ 4（LLM 判别 = 主路径）
审查清单: 全部确认（数据=日志确定性事件；L0 化；压缩失败 fail-lazy；卸载即净；
          判别器 observe 默认 = 行为隔离）
度量: segmentsPerSession / taskSwitchRate / taskDefinitionBytes / judge*（docs/07）`

export function apply(ctx: Context, config: Partial<ConfigShape>): void {
  ctx.logger.info('task-memory: applying')

  // 投影单元：纯 fold（会话日志 → task 段状态机）。v0.3.0：机械判定层已退役。
  registerTaskProjection(ctx)

  // 指挥半边所需服务（可选获取：headless/未装压缩引擎时安全降级）。
  const sessionProjections = ctx.get('sessionProjections') as {
    stateOf(session: Session, key: string): ContextEconomyTaskState | undefined
  } | undefined
  const compaction = ctx.get('compaction') as CompactionEngine | undefined

  // —— settings 注册：配置权威源 = settings scope（用户层 > 装配 base > schema 默认）。
  //    动态读取函数 configSource() 实时返回已解析值；onChange 在配置提交/脱离时触发
  //    （installSection 首次注册也会触发一次 → 用于初始同步挂载）。
  //    注意：settings 服务未装配时静默跳过（源回退装配 base），插件行为不变。
  let configSource: () => ConfigShape
  let mounted: { discriminator: (() => void) | null; orchestrator: (() => void) | null } = {
    discriminator: null,
    orchestrator: null,
  }

  /** 判别器：语义票（输入域主路径）。默认 observe（只读观测，零行为影响）；
   *  mode='off' 不挂载。stateOf 可缺（headless 时 contextModel='unbound' 仍可判）。
   *  配置变更（含 mode 切换）→ 拆旧挂新（幂等：disposer 二次调用为 no-op）。 */
  const mountDiscriminator = (cfg: ConfigShape) => {
    // 配置来自当前 scope（动态）；mode='off' 即拆（不挂）。
    if (cfg.discriminator.mode !== 'off' && mounted.discriminator === null) {
      mounted.discriminator = ctx.effect(() => registerDiscriminator({
        ctx,
        config: cfg.discriminator,
        stateOf: sessionProjections === undefined
          ? undefined
          : (session, key) => sessionProjections.stateOf(session, key),
      }), 'task-memory discriminator')
      ctx.logger.info(`task-memory: discriminator mounted (mode=${cfg.discriminator.mode})`)
    } else if (cfg.discriminator.mode === 'off' && mounted.discriminator !== null) {
      mounted.discriminator()
      mounted.discriminator = null
      ctx.logger.info('task-memory: discriminator unmounted (mode=off)')
    } else if (cfg.discriminator.mode !== 'off' && mounted.discriminator !== null) {
      // 已挂但配置可能变（preset/超时等运行参数）：拆旧挂新，应用新配置。
      mounted.discriminator()
      mounted.discriminator = ctx.effect(() => registerDiscriminator({
        ctx,
        config: cfg.discriminator,
        stateOf: sessionProjections === undefined
          ? undefined
          : (session, key) => sessionProjections.stateOf(session, key),
      }), 'task-memory discriminator')
      ctx.logger.info(`task-memory: discriminator re-mounted (mode=${cfg.discriminator.mode})`)
    }
  }

  /** 编排半边：pre-step 压缩触发 + 溢出接管（副作用集中地；fiber 效应，卸载即净）。 */
  const mountOrchestrator = (cfg: ConfigShape) => {
    if (sessionProjections === undefined) {
      ctx.logger?.warn?.('task-memory: sessionProjections unavailable — orchestrator disabled (headless)')
      return
    }
    if (!cfg.sub2IntentMapping) {
      ctx.logger?.info?.('task-memory: sub2IntentMapping=false — projection registered, orchestrator disabled')
      return
    }
    if (!cfg.taskCompression && !cfg.overflowRecovery) {
      ctx.logger?.info?.('task-memory: compression disabled — boundary signals only')
    }
    if (mounted.orchestrator !== null) {
      mounted.orchestrator()
      mounted.orchestrator = null
    }
    mounted.orchestrator = ctx.effect(() => registerOrchestrator({
      ctx,
      sessionProjections: {
        stateOf: (session, key) => sessionProjections.stateOf(session, key),
      },
      compaction: cfg.taskCompression || cfg.overflowRecovery ? compaction : undefined,
      // task 分划保留策略（A3/A4 档）：近因保留尾 + 冷区闭合任务整压（边界锚定）。
      compressionDriverMode: cfg.compressionDriver,
      retainTokens: cfg.retainTokens,
      tokenMeter: ctx.get('tokenMeter') as
        | TokenMeterShape
        | undefined,
    }), 'task-memory orchestrator')
  }

  /** 配置提交/脱离同步：拆旧挂新（幂等）。 */
  const sync = (cfg: ConfigShape) => {
    mountDiscriminator(cfg)
    mountOrchestrator(cfg)
  }

  // settings 注册（返回动态源；首次注册会触发一次 onChange → 同步初始挂载）。
  configSource = registerContextEconomySettings(ctx, config, {
    onChange: () => sync(configSource()),
  })

  // 兜底：settings 服务未装配（无 scope）时，configSource() 即装配 base——照常挂载。
  if (mounted.discriminator === null && mounted.orchestrator === null) {
    sync(configSource())
  }
}

export { TASK_PROJECTION_KEY }

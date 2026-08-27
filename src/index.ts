/**
 * @dsh-external/dsh-context-economy — 任务记忆插件（底座 + 输入流合并形态）。
 *
 * 职责：以会话为单位维护 task 状态机（当前 task/历史/摘要/表面位置），
 * 以 task 边界触发原生压缩（占位），压缩摘要自动进 task 归档，
 * task 结束唤起图谱更新 hook（占位）。完全原生环境：不依赖注入器；
 * 逻辑（投影 fold/判界/范围选择）为纯函数，无 harness 环境可测。
 *
 * 模块: 主插件入口（装配）
 * 平面: L0（装配）+ 委托给各模块（投影 L0 / 指挥 L0+L1）
 * 回退链步数: 见各模块自证
 * 审查清单: 投影注册置于 ctx.inject(['sessionProjections'], …) 回调
 *           （headless 装配不阻塞，参考 session-title 官方式）；
 *           所有监听/注册均为 fiber 效应（卸载即净）；
 * 度量: roundsPerTask / taskSwitchRate / taskDefinitionBytes（docs/07）
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'
import { Config, type Config as ConfigShape } from './config.ts'
import { taskProjectionDefinition } from './task/projection.ts'
import { registerOrchestrator } from './task/orchestrator.ts'
import {
  TASK_PROJECTION_KEY,
  type ContextEconomyTaskState,
} from './task/types.ts'

export const name = '@dsh-external/dsh-context-economy'

/** 投影状态读取接口（注入给指挥半边的最小形状）。 */
export interface TaskProjectionReader {
  stateOf(session: Session, key: string): ContextEconomyTaskState | undefined
}

/**
 * 注册投影单元（纯 fold）。置于 ctx.inject(['sessionProjections'], …)：
 * headless 装配（无投影 registry）不阻塞插件（参考 session-title 官方式）。
 */
export function registerTaskProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(taskProjectionDefinition)
    projectionCtx.logger?.info?.('task-memory: projection unit registered')
  })
}

/** 模块自证模板（docs/05 §6）。 */
const COMPLIANCE_SELF_TEST = `模块: task 记忆插件
平面: L0（事件观测 + 规则 fold）+ L1（压缩触发 = 原生摘要，回退链第 6 级）
回退链步数: 2（代码分支：T0/T1 判界）→ 3（机械字符匹配）→ 6（原生压缩摘要）
审查清单: 全部确认（信号=日志确定性事件；L0 化；压缩失败 fail-lazy；卸载即净）
度量: roundsPerTask / taskSwitchRate / taskDefinitionBytes（docs/07）`

export function apply(ctx: Context, config: ConfigShape): void {
  ctx.logger.info('task-memory: applying')

  // 投影单元：纯 fold（会话日志 → task 状态机）。
  registerTaskProjection(ctx)

  // 指挥半边所需服务（可选获取：headless/未装压缩引擎时安全降级）。
  const sessionProjections = ctx.get('sessionProjections') as {
    stateOf(session: Session, key: string): ContextEconomyTaskState | undefined
  } | undefined
  const compaction = ctx.get('compaction') as CompactionEngine | undefined

  if (sessionProjections === undefined) {
    ctx.logger?.warn?.('task-memory: sessionProjections unavailable — orchestrator disabled (headless)')
    return
  }
  if (!config.sub2IntentMapping) {
    ctx.logger?.info?.('task-memory: sub2IntentMapping=false — projection registered, orchestrator disabled')
    return
  }
  if (!config.taskCompression && !config.overflowRecovery) {
    ctx.logger?.info?.('task-memory: compression disabled — boundary signals only')
  }

  // 指挥半边：pre-step 压缩触发 + 溢出接管（副作用集中地；fiber 效应，卸载即净）。
  ctx.effect(() => registerOrchestrator({
    ctx,
    sessionProjections: {
      stateOf: (session, key) => sessionProjections.stateOf(session, key),
    },
    compaction: config.taskCompression || config.overflowRecovery ? compaction : undefined,
  }), 'task-memory orchestrator')
}

export { TASK_PROJECTION_KEY }

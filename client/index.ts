/**
 * context-economy 配置卡片（client 半边入口）。
 *
 * 注册 `settings.plugin.item` 卡槽条目（key='context-economy'）：
 * - tab（ui-settings-plugins）按 settings namespace 与卡片 key 配对分发；
 * - 本文件只注册卡片；namespace 由 Host 半边（src/settings.ts）注册为 'context-economy'；
 *   浏览器侧 settingsScope 服务经 bind 读取同一 namespace。
 *
 * v0.6.0：新增 `remote.session`（模型目录，供模型路由下拉）与 `connection`
 * （连接重置时刷新目录）；监听 llm/adapters-updated / settings/document-updated
 * 在模型/配置变更后刷新候选（镜像官方 subagent 卡）。
 *
 * 依赖面（全部共享模块表/服务，无官方内部 src 依赖）：
 * - ctx.slots / ctx.settingsScope / ctx.remote.session / ctx.on（connection）
 * - react / react/jsx-runtime；
 * - @deepseek-ai/dsh-api-remotes（纯类型，拉入 ctx.remote Context merge，零运行期依赖）。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：拉入 slots / settingsScope / remote 的 Context merge 与官方槽位声明。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// U17④：type-only 拉入 ctx.sessions（会话绑定 → 事件窗）与 SessionEventWindow 类型面。
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { EconomyCard } from './Card.tsx'
import { CompactionProgressDock, type CompactionProgressInjected } from './CompactionProgress.tsx'
import { createCompactionProgressSource } from './compaction-progress.ts'
import { EconomyCardController, type EconomyCardFace } from './controller.ts'
import { StarButton } from './star/StarButton.tsx'
import { createHostStarBridge } from './star/star-bridge.ts'

/** 插件名（与 tsdown banner 的 ModuleLoader load id 一致；入口铁律 docs/11 §1 client 行）。 */
export const name = 'dsh-price-less'

/** 本插件配置 namespace（与 host 半边 src/settings.ts 同值；client 不得依赖 host 包）。 */
export const CONTEXT_ECONOMY_NS = 'context-economy'

/** 浏览器插件所需服务（fiber 注入）。 */
export const inject = ['slots', 'settingsScope', 'remote', 'remote.session', 'connection', 'sessions']

/**
 * 挂载配置卡片。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  const controller = new EconomyCardController(
    ctx.settingsScope.bind({ namespace: CONTEXT_ECONOMY_NS }),
    ctx.remote.session,
  )
  ctx.effect(() => () => { controller.dispose() }, 'context-economy: card controller')

  // 模型/适配器/配置变更 → 刷新模型目录候选。
  ctx.effect(
    () => ctx.remote.$on('llm/adapters-updated', () => { controller.refreshCatalog() }),
    'context-economy: catalog adapter invalidation',
  )
  ctx.effect(
    () => ctx.remote.$on('settings/document-updated', () => { controller.refreshCatalog() }),
    'context-economy: catalog settings invalidation',
  )
  ctx.effect(
    () => ctx.on('connection/reset', () => { controller.refreshCatalog() }),
    'context-economy: catalog connection generation',
  )

  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: CONTEXT_ECONOMY_NS,
      inject: () => {
        const face: EconomyCardFace = {
          hooks: { economyCard: controller.injectStore() },
          ...controller.actions(),
        }
        return face
      },
    }, EconomyCard)
  })

  const starBridge = createHostStarBridge(ctx)
  ctx.slots.inject('conversation.input.right', function* () {
    yield ctx.slots.register({
      name: 'conversation.input.right',
      id: 'context-economy-star',
      order: 10,
      inject: (sessionId: SessionId) => ({ star: starBridge }),
    }, StarButton)
  })

  // U17④：压缩进度条。数据源 = 该会话的事件窗（`context-economy/*` 事实经 session/follow 到达，
  // ignorable 事件不过滤）⇒ 不新增宿主→浏览器的推送通道，也就不存在"第二投递路径"的漂移面。
  ctx.slots.inject('conversation.input.dock', function* () {
    yield ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'context-economy-compaction-progress',
      order: 20,
      inject: (sessionId: SessionId): CompactionProgressInjected => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined) throw new Error(`context-economy: session "${String(sessionId)}" is unavailable`)
        return { hooks: { compactionProgress: createCompactionProgressSource(binding.eventSource) } }
      },
    }, CompactionProgressDock)
  })
}

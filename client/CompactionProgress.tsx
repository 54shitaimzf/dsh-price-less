/**
 * U17④ 压缩进度条（client 半边）：`conversation.input.dock` 里的一条"正在压缩"提示。
 *
 * **为什么需要**：压缩的模型调用是**长尾**——真机 A/F2 实测阻塞 62.6s（判词落地时首步思考早已产出）。
 * 那段时间界面上没有任何反馈，用户会以为卡死。宿主在调用前后各发一条 `context-economy/compact-progress`
 * 事实（ignorable，随 `session/follow` 到浏览器），本组件把"最后一条是 start"渲染成这条提示。
 *
 * **为什么只显示进行中**：`phase:'end'` 到达即消失。压缩的**结果**已有落位物（边界/压力压缩的
 * checkpoint 节点、`/compact` 的命令回复），再留一条"上次压缩用了 62s"只会变成噪声；且"几秒后自动隐藏"
 * 需要定时器，与"宿主/客户端事件驱动、无轮询"的纪律冲突（docs/11 §2 S5）。
 *
 * 禁区：不改写任何会话状态、不发 RPC、不显示宿主未报的数字（区间端点直接来自事实）。
 */
import type { CSSProperties } from 'react'
import type { InjectFace, PropsRuntime, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：拉取 conversation.input.dock 槽位声明（含 sessionId 等标准 props）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CompactionInFlight } from './compaction-progress.ts'
import { tint, TOKEN } from './theme.ts'

/** 本槽位的注入面：观察源经 `hooks` 隔舱交给渲染器合成为 `useCompactionProgress`。 */
export interface CompactionProgressInjected {
  hooks: { compactionProgress: HostObservable<CompactionInFlight | null> }
}

/** 槽位组件 props：标准运行时 share + 注入的进度观察源（hooks 已绑定成选择器 Hook）。 */
export type CompactionProgressProps =
  PropsRuntime<'conversation.input.dock'>
  & InjectFace<CompactionProgressInjected>

const MODE_LABEL: Record<CompactionInFlight['mode'], string> = {
  boundary: '任务边界压缩',
  pressure: '压力折叠',
}

const STRIP: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 8px',
  borderRadius: 6,
  border: `1px solid ${TOKEN.borderL1}`,
  background: tint(TOKEN.businessPrimary, 0.08),
  color: TOKEN.labelSecondary,
  fontSize: 11.5,
  lineHeight: 1.5,
}

/** 静态标记（不用 CSS 动画：本插件客户端零样式表、零定时器）。 */
const DOT: CSSProperties = {
  color: TOKEN.businessPrimary,
  fontSize: 12,
  lineHeight: 1,
}

/**
 * 压缩进行中提示条。
 * @param props - 槽位标准 props + `useCompactionProgress`（选择器 Hook）。
 */
export function CompactionProgressDock({ useCompactionProgress }: CompactionProgressProps) {
  // 选择器恒等取值：观察源快照引用稳定（同一把刀不换引用），故不会引发额外重渲染。
  const progress = useCompactionProgress((snapshot) => snapshot)
  if (progress === null || progress === undefined) return null

  const range = progress.startSeq === undefined || progress.endSeq === undefined
    ? ''
    : ` · 区间 ${progress.startSeq}–${progress.endSeq}`

  return (
    <div style={STRIP} role="status" aria-live="polite" title="上下文压缩进行中：本插件的压缩器正在重写一段历史">
      <span style={DOT} aria-hidden="true">◐</span>
      <span>上下文压缩中…</span>
      <span style={{ color: TOKEN.labelTertiary }}>
        {MODE_LABEL[progress.mode]}
        {range}
      </span>
    </div>
  )
}

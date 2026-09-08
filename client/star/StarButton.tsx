/**
 * P14a 星标按钮 UI（client 半边）。
 *
 * 注册到 `conversation.input.right`：读取当前会话草稿 → 调用可替换的
 * `StarHostBridge.preview` → 预览弹层 → 用户确认/编辑 → `apply` →
 * `inputActions.setDraft(editedProduct)` + `inputActions.submit()` 直接发送（确认即发送）。
 *
 * P14d：删 diff 与顶部统计（账本数据不进决策面）；裁决收进折叠详情；
 * 点弹层侧面不再关闭（防误触，只认取消/Esc）；只有关键事实缺失才显示警告。
 * 禁区：不写 host/storage/LLM；失败只显示错误，绝不改写用户草稿。
 */

import { useEffect, useState, type CSSProperties } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：拉取 conversation/session 的 SlotMap 合并，使本组件获得标准会话 props。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { CeButton } from '../components/CeButton.tsx'
import { TOKEN, Z_POPOVER, tint } from '../theme.ts'
import { STAR_NO_CONTEXT_NOTICE } from './star-protocol.ts'
import { isTrivialPrompt, verdictSummary } from './star-model.ts'
import type { StarButtonInjected, StarPreviewData } from './star-types.ts'

/** 槽位组件 props：标准运行时 share + 注入的 star 桥。 */
export type StarButtonProps =
  PropsRuntime<'conversation.input.right'>
  & InjectFace<StarButtonInjected>
const OVERLAY: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: Z_POPOVER,
  background: 'rgba(0,0,0,.42)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
}

const CARD: CSSProperties = {
  background: TOKEN.menu,
  border: `1px solid ${TOKEN.borderL2}`,
  borderRadius: 12,
  boxShadow: TOKEN.shadowLv3,
  padding: '16px 18px',
  width: '100%',
  maxWidth: 720,
  maxHeight: '80vh',
  overflow: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  color: TOKEN.labelPrimary,
  fontFamily: 'inherit',
}

const CODE: CSSProperties = {
  background: TOKEN.bgLayer2,
  border: `1px solid ${TOKEN.borderL1}`,
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 12,
  fontFamily: TOKEN.fontMono,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}
/**
 * 四角星闪光图标（勾线，AI/生成语义——业界共识；五角星会被读成"收藏"）。
 * 内联 SVG：不引入图标依赖；stroke=currentColor，随主题 token 变色。
 */
function SparkleIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ display: "block" }}
    >
      <path d="M11 2c.55 5.5 2.5 7.45 8 8-5.5.55-7.45 2.5-8 8-.55-5.5-2.5-7.45-8-8 5.5-.55 7.45-2.5 8-8Z" />
      <path d="M18 13.5c.3 2.2.8 2.7 3 3-2.2.3-2.7.8-3 3-.3-2.2-.8-2.7-3-3 2.2-.3 2.7-.8 3-3Z" />
    </svg>
  )
}

export function StarButton(props: StarButtonProps) {
  const { sessionId, inputActions, useInput, star } = props
  const draft = useInput((s) => s.draft)
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<StarPreviewData | null>(null)
  const [edited, setEdited] = useState('')
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** P14e：上次断面结果（按草稿文本保留）——同草稿再点只展开，不再调模型。 */
  const [cached, setCached] = useState<{ draft: string; data: StarPreviewData } | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const empty = draft.trim().length === 0
  const trivial = !empty && isTrivialPrompt(draft)
  const cachedHit = cached !== null && cached.draft === draft
  const disabled = loading || applying || sessionId === undefined || empty || trivial
  const hint = empty
    ? '先在输入框写下提示词，再用 AI 优化'
    : trivial
      ? '提示词过短（去标点后不足 4 字），没有可优化的内容'
      : cachedHit
        ? '展开上次优化结果（不再调用模型）'
        : 'AI 优化当前提示词（基于本任务已有消息）'

  const runPreview = async () => {
    if (sessionId === undefined || draft.trim().length === 0) return
    // P14e：同草稿已有结果 → 只展开，零调用、零等待。
    if (cachedHit) {
      setError(null)
      setNotice(null)
      setPreview(cached.data)
      setEdited(cached.data.product ?? draft)
      setOpen(true)
      return
    }
    setLoading(true)
    setError(null)
    setNotice(null)
    const result = await star.preview(sessionId, draft)
    setLoading(false)
    if (result.ok) {
      setCached({ draft, data: result.data })
      setPreview(result.data)
      setEdited(result.data.product ?? result.data.originalPrompt)
      setOpen(true)
    } else {
      setError(result.message)
    }
  }

  const runApply = async () => {
    if (preview === null || sessionId === undefined || applying) return
    setApplying(true)
    setError(null)
    setNotice(null)
    const result = await star.apply(sessionId, { previewId: preview.previewId, editedProduct: edited })
    setApplying(false)
    if (result.ok) {
      // P14d：确认即发送——先写回草稿再走标准提交机（提交失败会恢复草稿，不吞用户输入）。
      inputActions.setDraft(edited)
      inputActions.submit()
      // 结果已消费：失效缓存，避免复用已 apply 的预览（下次点击重新断面）。
      setCached(null)
      setOpen(false)
      setPreview(null)
      setNotice('已发送')
    } else {
      // 失败默认保留草稿；同时失效缓存，使下次点击重新断面而非反复撞同一个坏预览。
      setCached(null)
      setError(result.message)
    }
  }

  const close = () => {
    if (applying) return
    setOpen(false)
    setPreview(null)
    setError(null)
    setNotice(null)
  }

  const button: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 24,
    minWidth: 24,
    padding: '0 6px',
    borderRadius: 6,
    border: `1px solid ${TOKEN.borderL2}`,
    background: 'transparent',
    color: loading ? TOKEN.labelTertiary : TOKEN.warnPrimary,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    fontSize: 14,
    lineHeight: 1,
  }

  return (
    <>
      <button
        type="button"
        title={hint}
        aria-label="AI 优化提示词"
        disabled={disabled}
        style={button}
        onClick={() => { void runPreview() }}
      >
        {loading ? '…' : <SparkleIcon />}
      </button>
      {error !== null ? (
        <div role="alert" style={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          zIndex: Z_POPOVER,
          background: TOKEN.errorPrimary,
          color: '#fff',
          padding: '8px 12px',
          borderRadius: 8,
          fontSize: 12,
          maxWidth: 360,
          boxShadow: TOKEN.shadowLv3,
        }}>{error}</div>
      ) : null}
      {notice !== null ? (
        <div role="status" style={{
          position: 'fixed',
          bottom: 16,
          left: 16,
          zIndex: Z_POPOVER,
          background: TOKEN.successPrimary,
          color: '#fff',
          padding: '8px 12px',
          borderRadius: 8,
          fontSize: 12,
          maxWidth: 360,
          boxShadow: TOKEN.shadowLv3,
        }}>{notice}</div>
      ) : null}
      {open && preview !== null ? (
        <div style={OVERLAY}>
          <div style={CARD} role="dialog" aria-modal="true">
            <div style={{ fontSize: 15, fontWeight: 700 }}>提示词优化预览</div>
            {preview.historyCount === 0 ? (
              <div style={{ fontSize: 11.5, color: TOKEN.labelTertiary }}>{STAR_NO_CONTEXT_NOTICE}</div>
            ) : null}
            {preview.missingAuthority.length > 0 ? (
              <div style={{ border: `1px solid ${tint(TOKEN.warnPrimary, 0.5)}`, borderRadius: 8, padding: "6px 8px", fontSize: 12, color: TOKEN.warnPrimary }}>
                关键事实未保留：{preview.missingAuthority.slice(0, 3).map((m) => m.text).join("；")}
                {preview.missingAuthority.length > 3 ? ` 等 ${preview.missingAuthority.length} 处` : ""}
              </div>
            ) : null}
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>优化后 prompt（可编辑，确认即发送）</div>
              <textarea
                value={edited}
                onChange={(e) => setEdited(e.target.value)}
                rows={8}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  resize: 'vertical',
                  border: `1px solid ${TOKEN.borderL2}`,
                  borderRadius: 8,
                  padding: '8px 10px',
                  fontSize: 12,
                  fontFamily: TOKEN.fontMono,
                  lineHeight: 1.55,
                  background: TOKEN.inputMajor,
                  color: TOKEN.labelPrimary,
                }}
              />
            </div>
            <details style={{ fontSize: 12, color: TOKEN.labelSecondary }}>
              <summary style={{ cursor: "pointer" }}>
                详情（历史 {preview.historyCount} 条 · 上下文 {preview.ctxTokens} tokens · {verdictSummary(preview.verdicts)} · 丢行 {preview.droppedLines}）
              </summary>
              <div style={{ ...CODE, maxHeight: 160, overflow: "auto", marginTop: 6 }}>
                {preview.verdicts.length === 0 ? '（无裁决）' : preview.verdicts.map((v, i) => (
                  <div key={i}>{v.kind}: {v.summary}</div>
                ))}
              </div>
            </details>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <CeButton variant="ghost" onClick={close} disabled={applying}>取消</CeButton>
              <CeButton variant="primary" onClick={() => { void runApply() }} disabled={applying}>
                {applying ? '发送中…' : '应用并发送'}
              </CeButton>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

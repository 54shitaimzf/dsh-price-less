/**
 * CeConfirm —— 危险操作二次确认（卡片内 in-place 遮罩 + 居中弹窗）。
 * 只在"影响面大"的操作上用（如全量恢复默认）；遮罩覆盖本卡片，点外/取消关闭。
 */
import type { CSSProperties, ReactNode } from 'react'
import { TOKEN, Z_CONFIRM } from '../theme.ts'
import { CeButton } from './CeButton.tsx'

export interface CeConfirmProps {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel: string
  cancelLabel?: string
  confirmVariant?: 'danger' | 'primary'
  onConfirm: () => void
  onCancel: () => void
}

export function CeConfirm({
  open, title, body, confirmLabel, cancelLabel = '取消',
  confirmVariant = 'danger', onConfirm, onCancel,
}: CeConfirmProps) {
  if (!open) return null
  const overlay: CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: Z_CONFIRM,
    background: 'rgba(0,0,0,.42)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
  }
  const card: CSSProperties = {
    background: TOKEN.menu,
    border: `1px solid ${TOKEN.borderL2}`,
    borderRadius: 10,
    boxShadow: TOKEN.shadowLv3,
    padding: '16px 18px',
    width: '100%',
    maxWidth: 320,
  }
  return (
    <div style={overlay} onClick={onCancel}>
      <div style={card} role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 14, fontWeight: 700, color: TOKEN.labelPrimary, marginBottom: 6 }}>{title}</div>
        <div style={{ fontSize: 12.5, lineHeight: 1.6, color: TOKEN.labelSecondary, marginBottom: 14 }}>{body}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <CeButton variant="ghost" onClick={onCancel}>{cancelLabel}</CeButton>
          <CeButton variant={confirmVariant} onClick={onConfirm}>{confirmLabel}</CeButton>
        </div>
      </div>
    </div>
  )
}

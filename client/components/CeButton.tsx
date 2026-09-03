/**
 * CeButton —— token 驱动的自研按钮（primary/ghost/danger）。
 * 统一本卡片的按钮视觉（替代散落的内联 button 样式）。
 */
import type { CSSProperties, ReactNode } from 'react'
import { TOKEN } from '../theme.ts'

export type CeButtonVariant = 'primary' | 'ghost' | 'danger' | 'ghostDanger'

export interface CeButtonProps {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: CeButtonVariant
  style?: CSSProperties
  title?: string
}

const BASE: CSSProperties = {
  border: 'none',
  borderRadius: 7,
  padding: '6px 14px',
  fontSize: 13,
  fontFamily: 'inherit',
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'background .12s ease, color .12s ease, border-color .12s ease, opacity .12s ease',
}

export function CeButton({ children, onClick, disabled = false, variant = 'ghost', style, title }: CeButtonProps) {
  const styles: Record<CeButtonVariant, CSSProperties> = {
    primary: {
      background: TOKEN.businessPrimary,
      color: '#fff',
      border: 'none',
    },
    ghost: {
      background: 'transparent',
      color: TOKEN.labelSecondary,
      border: `1px solid ${TOKEN.borderL2}`,
    },
    ghostDanger: {
      background: TOKEN.interactiveHoverDanger,
      color: TOKEN.errorPrimary,
      border: 'none',
    },
    danger: {
      background: TOKEN.errorPrimary,
      color: '#fff',
      border: 'none',
    },
  }
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{ ...BASE, ...styles[variant], opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer', ...style }}
    >
      {children}
    </button>
  )
}

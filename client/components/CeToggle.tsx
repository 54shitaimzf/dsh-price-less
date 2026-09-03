/**
 * CeToggle —— 自研开关（替代原生 <input type=checkbox>）。
 */
import type { CSSProperties } from 'react'
import { TOKEN } from '../theme.ts'

export interface CeToggleProps {
  checked: boolean
  disabled?: boolean
  accent?: string
  onChange: (checked: boolean) => void
}

export function CeToggle({ checked, disabled = false, accent = TOKEN.businessPrimary, onChange }: CeToggleProps) {
  const trackStyle: CSSProperties = {
    position: 'relative',
    width: 34,
    height: 18,
    borderRadius: 9,
    background: checked ? accent : TOKEN.borderL2,
    cursor: disabled ? 'default' : 'pointer',
    transition: 'background .15s ease',
    flex: '0 0 auto',
  }
  const knobStyle: CSSProperties = {
    position: 'absolute',
    top: 2,
    left: 2,
    width: 14,
    height: 14,
    borderRadius: '50%',
    background: '#fff',
    transition: 'transform .15s ease',
    transform: checked ? 'translateX(16px)' : 'translateX(0)',
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{ ...trackStyle, opacity: disabled ? 0.5 : 1, border: 'none' }}
    >
      <span style={knobStyle} />
    </button>
  )
}

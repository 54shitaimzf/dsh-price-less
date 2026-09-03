/**
 * CeText —— token 驱动的文本输入。
 */
import type { CSSProperties } from 'react'
import { TOKEN } from '../theme.ts'

export interface CeTextProps {
  value: string
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  onChange: (text: string) => void
}

export function CeText({ value, placeholder, disabled = false, invalid = false, onChange }: CeTextProps) {
  const inputStyle: CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 8px',
    borderRadius: 6,
    border: `1px solid ${invalid ? TOKEN.errorPrimary : TOKEN.borderL2}`,
    background: TOKEN.inputMajor,
    color: TOKEN.labelPrimary,
    fontSize: 13,
    fontFamily: 'inherit',
  }
  return (
    <input
      type="text"
      disabled={disabled}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={inputStyle}
    />
  )
}

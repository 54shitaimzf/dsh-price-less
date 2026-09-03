/**
 * CePath —— 路径字段（默认目录 | 自定义）+ 自定义文本输入。
 * "高成本文字填写 → 下拉"的降级：路径不默认让用户手打，先给"默认目录"选项，
 * 只有显式选"自定义"才出现文本框。
 */
import { useState, type CSSProperties } from 'react'
import { TOKEN } from '../theme.ts'

export interface CePathProps {
  value: string
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  onChange: (text: string) => void
}

export function CePath({ value, placeholder, disabled = false, invalid = false, onChange }: CePathProps) {
  const [pickedCustom, setPickedCustom] = useState(false)
  const isCustom = value !== '' ? true : pickedCustom

  const segStyle = (active: boolean): CSSProperties => ({
    flex: '0 0 auto',
    padding: '6px 10px',
    fontSize: 12,
    borderRadius: 6,
    border: `1px solid ${active ? TOKEN.businessPrimary : TOKEN.borderL2}`,
    background: active ? TOKEN.interactiveHover : 'transparent',
    color: active ? TOKEN.labelPrimary : TOKEN.labelTertiary,
    cursor: disabled ? 'default' : 'pointer',
  })
  const inputStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
      <button type="button" disabled={disabled} onClick={() => { onChange(''); setPickedCustom(false) }} style={segStyle(!isCustom)}>
        默认目录
      </button>
      <button type="button" disabled={disabled} onClick={() => setPickedCustom(true)} style={segStyle(isCustom)}>
        自定义
      </button>
      {isCustom ? <input type="text" disabled={disabled} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={inputStyle} /> : null}
    </div>
  )
}

/**
 * CeNumber —— 数字输入 + 自研上下步进（替代原生数字文本框）。
 *
 * 整行化控件：与 CeSelect 触发区同高、同描边、同底色、同圆角 —— 左右缘与其它字段对齐，
 * 不再是"窄带"。框内从左到右：可编辑数值（flex 撑满）→ 单位（右对齐，统一贴后列）→ 步进列。
 * 步进列 = 一组上下 chevron（沿用 CHEVRON_PATH 原生 wide-V，up/down 旋转），embed 在整行尾部，
 * 用 fillL2 底 + borderLeft 分隔成"编辑区 / 步进区"。
 *
 * 注意：hover/disabled/focus 这类交互态颜色必须放 `<style>`（内联 style 优先级高于样式表，
 * 内联会压死 :hover/:focus-within）。本文件把"边框色 + 步进钮底色/字色"都收敛到 BOX_CSS，
 * 结构样式（布局/尺寸/圆角/字号）留在内联。
 */
import type { CSSProperties } from 'react'
import { TOKEN } from '../theme.ts'
import { Chevron } from '../icons.tsx'

/** 交互态样式（内联无法表达 :hover/:focus-within/disabled，必须走样式表）。 */
const BOX_CSS = `
.ce-num-box{border:1px solid var(--dsw-alias-border-l2)}
.ce-num-box:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.ce-num-box.ce-num--invalid{border-color:var(--dsw-alias-state-error-primary)}
.ce-num-box.ce-num--invalid:focus-within{border-color:var(--dsw-alias-state-error-primary)}
.ce-num-step{background:transparent;color:var(--dsw-alias-label-tertiary)}
.ce-num-step:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
`

export interface CeNumberProps {
  value: string
  min?: number
  max?: number
  step?: number
  unit?: string
  disabled?: boolean
  invalid?: boolean
  onChange: (text: string) => void
}

export function CeNumber({ value, min, max, step = 1, unit, disabled = false, invalid = false, onChange }: CeNumberProps) {
  const boxStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'stretch',
    width: '100%',
    boxSizing: 'border-box',
    borderRadius: 6,
    background: TOKEN.inputMajor,
    overflow: 'hidden',
  }
  const inputStyle: CSSProperties = {
    flex: '1 1 auto',
    minWidth: 0,
    boxSizing: 'border-box',
    border: 'none',
    background: 'transparent',
    padding: '6px 9px',
    color: TOKEN.labelPrimary,
    fontSize: 13,
    fontFamily: 'inherit',
    outline: 'none',
  }
  const unitStyle: CSSProperties = {
    flex: '0 0 auto',
    alignSelf: 'center',
    paddingRight: 9,
    fontSize: 11,
    color: TOKEN.labelTertiary,
    whiteSpace: 'nowrap',
  }
  const stepperStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    flex: '0 0 22px',
    width: 22,
    boxSizing: 'border-box',
    borderLeft: `1px solid ${TOKEN.borderL2}`,
    background: TOKEN.fillL2,
  }
  const stepBtn: CSSProperties = {
    flex: '1 1 0',
    minHeight: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    padding: 0,
    cursor: disabled ? 'default' : 'pointer',
  }
  const current = Number(value)
  const bump = (dir: 1 | -1) => {
    const base = Number.isFinite(current) ? current : (Number.isFinite(min) ? min! : 0)
    let next = base + dir * step
    if (min !== undefined && next < min) next = min
    if (max !== undefined && next > max) next = max
    onChange(String(next))
  }
  return (
    <div className={invalid ? 'ce-num-box ce-num--invalid' : 'ce-num-box'} style={boxStyle}>
      <style>{BOX_CSS}</style>
      <input
        type="text"
        inputMode="numeric"
        disabled={disabled}
        value={value}
        placeholder={String(min ?? '')}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
      {unit ? <span style={unitStyle}>{unit}</span> : null}
      <div style={stepperStyle}>
        <button type="button" className="ce-num-step" disabled={disabled} aria-label="增加" onClick={() => bump(1)} style={stepBtn}>
          <Chevron dir="up" size={12} />
        </button>
        <button type="button" className="ce-num-step" disabled={disabled} aria-label="减少" onClick={() => bump(-1)} style={stepBtn}>
          <Chevron dir="down" size={12} />
        </button>
      </div>
    </div>
  )
}

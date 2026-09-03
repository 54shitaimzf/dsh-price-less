/**
 * FieldRow —— 每字段壳：label + 控件 + 短 hint + "?"帮助 + 复原胶囊。
 * 把长说明收进 CeTip（有 docs 才显示 "?"）；复原胶囊仅非 select 且 modified 时出现（红色危险语义）。
 */
import type { CSSProperties } from 'react'
import { ECONOMY_FIELD_COPY, type EconomyFieldSpec } from '../field-model.ts'
import type { EconomyFieldState } from '../controller.ts'
import { TOKEN } from '../theme.ts'
import { CeSelect } from './CeSelect.tsx'
import { CeToggle } from './CeToggle.tsx'
import { CeNumber } from './CeNumber.tsx'
import { CeText } from './CeText.tsx'
import { CePath } from './CePath.tsx'
import { CeTip } from './CeTip.tsx'

export interface FieldRowProps {
  field: string
  spec: EconomyFieldSpec
  state: EconomyFieldState
  disabled: boolean
  accent: string
  onEdit: (text: string) => void
  onReset: () => void
}

export function FieldRow({ field, spec, state, disabled, accent, onEdit, onReset }: FieldRowProps) {
  const copy = ECONOMY_FIELD_COPY[field] ?? { label: field, hint: spec.valueHint ?? '' }
  const fieldStyle: CSSProperties = { margin: '10px 0', display: 'flex', flexDirection: 'column', gap: 4 }
  const labelRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }
  const labelStyle: CSSProperties = { fontSize: 13, fontWeight: 600, color: TOKEN.labelPrimary }
  const hintStyle: CSSProperties = {
    margin: 0,
    minHeight: 14,
    fontSize: 11,
    color: state.invalid ? TOKEN.errorPrimary : TOKEN.labelTertiary,
  }
  const resetPill: CSSProperties = {
    fontSize: 11,
    background: TOKEN.interactiveHoverDanger,
    border: 'none',
    color: TOKEN.errorPrimary,
    borderRadius: 10,
    padding: '2px 8px',
    cursor: disabled ? 'default' : 'pointer',
    flex: '0 0 auto',
    whiteSpace: 'nowrap',
  }

  // 复原胶囊始终渲染（只切 visibility）——占用空间（行高 + 右槽位）恒定，出现/消失零 reflow，
  // 标签行与其下控件不再因"有无胶囊"而上下跳。隐藏时叠加 disabled+tabIndex+aria-hidden：鼠标/键盘/读屏均无法命中。
  const showReset = state.modified && spec.type !== 'select'
  const pillDisabled = disabled || !showReset

  let control
  switch (spec.type) {
    case 'select':
      control = (
        <CeSelect
          value={state.text}
          options={spec.options ?? []}
          placeholder={spec.placeholder}
          disabled={disabled}
          invalid={state.invalid}
          defaultValue={spec.default === undefined ? undefined : String(spec.default)}
          onChange={onEdit}
        />
      )
      break
    case 'number':
      control = <CeNumber value={state.text} min={spec.min} max={spec.max} step={spec.step} unit={spec.unit} disabled={disabled} invalid={state.invalid} onChange={onEdit} />
      break
    case 'bool': {
      const checked = state.text === 'true'
      control = (
        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, color: TOKEN.labelPrimary }}>
          <CeToggle checked={checked} disabled={disabled} accent={accent} onChange={(c) => onEdit(c ? 'true' : 'false')} />
          {checked ? '开启' : '关闭'}
        </label>
      )
      break
    }
    case 'path':
      control = <CePath value={state.text} placeholder={spec.placeholder} disabled={disabled} invalid={state.invalid} onChange={onEdit} />
      break
    default:
      control = <CeText value={state.text} placeholder={spec.placeholder} disabled={disabled} invalid={state.invalid} onChange={onEdit} />
  }

  return (
    <div style={fieldStyle}>
      <div style={labelRow}>
        <label style={labelStyle}>{copy.label}</label>
        {copy.docs ? <CeTip text={copy.docs} /> : null}
        <div style={{ flex: 1 }} />
        {/* 预留固定 56px 右槽：「复原」始终渲染（visibility 切换）、占位恒定 → 出现/消失零布局位移，可扩展到同排右侧控件。 */}
        <div style={{ flex: '0 0 56px', width: 56, display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
          <button
            type="button"
            disabled={pillDisabled}
            onClick={onReset}
            tabIndex={showReset ? 0 : -1}
            aria-hidden={!showReset}
            style={{ ...resetPill, visibility: showReset ? 'visible' : 'hidden' }}
          >复原</button>
        </div>
      </div>
      {control}
      {spec.type === 'bool'
        ? null
        : <p style={hintStyle}>{state.invalid ? (state.errorMessage ?? '无效值') : copy.hint || spec.valueHint || ''}</p>}
    </div>
  )
}

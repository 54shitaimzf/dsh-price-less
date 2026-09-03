/**
 * CeGroup —— 折叠组卡（编号标题 + accent 色条 + N 项 + ▾/▸）。
 * 标题本身带边框包裹（让"纯文字标题"可感知可点）；默认折叠由 defaultOpen 控制。
 */
import type { CSSProperties, ReactNode } from 'react'
import type { EconomyFieldGroup } from '../field-model.ts'
import { TOKEN } from '../theme.ts'
import { Chevron, GroupIcon } from '../icons.tsx'

export interface CeGroupProps {
  group: EconomyFieldGroup
  open: boolean
  disabled?: boolean
  onToggle: () => void
  children: ReactNode
}

export function CeGroup({ group, open, disabled = false, onToggle, children }: CeGroupProps) {
  // 扁平子标题行：不再是"按钮胶囊"（去 border/圆角）；展开/悬停一层 group.tint 浅底。
  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    boxSizing: 'border-box',
    border: 'none',
    borderRadius: 6,
    padding: '5px 2px',
    marginBottom: 2,
    background: open ? group.tint : 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    color: 'inherit',
    fontFamily: 'inherit',
  }
  const titleStyle: CSSProperties = {
    fontSize: 14,
    fontWeight: 600,
    color: TOKEN.labelPrimary,
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  }
  // 不再用横向缩进（paddingLeft+borderLeft）标识层级——它会右移控件、破坏与常驻行的对齐；
  // 功能区色改由组头图标/描边/浅底体现，层级由「设置项」父容器视觉负责。
  const bodyStyle: CSSProperties = {
    padding: '2px 0 8px',
    overflow: 'visible',
  }
  return (
    <div style={{ marginBottom: 4 }}>
      <button type="button" onClick={onToggle} disabled={disabled} style={headerStyle} aria-expanded={open}>
        <GroupIcon id={group.id} color={group.accent} />
        <span style={titleStyle}>{group.title}</span>
        <span style={{ fontSize: 11, color: TOKEN.labelTertiary, whiteSpace: 'nowrap' }}>{group.fields.length} 项</span>
        <Chevron dir={open ? 'down' : 'right'} color={TOKEN.labelTertiary} />
      </button>
      {open ? (
        <div style={bodyStyle}>
          {group.desc ? <p style={{ margin: '2px 0 8px', fontSize: 12, color: TOKEN.labelSecondary }}>{group.desc}</p> : null}
          {children}
        </div>
      ) : null}
    </div>
  )
}

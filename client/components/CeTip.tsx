/**
 * CeTip —— "?" 帮助浮窗（把长说明信息收起来）。
 * **纯 hover、无 click 兜底**：鼠标移到 "?" 即展开，移入浮窗保持，移出（离开触发/浮窗）后
 * 约 120ms 关闭——这是简洁的说明元素，不叠点击路径。
 * 弹层 position:fixed 定位到视口（不被 AppFrame/设置列裁剪，压过侧边栏）。
 */
import { useCallback, useEffect, useRef, type CSSProperties } from 'react'
import { TOKEN, Z_POPOVER } from '../theme.ts'
import { useAnchorPopover } from './popover.ts'

export interface CeTipProps {
  text: string
}

export function CeTip({ text }: CeTipProps) {
  const { open, setOpen, ref, panelRef, pos } = useAnchorPopover()
  const leaveTimer = useRef<number | undefined>(undefined)

  const enter = useCallback(() => {
    if (leaveTimer.current !== undefined) { clearTimeout(leaveTimer.current); leaveTimer.current = undefined }
    setOpen(true)
  }, [])
  const leave = useCallback(() => {
    if (leaveTimer.current !== undefined) clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => setOpen(false), 120)
  }, [])
  useEffect(() => () => { if (leaveTimer.current !== undefined) clearTimeout(leaveTimer.current) }, [])

  const trigger: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 15,
    height: 15,
    borderRadius: '50%',
    border: `1px solid ${TOKEN.borderL2}`,
    background: 'transparent',
    color: TOKEN.labelTertiary,
    fontSize: 10,
    fontWeight: 700,
    lineHeight: 1,
    cursor: 'help',
    flex: '0 0 auto',
  }
  const panel: CSSProperties = {
    ...pos,
    zIndex: Z_POPOVER,
    maxWidth: 264,
    background: TOKEN.menu,
    border: `1px solid ${TOKEN.borderL2}`,
    borderRadius: 10,
    boxShadow: TOKEN.shadowLv3,
    padding: '10px 12px',
    fontSize: 12,
    lineHeight: 1.6,
    color: TOKEN.labelSecondary,
    fontWeight: 400,
    whiteSpace: 'normal',
  }
  return (
    <div ref={ref} onMouseEnter={enter} onMouseLeave={leave} style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" aria-label="说明" style={trigger}>?</button>
      {open ? (
        <div ref={panelRef} role="tooltip" style={panel} onMouseEnter={enter} onMouseLeave={leave}>{text}</div>
      ) : null}
    </div>
  )
}

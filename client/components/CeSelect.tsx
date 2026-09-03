/**
 * CeSelect —— 自研 token 驱动下拉（替代原生 <select>）。
 *
 * - 弹层 position:fixed 视口定位（不被 AppFrame/设置列 overflow:hidden 裁剪，压过侧边栏）；
 *   定位后坐标带 position:'fixed'（popover.ts 已修），**不撑布局**。
 * - 宽度**显式取触发钮实宽**（fixed 下 `minWidth:100%` 会塌成视口宽）。
 * - 滚动条隐藏（.ce-scroll-panel），可滚动时在顶/底叠透明→面板底色渐变预告（pointer-events:none）。
 * - 选项按 值(主色) + 系统提示(浅色) 拆开；选中 = 品牌浅底 + 左 3px 类别竖条 + 值加粗 + 绿勾；
 *   每选项带左侧类别色指示条（tone，望色生义）。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { EconomySelectOption } from '../field-model.ts'
import { TOKEN, TONE_COLOR, Z_POPOVER, type Tone } from '../theme.ts'
import { useAnchorPopover } from './popover.ts'
import { Chevron } from '../icons.tsx'

const SCROLL_CSS = `
.ce-scroll-panel{scrollbar-width:none}
.ce-scroll-panel::-webkit-scrollbar{display:none}
.ce-opt:not(.ce-opt--selected):hover{background:var(--dsw-alias-interactive-bg-hover)}
`

export interface CeSelectProps {
  value: string
  options: readonly EconomySelectOption[]
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  /** 值为该值的选项标（默认）提示。 */
  defaultValue?: string
  /** 触发区宽度（默认 100%）。 */
  width?: string | number
  onChange: (value: string) => void
}

/** 拆「主文本 + 提示」：剥离所有 `（…）`/`(…)` 成提示组，值只留主干并归一化 ` ： ` → `：`。 */
function splitLabel(label: string): { value: string; hints: string[] } {
  const hints: string[] = []
  const value = label.replace(/[（(]([^（）()]*)[）)]/g, (_, m: string) => {
    const t = m.trim()
    if (t) hints.push(t)
    return ''
  }).replace(/\s*：\s*/g, '：').trim()
  return { value, hints }
}

/** 组装「值（主色）+ 提示（浅色）」片段；值为空时提示整体作为浅色占位行。 */
function labelNode(
  label: string,
  isDefault: boolean,
  bold: boolean,
  valueColor: string,
  hintColor: string,
  hintSize?: number,
): ReactNode {
  const { value, hints } = splitLabel(label)
  if (isDefault && !hints.includes('默认')) hints.push('默认')
  if (value) {
    return (
      <>
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0, fontWeight: bold ? 600 : 400, color: valueColor }}>{value}</span>
        {hints.map((h, i) => (
          <span key={i} style={{ color: hintColor, fontSize: hintSize, flex: '0 0 auto', marginLeft: 6 }}>{h}</span>
        ))}
      </>
    )
  }
  const only = hints[0] ?? ''
  return (
    <span style={{ color: hintColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0, fontStyle: 'italic' }}>{only}</span>
  )
}

function toneColor(tone: Tone | undefined): string {
  return TONE_COLOR[tone ?? 'neutral']
}

export function CeSelect({
  value, options, placeholder = '— 选择 —', disabled = false, invalid = false,
  defaultValue, width = '100%', onChange,
}: CeSelectProps) {
  const { open, setOpen, ref, panelRef, pos } = useAnchorPopover()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ up: false, down: false })

  const selected = options.find(o => o.value === value)
  const triggerW = ref.current?.offsetWidth ?? 220
  const panelW = Math.min(Math.max(triggerW, 160), 340)

  const updateScroll = useCallback(() => {
    const p = scrollRef.current
    if (!p) return
    setScroll({ up: p.scrollTop > 1, down: p.scrollTop + p.clientHeight < p.scrollHeight - 1 })
  }, [])
  useEffect(() => {
    if (!open) { setScroll({ up: false, down: false }); return }
    updateScroll()
    const p = scrollRef.current
    if (!p) return
    p.addEventListener('scroll', updateScroll)
    window.addEventListener('resize', updateScroll)
    return () => { p.removeEventListener('scroll', updateScroll); window.removeEventListener('resize', updateScroll) }
  }, [open, updateScroll])

  const triggerStyle: CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 9px',
    borderRadius: 6,
    border: `1px solid ${invalid ? TOKEN.errorPrimary : TOKEN.borderL2}`,
    background: TOKEN.inputMajor,
    color: TOKEN.labelPrimary,
    fontSize: 13,
    fontFamily: 'inherit',
    cursor: disabled ? 'default' : 'pointer',
    textAlign: 'left',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  }
  const panelStyle: CSSProperties = {
    ...pos,
    zIndex: Z_POPOVER,
    width: panelW,
    background: TOKEN.menu,
    border: `1px solid ${TOKEN.borderL2}`,
    borderRadius: 8,
    boxShadow: TOKEN.shadowLv3,
    padding: '4px',
  }
  const rowStyle = (isSelected: boolean): CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 8px',
    borderRadius: 6,
    fontSize: 13,
    color: TOKEN.labelPrimary,
    background: isSelected ? TOKEN.businessTertiary : 'transparent',
    cursor: 'pointer',
  })
  const railStyle = (tone: Tone | undefined): CSSProperties => ({
    width: 3,
    alignSelf: 'stretch',
    borderRadius: 2,
    background: toneColor(tone),
    flex: '0 0 auto',
  })
  // 渐变淡出：严格叠在滚动列表上/下边缘（position:fixed 面板 + padding:4px → 用 top:4/bottom:4 对齐内容区）。
  // 历史 bug：只写了 left/right、漏 top/bottom，absolute 落位到列表下方静态位置 → 滚动时看不到淡出。
  // 明显度：高 30px（约盖住一行选项）+ 边缘 22% 保色平台（menu 先实后虚线性下滑）→ 边缘仅少量内容时也清晰可辨；
  //         满透明在 100% 处收尾，不与相邻选项形成硬边。
  const fade: (dir: 'top' | 'bottom') => CSSProperties = (dir) => ({
    position: 'absolute',
    left: 4,
    right: 4,
    height: 30,
    pointerEvents: 'none',
    ...(dir === 'top' ? { top: 4 } : { bottom: 4 }),
    background: dir === 'top'
      ? `linear-gradient(180deg, ${TOKEN.menu} 0%, ${TOKEN.menu} 22%, transparent 100%)`
      : `linear-gradient(0deg, ${TOKEN.menu} 0%, ${TOKEN.menu} 22%, transparent 100%)`,
  })

  let lastGroup: string | undefined
  return (
    <div ref={ref} style={{ position: 'relative', width }}>
      <style>{SCROLL_CSS}</style>
      <button type="button" disabled={disabled} onClick={() => setOpen(!open)} style={triggerStyle}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, display: 'inline-flex', alignItems: 'center' }}>
          {selected
            ? labelNode(selected.label, defaultValue !== undefined && selected.value === defaultValue, false, TOKEN.labelPrimary, TOKEN.labelTertiary, 11)
            : <span style={{ color: TOKEN.labelTertiary }}>{placeholder}</span>}
        </span>
        <Chevron dir={open ? 'up' : 'down'} color={TOKEN.labelTertiary} />
      </button>
      {open ? (
        <div ref={panelRef} style={panelStyle} onClick={(e) => e.stopPropagation()}>
          <div ref={scrollRef} className="ce-scroll-panel" role="listbox" style={{ maxHeight: 260, overflowY: 'auto' }}>
            {options.map((opt) => {
              const header = opt.group !== undefined && opt.group !== lastGroup
              lastGroup = opt.group
              const isDefault = defaultValue !== undefined && opt.value === defaultValue
              const isSelected = opt.value === value
              return (
                <div key={opt.value}>
                  {header ? <div style={{ padding: '4px 8px 2px', fontSize: 11, color: TOKEN.labelTertiary }}>{opt.group}</div> : null}
                  <div
                    role="option"
                    aria-selected={isSelected}
                    className={isSelected ? 'ce-opt ce-opt--selected' : 'ce-opt'}
                    style={rowStyle(isSelected)}
                    onClick={() => { onChange(opt.value); setOpen(false) }}
                  >
                    <span style={railStyle(opt.tone)} />
                    <span style={{ flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center' }}>
                      {labelNode(opt.label, isDefault, isSelected, TOKEN.labelPrimary, TOKEN.labelTertiary, 11)}
                    </span>
                    <span style={{ fontSize: 11, color: TOKEN.successPrimary, flex: '0 0 auto', fontWeight: 700 }}>{isSelected ? '✓' : ''}</span>
                  </div>
                </div>
              )
            })}
          </div>
          {scroll.up ? <div style={fade('top')} /> : null}
          {scroll.down ? <div style={fade('bottom')} /> : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * context-economy 弹层/事件共用 hook（client 半边，自研 —— 不依赖 react-dom portal）。
 *
 * 关键：应用外壳（AppFrame）与设置列都是 `overflow:hidden`，绝对定位的子弹层会被
 * 裁剪（表现为"被侧边栏遮挡 / 不在最上层"）。改用 **position:fixed** 定位到视口：
 * - 由触发元件的 getBoundingClientRect() 计算坐标；打开时在 scroll/resize 上重放；
 * - position:fixed 不被祖先 overflow:hidden 裁剪（本卡无 transform 祖先）；
 * - 高 z-index + 根层叠上下文 → 压过侧边栏/内容列。
 *
 * 弹层仍作为触发元件的兄弟节点渲染（不 portal、不引入 react-dom），因此
 * "点外/Esc 关闭" 用包裹 ref 判断即可（面板是子节点，点内不算外点）。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

/** 固定定位的隐藏占位（首次渲染先布局以量尺寸，再贴到目标位）。 */
const HIDDEN: CSSProperties = { position: 'fixed', left: -9999, top: -9999, visibility: 'hidden' }

export interface AnchorPopover {
  open: boolean
  setOpen: (open: boolean) => void
  close: () => void
  /** 包裹（触发 + 弹层）的 ref：既作 outside-close 判定，也作定位锚点。 */
  ref: RefObject<HTMLDivElement>
  /** 弹层节点 ref（量尺寸）。 */
  panelRef: RefObject<HTMLDivElement>
  /** 贴到弹层（open 且已定位时为 fixed 坐标；否则隐藏占位）。 */
  pos: CSSProperties
}

/**
 * in-place 触发 + fixed 定位弹层的组合 hook。
 * @param side 默认 bottom（下方）；贴底自动翻到上方。
 */
export function useAnchorPopover(side: 'bottom' | 'top' = 'bottom'): AnchorPopover {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [fixed, setFixed] = useState<CSSProperties | null>(null)
  const close = useCallback(() => setOpen(false), [])

  // 点外 / Esc 关闭。
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return
      if (ref.current?.contains(e.target) === true) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // fixed 定位：从触发 rect 计算坐标，scroll/resize 时重放。
  useLayoutEffect(() => {
    if (!open) { setFixed(null); return }
    const place = () => {
      const a = ref.current?.getBoundingClientRect()
      const p = panelRef.current
      if (!a) return
      const lw = p?.offsetWidth ?? 0
      const lh = p?.offsetHeight ?? 0
      let x = a.left
      let y = side === 'top' || (side === 'bottom' && lh > 0 && a.bottom + 6 + lh > window.innerHeight - 8)
        ? a.top - lh - 6
        : a.bottom + 6
      if (lw > 0) x = Math.min(Math.max(x, 8), window.innerWidth - lw - 8)
      y = Math.min(Math.max(y, 8), window.innerHeight - lh - 8)
      // 关键：落位必须带 position:'fixed'——否则从 HIDDEN(含 fixed) 掉成 static，
      // 弹层变成文档流块级元素、撑高布局（历史 bug 根因）。
      setFixed({ position: 'fixed', left: x, top: y })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, side])

  const pos: CSSProperties = open ? (fixed ?? { ...HIDDEN }) : { ...HIDDEN }
  return { open, setOpen, close, ref, panelRef, pos }
}

/**
 * 对 onClose 的触发器：pointdown/Esc 关闭（用于无需固定在视口的小面板）。
 */
export function useOutsideClose<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return
      if (ref.current?.contains(e.target) === true) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])
  return ref
}

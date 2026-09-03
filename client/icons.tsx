/**
 * context-economy 分组图标（自研内联 SVG，currentColor 随分组 accent 上色）。
 * 用图标取代组标题里的序号（①②③④）与装饰圆点，增强可读性。
 */

import type { ReactNode } from 'react'

export interface GroupIconProps {
  id: string
  color: string
  size?: number
}

const paths: Record<string, ReactNode> = {
  assembly: (
    <>
      <circle cx="12" cy="12" r="8" fill="none" strokeWidth="1.8" />
      <line x1="12" y1="7" x2="12" y2="14" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  discern: (
    <>
      <circle cx="12" cy="12" r="8" fill="none" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="4.2" fill="none" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </>
  ),
  tune: (
    <>
      <line x1="4" y1="7" x2="20" y2="7" strokeWidth="1.6" />
      <circle cx="14" cy="7" r="2.2" fill="none" strokeWidth="1.6" />
      <line x1="4" y1="12.5" x2="20" y2="12.5" strokeWidth="1.6" />
      <circle cx="9" cy="12.5" r="2.2" fill="none" strokeWidth="1.6" />
      <line x1="4" y1="18" x2="20" y2="18" strokeWidth="1.6" />
      <circle cx="16" cy="18" r="2.2" fill="none" strokeWidth="1.6" />
    </>
  ),
  advanced: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.8" fill="none" strokeWidth="1.5" />
      <path d="M5 6c0 1.55 3.13 2.8 7 2.8S19 7.55 19 6" fill="none" strokeWidth="1.5" />
      <path d="M5 6v12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V6" fill="none" strokeWidth="1.5" />
      <path d="M5 12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8" fill="none" strokeWidth="1.5" />
    </>
  ),
}

export function GroupIcon({ id, color, size = 18 }: GroupIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      aria-hidden="true"
      style={{ flex: '0 0 auto' }}
    >
      {paths[id] ?? paths.assembly}
    </svg>
  )
}

export interface ChevronProps {
  dir: 'down' | 'up' | 'right'
  size?: number
  color?: string
}

/**
 * 原样提取 DSH 原生 `IconChevronDownOutline14`（ui-primitives/src/icons/index.tsx）——
 * 宽而浅的对称 V（回旋镖），fill=currentColor；用 rotate 表达方向。不 import 官方图标包
 * （保持产包自包含、即插即用不干涉原生）。
 */
const CHEVRON_PATH = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z'

export function Chevron({ dir, size = 14, color }: ChevronProps) {
  const rotate = dir === 'up' ? 180 : dir === 'right' ? -90 : 0
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      style={{ flex: '0 0 auto', transform: `rotate(${rotate}deg)`, color: color ?? undefined }}
    >
      <path d={CHEVRON_PATH} fill="currentColor" />
    </svg>
  )
}
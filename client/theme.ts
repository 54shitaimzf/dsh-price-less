/**
 * context-economy 配置卡片主题令牌（client 半边）。
 *
 * 唯一出处：所有 CSS 变量名与品牌色、浮窗 z-index 都收敛到本文件，避免组件里
 * 散落硬编码字符串。改用真实 `--dsw-*` 令牌（亮/暗主题自动切换）——历史 bug 是
 * 用了不存在于 DSH 的 `--theme-*` 变量，导致一直落到硬编码深色回退值。
 *
 * 令牌名来源：`packages/client` 各 `*.css` 实际使用的 `--dsw-*`（已 grep 核实，
 * 见 docs/12 §5 配置面 UI 重构账本）。命名空间含义：
 * - `--dsw-alias-label-*` 文字层级；`--dsw-alias-bg-*` 表面层级；
 * - `--dsw-alias-border-*` 边框层级；`--dsw-specific-input-major` 输入框表面；
 * - `--dsw-alias-brand-primary` 品牌主色；`--dsw-alias-state-error-primary` 错误/危险。
 */

/** 统一 CSS 变量引用（只在部分场景需要逐 token 引用；内联 style 直接用字符串）。 */
export const TOKEN = {
  labelPrimary: 'var(--dsw-alias-label-primary)',
  labelSecondary: 'var(--dsw-alias-label-secondary)',
  labelTertiary: 'var(--dsw-alias-label-tertiary)',
  labelQuaternary: 'var(--dsw-alias-label-quaternary)',
  labelCaption: 'var(--dsw-alias-label-caption)',
  labelDimmed: 'var(--dsw-alias-label-dimmed)',
  bgBase: 'var(--dsw-alias-bg-base)',
  bgLayer1: 'var(--dsw-alias-bg-layer-1)',
  bgLayer2: 'var(--dsw-alias-bg-layer-2)',
  bgLayer3: 'var(--dsw-alias-bg-layer-3)',
  bgModulePlatform: 'var(--dsw-alias-bg-module-platform)',
  borderL1: 'var(--dsw-alias-border-l1)',
  borderL2: 'var(--dsw-alias-border-l2)',
  borderL3: 'var(--dsw-alias-border-l3)',
  borderInverted: 'var(--dsw-alias-border-inverted)',
  fillL2: 'var(--dsw-alias-fill-l2)',
  interactiveHover: 'var(--dsw-alias-interactive-bg-hover)',
  interactiveHoverSolid: 'var(--dsw-alias-interactive-bg-hover-solid)',
  interactiveHoverDanger: 'var(--dsw-alias-interactive-bg-hover-danger)',
  brandPrimary: 'var(--dsw-alias-brand-primary)',
  /** 主题感知语义色：亮/暗自动换值（design-platform.css body[data-ds-dark-theme]）。 */
  businessPrimary: 'var(--dsw-alias-state-business-primary)',
  businessTertiary: 'var(--dsw-alias-state-business-tertiary)',
  errorPrimary: 'var(--dsw-alias-state-error-primary)',
  errorTertiary: 'var(--dsw-alias-state-error-tertiary)',
  successPrimary: 'var(--dsw-alias-state-success-primary)',
  successTertiary: 'var(--dsw-alias-state-success-tertiary)',
  warnPrimary: 'var(--dsw-alias-state-warn-primary)',
  warnTertiary: 'var(--dsw-alias-state-warn-tertiary)',
  bizPrimary: 'var(--dsw-alias-state-business-primary)',
  inputMajor: 'var(--dsw-specific-input-major)',
  menu: 'var(--dsw-specific-menu)',
  tip: 'var(--dsw-specific-tip)',
  selector: 'var(--dsw-specific-selector)',
  shadowLv2: 'var(--dsw-shadow-lv2)',
  shadowLv3: 'var(--dsw-shadow-lv3)',
  fontMono: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
} as const

/**
 * 由主题感知色 token 生成半透明 tint（用 color-mix，可作用于任意 alpha）。
 * 例：`tint(TOKEN.businessPrimary, 0.12)` → `color-mix(in srgb, var(--dsw-…) 12%, transparent)`。
 */
export function tint(primaryVar: string, alpha: number): string {
  return `color-mix(in srgb, ${primaryVar} ${Math.round(alpha * 100)}%, transparent)`
}

/** 功能区/选项类别的语义色（望色生义：绿=已选/通过，琥珀=谨慎/成本，蓝=品牌，红=高危）。 */
export type Tone = 'neutral' | 'business' | 'success' | 'warn' | 'error'
export const TONE_COLOR: Record<Tone, string> = {
  neutral: 'var(--dsw-alias-label-tertiary)',
  business: TOKEN.businessPrimary,
  success: TOKEN.successPrimary,
  warn: TOKEN.warnPrimary,
  error: TOKEN.errorPrimary,
}

/** 浮层层级（position:fixed + 根层叠上下文，压过侧边栏/内容列；实测校验）。 */
export const Z_POPOVER = 3000
export const Z_CONFIRM = 3500

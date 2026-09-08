/**
 * context-economy 配置卡片（client 半边）——字段模型 + 纯逻辑层。
 *
 * 本文件不依赖 React/DOM，可被 host vitest 单测。职责：
 * - 字段读写规范（EconomyFieldSpec）与多态 parse/format（select/number/bool/text/path）；
 * - 默认值解析（CLIENT_DEFAULTS 镜像，与 host src/config.ts CONFIG_DEFAULTS 同值）；
 * - 可见性分级（core/tune/debug/hidden），驱动卡片"分级精简"；
 * - 模型路由选项构建（预设三源 + 配置 catalog 三源合并，与对话模型选择一致）；
 * - 下划线约定：字段 key 用点路径（'discriminator.provider'）；paths 为写路径数组
 *   （默认 [field]），供 scope.mutate 原子提交多段 path。
 *
 * 版本协议: 插件主体清退至模板态后，本文件是重设计的唯一"加回设置项"入口——
 *           组壳/组件/交互全保留，仅 FIELD-DEF 载荷清空（4 组壳 fields:[]，
 *           2 个组外保留 spec 支撑模型路由选择器安全保存）。观察模式设置项
 *           （off/observe/active）已按用户定调清理；机制开关随 R2 工单
 *           以 boolean 门控形态加回。
 *           host 侧对应最小 schema = src/config.ts（手工同步对；客户端不得
 *           import host src——跨域打包约束）。
 *
 * 审查清单: 纯数据/纯函数；无 Host 引用穿越；不 import react。
 * 度量: 无新增（配置变更经判账号本 call 字段可观测，docs/07 §18）。
 */

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Tone } from './theme.ts'

/* -------------------------------------------------------------------------- */
/* 基础类型                                                                    */
/* -------------------------------------------------------------------------- */

/** 卡片编辑的配置形状（= host Config schema 的可写面；模板态最小集）。 */
export interface EconomyCardSettingsShape {
  discriminator?: {
    provider?: string
    model?: string
    auto?: boolean
  }
}

/** 字段显示形态：下拉 / 数字 / 布尔开关 / 文本 / 路径（默认目录|自定义）。 */
export type EconomyFieldType = 'select' | 'number' | 'bool' | 'text' | 'path'

/** 可见性分级（驱动"设置项精简"）：core=核心常显；tune=调节（折叠组）；debug=排障（折叠组）；hidden=不单独渲染（被复合控件接管）。 */
export type EconomyFieldVisibility = 'core' | 'tune' | 'debug' | 'hidden'

/** 下拉选项（值 + 展示名；group 用于分组标签；tone 用于"望色生义"类别色指示）。 */
export interface EconomySelectOption {
  value: string
  label: string
  group?: string
  /** 用于 "?" 浮窗的长说明（如预设 pitch）。 */
  pitch?: string
  /** 类别语义色（纯展示元数据，不影响值/parse；渲染左侧类别指示条）。 */
  tone?: Tone
}

/** parse 结果：set（写多段 path）/ clear（清空）/ error（非法，阻断保存，带人话文案）。 */
export type ParseResult =
  | { kind: 'set'; values: Record<string, unknown> }
  | { kind: 'clear' }
  | { kind: 'error'; message: string }

/**
 * 字段读写规范（多态）。
 * - field: 稳定 key（点路径）；paths: 写路径数组（默认 [field]）。
 * - format(value) 把当前存值 → 显示文本（无值=空串）。
 * - parse(text) 把草稿 → set/clear/error。
 * - min/max/step/unit 数字；options 下拉；placeholder/valueHint 说明；
 * - default/deflabel 恢复默认落值与默认标注；pos = 在组内的顺序。
 */
export interface EconomyFieldSpec {
  field: string
  paths: string[]
  type: EconomyFieldType
  visibility: EconomyFieldVisibility
  format: (value: unknown) => string
  parse: (text: string) => ParseResult
  options?: EconomySelectOption[]
  min?: number
  max?: number
  step?: number
  unit?: string
  placeholder?: string
  valueHint?: string
  /** 恢复默认后的落值（undefined = 清空跟随预设）。 */
  default?: unknown
  /** 默认的人话标注（（默认）/（跟随预设）/（默认目录））。 */
  deflabel?: string
}

/* -------------------------------------------------------------------------- */
/* 字段工厂                                                                    */
/* -------------------------------------------------------------------------- */

export function economyNumberField(
  field: string,
  opts: { min?: number; max?: number; step?: number; unit?: string; visibility?: EconomyFieldVisibility; default?: number; deflabel?: string } = {},
): EconomyFieldSpec {
  const range = opts.min === undefined && opts.max === undefined ? '' : `${opts.min ?? '–'}..${opts.max ?? '–'}`
  return {
    field,
    paths: [field],
    type: 'number',
    visibility: opts.visibility ?? 'core',
    min: opts.min,
    max: opts.max,
    step: opts.step,
    unit: opts.unit,
    default: opts.default,
    deflabel: opts.deflabel,
    valueHint: range,
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const n = Number(trimmed)
      if (!Number.isFinite(n)) return { kind: 'error', message: '不是有效数字' }
      if (opts.min !== undefined && n < opts.min) return { kind: 'error', message: `需 ≥ ${opts.min}` }
      if (opts.max !== undefined && n > opts.max) return { kind: 'error', message: `需 ≤ ${opts.max}` }
      return { kind: 'set', values: { [field]: n } }
    },
  }
}

export function economyBoolField(
  field: string,
  opts: { visibility?: EconomyFieldVisibility; default?: boolean; deflabel?: string } = {},
): EconomyFieldSpec {
  return {
    field,
    paths: [field],
    type: 'bool',
    visibility: opts.visibility ?? 'core',
    default: opts.default,
    deflabel: opts.deflabel,
    format: value => typeof value === 'boolean' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      if (trimmed === 'true') return { kind: 'set', values: { [field]: true } }
      if (trimmed === 'false') return { kind: 'set', values: { [field]: false } }
      return { kind: 'error', message: '请选择开启或关闭' }
    },
  }
}

export function economySelectField(
  field: string,
  options: EconomySelectOption[],
  opts: { visibility?: EconomyFieldVisibility; placeholder?: string; default?: string; deflabel?: string } = {},
): EconomyFieldSpec {
  return {
    field,
    paths: [field],
    type: 'select',
    options,
    visibility: opts.visibility ?? 'core',
    placeholder: opts.placeholder,
    default: opts.default,
    deflabel: opts.deflabel,
    valueHint: options.map(o => `${o.label}${o.value === opts.default ? '（默认）' : ''}`).join(' | '),
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      return options.some(o => o.value === trimmed)
        ? { kind: 'set', values: { [field]: trimmed } }
        : { kind: 'error', message: '请从选项中选择' }
    },
  }
}

export function economyTextField(
  field: string,
  opts: { visibility?: EconomyFieldVisibility; placeholder?: string; default?: string; deflabel?: string } = {},
): EconomyFieldSpec {
  return {
    field,
    paths: [field],
    type: 'text',
    visibility: opts.visibility ?? 'core',
    placeholder: opts.placeholder,
    default: opts.default,
    deflabel: opts.deflabel,
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', values: { [field]: trimmed } }
    },
  }
}

/** 路径字段：默认目录（''=clear）| 自定义（非空=set）。组件用 CePath 渲染「默认|自定义」小下拉 + 文本。 */
export function economyPathField(
  field: string,
  opts: { visibility?: EconomyFieldVisibility; placeholder?: string; default?: string; deflabel?: string } = {},
): EconomyFieldSpec {
  return economyTextField(field, opts)
}

/* -------------------------------------------------------------------------- */
/* 默认值（client 侧镜像；与 host src/config.ts CONFIG_DEFAULTS 同源同值）      */
/* -------------------------------------------------------------------------- */

export const CLIENT_DEFAULTS = {
  discriminator: { auto: false },
} as const

/** 该路径的推荐默认值（未定义 = 可选覆盖，恢复时清空跟随预设）。 */
export function defaultForPath(key: string): unknown {
  const segments = pathSegments(key)
  let current: unknown = CLIENT_DEFAULTS
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/* -------------------------------------------------------------------------- */
/* 路径工具                                                                    */
/* -------------------------------------------------------------------------- */

/** 点路径 → 段数组（'discriminator.provider' → ['discriminator','provider']；顶层 = 单段）。 */
export function pathSegments(key: string): string[] {
  const dot = key.indexOf('.')
  return dot < 0 ? [key] : [key.slice(0, dot), key.slice(dot + 1)]
}

/** 深度读字段值（'discriminator.x' → value.discriminator.x）。 */
export function readPath(value: unknown, key: string): unknown {
  const segments = pathSegments(key)
  let current: unknown = value
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** 深度 user 层有值？ */
export function userHasPath(user: unknown, key: string): boolean {
  const segments = pathSegments(key)
  let current: unknown = user
  for (let i = 0; i < segments.length - 1; i++) {
    if (current === null || typeof current !== 'object') return false
    const next = (current as Record<string, unknown>)[segments[i]]
    if (next === undefined) return false
    current = next
  }
  if (current === null || typeof current !== 'object') return false
  return Object.hasOwn(current as object, segments[segments.length - 1]!)
}

/** 深度比较（原始值 + 对象；字段值全为原始类型，兜底用 JSON 序列化）。 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}

/* -------------------------------------------------------------------------- */
/* 模型路由（与对话模型选择一致的 provider@model 降级下拉）                      */
/* -------------------------------------------------------------------------- */

/** 路由分隔符（与 provider/model 组合唯一对应；来自预设 provider\0model）。 */
export const ROUTE_SEP = '\u0000'

/** 路由键：provider\0model（无 provider 时 =''，即跟随预设）。 */
export function routeKey(provider: string, model: string): string {
  return provider ? `${provider}${ROUTE_SEP}${model}` : ''
}

/** 拆路由键 → {provider, model}；空键 → {provider:'',model:''}。 */
export function splitRouteKey(key: string): { provider: string; model: string } {
  if (!key) return { provider: '', model: '' }
  const idx = key.indexOf(ROUTE_SEP)
  if (idx < 0) return { provider: key, model: '' }
  return { provider: key.slice(0, idx), model: key.slice(idx + ROUTE_SEP.length) }
}

/**
 * 内置预设路由（常驻模型路由下拉，保证"跟随预设/预设模型"始终可选）。
 * 模板态保留：这是"模型列表"交互的常驻底座，重设计时按需增删。
 */
export const MODEL_PRESET_ROUTES: EconomySelectOption[] = [
  { value: routeKey('deepseek-official', 'deepseek-v4.1-flash-expires-on-0910'), label: 'deepseek-official：deepseek-v4.1-flash-expires-on-0910', group: '内置预设', tone: 'business', pitch: '官方 API 直连：与主对话同模型（2026-09 默认）。' },
  { value: routeKey('deepseek-official', 'deepseek-v4-flash-vision-exp'), label: 'deepseek-official：deepseek-v4-flash-vision-exp', group: '内置预设', tone: 'business', pitch: '官方 API 直连：判别口径与实验批次一致（低成本）。' },
  { value: routeKey('deepseek-official', 'deepseek-v4-flash'), label: 'deepseek-official：deepseek-v4-flash', group: '内置预设', tone: 'business', pitch: '官方 API 直连：同价文本档（无图像输入）。' },
]

/** 由配置 catalog（groups）构造模型路由选项；与预设路由合并成单一选择列表。 */
export function buildModelRouteOptions(groups: readonly { id: string; name: string; models: readonly { id: string; name: string }[] }[]): EconomySelectOption[] {
  const catalog: EconomySelectOption[] = []
  for (const group of groups) {
    for (const model of group.models) {
      catalog.push({
        value: routeKey(group.id, model.id),
        label: `${group.name}：${model.name}`,
        group: group.name,
        tone: 'success',
      })
    }
  }
  return [...MODEL_PRESET_ROUTES, ...catalog]
}

/* -------------------------------------------------------------------------- */
/* 字段抄文案（label 一句 / hint 一行常显 / docs 长说明收进 "?" 浮窗）           */
/* -------------------------------------------------------------------------- */

export const ECONOMY_FIELD_COPY: Record<string, { label: string; hint: string; docs?: string }> = {
  'discriminator.provider': { label: '模型服务商', hint: '留空=跟随预设。', docs: '模型服务商覆盖；留空即跟随预设。一般用模型路由下拉选择，自动同时设好服务商与模型。' },
  'discriminator.model': { label: '模型', hint: '留空=跟随预设。', docs: '模型覆盖；留空即跟随预设。用模型路由下拉选择即可。' },
  'discriminator.auto': { label: '自动判别', hint: '开启后逐消息判断任务边界；默认关闭。', docs: '自动断面总开关；关闭时零成本，不挂载判别器。' },
}

/* -------------------------------------------------------------------------- */
/* 分组结构 + 字段注册（顺序 = 卡片展示顺序）                                    */
/* -------------------------------------------------------------------------- */

export interface EconomyFieldGroup {
  id: string
  level: 1 | 2
  title: string
  desc?: string
  /** 功能区语义色（主题感知 `--dsw-alias-state-*-primary`，用于图标/描边）。 */
  accent: string
  /** 功能区浅 tint（主题感知 `--dsw-alias-state-*-tertiary`，用于开态浅底）。 */
  tint: string
  defaultOpen: boolean
  /** 该组是否有复合"模型路由"选择器（渲染在普通字段之前）。 */
  routeSelector?: boolean
  note?: string[]
  fields: EconomyFieldSpec[]
}

/**
 * 分组壳（模板态）：4 个组的标题/描述/语义色/开态全部保留——重设计时向各组的
 * fields 数组加回 economyXxxField(...) 即可原样复现 UI；本态全部 fields:[]。
 */
const discriminatorAutoField = economyBoolField('discriminator.auto', { visibility: 'core', default: false, deflabel: '默认关闭' })

export const ECONOMY_FIELD_GROUPS: EconomyFieldGroup[] = [
  {
    id: 'assembly',
    level: 1,
    title: '功能开关',
    desc: '控制插件启用哪些功能；一般保持默认即可。',
    accent: 'var(--dsw-alias-state-business-primary)',
    tint: 'var(--dsw-alias-state-business-tertiary)',
    defaultOpen: true,
    fields: [discriminatorAutoField],
  },
  {
    id: 'discern',
    level: 1,
    title: '识别与判断',
    desc: '识别对话转折、判断该不该压缩。这两个最常调。',
    accent: 'var(--dsw-alias-state-success-primary)',
    tint: 'var(--dsw-alias-state-success-tertiary)',
    defaultOpen: true,
    routeSelector: true,
    fields: [],
  },
  {
    id: 'tune',
    level: 1,
    title: '模型与调优',
    desc: '想细调才看：模型参数与运行限制。',
    accent: 'var(--dsw-alias-state-warn-primary)',
    tint: 'var(--dsw-alias-state-warn-tertiary)',
    defaultOpen: false,
    fields: [],
  },
  {
    id: 'advanced',
    level: 1,
    title: '高级与调试',
    desc: '一般不用动；存储与排障参数。',
    accent: 'var(--dsw-alias-state-error-primary)',
    tint: 'var(--dsw-alias-state-error-tertiary)',
    defaultOpen: false,
    fields: [],
  },
]

/**
 * 组外保留 spec（不进任何组、不渲染为普通字段行）：
 * - provider/model：ModelRouteSelector 暂存目标——controller.save 按 spec 索引
 *   写路径，缺 spec 会崩（保留 = 模型路由选择器端到端可用）。
 * 观察模式设置项已清理；机制开关随 R2 工单以 boolean 字段进组（fields 数组）。
 * 重设计加回字段时：字段进组 fields；这两条保留 spec 的 key 若被复用则从本表移除。
 */
export const ECONOMY_FIELD_SPECS: EconomyFieldSpec[] = [
  discriminatorAutoField,
  economyTextField('discriminator.provider', { visibility: 'hidden', placeholder: '跟随预设（空）' }),
  economyTextField('discriminator.model', { visibility: 'hidden', placeholder: '跟随预设（空）' }),
]

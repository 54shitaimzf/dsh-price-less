/**
 * context-economy 配置卡片（client 半边）——字段模型 + 纯逻辑层。
 *
 * 本文件不依赖 React/DOM，可被 host vitest 单测。职责：
 * - 字段读写规范（EconomyFieldSpec）与多态 parse/format（select/number/bool/text/path）；
 * - 默认值解析（CLIENT_DEFAULTS 镜像，与 host src/config.ts CONFIG_DEFAULTS 同值）；
 * - 可见性分级（core/tune/debug/hidden），驱动卡片"分级精简"；
 * - 模型路由选项构建（预设三源 + 配置 catalog 三源合并，与对话模型选择一致）；
 * - 下划线约定：字段 key 用点路径（'discriminator.mode'）；paths 为写路径数组
 *   （默认 [field]），供 scope.mutate 原子提交多段 path。
 *
 * 版本协议: 本文件与 host 的 src/discriminator/presets.ts（DISC_PRESETS）同源是
 *           客户端侧镜像（preset 路由），改预设需同步（同 CLIENT_DEFAULTS 镜像
 *           CONFIG_DEFAULTS 的约定）。客户端不得 import host src（跨域打包）。
 *
 * 审查清单: 纯数据/纯函数；无 Host 引用穿越；不 import react。
 * 度量: 无新增（配置变更经判账号本 call 字段可观测，docs/07 §18）。
 */

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Tone } from './theme.ts'

/* -------------------------------------------------------------------------- */
/* 基础类型                                                                    */
/* -------------------------------------------------------------------------- */

/** 卡片编辑的配置形状（= Config schema 的可写面；可选字段只在暂存/覆盖时存在）。 */
export interface EconomyCardSettingsShape {
  sub2IntentMapping?: boolean
  compressionDriver?: string
  taskCompression?: boolean
  overflowRecovery?: boolean
  discriminator?: {
    mode?: 'off' | 'observe' | 'active'
    preset?: 'deepseek' | 'deepseek-low'
    provider?: string
    model?: string
    temperature?: number
    maxTokens?: number
    effort?: 'none' | 'low' | 'high' | 'max'
    maxConcurrency?: number
    timeoutMs?: number
    cacheLimit?: number
    journalLimit?: number
    historyWindow?: number
    messageExcerptChars?: number
    journalPath?: string
    debugIo?: boolean
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
  sub2IntentMapping: true,
  compressionDriver: 'native',
  taskCompression: true,
  overflowRecovery: true,
  discriminator: {
    mode: 'off',
    preset: 'deepseek',
    maxConcurrency: 4,
    timeoutMs: 15000,
    cacheLimit: 1024,
    journalLimit: 256,
    historyWindow: 2,
    messageExcerptChars: 80,
    journalPath: '',
    debugIo: false,
  },
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

/** 点路径 → 段数组（'discriminator.mode' → ['discriminator','mode']；顶层 = 单段）。 */
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
 * 内置预设路由（client 侧镜像 host DISC_PRESETS；改预设需同步 src/discriminator/presets.ts）。
 * 恒显示于模型路由下拉（即使不在配置目录里），保证"跟随预设/预设模型"始终可选。
 */
export const MODEL_PRESET_ROUTES: EconomySelectOption[] = [
  { value: routeKey('deepseek-official', 'deepseek-v4-flash-vision-exp'), label: 'deepseek-official：deepseek-v4-flash-vision-exp', group: '内置预设', tone: 'business', pitch: '官方 API 直连：判别口径与实验批次一致（推荐默认）。' },
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
  sub2IntentMapping: {
    label: '启用记忆投影',
    hint: '开启后会沉淀并复用任务要点；关闭则只压缩、不记忆。',
    docs: '把跨轮对话里的目标与步骤要点沉淀到知识层，后续任务直接复用，省去重复交代。关闭后仅做压缩、不做记忆。',
  },
  taskCompression: {
    label: '任务结束时压缩',
    hint: '任务完成即把完成步骤压成摘要，只留结论与待办，省上下文。',
    docs: '每个任务结束时，把已完成步骤的细节压缩成简短摘要，只保留结论与待办，从而明显降低之后每一轮的输入 token。',
  },
  overflowRecovery: {
    label: '溢出自动恢复',
    hint: '上下文接近上限时自动接管并整理关键内容，避免卡死。',
    docs: '当上下文接近上限、原生压缩可能失败时，插件接管并重排关键信息、加速释放空间，避免长对话卡死。',
  },
  compressionDriver: { label: '压缩驱动', hint: '当前为原生压缩引擎，无可选项。', docs: '压缩引擎选择。当前仅原生 compactRegion；本插件将来独立实现时，换值即换驱动。' },
  'discriminator.mode': {
    label: '判别模式',
    hint: 'off=关闭（推荐）；observe=只看不动（测量）；active=真正介入。',
    docs: 'off：不挂载判别器，零成本（默认）。observe：每条消息都判定但只记账、不发行为，用于测量；会产生少量 token 费，无直接收益。active：额外发出 verdict 事件，驱动上层编排。',
  },
  'discriminator.preset': {
    label: '预设',
    hint: '一键套用一套判据、模型与思考强度的组合。',
    docs: '预设决定 "用什么判据、哪个模型、多强思考" 这一整套搭配。新手选 deepseek 默认档即可；deepseek-low 为显式低思考档。想单独覆盖某个参数，去 "模型与调优/高级" 组。',
  },
  'discriminator.provider': { label: '模型服务商', hint: '留空=跟随预设。', docs: '模型服务商覆盖；留空即跟随预设。一般不需要单独填，用下方 "模型" 路由下拉即可。' },
  'discriminator.model': { label: '模型', hint: '留空=跟随预设。', docs: '模型覆盖；留空即跟随预设。一般用 "模型" 路由下拉选择，会自动同时设好服务商与模型，避免两者不匹配。' },
  'discriminator.temperature': {
    label: '随机性',
    hint: '默认 0（更稳定）；DeepSeek 思考模型下此参数会被忽略。',
    docs: '采样温度。0 最稳定（默认）。注意 DeepSeek 官方 API 在思考模式下会忽略此参数，改了未必生效。',
  },
  'discriminator.maxTokens': {
    label: '回答长度上限',
    hint: '单次判别的最大输出 token；调高会增加成本。',
    docs: '单次判别的输出 token 上限（软限制；推理模型的 thinking token 不计入，实测）。100–2000，默认 400。',
  },
  'discriminator.effort': {
    label: '思考强度',
    hint: 'none=不额外思考（默认省钱）；仅部分模型支持更高档。',
    docs: '仅对能力表里实测/文档双证的模型发送 low/high/max，其余强制 "不发送"（默认档）。增大思考会显著增加成本与延迟，仅部分模型支持。',
  },
  'discriminator.maxConcurrency': {
    label: '并发数',
    hint: '同时处理多少判断；过高可能排队或超时。',
    docs: '判别并发上限 1–16，默认 4。队列满即跳过并记 overload，避免阻塞主链路。',
  },
  'discriminator.timeoutMs': {
    label: '单次超时',
    hint: '超过此时限即放弃，按 "继续" 处理。',
    docs: '单次判别超时（1000–60000ms，默认 15000）。超时 → 按 continue 兜底，保证不卡住主链路。',
  },
  'discriminator.cacheLimit': {
    label: '结果缓存条数',
    hint: '缓存已判结果避免重复问模型；0=关缓存。',
    docs: 'L1 精确键缓存容量（默认 1024）。键含配置面，重放防重、不降语料调用；0=关闭。',
  },
  'discriminator.journalLimit': {
    label: '记录保留条数',
    hint: '最多保留多少条判定记录，超出自动滚动删除。',
    docs: '账号台账环表容量（16–1000，默认 256）。超出按时间滚动删除。',
  },
  'discriminator.historyWindow': {
    label: '参考历史条数',
    hint: '判断时带最近几条对话做参考；建议保持默认。',
    docs: '段内历史窗口 0–6。口径与实验 v6 冻结一致=2。改动会破坏跨配置的对比口径，除非做对照实验，否则不建议动。',
  },
  'discriminator.messageExcerptChars': {
    label: '原文摘录长度',
    hint: '记录里保留多少字原话；0=不留，省空间。',
    docs: '判别记录中目标消息原文摘录长度（0–200，默认 80）。0=不留原文，占空间更小。',
  },
  'discriminator.journalPath': {
    label: '记录保存位置',
    hint: '留空=默认目录；也可自定义。',
    docs: '判别台账/IO 日志落盘目录。空=默认 `~/.dsh/context-economy/`。落盘：judge-records.jsonl（常开，成本流水）+ judge-io.jsonl（仅 debugIo=true 时写原始输入输出）。',
  },
  'discriminator.debugIo': {
    label: '调试日志',
    hint: '开启后原样记录每次判别的输入输出（文件会大）；排障才开。',
    docs: 'debugIo=true 时写 judge-io.jsonl（原始 prompt 与模型输出，可回放比对）。日常关闭，排障时才开，避免文件膨胀。',
  },
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

/** 分组层级（可见性分级 → 组标题人话说明）。 */
export const ECONOMY_FIELD_GROUPS: EconomyFieldGroup[] = [
  {
    id: 'assembly',
    level: 1,
    title: '功能开关',
    desc: '控制插件启用哪些功能；一般保持默认即可。',
    accent: 'var(--dsw-alias-state-business-primary)',
    tint: 'var(--dsw-alias-state-business-tertiary)',
    defaultOpen: true,
    fields: [
      economyBoolField('sub2IntentMapping', { visibility: 'core', default: true }),
      economyBoolField('taskCompression', { visibility: 'core', default: true }),
      economyBoolField('overflowRecovery', { visibility: 'core', default: true }),
      economySelectField('compressionDriver', [{ value: 'native', label: 'native（原生）' }], { visibility: 'hidden', default: 'native', deflabel: '（原生）' }),
    ],
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
    fields: [
      economySelectField('discriminator.mode', [
        { value: 'off', label: 'off（默认）：关闭，零成本', tone: 'neutral' },
        { value: 'observe', label: 'observe：只看不动（测量）', tone: 'warn' },
        { value: 'active', label: 'active：发 verdict 驱动编排', tone: 'business' },
      ], { visibility: 'core', default: 'off', deflabel: '（默认）' }),
      economySelectField('discriminator.preset', [
        { value: 'deepseek', label: 'deepseek（默认）：官方直连', tone: 'business' },
        { value: 'deepseek-low', label: 'deepseek-low：低思考档', tone: 'success' },
      ], { visibility: 'core', default: 'deepseek', deflabel: '（默认）' }),
      economyTextField('discriminator.provider', { visibility: 'hidden', placeholder: '跟随预设（空）' }),
      economyTextField('discriminator.model', { visibility: 'hidden', placeholder: '跟随预设（空）' }),
    ],
  },
  {
    id: 'tune',
    level: 1,
    title: '模型与调优',
    desc: '想细调才看：模型参数与运行限制。',
    accent: 'var(--dsw-alias-state-warn-primary)',
    tint: 'var(--dsw-alias-state-warn-tertiary)',
    defaultOpen: false,
    fields: [
      economySelectField('discriminator.effort', [
        { value: '', label: '（跟随预设）', tone: 'neutral' },
        { value: 'none', label: 'none：不发送（模型默认档）', tone: 'neutral' },
        { value: 'low', label: 'low', tone: 'success' },
        { value: 'high', label: 'high', tone: 'warn' },
        { value: 'max', label: 'max', tone: 'error' },
      ], { visibility: 'tune', deflabel: '（跟随预设）' }),
      economyNumberField('discriminator.temperature', { min: 0, max: 1, step: 0.1, unit: '', visibility: 'tune', deflabel: '（跟随预设）' }),
      economyNumberField('discriminator.maxTokens', { min: 100, max: 2000, step: 50, unit: 'token', visibility: 'tune', deflabel: '（跟随预设）' }),
      economyNumberField('discriminator.maxConcurrency', { min: 1, max: 16, step: 1, unit: '并发', visibility: 'tune', default: 4, deflabel: '（默认 4）' }),
      economyNumberField('discriminator.timeoutMs', { min: 1000, max: 60000, step: 500, unit: 'ms', visibility: 'tune', default: 15000, deflabel: '（默认 15000）' }),
    ],
  },
  {
    id: 'advanced',
    level: 1,
    title: '高级与调试',
    desc: '一般不用动；存储与排障参数。',
    accent: 'var(--dsw-alias-state-error-primary)',
    tint: 'var(--dsw-alias-state-error-tertiary)',
    defaultOpen: false,
    fields: [
      economyNumberField('discriminator.cacheLimit', { min: 0, max: 5000, step: 100, unit: '条', visibility: 'debug', default: 1024, deflabel: '（默认 1024）' }),
      economyNumberField('discriminator.journalLimit', { min: 16, max: 1000, step: 16, unit: '条', visibility: 'debug', default: 256, deflabel: '（默认 256）' }),
      economyNumberField('discriminator.historyWindow', { min: 0, max: 6, step: 1, unit: '条', visibility: 'debug', default: 2, deflabel: '（建议保持 2）' }),
      economyNumberField('discriminator.messageExcerptChars', { min: 0, max: 200, step: 10, unit: '字', visibility: 'debug', default: 80, deflabel: '（默认 80）' }),
      economyPathField('discriminator.journalPath', { visibility: 'debug', placeholder: '默认 ~/.dsh/context-economy/', default: '', deflabel: '（默认目录）' }),
      economyBoolField('discriminator.debugIo', { visibility: 'debug', default: false, deflabel: '（关）' }),
    ],
  },
]

/** 扁平化字段 spec 表（维持 key → spec 索引 + 旧版一次性升级兼容）。 */
export const ECONOMY_FIELD_SPECS: EconomyFieldSpec[] = ECONOMY_FIELD_GROUPS.flatMap(g => g.fields)

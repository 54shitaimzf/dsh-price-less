/**
 * field-model 纯逻辑单测（client 半边，无 React/DOM 依赖）——模板态修剪版。
 * 插件主体清退后本 spec 只保护**保留的 UI 壳机械件**：
 * 字段工厂 parse 精度、默认解析与深度工具、模型路由选项合并、
 * 空组壳 + 2 个组外保留 spec（模型路由暂存安全）。
 * 观察模式设置项已按用户定调清理；机制开关随 R2 工单以 boolean 字段加回。
 * 重设计加回设置项时按域扩回对应断言（清退前完整版见 git 历史）。
 */
import { describe, expect, it } from 'vitest'
import {
  CLIENT_DEFAULTS,
  ECONOMY_FIELD_COPY,
  ECONOMY_FIELD_GROUPS,
  ECONOMY_FIELD_SPECS,
  buildModelRouteOptions,
  defaultForPath,
  economyBoolField,
  economyNumberField,
  economySelectField,
  readPath,
  routeKey,
  sameValue,
  splitRouteKey,
} from '../client/field-model.ts'

describe('字段 parse（validation 精度）', () => {
  it('number：合法 / 越界 / 非数 → 精确错误文案', () => {
    const f = economyNumberField('demo.timeoutMs', { min: 1000, max: 60000, step: 500 })
    expect(f.parse('15000')).toEqual({ kind: 'set', values: { 'demo.timeoutMs': 15000 } })
    expect(f.parse('999')).toEqual({ kind: 'error', message: '需 ≥ 1000' })
    expect(f.parse('999999')).toEqual({ kind: 'error', message: '需 ≤ 60000' })
    expect(f.parse('abc')).toEqual({ kind: 'error', message: '不是有效数字' })
    expect(f.parse('')).toEqual({ kind: 'clear' })
  })

  it('bool：true/false / 其他 → 错误文案', () => {
    const f = economyBoolField('demo.enabled')
    expect(f.parse('true')).toEqual({ kind: 'set', values: { 'demo.enabled': true } })
    expect(f.parse('false')).toEqual({ kind: 'set', values: { 'demo.enabled': false } })
    expect(f.parse('yes').kind).toBe('error')
  })

  it('select：合法值 set；空串 → clear（跟随预设 = 无该选项时清空）', () => {
    const f = economySelectField('demo.enabled', [
      { value: 'off', label: 'off' },
      { value: 'on', label: 'on' },
    ])
    expect(f.parse('off')).toEqual({ kind: 'set', values: { 'demo.enabled': 'off' } })
    expect(f.parse('watch')).toEqual({ kind: 'error', message: '请从选项中选择' })
    expect(f.parse('')).toEqual({ kind: 'clear' })
  })
})

describe('默认解析与深度工具', () => {
  it('defaultForPath：模板态无必填默认；可选覆盖（provider/model）→ undefined', () => {
    expect(defaultForPath('discriminator.provider')).toBeUndefined()
    expect(defaultForPath('discriminator.model')).toBeUndefined()
  })

  it('readPath：点路径深度读', () => {
    expect(readPath({ discriminator: { provider: 'deepseek-official' } }, 'discriminator.provider')).toBe('deepseek-official')
    expect(readPath({ discriminator: {} }, 'discriminator.provider')).toBeUndefined()
  })

  it('sameValue：原始与对象比较', () => {
    expect(sameValue('off', 'off')).toBe(true)
    expect(sameValue({ a: 1 }, { a: 1 })).toBe(true)
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false)
  })
})

describe('模型路由', () => {
  it('routeKey / splitRouteKey 往返', () => {
    const key = routeKey('deepseek-official', 'deepseek-v4-flash-vision-exp')
    expect(key).toBe('deepseek-official\u0000deepseek-v4-flash-vision-exp')
    expect(splitRouteKey(key)).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    expect(splitRouteKey('')).toEqual({ provider: '', model: '' })
  })

  it('buildModelRouteOptions：预设恒显示 + 配置目录合并', () => {
    const groups = [
      { id: 'deepseek-official', name: 'DeepSeek Official', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] },
    ]
    const options = buildModelRouteOptions(groups)
    expect(options.some(o => o.value === routeKey('deepseek-official', 'deepseek-v4-flash-vision-exp'))).toBe(true)
    expect(options.some(o => o.value === routeKey('deepseek-official', 'deepseek-v4-flash'))).toBe(true)
    expect(options.some(o => o.label === 'DeepSeek Official：DeepSeek V4 Flash')).toBe(true)
  })
})

describe('模板态壳不变量（分组 + 字段 spec）', () => {
  it('4 个组壳保留；assembly 挂 auto，discern 挂推理档，其余组为空', () => {
    expect(ECONOMY_FIELD_GROUPS.map(g => g.id)).toEqual(['assembly', 'discern', 'tune', 'advanced'])
    const assembly = ECONOMY_FIELD_GROUPS.find(g => g.id === 'assembly')!
    expect(assembly.fields.map(f => f.field)).toEqual(['discriminator.auto'])
    const discern = ECONOMY_FIELD_GROUPS.find(g => g.id === 'discern')!
    expect(discern.fields.map(f => f.field)).toEqual(['discriminator.reasoningEffort'])
    expect(discern.routeSelector).toBe(true)
    for (const g of ECONOMY_FIELD_GROUPS.filter(x => x.id === 'tune' || x.id === 'advanced')) expect(g.fields).toEqual([])
  })

  it('ECONOMY_FIELD_SPECS = 4 个：auto + 推理档（core）+ provider/model（hidden），无观察模式', () => {
    const specs = new Map(ECONOMY_FIELD_SPECS.map(s => [s.field, s]))
    expect(ECONOMY_FIELD_SPECS).toHaveLength(4)
    expect(specs.has('discriminator.mode')).toBe(false)
    expect(specs.get('discriminator.auto')?.type).toBe('bool')
    expect(specs.get('discriminator.auto')?.visibility).toBe('core')
    expect(specs.get('discriminator.provider')?.visibility).toBe('hidden')
    expect(specs.get('discriminator.model')?.visibility).toBe('hidden')
    expect(CLIENT_DEFAULTS.discriminator.auto).toBe(false)
    expect(defaultForPath('discriminator.reasoningEffort')).toBeUndefined()
  })

  it('推理档字段（P14f）：选项含 off、parse 校验、空 = 跟随模型默认（clear）', () => {
    const spec = ECONOMY_FIELD_SPECS.find(s => s.field === 'discriminator.reasoningEffort')!
    expect(spec.type).toBe('select')
    expect(spec.visibility).toBe('core')
    expect(spec.options?.map(o => o.value)).toEqual(['off', 'low', 'medium', 'high', 'max'])
    expect(spec.parse('off')).toEqual({ kind: 'set', values: { 'discriminator.reasoningEffort': 'off' } })
    expect(spec.parse('bogus').kind).toBe('error')
    expect(spec.parse('')).toEqual({ kind: 'clear' })
    expect(ECONOMY_FIELD_COPY['discriminator.reasoningEffort'].hint).toContain('跟随模型默认')
  })

  it('provider/model 文案存在且提示"跟随预设"（模型路由选择器的安全语义）', () => {
    expect(ECONOMY_FIELD_COPY['discriminator.provider'].hint).toContain('跟随预设')
    expect(ECONOMY_FIELD_COPY['discriminator.model'].hint).toContain('跟随预设')
  })
})

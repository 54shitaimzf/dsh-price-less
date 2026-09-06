/**
 * field-model 纯逻辑单测（client 半边，无 React/DOM 依赖）——模板态修剪版。
 * 插件主体清退后本 spec 只保护**保留的 UI 壳机械件**：
 * 字段工厂 parse 精度、默认解析与深度工具、模型路由选项合并、
 * 空组壳 + 3 个组外保留 spec（钉住模式行 / 模型路由暂存安全）。
 * 重设计加回设置项时按域扩回对应断言（清退前完整版见 git 历史）。
 */
import { describe, expect, it } from 'vitest'
import {
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
    const f = economySelectField('demo.mode', [
      { value: 'off', label: 'off' },
      { value: 'observe', label: 'observe' },
    ])
    expect(f.parse('off')).toEqual({ kind: 'set', values: { 'demo.mode': 'off' } })
    expect(f.parse('watch')).toEqual({ kind: 'error', message: '请从选项中选择' })
    expect(f.parse('')).toEqual({ kind: 'clear' })
  })
})

describe('默认解析与深度工具', () => {
  it('defaultForPath：mode 有默认；可选覆盖（provider）→ undefined', () => {
    expect(defaultForPath('discriminator.mode')).toBe('off')
    expect(defaultForPath('discriminator.provider')).toBeUndefined()
  })

  it('readPath：点路径深度读', () => {
    expect(readPath({ discriminator: { mode: 'active' } }, 'discriminator.mode')).toBe('active')
    expect(readPath({ discriminator: {} }, 'discriminator.mode')).toBeUndefined()
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

  it('buildModelRouteOptions：预设三源恒显示 + 配置目录合并', () => {
    const groups = [
      { id: 'deepseek-official', name: 'DeepSeek Official', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] },
    ]
    const options = buildModelRouteOptions(groups)
    expect(options.some(o => o.value === routeKey('deepseek-official', 'deepseek-v4-flash-vision-exp'))).toBe(true)
    expect(options.some(o => o.value === routeKey('deepseek-official', 'deepseek-v4-flash'))).toBe(true)
    expect(options.some(o => o.label === 'DeepSeek Official：DeepSeek V4 Flash')).toBe(true)
  })
})

describe('模板态壳不变量（空组 + 组外保留 spec）', () => {
  it('4 个组壳保留但全部 fields:[]（清空设置项、保折叠标题）', () => {
    expect(ECONOMY_FIELD_GROUPS.map(g => g.id)).toEqual(['assembly', 'discern', 'tune', 'advanced'])
    for (const g of ECONOMY_FIELD_GROUPS) expect(g.fields).toEqual([])
    expect(ECONOMY_FIELD_GROUPS.find(g => g.id === 'discern')?.routeSelector).toBe(true)
  })

  it('ECONOMY_FIELD_SPECS = 恰 3 个保留 spec：mode（钉住行）+ provider/model（hidden，路由暂存安全）', () => {
    const specs = new Map(ECONOMY_FIELD_SPECS.map(s => [s.field, s]))
    expect(ECONOMY_FIELD_SPECS).toHaveLength(3)
    expect(specs.get('discriminator.mode')?.type).toBe('select')
    expect(specs.get('discriminator.provider')?.visibility).toBe('hidden')
    expect(specs.get('discriminator.model')?.visibility).toBe('hidden')
  })

  it('mode 文案一致性（下拉 vs 字段说明）', () => {
    const modeSpec = ECONOMY_FIELD_SPECS.find(s => s.field === 'discriminator.mode')!
    const observe = modeSpec.options!.find(o => o.value === 'observe')!
    expect(observe.label).toContain('测量')
    expect(ECONOMY_FIELD_COPY['discriminator.mode'].hint).toContain('observe=只看不动（测量）')
  })
})

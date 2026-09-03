/**
 * field-model 纯逻辑单测（client 半边，无 React/DOM 依赖）。
 * 覆盖：字段 parse/format、默认解析、可见性分级、模型路由选项三源合并、routeKey 往返。
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
    const f = economyNumberField('discriminator.timeoutMs', { min: 1000, max: 60000, step: 500 })
    expect(f.parse('15000')).toEqual({ kind: 'set', values: { 'discriminator.timeoutMs': 15000 } })
    expect(f.parse('999')).toEqual({ kind: 'error', message: '需 ≥ 1000' })
    expect(f.parse('999999')).toEqual({ kind: 'error', message: '需 ≤ 60000' })
    expect(f.parse('abc')).toEqual({ kind: 'error', message: '不是有效数字' })
    expect(f.parse('')).toEqual({ kind: 'clear' })
  })

  it('bool：true/false / 其他 → 错误文案', () => {
    const f = economyBoolField('sub2IntentMapping')
    expect(f.parse('true')).toEqual({ kind: 'set', values: { sub2IntentMapping: true } })
    expect(f.parse('false')).toEqual({ kind: 'set', values: { sub2IntentMapping: false } })
    expect(f.parse('yes').kind).toBe('error')
  })

  it('select：合法值 set；空串 → clear（跟随预设 = 无该选项时清空）', () => {
    const f = economySelectField('discriminator.mode', [
      { value: 'off', label: 'off' },
      { value: 'observe', label: 'observe' },
      { value: 'active', label: 'active' },
    ])
    expect(f.parse('off')).toEqual({ kind: 'set', values: { 'discriminator.mode': 'off' } })
    expect(f.parse('watch')).toEqual({ kind: 'error', message: '请从选项中选择' })
    expect(f.parse('')).toEqual({ kind: 'clear' })
  })
})

describe('默认解析与深度工具', () => {
  it('defaultForPath：带默认字段返回值，可选覆盖（provider）→ undefined', () => {
    expect(defaultForPath('discriminator.mode')).toBe('off')
    expect(defaultForPath('discriminator.maxConcurrency')).toBe(4)
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
    const key = routeKey('opencode-go', 'minimax-m3')
    expect(key).toBe('opencode-go\u0000minimax-m3')
    expect(splitRouteKey(key)).toEqual({ provider: 'opencode-go', model: 'minimax-m3' })
    expect(splitRouteKey('')).toEqual({ provider: '', model: '' })
  })

  it('buildModelRouteOptions：预设三源恒显示 + 配置目录合并', () => {
    const groups = [
      { id: 'opencode-go', name: 'OpenCode Go', models: [{ id: 'hy3', name: 'Hy3' }] },
    ]
    const options = buildModelRouteOptions(groups)
    expect(options.some(o => o.value === routeKey('opencode-go', 'minimax-m3'))).toBe(true)
    expect(options.some(o => o.value === routeKey('opencode-go', 'hy3'))).toBe(true)
    expect(options.some(o => o.value === routeKey('opencode-go-v4', 'deepseek-v4-flash'))).toBe(true)
    expect(options.some(o => o.label === 'OpenCode Go：Hy3')).toBe(true)
  })
})

describe('文案一致性（下拉 vs 字段说明）', () => {
  it('mode 的字段 hint 含「测量」与下拉 observe 选项逐字一致', () => {
    const modeSpec = ECONOMY_FIELD_SPECS.find(s => s.field === 'discriminator.mode')!
    const observe = modeSpec.options!.find(o => o.value === 'observe')!
    // 下拉「测量」与字段说明「（测量）」一致，避免内容各说各话。
    expect(observe.label).toContain('测量')
    expect(ECONOMY_FIELD_COPY['discriminator.mode'].hint).toContain('observe=只看不动（测量）')
  })
})

describe('可见性分级（设置项精简）', () => {
  it('核心组默认展开，调节/排障组默认折叠', () => {
    const byId = Object.fromEntries(ECONOMY_FIELD_GROUPS.map(g => [g.id, g]))
    expect(byId.assembly.defaultOpen).toBe(true)
    expect(byId.discern.defaultOpen).toBe(true)
    expect(byId.tune.defaultOpen).toBe(false)
    expect(byId.advanced.defaultOpen).toBe(false)
  })

  it('compressionDriver 为 hidden（不单独渲染）；provider/model 为 hidden（复合路由接管）', () => {
    const specs = new Map(ECONOMY_FIELD_SPECS.map(s => [s.field, s]))
    expect(specs.get('compressionDriver')?.visibility).toBe('hidden')
    expect(specs.get('discriminator.provider')?.visibility).toBe('hidden')
    expect(specs.get('discriminator.model')?.visibility).toBe('hidden')
  })
})

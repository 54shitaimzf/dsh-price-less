/**
 * 配置默认值双源一致性测试（防漂移，docs/12 §5）。
 *
 * 背景：插件存在两套默认值来源——config.ts 的 schemastery schema `.default()`
 * 与 index.ts 的 CONFIG_DEFAULTS（include/loader 以部分 config 装配时兜底）。
 * 二者必须同值；改一边忘另一边 = 静默改变默认行为。
 * 本测试以 schema 空输入解析结果为权威，逐字段断言 ≡ CONFIG_DEFAULTS。
 */
import { describe, expect, it } from 'vitest'
import Schema from 'schemastery'
import { Config } from '../src/config.js'
import { CONFIG_DEFAULTS } from '../src/index.js'

describe('配置默认值双源一致性（schema.CONFIG_DEFAULTS）', () => {
  // schemastery 空输入解析：所有 `.default()` 字段被填充；无 default 的可选字段省略。
  const [parsed] = Schema.resolve({}, Config)

  it('顶层 4 个开关与 CONFIG_DEFAULTS 一致', () => {
    expect(parsed.sub2IntentMapping).toBe(CONFIG_DEFAULTS.sub2IntentMapping)
    expect(parsed.compressionDriver).toBe(CONFIG_DEFAULTS.compressionDriver)
    expect(parsed.taskCompression).toBe(CONFIG_DEFAULTS.taskCompression)
    expect(parsed.overflowRecovery).toBe(CONFIG_DEFAULTS.overflowRecovery)
  })

  it('所有非 discriminator 顶层字段（含压缩域新增）与 CONFIG_DEFAULTS 一致', () => {
    for (const key of Object.keys(CONFIG_DEFAULTS) as Array<keyof typeof CONFIG_DEFAULTS>) {
      if (key === 'discriminator') continue
      expect(parsed[key], `top-level ${String(key)}`).toBe(CONFIG_DEFAULTS[key])
    }
  })

  it('discriminator 全部带默认字段与 CONFIG_DEFAULTS 一致', () => {
    for (const key of Object.keys(CONFIG_DEFAULTS.discriminator) as Array<keyof typeof CONFIG_DEFAULTS.discriminator>) {
      expect(parsed.discriminator[key], `discriminator.${String(key)}`).toBe(CONFIG_DEFAULTS.discriminator[key])
    }
  })

  it('判别器默认 mode 为 off（零成本，默认不挂载；observe 仅主动测量）', () => {
    expect(parsed.discriminator.mode).toBe('off')
    expect(CONFIG_DEFAULTS.discriminator.mode).toBe('off')
  })

  it('CONFIG_DEFAULTS 中每个 discriminator 字段在 schema 里都有默认值（防漏补）', () => {
    for (const key of Object.keys(CONFIG_DEFAULTS.discriminator)) {
      expect(parsed.discriminator[key], `schema 未给 discriminator.${key} 默认值`).not.toBeUndefined()
    }
  })
})
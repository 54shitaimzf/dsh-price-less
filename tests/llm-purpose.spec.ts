/**
 * llm-purpose 契约锚（docs/12 §1 C2）——宿主 purpose 未宽化前，插件侧适配单点。
 * 本 spec 锁住：purpose 词汇冻结、toHarnessGenerateOptions 是唯一收窄点、
 * llm 服务解析 fail-lazy（未装配 → undefined，不抛）。
 * P5 落 stream/usage 回执后，本文件追加调用面断言（不重写存量断言）。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  CE_AUX_PURPOSES,
  resolveLlmService,
  toHarnessGenerateOptions,
  type CeGenerateOptions,
} from '../src/platform/llm.ts'

describe('辅助调用 purpose 契约锚（12 §1 C2）', () => {
  it('purpose 词汇冻结：三个域各一值，且只作为本地宽化存在', () => {
    expect(CE_AUX_PURPOSES).toEqual([
      'context-economy-judge',
      'context-economy-optimize',
      'context-economy-compaction',
    ])
  })

  it('宽化选项经单点收窄后逐字段保留（custom purpose 可进入宿主类型面）', () => {
    const options: CeGenerateOptions = {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: [],
      purpose: 'context-economy-judge',
    }
    const harnessOptions = toHarnessGenerateOptions(options)
    expect(harnessOptions).toEqual(options)
  })

  it('resolveLlmService：未装配 → undefined（fail-lazy 前提），有服务 → 原样返回', () => {
    expect(resolveLlmService({} as Context)).toBeUndefined()
    const service = { stream: async function* () {} }
    expect(resolveLlmService({ llm: service } as never)).toBe(service)
  })
})

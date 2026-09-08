/**
 * P8 稳定前缀测试（docs/implement/archive/P8-units-prefix.md §3.6）。
 * 全部纯函数，零 harness/cordis 运行时 import。
 */
import { describe, expect, it } from 'vitest'
import {
  PREFIX_REBUILD_CAUSES,
  createProjectFrame,
  foldPrefixMetrics,
  normalizeSkillCatalog,
  projectFrameStorageKey,
  reconcileProjectFrame,
  renderStablePrefix,
  type ProjectFrameBody,
  type ProjectFrameRecord,
  type SkillCatalogSnapshot,
} from '../src/core/prefix.ts'
import { estimateTokens } from '../src/core/ledger/fold.ts'

const body = (overrides: Partial<ProjectFrameBody> = {}): ProjectFrameBody => ({
  goal: 'Build a parser',
  aspects: ['parsing', 'testing'],
  skillCatalog: {
    complete: true,
    skills: [
      { name: 'z-test', description: 'Test desc' },
      { name: 'a-build', description: 'Build desc', whenToUse: 'when building' },
    ],
  },
  ...overrides,
})

describe('renderStablePrefix', () => {
  it('黄金字节：排序、whenToUse 有无、末行换行逐字节冻结', () => {
    const text = renderStablePrefix(body())
    expect(text).toBe([
      '[项目最终目标]',
      'Build a parser',
      '',
      '[方面分解]',
      '- parsing',
      '- testing',
      '',
      '[技能目录]',
      '- a-build: Build desc (whenToUse: when building)',
      '- z-test: Test desc',
      '',
    ].join('\n'))
  })

  it('(无) 分支：无方面无技能输出占位', () => {
    const text = renderStablePrefix(body({ aspects: [], skillCatalog: { complete: true, skills: [] } }))
    expect(text).toBe('[项目最终目标]\nBuild a parser\n\n[方面分解]\n(无)\n\n[技能目录]\n(无)\n')
  })

  it('确定性：同一 body 连跑 3 次逐字节一致；乱序输入排序后一致', () => {
    const a = renderStablePrefix(body())
    const b = renderStablePrefix(body())
    const c = renderStablePrefix(body())
    const shuffled = body({ skillCatalog: { complete: true, skills: [...body().skillCatalog.skills].reverse() } })
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(renderStablePrefix(shuffled)).toBe(a)
  })
})

describe('normalizeSkillCatalog', () => {
  it('排序、复制、不引用输入、complete 透传', () => {
    const input: SkillCatalogSnapshot = {
      complete: false,
      skills: [
        { name: 'b', description: 'B' },
        { name: 'a', description: 'A', whenToUse: 'when a' },
      ],
    }
    const out = normalizeSkillCatalog(input)
    expect(out).toEqual({
      complete: false,
      skills: [
        { name: 'a', description: 'A', whenToUse: 'when a' },
        { name: 'b', description: 'B' },
      ],
    })
    ;(input.skills[0] as { name: string }).name = 'mutated'
    expect(out.skills[0]!.name).toBe('a')
    expect(out.skills[0]).not.toBe(input.skills[1])
  })
})

describe('projectFrameStorageKey', () => {
  it('project_frame:${workspace} 前缀', () => {
    expect(projectFrameStorageKey('d:/x')).toBe('project_frame:d:/x')
    expect(projectFrameStorageKey('C:/repo')).toBe('project_frame:C:/repo')
  })
})

describe('createProjectFrame', () => {
  it('v1 初始帧：fromVersion null、cause frame、渲染与 token 一致', () => {
    const result = createProjectFrame('Goal', ['A'], { complete: true, skills: [{ name: 'tool', description: 'Tool' }] })
    expect(result.rebuilt).toBe(true)
    expect(result.version).toBe(1)
    expect(result.fromVersion).toBeNull()
    expect(result.cause).toBe('frame')
    expect(result.renderedPrefix).toContain('Goal')
    expect(result.renderedPrefix).toContain('tool')
    expect(result.prefixTokens).toBe(estimateTokens(result.renderedPrefix))
  })
})

describe('reconcileProjectFrame', () => {
  const current: ProjectFrameRecord = { version: 1, body: body() }

  it('无 current：返回 null，不创建', () => {
    expect(reconcileProjectFrame(undefined, body().skillCatalog, 'skill')).toBeNull()
  })

  it('同目录：rebuilt=false、版本不变、字节不变', () => {
    const result = reconcileProjectFrame(current, body().skillCatalog, 'skill')
    expect(result).not.toBeNull()
    expect(result!.rebuilt).toBe(false)
    expect(result!.version).toBe(1)
    expect(result!.renderedPrefix).toBe(renderStablePrefix(current.body))
  })

  it('目录变更：rebuilt=true、version 2、字节变化、prefixTokens 正', () => {
    const nextCatalog: SkillCatalogSnapshot = { complete: true, skills: [{ name: 'new', description: 'New' }] }
    const result = reconcileProjectFrame(current, nextCatalog, 'skill')!
    expect(result.rebuilt).toBe(true)
    expect(result.version).toBe(2)
    expect(result.fromVersion).toBe(1)
    expect(result.renderedPrefix).not.toBe(renderStablePrefix(current.body))
    expect(result.prefixTokens).toBeGreaterThan(0)
  })

  it('last-good：undefined/complete=false 不 bump 且保持原字节', () => {
    const missing = reconcileProjectFrame(current, undefined, 'skill')!
    expect(missing.rebuilt).toBe(false)
    expect(missing.version).toBe(1)
    expect(missing.renderedPrefix).toBe(renderStablePrefix(current.body))
    const partial = reconcileProjectFrame(current, { ...current.body.skillCatalog, complete: false }, 'skill')!
    expect(partial.rebuilt).toBe(false)
    expect(partial.version).toBe(1)
    expect(partial.renderedPrefix).toBe(renderStablePrefix(current.body))
  })
})

describe('foldPrefixMetrics', () => {
  it('计数、token 求和、cause 全谱缺省 0', () => {
    const metrics = foldPrefixMetrics([
      { fromVersion: 1, version: 2, cause: 'skill', prefixTokens: 10 },
      { fromVersion: 2, version: 3, cause: 'frame', prefixTokens: 20 },
      { fromVersion: 3, version: 4, cause: 'skill', prefixTokens: 30 },
    ])
    expect(metrics.prefixRebuildCount).toBe(3)
    expect(metrics.prefixRebuildTokens).toBe(60)
    expect(metrics.prefixRebuildCause).toEqual({
      shear: 0, compaction: 0, note: 0, skill: 2, frame: 1,
    })
    expect(Object.keys(metrics.prefixRebuildCause).sort()).toEqual([...PREFIX_REBUILD_CAUSES].sort())
  })
})

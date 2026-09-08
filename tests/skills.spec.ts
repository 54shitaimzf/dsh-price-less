/**
 * P4 技能目录端口测试（docs/implement/archive/P4-skills.md §3.2）。
 * 全部 fake，零 cordis 运行时 import；锁：只经 ctx.skills 官方缝、最小字段映射、
 * fail-lazy、skills/change 热更新、幂等卸载、onChange 异常遏制。
 */
import { describe, expect, it, vi } from 'vitest'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import {
  getSkillDefinition,
  listSkillCatalog,
  skillCatalogContains,
  skillCatalogNames,
  toSkillCatalogSnapshot,
  watchSkillCatalog,
} from '../src/platform/skills.ts'

const summary = (name: string, description = '', whenToUse?: string, modelInvocable = true): SkillSummary => ({
  name,
  description,
  ...(whenToUse === undefined ? {} : { whenToUse }),
  invocation: { modelInvocable, userInvocable: true },
  source: 'runtime',
  provider: 'test',
})

const definition = (name: string): SkillDefinition => ({
  ...summary(name, `${name} desc`),
  content: `${name} body`,
})

const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve() }

function makeLoggerCtx() {
  const warn = vi.fn()
  const logger = (name: string) => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() })
  return { logger, warn }
}

function makeWatchCtx(skills: unknown) {
  const { logger, warn } = makeLoggerCtx()
  const listeners = new Set<() => void>()
  const ctx = {
    skills,
    logger,
    on: (_name: string, fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
  return {
    ctx,
    warn,
    emit: () => { for (const fn of [...listeners]) fn() },
  }
}

describe('toSkillCatalogSnapshot', () => {
  it('过滤 modelInvocable=false，只留最小字段，按 name 码点升序，输出全新对象', () => {
    const b = summary('b-skill', 'B', 'when b')
    const a = summary('a-skill', 'A')
    const hidden = summary('hidden', 'H', undefined, false)
    const input = [b, a, hidden]
    const snap = toSkillCatalogSnapshot(input, false)
    expect(snap).toEqual({
      complete: false,
      skills: [
        { name: 'a-skill', description: 'A' },
        { name: 'b-skill', description: 'B', whenToUse: 'when b' },
      ],
    })
    expect(snap.skills[0]).not.toBe(input[1])
    ;(input[1] as { name: string }).name = 'mutated'
    expect(snap.skills[0]!.name).toBe('a-skill')
  })
})

describe('skillCatalogContains / skillCatalogNames', () => {
  it('精确查表；undefined 目录视为空', () => {
    const snap = toSkillCatalogSnapshot([summary('alpha'), summary('beta')], true)
    expect(skillCatalogContains(snap, 'alpha')).toBe(true)
    expect(skillCatalogContains(snap, 'ALPHA')).toBe(false)
    expect(skillCatalogContains(snap, 'gamma')).toBe(false)
    expect(skillCatalogContains(undefined, 'alpha')).toBe(false)
    expect(skillCatalogNames(snap)).toEqual(['alpha', 'beta'])
    expect(skillCatalogNames(undefined)).toEqual([])
  })
})

describe('listSkillCatalog', () => {
  it('snapshot 返回 complete 透传；list 回退置 complete=true', async () => {
    const { logger, warn } = makeLoggerCtx()
    const snapshot = vi.fn().mockResolvedValue({ skills: [summary('z'), summary('a')], complete: false })
    const list = vi.fn().mockResolvedValue([summary('only')])
    const snap = await listSkillCatalog({ skills: { snapshot, list }, logger } as never)
    expect(snap?.complete).toBe(false)
    expect(snap?.skills.map((s) => s.name)).toEqual(['a', 'z'])
    const fallback = await listSkillCatalog({ skills: { list }, logger } as never)
    expect(fallback?.complete).toBe(true)
    expect(fallback?.skills.map((s) => s.name)).toEqual(['only'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('skills 缺失返回 undefined；snapshot 拒绝 warn + undefined（fail-lazy）', async () => {
    const { logger } = makeLoggerCtx()
    expect(await listSkillCatalog({ logger } as never)).toBeUndefined()
    const warn = vi.fn()
    const bad = { skills: { snapshot: vi.fn().mockRejectedValue(new Error('boom')) }, logger: (name: string) => ({ warn }) }
    expect(await listSkillCatalog(bad as never)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skill catalog unavailable'), 'boom')
  })
})

describe('getSkillDefinition', () => {
  it('合法名委托 skills.get 并返回；非法名不调用直接 undefined', async () => {
    const { logger } = makeLoggerCtx()
    const good = definition('good')
    const get = vi.fn().mockResolvedValue(good)
    expect(await getSkillDefinition({ skills: { get }, logger } as never, 'good')).toBe(good)
    expect(get).toHaveBeenCalledWith('good', undefined)
    expect(await getSkillDefinition({ skills: { get }, logger } as never, 'Bad_Name')).toBeUndefined()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('skills 缺失/get 拒绝 → undefined + warn', async () => {
    const missing = makeLoggerCtx()
    expect(await getSkillDefinition({ logger: missing.logger } as never, 'good')).toBeUndefined()
    const warn = vi.fn()
    const bad = { skills: { get: vi.fn().mockRejectedValue(new Error('down')) }, logger: (name: string) => ({ warn }) }
    expect(await getSkillDefinition(bad as never, 'good')).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skill definition unavailable'), 'down')
  })
})

describe('watchSkillCatalog', () => {
  it('立即首刷；skills/change 再次刷新；running 防重入', async () => {
    let release!: (v: { skills: SkillSummary[]; complete: boolean }) => void
    let first = true
    const snapshot = vi.fn(() => {
      if (first) {
        first = false
        return new Promise<{ skills: SkillSummary[]; complete: boolean }>((resolve) => { release = resolve })
      }
      return Promise.resolve({ skills: [summary('a')], complete: true })
    })
    const skills = { snapshot }
    const { ctx, emit } = makeWatchCtx(skills)
    const onChange = vi.fn()
    const dispose = watchSkillCatalog(ctx as never, onChange)
    emit()
    emit()
    release({ skills: [summary('a')], complete: true })
    await flush()
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
    emit()
    await flush()
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('disposer 幂等；卸载后 emit 不再回调', async () => {
    const snapshot = vi.fn().mockResolvedValue({ skills: [summary('a')], complete: true })
    const { ctx, emit } = makeWatchCtx({ snapshot })
    const onChange = vi.fn()
    const dispose = watchSkillCatalog(ctx as never, onChange)
    await flush()
    dispose()
    dispose()
    emit()
    await flush()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('onChange 抛错被抓 + warn，不放外溢且 disposer 正常', async () => {
    const snapshot = vi.fn().mockResolvedValue({ skills: [summary('a')], complete: true })
    const { ctx, warn, emit } = makeWatchCtx({ snapshot })
    const onChange = vi.fn(() => { throw new Error('consumer bug') })
    expect(() => watchSkillCatalog(ctx as never, onChange)).not.toThrow()
    await flush()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onChange failed'), 'consumer bug')
    emit()
    await flush()
    expect(onChange).toHaveBeenCalledTimes(2)
  })
})

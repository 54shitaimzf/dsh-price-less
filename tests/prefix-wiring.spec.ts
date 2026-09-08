/**
 * P8 稳定前缀 watch 接线测试（docs/implement/archive/P8-units-prefix.md §3.7）。
 * fake ctx + fake storageDomain；零 cordis 运行时依赖。
 */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { projectFrameStorageKey } from '../src/core/prefix.ts'
import type { SkillCatalogSnapshot } from '../src/core/prefix.ts'
import { ENTITY_TABLES, type EntityRecord } from '../src/platform/storage.ts'

class FakeTable<V> {
  private readonly map = new Map<string, V>()
  get(key: string): V | undefined { return this.map.get(key) }
  entries(): IterableIterator<[string, V]> { return this.map.entries() }
  keys(): IterableIterator<string> { return this.map.keys() }
  get size(): number { return this.map.size }
  async put(key: string, value: V): Promise<void> { this.map.set(key, value) }
  async delete(key: string): Promise<boolean> { return this.map.delete(key) }
  async update(key: string, fn: (current: V) => V): Promise<V> {
    if (!this.map.has(key)) throw new Error('missing-key')
    const next = fn(this.map.get(key)!)
    this.map.set(key, next)
    return next
  }
}

class FakeDomain {
  readonly tables = new Map<string, FakeTable<unknown>>()
  constructor() {
    for (const name of [...ENTITY_TABLES, 'fact_mirror', 'entity_snapshots']) this.tables.set(name, new FakeTable())
  }
  table(name: string): FakeTable<unknown> {
    const table = this.tables.get(name)
    if (!table) throw new Error(`no table ${name}`)
    return table
  }
  async close(): Promise<void> {}
}

const catalogA: SkillCatalogSnapshot = {
  complete: true,
  skills: [{ name: 'alpha', description: 'Alpha' }],
}
const catalogB: SkillCatalogSnapshot = {
  complete: true,
  skills: [{ name: 'beta', description: 'Beta' }],
}

function makeHarness(opts: { withSkills?: boolean } = {}) {
  const withSkills = opts.withSkills ?? true
  const domain = new FakeDomain()
  const disposers: Array<() => unknown> = []
  const logs: Array<{ level: string; text: string }> = []
  const listeners = new Map<string, Set<() => void>>()
  let catalog: SkillCatalogSnapshot | undefined = catalogA

  const rec = (level: string) => (...args: unknown[]) => {
    logs.push({ level, text: args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') })
  }
  const logger = (() => {
    const fn = ((name: string) => ({ info: rec('info'), warn: rec('warn'), error: rec('error') })) as unknown as {
      info: (...a: unknown[]) => void
      warn: (...a: unknown[]) => void
      error: (...a: unknown[]) => void
    }
    fn.info = rec('info')
    fn.warn = rec('warn')
    fn.error = rec('error')
    return fn
  })()

  const skills = {
    snapshot: async () => {
      const c = catalog ?? { complete: true, skills: [] }
      return {
        skills: c.skills.map((s) => ({
          name: s.name,
          description: s.description,
          ...(s.whenToUse === undefined ? {} : { whenToUse: s.whenToUse }),
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'test',
          provider: 'test',
        })),
        complete: c.complete,
      }
    },
    list: async () => [],
  }

  const ctx = {
    logger,
    ...(withSkills ? { skills } : {}),
    on: (name: string, fn: () => void) => {
      let set = listeners.get(name)
      if (!set) listeners.set(name, (set = new Set()))
      set.add(fn)
      return () => { set.delete(fn) }
    },
    effect: (fn: () => unknown) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => unknown)
    },
    inject: (deps: readonly string[], cb: (provided: unknown) => unknown) => {
      if (deps.includes('skills')) {
        if (!withSkills) return
        const d = cb(ctx)
        if (typeof d === 'function') disposers.push(d as () => unknown)
        return
      }
      if (!deps.includes('storageDomain')) return
      const storageCtx = {
        storageDomain: { open: async () => domain },
        logger,
        effect: ctx.effect,
        on: ctx.on,
        ...(withSkills ? { skills } : {}),
      }
      const d = cb(storageCtx)
      if (typeof d === 'function') disposers.push(d as () => unknown)
    },
  }

  const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const emitSkillsChange = (): void => { for (const fn of [...(listeners.get('skills/change') ?? [])]) fn() }
  const projectFrame = (): EntityRecord | undefined => domain.table('project_frame').get(projectFrameStorageKey(process.cwd().replaceAll('\\', '/'))) as EntityRecord | undefined
  const setCatalog = (next: SkillCatalogSnapshot | undefined): void => { catalog = next }

  return { ctx, disposers, domain, flush, emitSkillsChange, projectFrame, setCatalog, listeners }
}

describe('prefix wiring', () => {
  it('无项目帧不创建：watch 注册且 project_frame 为空', async () => {
    const h = makeHarness()
    apply(h.ctx as never, {})
    await h.flush()
    expect(h.projectFrame()).toBeUndefined()
    expect(h.listeners.get('skills/change')?.size ?? 0).toBeGreaterThan(0)
  })

  it('已有项目帧 + 首刷同目录：保持版本 1 不写新快照', async () => {
    const h = makeHarness()
    const key = projectFrameStorageKey(process.cwd().replaceAll('\\', '/'))
    await h.domain.table('project_frame').put(key, {
      schemaVersion: 1,
      version: 1,
      source: { taskId: 'init', eventType: 'init', evidence: {} },
      body: { goal: 'G', aspects: [], skillCatalog: catalogA },
    })
    apply(h.ctx as never, {})
    await h.flush()
    const rec = h.projectFrame()!
    expect(rec.version).toBe(1)
    expect((rec.body as { skillCatalog: SkillCatalogSnapshot }).skillCatalog.skills[0]!.name).toBe('alpha')
    expect(h.domain.table('entity_snapshots').size).toBe(0)
  })

  it('skills/change 触发 bump：v2、catalog B、prefix-rebuild 审计', async () => {
    const h = makeHarness()
    const key = projectFrameStorageKey(process.cwd().replaceAll('\\', '/'))
    await h.domain.table('project_frame').put(key, {
      schemaVersion: 1,
      version: 1,
      source: { taskId: 'init', eventType: 'init', evidence: {} },
      body: { goal: 'G', aspects: [], skillCatalog: catalogA },
    })
    apply(h.ctx as never, {})
    await h.flush()
    h.setCatalog(catalogB)
    h.emitSkillsChange()
    await h.flush()
    const rec = h.projectFrame()!
    expect(rec.version).toBe(2)
    expect((rec.body as { skillCatalog: SkillCatalogSnapshot }).skillCatalog.skills[0]!.name).toBe('beta')
    expect(rec.source.eventType).toBe('prefix-rebuild')
    expect((rec.source.evidence as { cause: string }).cause).toBe('skill')
    expect((rec.source.evidence as { fromVersion: number }).fromVersion).toBe(1)
    expect((rec.source.evidence as { toVersion: number }).toVersion).toBe(2)
  })

  it('卸载净：dispose 后不再 bump，重复 dispose no-op', async () => {
    const h = makeHarness()
    const key = projectFrameStorageKey(process.cwd().replaceAll('\\', '/'))
    await h.domain.table('project_frame').put(key, {
      schemaVersion: 1,
      version: 1,
      source: { taskId: 'init', eventType: 'init', evidence: {} },
      body: { goal: 'G', aspects: [], skillCatalog: catalogA },
    })
    apply(h.ctx as never, {})
    await h.flush()
    h.setCatalog(catalogB)
    h.emitSkillsChange()
    await h.flush()
    expect(h.projectFrame()!.version).toBe(2)
    for (const d of [...h.disposers]) d()
    h.emitSkillsChange()
    await h.flush()
    expect(h.projectFrame()!.version).toBe(2)
    for (const d of [...h.disposers]) d()
    expect(h.projectFrame()!.version).toBe(2)
  })

  it('无 skills 服务时主插件仍可用：不注册 skills/change watch，也不创建项目帧', async () => {
    const h = makeHarness({ withSkills: false })
    apply(h.ctx as never, {})
    await h.flush()
    expect(h.listeners.get('skills/change')?.size ?? 0).toBe(0)
    expect(h.projectFrame()).toBeUndefined()
    expect(h.domain.tables.has('fact_mirror')).toBe(true)
  })
})

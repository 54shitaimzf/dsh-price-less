/**
 * 技能目录端口（docs/11 §2 skills.ts / docs/10 §1 H13 / docs/13 §3.7）。
 *
 * 只走 harness 官方技能注册表 `ctx.skills`：不做技能文件扫描、不轮询、
 * 不 import core。提供 model-invocable 目录快照枚举、`skills/change` 热更新订阅、
 * 单技能定义读取与引用守卫查表。本单只建端口，不发前缀重建/设置/会话事件（P8 起消费）。
 *
 * 模块: platform 技能目录端口
 * 平面: L0（官方缝枚举 + 查表；无模型、无机制逻辑）
 * 回退链步数: 1（能力缺失/失败 → undefined + warn，fail-lazy）
 * 审查清单: 无网络/timer；快照全新对象；skill 概念只许在本文件（D5）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import {
  isModelInvocable,
  isSkillName,
  type SkillDefinition,
  type SkillSummary,
  type SkillViewOptions,
} from '@deepseek-ai/dsh-skill'

/** 稳定前缀使用的技能目录条目（仅机械枚举字段，零 LLM）。 */
export interface SkillCatalogEntry {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
}

/** 平台侧技能目录快照（harness `SkillCatalogSnapshot` 的收窄只读形态）。 */
export interface SkillCatalogSnapshot {
  readonly skills: readonly SkillCatalogEntry[]
  readonly complete: boolean
}

/** 过滤 model-invocable、取最小字段、按 name 码点升序；输出全新对象。 */
export function toSkillCatalogSnapshot(
  summaries: readonly SkillSummary[],
  complete: boolean,
): SkillCatalogSnapshot {
  const skills = summaries
    .filter((s) => isModelInvocable(s))
    .map((s) => ({
      name: s.name,
      description: s.description,
      ...(s.whenToUse !== undefined ? { whenToUse: s.whenToUse } : {}),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { skills, complete }
}

/** 引用守卫查表：目录缺失视为空目录；技能名 kebab-case 精确匹配。 */
export function skillCatalogContains(catalog: SkillCatalogSnapshot | undefined, name: string): boolean {
  return catalog?.skills.some((s) => s.name === name) ?? false
}

/** 目录名列表（新数组；目录缺失返回空）。 */
export function skillCatalogNames(catalog: SkillCatalogSnapshot | undefined): string[] {
  return catalog?.skills.map((s) => s.name) ?? []
}

/** 读取目录快照；服务缺失或失败返回 undefined + warn（fail-lazy）。 */
export async function listSkillCatalog(
  ctx: Pick<Context, 'skills' | 'logger'>,
  options?: SkillViewOptions,
): Promise<SkillCatalogSnapshot | undefined> {
  const skills = ctx.skills
  if (skills == null) return undefined
  try {
    if (typeof (skills as { snapshot?: unknown }).snapshot === 'function') {
      const raw = await skills.snapshot(options)
      return toSkillCatalogSnapshot(raw.skills, raw.complete)
    }
    const summaries = await skills.list(options)
    return toSkillCatalogSnapshot(summaries, true)
  } catch (e) {
    ctx.logger('context-economy').warn('context-economy: skill catalog unavailable (contained, fail-lazy)', e instanceof Error ? e.message : String(e))
    return undefined
  }
}

/** 读取单个技能定义；非法名/服务缺失/失败返回 undefined + warn（fail-lazy）。 */
export async function getSkillDefinition(
  ctx: Pick<Context, 'skills' | 'logger'>,
  name: string,
  options?: SkillViewOptions,
): Promise<SkillDefinition | undefined> {
  if (!isSkillName(name)) return undefined
  const skills = ctx.skills
  if (skills == null) return undefined
  try {
    return await skills.get(name, options)
  } catch (e) {
    ctx.logger('context-economy').warn('context-economy: skill definition unavailable (contained, fail-lazy)', e instanceof Error ? e.message : String(e))
    return undefined
  }
}

/**
 * 订阅 `skills/change` 并立即首刷一次；返回幂等 disposer。
 * 热更新完全由事件驱动；refresh 防重入；onChange 异常只 warn 不外溢。
 */
export function watchSkillCatalog(
  ctx: Pick<Context, 'skills' | 'logger' | 'on'>,
  onChange: (catalog: SkillCatalogSnapshot | undefined) => void,
  options?: SkillViewOptions,
): () => void {
  let disposed = false
  let running = false
  let unsubscribe: (() => void) | undefined

  const refresh = async (): Promise<void> => {
    if (running || disposed) return
    running = true
    try {
      const catalog = await listSkillCatalog(ctx, options)
      if (disposed) return
      try {
        onChange(catalog)
      } catch (e) {
        ctx.logger('context-economy').warn('context-economy: skill catalog onChange failed (contained)', e instanceof Error ? e.message : String(e))
      }
    } finally {
      running = false
    }
  }

  unsubscribe = ctx.on('skills/change', () => { void refresh() })
  void refresh()

  return () => {
    if (disposed) return
    disposed = true
    unsubscribe?.()
  }
}

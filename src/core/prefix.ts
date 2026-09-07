/**
 * 稳定前缀（docs/02 §2 / docs/06 §3–§4 / docs/09 §2 / docs/12 §3）。
 * 纯函数：技能目录快照本地重声明（零 harness import）、项目帧渲染/重建、版本与度量。
 */
import { estimateTokens } from './ledger/fold.ts'

export const PREFIX_REBUILD_CAUSES = ['shear', 'compaction', 'note', 'skill', 'frame'] as const
export type PrefixRebuildCause = (typeof PREFIX_REBUILD_CAUSES)[number]

export interface SkillCatalogEntry {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
}

export interface SkillCatalogSnapshot {
  readonly skills: readonly SkillCatalogEntry[]
  readonly complete: boolean
}

export interface ProjectFrameBody {
  goal: string
  aspects: string[]
  skillCatalog: SkillCatalogSnapshot
}

export interface ProjectFrameRecord {
  version: number
  body: ProjectFrameBody
}

export interface PrefixReconcileResult {
  rebuilt: boolean
  fromVersion: number | null
  version: number
  cause: PrefixRebuildCause
  body: ProjectFrameBody
  renderedPrefix: string
  prefixTokens: number
}

export interface PrefixRebuildRecord {
  fromVersion: number | null
  version: number
  cause: PrefixRebuildCause
  prefixTokens: number
}

export interface PrefixMetrics {
  prefixRebuildCount: number
  prefixRebuildTokens: number
  prefixRebuildCause: Record<PrefixRebuildCause, number>
}

export function projectFrameStorageKey(workspace: string): string {
  return `project_frame:${workspace}`
}

export function normalizeSkillCatalog(catalog: SkillCatalogSnapshot): SkillCatalogSnapshot {
  const skills = catalog.skills
    .map((s) => ({
      name: s.name,
      description: s.description,
      ...(s.whenToUse === undefined ? {} : { whenToUse: s.whenToUse }),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { skills, complete: catalog.complete }
}

export function renderStablePrefix(body: ProjectFrameBody): string {
  const catalog = normalizeSkillCatalog(body.skillCatalog)
  const aspects = body.aspects.length > 0 ? body.aspects.map((a) => `- ${a}`).join('\n') : '(无)'
  const skills = catalog.skills.length > 0
    ? catalog.skills.map((s) => s.whenToUse === undefined
        ? `- ${s.name}: ${s.description}`
        : `- ${s.name}: ${s.description} (whenToUse: ${s.whenToUse})`).join('\n')
    : '(无)'
  return `[项目最终目标]\n${body.goal}\n\n[方面分解]\n${aspects}\n\n[技能目录]\n${skills}\n`
}

export function createProjectFrame(goal: string, aspects: string[], catalog: SkillCatalogSnapshot): PrefixReconcileResult {
  const body: ProjectFrameBody = {
    goal,
    aspects,
    skillCatalog: normalizeSkillCatalog(catalog),
  }
  const renderedPrefix = renderStablePrefix(body)
  return {
    rebuilt: true,
    fromVersion: null,
    version: 1,
    cause: 'frame',
    body,
    renderedPrefix,
    prefixTokens: estimateTokens(renderedPrefix),
  }
}

export function reconcileProjectFrame(
  current: ProjectFrameRecord | undefined,
  catalog: SkillCatalogSnapshot | undefined,
  cause: PrefixRebuildCause,
): PrefixReconcileResult | null {
  if (current === undefined) return null
  const lastGood = (): PrefixReconcileResult => ({
    rebuilt: false,
    fromVersion: current.version,
    version: current.version,
    cause,
    body: current.body,
    renderedPrefix: renderStablePrefix(current.body),
    prefixTokens: estimateTokens(renderStablePrefix(current.body)),
  })

  if (catalog === undefined || catalog.complete === false) return lastGood()

  const nextBody: ProjectFrameBody = {
    goal: current.body.goal,
    aspects: current.body.aspects,
    skillCatalog: normalizeSkillCatalog(catalog),
  }
  const nextRendered = renderStablePrefix(nextBody)
  const currentRendered = renderStablePrefix(current.body)
  if (nextRendered === currentRendered) return lastGood()

  return {
    rebuilt: true,
    fromVersion: current.version,
    version: current.version + 1,
    cause,
    body: nextBody,
    renderedPrefix: nextRendered,
    prefixTokens: estimateTokens(nextRendered),
  }
}

export function foldPrefixMetrics(records: PrefixRebuildRecord[]): PrefixMetrics {
  const causeCounts = Object.fromEntries(PREFIX_REBUILD_CAUSES.map((c) => [c, 0])) as Record<PrefixRebuildCause, number>
  let tokens = 0
  for (const record of records) {
    tokens += record.prefixTokens
    causeCounts[record.cause] += 1
  }
  return {
    prefixRebuildCount: records.length,
    prefixRebuildTokens: tokens,
    prefixRebuildCause: causeCounts,
  }
}

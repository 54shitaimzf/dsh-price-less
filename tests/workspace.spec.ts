/**
 * F3 工作区隔离单测（docs/09 §1；真机 2026-09-09：跨项目会话共用一个档案键互相驱逐）。
 * 纯函数 + 键派生：会话 header.cwd 优先，缺失回落；不同会话 → 不同实体键。
 */
import { describe, expect, it } from 'vitest'
import { normalizeWorkspace, workspaceOf } from '../src/domains/workspace.ts'
import { boundaryArchiveKey } from '../src/domains/compaction.ts'
import { optimizeArtifactStorageKey } from '../src/domains/star.ts'
import { projectFrameStorageKey } from '../src/core/prefix.ts'

describe('F3 工作区解析（会话 cwd 优先）', () => {
  it('normalizeWorkspace：反斜杠统一 + 去尾斜杠', () => {
    expect(normalizeWorkspace('C:\\a\\b\\')).toBe('C:/a/b')
    expect(normalizeWorkspace('/x/y///')).toBe('/x/y')
  })
  it('workspaceOf：header.cwd 优先；缺失/空白 → fallback', () => {
    expect(workspaceOf({ header: { cwd: 'C:\\proj\\resume' } }, 'C:/fallback')).toBe('C:/proj/resume')
    expect(workspaceOf({ header: {} }, 'C:/fallback')).toBe('C:/fallback')
    expect(workspaceOf({ header: { cwd: '   ' } }, 'C:/fallback')).toBe('C:/fallback')
    expect(workspaceOf(undefined, 'C:/fallback')).toBe('C:/fallback')
  })
  it('三个实体键由 workspace 派生：不同会话 cwd → 不同键（互不驱逐）', () => {
    const a = workspaceOf({ header: { cwd: 'C:/proj/a' } })
    const b = workspaceOf({ header: { cwd: 'C:/proj/b' } })
    expect(a).not.toBe(b)
    expect(boundaryArchiveKey(a)).not.toBe(boundaryArchiveKey(b))
    expect(optimizeArtifactStorageKey(a)).not.toBe(optimizeArtifactStorageKey(b))
    expect(projectFrameStorageKey(a)).not.toBe(projectFrameStorageKey(b))
  })
})
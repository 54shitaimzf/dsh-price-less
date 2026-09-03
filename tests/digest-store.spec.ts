/**
 * per-task 摘要落盘单测（无 harness）：内存 IO mock 下的原子写 / 版本 / 溯源 / 合并策略。
 */
import { describe, expect, it } from 'vitest'
import { DigestStore, type DigestStoreIO } from '../src/task/digest-store.js'
import { DIGEST_SCHEMA_VERSION, emptyDigest } from '../src/task/digest-schema.js'

/** 内存 IO mock：路径 → 内容。原子写 = set(tmp) + rename 到目标。 */
function memIO(initial: Record<string, string> = {}): DigestStoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initial))
  return {
    files,
    exists: (p) => files.has(p),
    read: (p) => {
      const v = files.get(p)
      if (v === undefined) throw new Error(`E_NOENT ${p}`)
      return v
    },
    write: (p, c) => files.set(p, c),
    rename: (a, b) => {
      const v = files.get(a)
      if (v === undefined) throw new Error(`E_NOENT ${a}`)
      files.set(b, v)
      files.delete(a)
    },
    mkdir: () => {},
  }
}

const PATH = '/data/knowledge.json'

describe('DigestStore', () => {
  it('文件不存在 → load 空表', () => {
    const io = memIO()
    const store = new DigestStore({ filePath: PATH, io })
    expect(store.load()).toEqual({})
    expect(store.readDigest('task-1')).toBeNull()
  })

  it('无 source → 拒绝写入', () => {
    const io = memIO()
    const store = new DigestStore({ filePath: PATH, io })
    expect(store.writeDigest('task-1', emptyDigest('task-1', 'a'), '')).toBe(false)
  })

  it('非法 digest → 拒绝写入', () => {
    const io = memIO()
    const store = new DigestStore({ filePath: PATH, io })
    const bad = { ...emptyDigest('task-1', 'a'), schemaVersion: 999 } as never
    expect(store.writeDigest('task-1', bad, 'task-1:close')).toBe(false)
  })

  it('首次写入版本=1，二次写入版本=2（version 单调递增）', () => {
    const io = memIO()
    const store = new DigestStore({ filePath: PATH, io })
    expect(store.writeDigest('task-1', emptyDigest('task-1', 'a', 1), 'task-1:close')).toBe(true)
    expect(store.readDigest('task-1')?.version).toBe(1)
    expect(store.writeDigest('task-1', emptyDigest('task-1', 'a', 2), 'task-1:merge')).toBe(true)
    expect(store.readDigest('task-1')?.version).toBe(2)
    expect(store.readDigest('task-1')?.digest.createdAtMs).toBe(2)
  })

  it('mergeOnReopen=false 且已存在 → 拒绝', () => {
    const io = memIO()
    const store = new DigestStore({ filePath: PATH, io, mergeOnReopen: false })
    store.writeDigest('task-1', emptyDigest('task-1', 'a'), 'task-1:close')
    expect(store.writeDigest('task-1', emptyDigest('task-1', 'b'), 'task-1:reopen')).toBe(false)
  })

  it('落盘保留其它顶层键（preferences/mappings 不被覆盖）', () => {
    const prior = JSON.stringify({ schemaVersion: 1, preferences: { version: 7, items: [] } })
    const io = memIO({ [PATH]: prior })
    const store = new DigestStore({ filePath: PATH, io })
    store.writeDigest('task-1', emptyDigest('task-1', 'a'), 'task-1:close')
    const written = JSON.parse(io.files.get(PATH)!)
    expect(written.preferences.version).toBe(7)
    expect(written.taskSummaries.archived['task-1'].digest.taskId).toBe('task-1')
  })

  it('无效条目在 load 时被跳过（fail-lazy）', () => {
    const corrupt = JSON.stringify({
      schemaVersion: 1,
      taskSummaries: { version: 1, archived: { 'bad': { digest: { taskId: 'x' }, version: 1, source: 's' } } },
    })
    const io = memIO({ [PATH]: corrupt })
    const store = new DigestStore({ filePath: PATH, io })
    expect(store.readDigest('bad')).toBeNull()
  })

  it('schemaVersion 正确（KNOWLEDGE_SCHEMA_VERSION=1）', () => {
    const io = memIO()
    const store = new DigestStore({ filePath: PATH, io })
    store.writeDigest('task-1', emptyDigest('task-1', 'a'), 's')
    const written = JSON.parse(io.files.get(PATH)!)
    expect(written.schemaVersion).toBe(1)
    expect(written.taskSummaries.archived['task-1'].schemaVersion).toBe(DIGEST_SCHEMA_VERSION)
  })
})

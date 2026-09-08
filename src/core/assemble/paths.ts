/**
 * 路径压缩（F9e；docs/04 §2/§6）：root 解析 + 相对化 + 短 ID 表。
 * 纯函数：同输入同输出；**不猜**——不在 root 下的绝对路径原样保留。
 * 目标：档案产物中路径字节占比下降，同时保留准确定位能力（相对路径 + 首现序短 ID）。
 *
 * 模块: core 边界装配纯核（路径面）
 * 平面: L0（确定性字符串变换；零模型、零 IO）
 * 回退链步数: 0（坏形状 = 原样返回，绝不抛错）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D12）；不读盘、不写事实、不改史。
 * 度量: pathBytesSaved / pathTableEntries / rootKind 经 assemble-run 事实入账。
 */

export type RootKind = 'session' | 'cwd' | 'none'

/** 根目录归一化（反斜杠 → 正斜杠；去尾斜杠）；空/非串 = undefined。 */
export function normalizeRoot(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value.replaceAll('\\', '/').replace(/\/+$/, '')
}

/** 相对化：在 root 下 → 去前缀；否则原样（不猜）。 */
export function relativePath(path: string, root: string | undefined): string {
  const normalized = path.replaceAll('\\', '/')
  if (root === undefined || root === '') return normalized
  if (normalized === root) return '.'
  const prefix = root.endsWith('/') ? root : `${root}/`
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized
}

export interface PathTableEntry {
  readonly id: string
  readonly path: string
}

/** 短 ID 表：同路径出现 ≥2 次才入表（首现序编号 `§1`、`§2`…）。 */
export interface PathTable {
  readonly entries: readonly PathTableEntry[]
  readonly index: ReadonlyMap<string, string>
}

export const EMPTY_PATH_TABLE: PathTable = { entries: [], index: new Map() }

export function buildPathTable(paths: readonly string[], root: string | undefined): PathTable {
  const counts = new Map<string, number>()
  const order: string[] = []
  for (const raw of paths) {
    const rel = relativePath(raw, root)
    if (!counts.has(rel)) order.push(rel)
    counts.set(rel, (counts.get(rel) ?? 0) + 1)
  }
  const entries: PathTableEntry[] = []
  const index = new Map<string, string>()
  for (const rel of order) {
    if ((counts.get(rel) ?? 0) < 2) continue
    const id = `§${entries.length + 1}`
    entries.push({ id, path: rel })
    index.set(rel, id)
  }
  return { entries, index }
}

/** 指针里的路径引用：命中短 ID 表 → `§n`；否则相对路径。 */
export function pathRef(path: string, root: string | undefined, table: PathTable): string {
  const rel = relativePath(path, root)
  return table.index.get(rel) ?? rel
}

/** 路径表渲染（空表 = 空串；字节稳定）。 */
export function renderPathTable(table: PathTable): string {
  if (table.entries.length === 0) return ''
  return `【路径】\n${table.entries.map((entry) => `${entry.id} = ${entry.path}`).join('\n')}`
}

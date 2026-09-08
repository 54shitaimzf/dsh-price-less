/**
 * 路径相对化（F10；docs/04 §2）：root 解析 + 相对化。
 * 纯函数：同输入同输出；**不猜**——不在 root 下的绝对路径原样保留。
 * F10 起热尾指针改指档案（vN），产物内不再出现文件路径；本层只剩单元清单的相对化基准。
 *
 * 模块: core 边界装配纯核（路径面）
 * 平面: L0（确定性字符串变换；零模型、零 IO）
 * 回退链步数: 0（坏形状 = 原样返回，绝不抛错）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D12）；不读盘、不写事实、不改史。
 * 度量: rootKind 经 assemble-run 事实入账。
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

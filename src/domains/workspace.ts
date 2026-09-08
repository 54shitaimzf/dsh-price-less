/**
 * F3 工作区隔离（docs/09 §1 状态分层；docs/10 事件流）。
 * 单一键源：workspace = 会话 header.cwd（会话真实工作区），缺失才回落进程 cwd。
 * 禁止各域各自 process.cwd()——跨项目会话共用一个键会互相驱逐（真机 2026-09-09：resume 档案被本会话挤出）。
 *
 * 模块: domains 工作区解析（唯一 workspace 键源）
 * 平面: L0（确定性规则：读会话头 + 规范化）
 * 回退链步数: 0
 * 审查清单: 不改史、不写 KV、不发事实；零 IO（process.cwd 除外）
 * 度量: 键站点分布（07 存储族）
 */
export interface WorkspaceCarrier {
  readonly header?: { readonly cwd?: unknown }
}

export function normalizeWorkspace(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '')
}

/** 会话工作区根；header.cwd 缺失/空 → fallback（缺省 = 进程 cwd）。 */
export function workspaceOf(session: WorkspaceCarrier | undefined, fallback: string = process.cwd()): string {
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') return normalizeWorkspace(cwd)
  return normalizeWorkspace(fallback)
}
/**
 * T0 显式命令纯解析（docs/02 §3 决策链第 1 级；P12 与 P13 共用，不另写一套）。
 * core 零 harness/platform import；纯函数、不抛错。
 */
export interface T0Command {
  boundary: 'open' | 'close' | null
  description?: string
}

export function parseT0Command(text: string): T0Command {
  const trimmed = text.trim()
  if (trimmed === '/task close') return { boundary: 'close' }
  if (trimmed.startsWith('/task ')) {
    const description = trimmed.slice(6).trim()
    if (description.length > 0) return { boundary: 'open', description }
  }
  return { boundary: null }
}

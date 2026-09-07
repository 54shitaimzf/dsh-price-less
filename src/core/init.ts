/**
 * init 项目帧采集纯核（docs/02 §2 / docs/11 §2 core/init.ts）。
 * 纯函数：init prompt v1 渲染与 fail-lazy 解析；core 零 harness/platform import。
 */
export const INIT_PROMPT_VERSION = 1
export const INIT_PROMPT_HEAD = '你是项目帧采集器。请根据用户给出的项目目标，提炼项目最终目标并分解为若干可执行方面。'
export const INIT_PROMPT_OUTPUT = '输出（仅 JSON，无其他文本）：\n{"goal":"<原目标，可润色但不得改变意图>","aspects":["方面1","方面2"]}'

export interface InitProposal {
  goal: string
  aspects: string[]
}

export function clampInitGoal(goal: string, maxChars = 500): string {
  const trimmed = goal.trim()
  if (trimmed === '') return ''
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed
}

export function renderInitPrompt(goal: string): string {
  const clamped = clampInitGoal(goal)
  return `${INIT_PROMPT_HEAD}

<用户项目目标>
${clamped}

${INIT_PROMPT_OUTPUT}`
}

export function parseInitOutput(raw: string): InitProposal | null {
  let text = raw.trim()
  if (text.startsWith('```')) {
    const firstNewline = text.indexOf('\n')
    if (firstNewline === -1) return null
    text = text.slice(firstNewline + 1)
    if (text.endsWith('```')) text = text.slice(0, -3)
    text = text.trim()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.goal !== 'string') return null
  const goal = obj.goal.trim()
  if (goal === '' || goal.length > 500) return null
  if (!Array.isArray(obj.aspects)) return null

  const seen = new Set<string>()
  const aspects: string[] = []
  for (const item of obj.aspects) {
    if (typeof item !== 'string') return null
    const aspect = item.trim()
    if (aspect === '' || aspect.length > 80) return null
    if (!seen.has(aspect)) {
      seen.add(aspect)
      aspects.push(aspect)
    }
    if (aspects.length > 8) return null
  }
  return { goal, aspects }
}

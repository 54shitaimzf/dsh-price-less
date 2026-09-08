/**
 * 摘要事实泄漏扫描（F9；docs/04 §2）：gist/steps 应当零事实——路径/版本/数字/命令/引号文本/错误码
 * 全部由热尾承载。本模块只做**机械分类计数**：不删改、不改写、不拒单（事实泄漏 = 告警 + 入账，
 * 产物照常接受；重试由调用侧按 factLeakRetry 决定）。
 *
 * 模块: core 压缩调用纯核（事实泄漏扫描）
 * 平面: L0（确定性正则分类；零模型、零 IO）
 * 回退链步数: 0（纯计算，绝不抛错）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D13）；不读盘、不写事实、不改史。
 * 度量: factLeaks（compress-run / assemble-run 事实；07 压缩族摘要面）。
 */

export type FactKind = 'path' | 'version' | 'quote' | 'command' | 'code' | 'number'

export const FACT_KINDS: readonly FactKind[] = ['path', 'version', 'quote', 'command', 'code', 'number']

export interface FactLeak {
  readonly kind: FactKind
  /** 命中片段（截断到 40 字符；仅供审计，不参与字节稳定判定）。 */
  readonly sample: string
}

export interface FactLeakScan {
  readonly total: number
  readonly byKind: Readonly<Record<FactKind, number>>
  readonly leaks: readonly FactLeak[]
}

/**
 * 扫描顺序 = 优先级（先命中者占位，后续类别不再重复计数同一段字节）。
 * 路径最优先（最长、最可定位）；引号先于数字（引号内数字不重复计）。
 */
const PATTERNS: ReadonlyArray<{ readonly kind: FactKind; readonly re: RegExp }> = [
  {
    kind: 'path',
    re: /(?:[A-Za-z]:[\\/]|(?:^|[\s(（"'])(?:\.{0,2}\/)?[\w.@-]+\/[\w./@-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|py|rs|go|java|c|h|cpp|cs|sh|ps1|toml|ini|cfg|svg|css|html)\b)/gm,
  },
  {
    kind: 'version',
    re: /(?:@v\d+|\bv\d+(?:\.\d+)*\b|\b\d+\.\d+(?:\.\d+)?\b)/gi,
  },
  {
    kind: 'quote',
    re: /(?:"[^"\n]{2,}"|'[^'\n]{2,}'|“[^”\n]{2,}”|「[^」\n]{2,}」)/g,
  },
  {
    kind: 'command',
    re: /\b(?:npm|npx|node|pnpm|yarn|git|tsc|vitest|jest|pytest|cargo|make|bash|pwsh|powershell|python|pip|curl|docker|kubectl|ssh|scp|rsync)\b/g,
  },
  {
    kind: 'code',
    re: /\b[A-Z][A-Z0-9_]{3,}\b/g,
  },
  {
    kind: 'number',
    re: /\b\d{2,}\b/g,
  },
]

/** 机械扫描（同输入同输出；零抛错）。 */
export function scanFacts(text: string): FactLeakScan {
  const byKind: Record<FactKind, number> = { path: 0, version: 0, quote: 0, command: 0, code: 0, number: 0 }
  const leaks: FactLeak[] = []
  if (typeof text !== 'string' || text === '') return { total: 0, byKind, leaks }
  let work = text
  for (const { kind, re } of PATTERNS) {
    work = work.replace(re, (match) => {
      const sample = match.trim().slice(0, 40)
      if (sample !== '') {
        leaks.push({ kind, sample })
        byKind[kind]++
      }
      return ' '.repeat(match.length)
    })
  }
  return { total: leaks.length, byKind, leaks }
}

/** 扫描多段文本并合并（摘要 = gist + 各 step）。 */
export function scanFactTexts(texts: readonly string[]): FactLeakScan {
  const byKind: Record<FactKind, number> = { path: 0, version: 0, quote: 0, command: 0, code: 0, number: 0 }
  const leaks: FactLeak[] = []
  for (const text of texts) {
    const scan = scanFacts(text)
    leaks.push(...scan.leaks)
    for (const kind of FACT_KINDS) byKind[kind] += scan.byKind[kind]
  }
  return { total: leaks.length, byKind, leaks }
}

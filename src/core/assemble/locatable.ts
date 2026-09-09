/**
 * 热尾条目可定位性判定（①③ 落地；docs/04 §2 预算三环 + §6 路径面）。
 * 判定一条热尾内容能否**自证位置**：含路径 / 引号串 / 数字 / 版本 / 可辨识标识符时，
 * 模型可凭内容直接 grep 直达，无需显式定位；否则该条需要一个定位标注
 * （`path@vN:lines`，吃 `pointerOverheadTokens` 预留）。只判定，不删改、不拒单——
 * 事实保真优先（失败默认保留；丢一条事实比多花十几 token 贵得多）。
 *
 * 与 `core/compress/fact-leak.ts` 的分工：那是**泄漏告警**分类（总分里出现事实即计数，
 * 只记账）；本模块是**可搜索性**判定（这段内容能不能当 grep 键）。两者正则形似而目的相反，
 * 故各自持有，不共用表。
 *
 * 模块: core 边界装配纯核（可定位性判定）
 * 平面: L0（确定性正则；零模型、零 IO）
 * 回退链步数: 0（纯计算，绝不抛错）
 * 审查清单: 不 import harness/platform（S1）；无时钟随机（D12）；不读盘、不写事实、不改史。
 * 度量: hotTailLocated / hotTailUnlocated（assemble-run 事实 → 压缩族账本）。
 */

/** 命中类别（审计用；顺序 = 判定优先级）。 */
export type LocatableKind = 'path' | 'quote' | 'number' | 'version' | 'ident'

export interface LocatableScan {
  /** true = 内容自带可搜索键（无需定位标注）。 */
  readonly locatable: boolean
  /** 命中的类别（≤ 全部类别；供审计与用例断言）。 */
  readonly hits: readonly LocatableKind[]
}

/** 路径类（绝对盘符 / 相对目录 / 常见后缀文件名）。 */
const PATH_RE =
  /(?:[A-Za-z]:[\\/]|(?:^|[\s(（"'`])\.{0,2}\/[\w.@-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|py|rs|go|sh|ps1|toml|ini|cfg|css|html|svg|txt|typ)\b)/m
/** 引号串（半角/全角/反引号）。 */
const QUOTE_RE = /"[^"\n]{2,}"|'[^'\n]{2,}'|“[^”\n]{2,}”|「[^」\n]{2,}」|`[^`\n]{2,}`/
/** 长数字 / 小数（阈值/版本号的搜索键）。 */
const NUMBER_RE = /\b\d{4,}\b|\b\d+\.\d+\b/
/** 版本号（vN / vN.N.N）。 */
const VERSION_RE = /\bv\d+(?:\.\d+)*\b/i
/** ASCII 标识符候选。 */
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g

/** 普通英文词（return/function/string…）不是好搜索键；带形态标记或足够长才是。 */
function isDistinctiveIdentifier(token: string): boolean {
  if (token.length < 4) return false
  if (token.includes('_')) return true
  if (/[a-z][A-Z]/.test(token)) return true
  if (/[A-Za-z]\d|\d[A-Za-z]/.test(token)) return true
  if (/^[A-Z]{2,}$/.test(token)) return true
  return token.length >= 10
}

/**
 * 机械扫描（同输入同输出；零抛错）。命中顺序固定 = path → quote → number → version → ident，
 * 每类最多计一次（不数出现次数：本判定只回答"有没有"，不做评分）。
 */
export function scanLocatable(text: string): LocatableScan {
  if (typeof text !== 'string' || text === '') return { locatable: false, hits: [] }
  const hits: LocatableKind[] = []
  if (PATH_RE.test(text)) hits.push('path')
  if (QUOTE_RE.test(text)) hits.push('quote')
  if (NUMBER_RE.test(text)) hits.push('number')
  if (VERSION_RE.test(text)) hits.push('version')
  if (hits.length === 0) {
    for (const match of text.matchAll(IDENT_RE)) {
      if (isDistinctiveIdentifier(match[0])) {
        hits.push('ident')
        break
      }
    }
  }
  return { locatable: hits.length > 0, hits }
}

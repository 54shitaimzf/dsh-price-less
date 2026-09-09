/**
 * N1 工具结果可剪分类器（docs/implement/N1-identity-and-eligible.md §4；docs/03 §2 内容闸门）。
 * 两阶段收敛：① 身份（DSH 工具签名 kind/card，硬证据）→ ② 结果形态（副作用/截断/错误/语料四类否决）。
 * 输出带证据等级 basis：signature（工具自声明）> name（工具名白名单）> command（命令串拆段）> none（兜底）。
 * N 系列协商线（N2 结论契约 / N3 影子模式）已退役（docs/legacy.md §9）；本分类器只服务写时确定性剪除的候选普查。
 *
 * 模块: core 纯核（零 harness/platform import；判定全在纯函数内）
 * 平面: L0（确定性规则：正则 + 表驱动；无模型、无 IO、无时钟、无随机）
 * 回退链步数: 0（本模块只给判定；失败语义 = 未知一律 never，由调用方直接采用）
 * 审查清单: 不 import harness/platform（S1）；无 Date/Math.random（D10）；不改史、不发事实
 * 度量: 判定结果由 domains 侧入账（verdict/basis/reason 三元组）
 */

import { utf8ByteLength } from './tool.ts'

/** 最终判定：只有可剪 / 永不剪两档（`needs-result` 是身份阶段标签，形态阶段收敛）。 */
export type CutVerdict = 'cuttable' | 'never'
/** 证据等级（工单 §4.3）。 */
export type CutBasis = 'signature' | 'name' | 'command' | 'none'
/** 定音阶段：identity = 身份直接定；shape = 形态阶段定。 */
export type CutStage = 'identity' | 'shape'
/** 命中判据（可审计，进账本）。 */
export const CUT_REASON = {
  TOO_SMALL: 'too-small',
  WRITE_HISTORY: 'write-history',
  FILE_FACT: 'file-fact',
  EXTERNAL_FACT: 'external-fact',
  SEARCH_FACT: 'search-fact',
  SIDE_EFFECT: 'side-effect',
  TRUNCATED: 'truncated',
  ERROR_OUTPUT: 'error-output',
  CORPUS: 'corpus',
  CONCLUSION: 'conclusion',
  UNKNOWN: 'unknown',
} as const
export type CutReason = (typeof CUT_REASON)[keyof typeof CUT_REASON]

/** 纯描述符：平台只供字段（args = 解析后调用参数；meta = result.meta；kind/card = presentCall）。 */
export interface ToolDescriptor {
  readonly name: string
  readonly kind?: string
  readonly card?: string
  readonly args?: unknown
  readonly meta?: unknown
  readonly resultText: string
  /** UTF-8 字节数；缺省时纯核自算（等价）。 */
  readonly resultBytes?: number
  readonly isError?: boolean
}

export interface CutDecision {
  readonly verdict: CutVerdict
  readonly stage: CutStage
  readonly basis: CutBasis
  readonly reason: CutReason
}

/** 候选下限：低于此体积剪了没收益（工单 §4.1 行 0）。 */
export const CUT_CANDIDATE_MIN_BYTES = 2048
/** 名字白名单（工单 §4.1 行 6；身份通道认不出但载荷是程序化输出）。 */
export const CUT_NAME_WHITELIST: readonly string[] = ['run_code', 'job_output', 'subagent']

const WRITE_KINDS = new Set(['edit', 'delete', 'move'])

/** 命令串副作用迹象（terminal；工单 §4.2 行 1）。 */
const SHELL_SIDE_EFFECT: readonly RegExp[] = [
  /\bgit\s+(?:commit|push|reset|checkout|clean|merge|rebase|tag|stash|apply|am|init|rm|mv)\b/,
  /(?:^|[;&|]\s*|\s)(?:rm|rmdir|del|erase|mv|move|cp|copy|mkdir|md|touch|truncate|chmod|chown|ln|mklink|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item)\b/,
  /(?:^|[\s;&|])\d?>>?(?!=)\s*[^\s|&;]/,
  /\b(?:Set-Content|Add-Content|Out-File|Tee-Object|Clear-Content)\b/,
  /\b(?:npm|pnpm|yarn)\s+(?:install|i|add|remove|uninstall|publish|link|ci|update|upgrade|prune)\b/,
  /\b(?:pip|pip3|conda|poetry|uv)\s+(?:install|uninstall|add|remove)\b/,
  /\b(?:docker|kubectl|helm|terraform|systemctl|service)\b/,
  /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data\b|--upload-file|-T\s|--method\s*(?:POST|PUT|PATCH|DELETE))/i,
]
/** 程序源码副作用迹象（run_code；工单 §4.2 行 1）。 */
const CODE_SIDE_EFFECT: readonly RegExp[] = [
  /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|rmSync|rmdirSync|unlinkSync|unlink|renameSync|rename|mkdirSync|mkdir|copyFileSync|copyFile|truncateSync|chmodSync|chownSync)\s*\(/,
  /\b(?:execSync|spawnSync|execFileSync|execFile|spawn)\s*\(/,
  /\bchild_process\b/,
  /\bgit\s+(?:commit|push|reset|checkout|clean|merge|rebase|tag|stash|apply|am|init|rm|mv)\b/,
  /\bfetch\s*\(/,
  /\b(?:axios|undici|http\.request|https\.request)\b/,
  /\b(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item)\b/,
  /\b(?:Deno\.writeTextFile|Deno\.remove|Bun\.write)\b/,
]
/** 命令本身截断输出（head/tail/wc；工单 §4.2 行 2）。 */
const SHELL_TRUNCATE: readonly RegExp[] = [/(?:^|[;&|]\s*|\s)(?:head|tail|wc)\b/]
/** 结果自带截断标记（工单 §4.2 行 2）。 */
const RESULT_TRUNCATE: readonly RegExp[] = [
  /\[truncated\]/i, /\(truncated\)/i, /\btruncated at\b/i, /\.\.\.\s*truncated/i,
  /输出已截断/, /全文(?:已)?落盘/, /\.dsh[\\/]spill/,
]
/** 错误 / 失败诊断（工单 §4.2 行 3）。 */
const RESULT_FAILURE: readonly RegExp[] = [
  /\b(?:Error|ERROR|error):\s/,
  /\b(?:Traceback \(most recent call last\)|panic:|fatal:|FATAL ERROR)\b/,
  /\b(?:AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|ValueError|KeyError|IndexError|NullPointerException|Segmentation fault)\b/,
  /\b(?:[1-9]\d*)\s+(?:failed|failures?|errors?)\b/i,
  /\bFAIL(?:ED|URES?)?\b/,
  /\bexit\s*code["'\s:=]+[1-9]/i,
  /"exitCode"\s*:\s*[1-9]/,
  /✗|✘/,
  /\bnot ok\b/i,
]
/** 代码 / 语料迹象（工单 §4.2 行 4）。 */
const CORPUS_LINE = /^\s*(?:\d+\t|\d+\s\|\s)?\s*(?:import|export|from|const|let|var|function|class|interface|enum|type|def|return|public|private|protected|package|#include|using)\b/

function decide(verdict: CutVerdict, stage: CutStage, basis: CutBasis, reason: CutReason): CutDecision {
  return { verdict, stage, basis, reason }
}

function argString(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/** 副作用扫描源：terminal 取 command，run_code 取 code，其余（job_output/subagent）无源。 */
function sourceOf(desc: ToolDescriptor): { text: string; code: boolean } | undefined {
  if (desc.name === 'run_code') {
    const code = argString(desc.args, 'code')
    return code === undefined ? undefined : { text: code, code: true }
  }
  if (desc.card === 'terminal') {
    const command = argString(desc.args, 'command')
    return command === undefined ? undefined : { text: command, code: false }
  }
  return undefined
}

function anyMatch(patterns: readonly RegExp[], text: string): boolean {
  for (const re of patterns) if (re.test(text)) return true
  return false
}

function looksLikeCorpus(text: string): boolean {
  if (text.includes('```')) return true
  let numbered = 0
  let code = 0
  for (const line of text.split('\n')) {
    if (/^\s*\d+\t/.test(line)) numbered++
    else if (CORPUS_LINE.test(line)) code++
  }
  return numbered >= 5 || code >= 8
}

/** 形态阶段：先看副作用/截断（源与结果两侧），再看错误诊断，最后看语料，全不过 → 结论型可剪。 */
function shapeStage(desc: ToolDescriptor, basis: CutBasis): CutDecision {
  const source = sourceOf(desc)
  // 需要命令/程序源才能判副作用的两类：源读不到 → 不猜（失败默认保留）。
  if (source === undefined && (desc.card === 'terminal' || desc.name === 'run_code')) {
    return decide('never', 'shape', basis, CUT_REASON.UNKNOWN)
  }
  if (source !== undefined) {
    const patterns = source.code ? CODE_SIDE_EFFECT : SHELL_SIDE_EFFECT
    if (anyMatch(patterns, source.text)) return decide('never', 'shape', basis, CUT_REASON.SIDE_EFFECT)
    if (!source.code && anyMatch(SHELL_TRUNCATE, source.text)) return decide('never', 'shape', basis, CUT_REASON.TRUNCATED)
  }
  if (anyMatch(RESULT_TRUNCATE, desc.resultText)) return decide('never', 'shape', basis, CUT_REASON.TRUNCATED)
  if (desc.isError === true || anyMatch(RESULT_FAILURE, desc.resultText)) return decide('never', 'shape', basis, CUT_REASON.ERROR_OUTPUT)
  if (looksLikeCorpus(desc.resultText)) return decide('never', 'shape', basis, CUT_REASON.CORPUS)
  return decide('cuttable', 'shape', basis, CUT_REASON.CONCLUSION)
}

/**
 * 分类入口：按工单 §4.1 决策序列先定身份，`needs-result` 再进形态阶段。
 * 任何字段缺失 / 认不出 / 异常形状一律 `never` + `basis:'none'`（失败默认保留）。
 */
export function classifyToolResult(desc: ToolDescriptor): CutDecision {
  const bytes = desc.resultBytes ?? utf8ByteLength(desc.resultText)
  if (bytes < CUT_CANDIDATE_MIN_BYTES) return decide('never', 'identity', 'none', CUT_REASON.TOO_SMALL)

  const { name, kind, card } = desc
  if (card === 'diff' || (kind !== undefined && WRITE_KINDS.has(kind))) {
    return decide('never', 'identity', 'signature', CUT_REASON.WRITE_HISTORY)
  }
  if ((kind === 'read' || card === 'read') && name !== 'job_output') {
    return decide('never', 'identity', 'signature', CUT_REASON.FILE_FACT)
  }
  if (card === 'web' || kind === 'fetch') return decide('never', 'identity', 'signature', CUT_REASON.EXTERNAL_FACT)
  if (card === 'search' || kind === 'search') return decide('never', 'identity', 'signature', CUT_REASON.SEARCH_FACT)

  if (card === 'terminal') return shapeStage(desc, 'command')
  if (CUT_NAME_WHITELIST.includes(name)) return shapeStage(desc, 'name')
  return decide('never', 'identity', 'none', CUT_REASON.UNKNOWN)
}

/**
 * 边界装配器词汇与策略初值（docs/04 §2/§5/§6；docs/11 §2 core/assemble 行；P17a）。
 * 纯数据契约：坐标层（文件坐标 / 历史 span）、事实层（类型化摘要）、热尾计划与预算策略。
 * 模型只产坐标与排序（选坐标不造坐标），计量/裁剪/取真全在本层机械完成。
 *
 * 模块: core 边界装配纯核（词汇面）
 * 平面: L0（确定性机械装配；零模型参与）
 * 回退链步数: 0（失败语义在 assemble.ts：一律降级不 fatal，失败默认保留）
 * 审查清单: 不 import harness/platform（S1）；不写 KV/日志/事实；不改史；无时钟随机（D12）。
 * 度量: 阈值初值集中于此（docs/04 §2 预算三环 / §5 标定 / §6 硬帽）。
 */
import { DEFAULT_TOKEN_DENSITY, type TokenDensity } from '../meter/estimate.ts'

/** 策略版本（阈值口径可复现；docs/03 §4 同哲学）。 */
export const ASSEMBLE_POLICY_VERSION = 1

/** 1-based 闭区间行号（原生 read 信封口径）。 */
export interface LineRange {
  readonly start: number
  readonly end: number
}

/** 通道 A 坐标：文件坐标（vN = 模型见过的版本；补丁链重映射后盘上取真）。 */
export interface FileCoord {
  readonly path: string
  readonly version: number
  /** 省略 = 整文件。 */
  readonly lineRange?: LineRange
}

/** 通道 B 坐标：历史 span（单元 ID 区间；append-only 账本切片即精确真值）。 */
export interface SpanCoord {
  readonly unitId: string
}

/** 热尾申报项（模型按重要性降序申报；禁止预算计算）。 */
export interface HotTailDecl {
  readonly unitId: string
  /** 文件类单元可带文件坐标（通道 A）；省略 = 通道 B 取单元原文。 */
  readonly coord?: FileCoord
}

/** 类型化摘要信息块（plan/impl/verify/wrap；impl 用坐标指针不嵌代码）。 */
export type DigestBlockType = 'plan' | 'impl' | 'verify' | 'wrap'
export const DIGEST_BLOCK_ORDER: readonly DigestBlockType[] = ['plan', 'impl', 'verify', 'wrap']

export interface DigestBlock {
  readonly type: DigestBlockType
  readonly text: string
}

/** 坐标层条目（事实层冻结时的文件/符号/行区间；后续漂移由重映射吸收）。 */
export interface DigestCoord {
  readonly path: string
  readonly version: number
  readonly lineRange?: LineRange
  readonly symbol?: string
}

/** 一条边界档案的装配输入（P18 产出的已解析申报；本层只消费）。 */
export interface TaskDigest {
  readonly blocks: readonly DigestBlock[]
  readonly coords: readonly DigestCoord[]
}

/** 档案条目种类：C = 压力检查点（未完成边界），D = 边界追加块（闭合）。 */
export type ArchiveKind = 'checkpoint' | 'boundary'

/** 档案条目（一条 = 一个 task 的归档块；追加式，字节一经写出不可变）。 */
export interface ArchiveEntry {
  readonly taskId: string
  readonly kind: ArchiveKind
  readonly text: string
}

/** 档案区硬帽截断计数（07 压缩族 `archiveTruncate{count,tokens}`）。 */
export interface ArchiveTruncation {
  readonly count: number
  readonly tokens: number
}

/** 档案形态（04 §3 机制 A：单块总摘要 / [C…][D] 追加式链）。 */
export interface ArchiveForm {
  readonly form: 'single' | 'chain'
  readonly checkpointCount: number
}

/** 压缩层（生产/消费不对称律：边界产热尾模式、压力产检查点+末段子任务）。 */
export type AssembleLayer = 'boundary' | 'pressure'

/** 装配单元（tool 对 = 一个单元，配对永不拆分；message 单元无 callId）。 */
export interface AssembleUnit {
  readonly id: string
  readonly kind: 'tool-pair' | 'message'
  readonly seqStart: number
  readonly seqEnd: number
  readonly name?: string
  readonly path?: string
  readonly version?: number
  /** 单元原文（通道 B 取真面；工具对 = 结果文本，message = 消息文本）。 */
  readonly text: string
  readonly tokens: number
  /** run/命令类结果（地板填充的类目判据）。 */
  readonly isRunResult?: boolean
  /** 验证类结果（末次验证尾的地板来源）。 */
  readonly isVerification?: boolean
  /** 失败/错误结果（错误行地板来源）。 */
  readonly isError?: boolean
}

/** 热尾选中项（tier = 申报 / 地板；source = 盘上取真 / 账本取真）。 */
export interface HotTailSelection {
  readonly unitId: string
  readonly tier: 'model' | 'floor' | 'fallback'
  readonly seqStart: number
  readonly seqEnd: number
  readonly source: 'file' | 'span'
  readonly coord?: FileCoord
  readonly text: string
  readonly tokens: number
  /** 单单元超帽尾截断（可见标记已并入 text）。 */
  readonly truncated?: boolean
  /** 重映射出界裁剪（clipped）标记。 */
  readonly clipped?: boolean
}

export type HotTailStopReason = 'budget' | 'list-end'

/** 丢弃归因（HT 软门 / 重映射 / 取真；总数 = HotTailPlan.dropped）。 */
export type HotTailDropReason = 'badDecl' | 'unknownUnit' | 'remap' | 'fetch'
export interface HotTailDropCounts {
  readonly badDecl: number
  readonly unknownUnit: number
  readonly remap: number
  readonly fetch: number
}
export type HotTailSource = 'model' | 'positional-fallback'

export interface HotTailPlan {
  readonly selections: readonly HotTailSelection[]
  readonly stopReason: HotTailStopReason
  readonly source: HotTailSource
  readonly floorFilled: boolean
  /** 申报条数（模型产出侧规模；地板项不计）。 */
  readonly declaredUnits: number
  /** 坐标无效 / 单元缺失 / 取真缺失丢弃总数（= dropReasons 之和）。 */
  readonly dropped: number
  /** 丢弃归因（P17c：HT 软门 / 重映射 / 取真）。 */
  readonly dropReasons: HotTailDropCounts
  /** 出界裁剪数。 */
  readonly clipped: number
  readonly truncated: number
  readonly tokens: number
  readonly budgetTokens: number
}

/** 装配产物（事实层 + 坐标层 + 热尾；注入与档案 vN 归 P19）。 */
export interface AssembleResult {
  readonly layer: AssembleLayer
  readonly digest: TaskDigest
  readonly digestBytes: number
  readonly digestEntryCount: number
  readonly hotTail: HotTailPlan
  /** 本次产物的档案形态（priorChain 为空 = 单块；否则续传 + 追加）。 */
  readonly archiveForm: ArchiveForm
  readonly unitCount: number
  /** 事实层 + 热尾（装配序 = transcript 序，字节稳定）。 */
  readonly rendered: string
}

/** 装配结果信封：schema 违例 = fatal（三环口径），其余一律降级。 */
export type AssembleOutcome =
  | { readonly ok: true; readonly result: AssembleResult }
  | { readonly ok: false; readonly reason: 'digest-schema' | 'no-units' }

/** 装配策略（docs/04 §2 预算三环 + §5 标定 + §6 硬帽；绝对设计值，比例派生只作 fallback）。 */
export interface AssemblePolicy {
  readonly version: number
  /** 热尾预算（= retainTokens 绝对设计值 10K）。 */
  readonly hotTailTokens: number
  /** 档案区硬帽（04 §6 绝对设计值 15K；超限从最老档案条目起整条机械截断）。 */
  readonly archiveTokens: number
  /** 字符密度（04 §5：两桶标定 CJK 1.5 / 其余 2.9；与压缩器同源）。 */
  readonly density: TokenDensity
  /** 地板：逐字末次验证 ≤3 条。 */
  readonly floorVerifyLines: number
  /** 地板：逐字失败/错误行 ≤5 条。 */
  readonly floorErrorLines: number
  /** 单次装配最多向端口请求的坐标数（防御申报洪泛）。 */
  readonly maxFetchUnits: number
  /** 单单元超帽尾截断时保留的头部字符数下限（保证非空可读）。 */
  readonly minTruncatedChars: number
}

export const DEFAULT_ASSEMBLE_POLICY: AssemblePolicy = {
  version: ASSEMBLE_POLICY_VERSION,
  hotTailTokens: 10000,
  archiveTokens: 15000,
  density: DEFAULT_TOKEN_DENSITY,
  floorVerifyLines: 3,
  floorErrorLines: 5,
  maxFetchUnits: 64,
  minTruncatedChars: 200,
}

/** 尾截断可见标记（中性叙述；热尾是缓存，标记只为可审计）。 */
export const HOT_TAIL_TRUNCATION_MARKER = '…（此处按装配预算截断）'

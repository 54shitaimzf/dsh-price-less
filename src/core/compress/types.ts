/**
 * 压缩调用词汇与策略初值（docs/04 §2/§3/§5/§6；docs/11 §2 core/compress 行；P18）。
 * 纯数据契约：两模式产物（边界 = 类型化摘要 + 热尾申报；压力 = 进行时检查点 + 缝）、
 * prompt 渲染信封、共享消费语义（机制 A 续传 / 机制 B 折叠）。
 * 模型只做识别与排序（选坐标不造坐标）；计量、裁剪、取真全部由装配层机械完成。
 *
 * 模块: core 压缩调用纯核（词汇面）
 * 平面: L0（确定性机械组装/校验；零模型参与、零 IO）
 * 回退链步数: 0（失败语义在 product.ts：仅解析/schema fatal，其余降级不 fatal）
 * 审查清单: 不 import harness/platform（S1）；不写 KV/日志/事实；不改史；无时钟随机（D13）。
 * 度量: 版本号与策略初值集中于此（07 压缩族 compressionCall* 口径见 ledger.ts）。
 */
import type {
  ArchiveEntry,
  AssembleUnit,
  HotTailDecl,
  HotTailDropCounts,
  TaskDigest,
} from '../assemble/types.ts'
import { DEFAULT_TOKEN_DENSITY, type TokenDensity } from '../meter/estimate.ts'

/** prompt 模板版本（改模板必须升版本：产物 schema 与模板同版演进）。U15：3→4（unitId 抄写纪律）。 */
export const COMPRESS_PROMPT_VERSION = 4

/** 调用策略版本（计量口径可复现；同 docs/03 §4 哲学）。 */
export const COMPRESS_POLICY_VERSION = 3

/** 压缩层 = 生产签名（边界产热尾、压力产检查点 + 末段子任务；04 §3）。 */
export type CompressMode = 'boundary' | 'pressure'

export interface CompressPolicy {
  readonly version: number
  /** 字符密度（04 §5；与装配器同源，两桶标定）。 */
  readonly density: TokenDensity
  /** 单元清单最多列出条数；0 = 不限（正典行为）。超限保留**最近**单元 + 计数。 */
  readonly maxUnitListEntries: number
}

export const DEFAULT_COMPRESS_POLICY: CompressPolicy = {
  version: COMPRESS_POLICY_VERSION,
  density: DEFAULT_TOKEN_DENSITY,
  maxUnitListEntries: 0,
}

/** 进行时检查点（压力模式产物①；受众 = 当前任务的自己，不宣称最终事实）。 */
export interface CompressCheckpoint {
  readonly progress: string
  readonly currentState: string
  readonly nextStep: string
  readonly liveConstraints: readonly string[]
}

/** 缝（压力模式产物②）：最后一个子任务的起点 = 单元边界（不切工具对）。 */
export interface CutPointDecl {
  readonly unitId: string
}

/** 边界产物：类型化摘要（事实层 + 坐标层）+ 热尾申报（边界压缩器专属）。 */
export interface BoundaryProduct {
  readonly mode: 'boundary'
  readonly digest: TaskDigest
  readonly hotTail: readonly HotTailDecl[]
}

/** 压力产物：进行时检查点 + 缝。 */
export interface PressureProduct {
  readonly mode: 'pressure'
  readonly checkpoint: CompressCheckpoint
  readonly cutPoint: CutPointDecl
}

export type CompressProduct = BoundaryProduct | PressureProduct

/** 一次压缩调用的账本口径（07 压缩族 compressionCall*；生产者 = P19/P20a）。 */
export type CompressOutcome = 'ok' | 'parse' | 'schema' | 'skipped'

/** 产物解析结果：仅解析失败 / schema 违例 = fatal（04 §2 三环口径）。 */
export type CompressParseResult =
  | {
      readonly ok: true
      readonly product: CompressProduct
      /** 热尾申报降级计数（remap/fetch 为运行时归因，本层恒 0）。 */
      readonly dropped: HotTailDropCounts
    }
  | { readonly ok: false; readonly reason: 'parse' | 'schema' }

export interface CompressPromptInput {
  /** 闭合段（边界）/ 折叠区（压力）全量逐字节原文（本层不截断）。 */
  readonly regionText: string
  readonly units: readonly AssembleUnit[]
  /** 已归档检查点链（机制 A 续传面；只接受 empty/prefix/single/chain 形态）。 */
  readonly priorChain?: readonly ArchiveEntry[]
  /** 渲染根（单元清单路径相对化基准）。 */
  readonly root?: string
  readonly policy?: CompressPolicy
}

export interface CompressPromptRender {
  readonly mode: CompressMode
  readonly version: number
  readonly prompt: string
  /** 区域体量（机械计量，仅入事实轨；不进模型视野）。 */
  readonly regionTokens: number
  readonly unitCount: number
  readonly listedUnits: number
  readonly omittedUnits: number
  readonly priorChainCount: number
}

/** 尾部块种类：checkpoint/boundary = 摘要块（续传）；material = 热尾材料块（折叠）。 */
export type TailBlockKind = 'checkpoint' | 'boundary' | 'material'
export type TailConsumeOp = 'continue' | 'fold'

export interface TailConsumption {
  readonly kind: TailBlockKind
  readonly op: TailConsumeOp
  /** 语义依据（04 §3 机制 A/B）。 */
  readonly reason: 'stub-immutable' | 'cache-not-archive'
}

/** 四触发次序闭合表（04 §3 生产/消费不对称律；端到端交错验收归 P21b）。 */
export type TailPlanOutcome =
  | {
      readonly ok: true
      readonly form: 'single' | 'chain'
      readonly carryCount: number
      readonly appendKind: 'boundary' | 'checkpoint'
      readonly foldMaterial: boolean
    }
  | { readonly ok: false; readonly reason: 'chain-invalid' }

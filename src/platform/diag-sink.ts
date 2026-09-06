/**
 * 诊断落盘 sink（docs/11 §2 diag-sink.ts 行 + §4 纪律③追记；P1.1 工单）——named logger
 * `context-economy` 经 cordis 公开导出面 `ctx.logger.exporter()` 落盘 JSONL：
 * <插件根>/logs/context-economy.log（agent 自审入口：Read/grep 即审，零 harness 改动），
 * 与 ignorable 通道（docs/12 §2 可删除单元）互不引用——两单元可独立整删。
 * 模块: platform 诊断导出（唯一 harness 触点层）；平面: L0（公开 API 注册 + 确定性文件追加，
 * 无模型，永不进模型视野——带外）；回退链步数: 1（失败默认保留——能力缺失静默跳过，
 * 建目录/追加失败单次告警后停用）；度量: 无 07 字段（诊断面，非账本面）。审查清单: 零 cordis
 * 运行时 import（类型 type-only，src 不变量）；无 timer（S5）；不出现写侧归口调用形态（S2）；
 * 无 'context-economy/' 字面量（S3）；注销经本插件 fiber effect 承接 exporter() 的 disposer
 * （内建 disposer 挂根 fiber，卸载即净靠本层，11 §1 入口铁律）。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, Exporter, Message } from '@deepseek-ai/cordis'

const DIAG_NAME = 'context-economy'; const DIAG_FILE = 'context-economy.log'
const CAP_BYTES = 2 << 20 // 单文件 2 MiB 封顶，滚动保留 1 份 .log.1
const DEBUG_LEVEL = 3 // cordis LoggerLevel.DEBUG（const enum 不可运行时 import，字面钉值）

let warnDisabled = false
function warnOnce(msg: string, err: unknown): void {
  if (warnDisabled) return
  warnDisabled = true
  console.error(`[context-economy] diag sink disabled: ${msg}`, err instanceof Error ? err.message : err)
}

/** 测试钩子：重置「单次告警后停用」旗标（命名惯例同 ignorable 单元的 probe 重置钩子）。 */
export function resetDiagSinkWarnOnce(): void { warnDisabled = false }

/** 日志目录：opts.dir > 环境变量 CE_DIAG_DIR > <插件根>/logs（插件根 = 本文件上两级：src|lib/platform → 根）。 */
export function resolveDiagDir(explicit?: string): string {
  if (explicit) return explicit
  if (process.env.CE_DIAG_DIR) return process.env.CE_DIAG_DIR
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'logs')
}

/** cordis Logger.format 本地最小复刻（决策点②）：%s%d%i%f%o%O 占位 + Error 首参 stack + 尾参拼接。 */
function formatArgs(args: unknown[]): string {
  const rest = args.slice()
  const first = rest.shift()
  let out: string
  if (first instanceof Error) {
    out = first.stack || first.message
  } else if (typeof first === 'string') {
    out = first.replace(/%[sdifOo]/g, (tag) => {
      const v = rest.shift()
      if (v === undefined) return tag
      if (tag === '%s') return String(v)
      if (tag === '%o' || tag === '%O') return typeof v === 'object' && v ? JSON.stringify(v) : String(v)
      return String(Number(v))
    })
  } else {
    out = typeof first === 'object' && first ? JSON.stringify(first) : String(first)
  }
  for (const a of rest) out += ' ' + ((typeof a === 'object' && a) ? JSON.stringify(a) : String(a))
  return out
}

/** 一条 Message → 一行 JSONL（四字段冻结：ts/level/name/msg；P1.1 工单决策点⑦）。 */
function toLine(m: Message): string {
  return JSON.stringify({ ts: new Date(m.ts).toISOString(), level: m.type, name: m.name, msg: formatArgs(m.args) })
}

/** 挂载诊断落盘（apply 调一次）：named 过滤 + DEBUG 全档声明（门在 cordis 读取）→ 同步逐行
 *  追加、封顶滚动；能力缺失（无 ctx.effect / logger.exporter，测试替身形态）→ 静默 undefined；
 *  目录创建/追加失败 → 单次 console.error 后永久停用。永不抛出。 */
export function attachDiagSink(ctx: Context, opts: { dir?: string; capBytes?: number } = {}): { path: string } | undefined {
  const service = ctx.logger as unknown as { exporter?: (ex: Exporter) => () => void } | undefined
  if (typeof ctx.effect !== 'function' || typeof service?.exporter !== 'function') return undefined
  const dir = resolveDiagDir(opts.dir)
  const file = join(dir, DIAG_FILE)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    warnOnce(`cannot create log directory ${dir}`, err)
    return undefined
  }
  const cap = opts.capBytes ?? CAP_BYTES
  const exporter: Exporter = {
    colors: false,
    levels: { default: DEBUG_LEVEL },
    export: (message) => {
      if (warnDisabled || message.name !== DIAG_NAME) return
      try {
        if (statSync(file).size >= cap) renameSync(file, `${file}.1`)
      } catch { /* 文件尚不存在（首写）→ 直接追加 */ }
      try {
        appendFileSync(file, `${toLine(message)}\n`)
      } catch (err) {
        warnOnce(`append failed ${file}`, err)
      }
    },
  }
  ctx.effect(() => service.exporter!(exporter))
  return { path: file }
}

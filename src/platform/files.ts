/**
 * H15 盘上取真端口（docs/04 §2 通道 A；docs/10 §1 H15；docs/11 §2 platform/files.ts 行；P17b）。
 * **唯一磁盘读取触点**：ctx.fs resolve/stat/readText → 行窗口。文件坐标经版本重映射后在此取
 * 当前字节（含本会话已落盘编辑——上下文副本是历史快照，从上下文取 = 复活旧版本）。
 * 失败语义：服务缺失 / 文件不存在 / 读失败 → `null` + warn，零重试（失败默认保留）。
 *
 * 模块: platform 文件端口（唯一 harness 触点层）
 * 平面: L0（确定性 IO 封装；无模型、无机制逻辑）
 * 回退链步数: 1（读不到 → null，调用方丢弃坐标 + 计数）
 * 审查清单: 不 import core（端口类型本地声明）；不改史、不写 KV；不解释 harness 不透明 FsVersion；
 *           fs 概念只在本文件（D11 断言锁定）。
 * 度量: 无 07 字段（取真失败计数由装配域汇总进 assemble-run 事实）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'

export interface FileLines {
  /** 请求窗口内的文本行（1-based 闭区间切片）。 */
  readonly lines: readonly string[]
  /** 盘上当前总行数。 */
  readonly totalLines: number
}

export interface FilesPort {
  /** 读盘上当前文件的行窗口；文件不存在 / 不可读 → null。省略 range = 整文件。 */
  readLines(path: string, range?: { start: number; end: number }): Promise<FileLines | null>
}

export interface FilesPortOptions {
  /** 相对路径解析基准（缺省 = 后端默认 cwd）。 */
  cwd?: string
  /** 单文件读取字节帽（防御超大盘上文件；超帽 = null）。 */
  maxBytes?: number
  logger?: { warn: (...args: unknown[]) => void }
}

export const FILES_MAX_BYTES = 2 * 1024 * 1024

/** 行切分（尾部换行不产生空行；空文件 = 0 行）。 */
export function splitFileLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 创建盘上取真端口；`ctx.get('fs')` 缺失（服务未挂/降级）→ undefined（调用方按通道 A 降级处理）。
 */
export function createFilesPort(ctx: Pick<Context, 'get'>, options: FilesPortOptions = {}): FilesPort | undefined {
  const fs = ctx.get('fs') as FileSystem | undefined
  if (fs === undefined) return undefined
  const maxBytes = options.maxBytes ?? FILES_MAX_BYTES
  const warn = (message: string, detail: unknown): void => {
    options.logger?.warn('context-economy: file read degraded (contained, fail-lazy)', message, detail instanceof Error ? detail.message : String(detail))
  }

  const readLines = async (path: string, range?: { start: number; end: number }): Promise<FileLines | null> => {
    try {
      const target = await fs.resolve(path, options.cwd === undefined ? undefined : { cwd: options.cwd })
      const info = await fs.stat(target)
      if (info === undefined || info.type !== 'file') return null
      if (info.size !== undefined && info.size > maxBytes) { warn('size cap', path); return null }
      const text = await fs.readText(target)
      const lines = splitFileLines(text)
      const totalLines = lines.length
      if (range === undefined) return { lines, totalLines }
      const start = Math.max(1, range.start)
      const end = Math.min(totalLines, range.end)
      if (start > totalLines || end < start) return null
      return { lines: lines.slice(start - 1, end), totalLines }
    } catch (e) {
      warn(path, e)
      return null
    }
  }

  return { readLines }
}

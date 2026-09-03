/**
 * mech_replay 共用层：语料加载 + 规范化（确定性）。
 *
 * 两个来源统一到同一 canonical 会话模型：
 *  - claudeset（英文，turn/exchange 结构，无 DSH 事件）
 *  - 本地 DSH 归档（zstd 多帧 JSONL 事件流；node zlib 流式只解首帧 → execFile('zstd','-d','-c')）
 *
 * Canonical session:
 *  {
 *    id, corpus: 'claudeset'|'dsh', single: bool, proj?: string,
 *    us: [{ u, text, tools: [{name, dir, file}], todos: [{content,status}], flowPos }],   // U 空间
 *    flow: [{ role: 'user'|'assistant', text, u? }],          // 消息流（孤儿/锚点分析用）
 *    gt: { coarse: [u...] },                                   // U 空间翻转起点
 *  }
 *
 * 口径声明（probe19 生成脚本未入库，不可复刻；本管线显式定义）：
 *  - 工具名归一化小写（claudeset: Read→read、TodoWrite→todo；DSH 本已小写）。
 *  - filePathInfo 只认 file 工具（read/edit/write/glob/grep/ls/read_image 小写）。
 *  - U 空间（DSH）= 全部 append user/message 事件序数（任意 source kind，与生产 fold 所见一致）；
 *    claudeset = 带 user 文本的 exchange 序数。
 *  - GT seq→U（local-dsh legacy）：seq 为 user/message → 该消息 U；否则 → 其后第一条 user/message 的 U。
 */
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/* ---------------- 共享：token 字节、文本抽取 ---------------- */

/** 固定：字符代理 / 4 = tokens（与 compaction_fidelity 同一标准）。 */
export const CHARS_PER_TOKEN = 4
export const tokensOf = (s) => Math.ceil(String(s ?? '').length / CHARS_PER_TOKEN)

/** 递归收集 content（DSH 消息/工具结果载体）里的全部 text 块。 */
function collectText(content, out = []) {
  if (!Array.isArray(content)) return out
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    else if (Array.isArray(block.content)) collectText(block.content, out)
  }
  return out
}

/** 事件消息载体（data.message.content 优先，兼容扁平 data.content）。 */
function messageContent(event) {
  return event.data?.message?.content ?? event.data?.content ?? []
}

/* ---------------- claudeset ---------------- */

const FILE_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'ls', 'read_image'])

/** 解析 claudeset 工具输入（input 可能是对象或 JSON 字符串）。 */
function claudeInput(raw) {
  if (raw === null || raw === undefined) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return {} }
}

/** 从 claudeset 工具调用中提取 {name,dir,file}。 */
function claudeToolInfo(tc) {
  const name = String(tc?.tool ?? '').toLowerCase()
  const input = claudeInput(tc?.input)
  if (!FILE_TOOLS.has(name) && name !== 'todowrite') return null
  if (name === 'todowrite') return { name: 'todo', dir: '', file: '', todos: normalizeTodos(input.todos ?? input.todo) }
  const path = input.file_path ?? input.path ?? ''
  if (typeof path !== 'string' || path.length === 0) return null
  const parts = path.split(/[\\/]/).filter(p => p.length > 0).filter(p => !/^[a-zA-Z]:$/.test(p))
  const file = (parts.at(-1) ?? '').toLowerCase()
  const dirTail = parts.slice(0, -1)
  const trimmed = dirTail.length > 3 ? dirTail.slice(-3) : dirTail
  const dir = trimmed.join('/').toLowerCase()
  return { name, dir, file }
}

function normalizeTodos(raw) {
  if (!Array.isArray(raw)) return []
  return raw.map(t => ({ content: String(t?.content ?? ''), status: String(t?.status ?? '') }))
}

/** claudeset 会话 → canonical。 */
export function canonicalizeClaudeset(s, label) {
  const us = []
  const flow = []
  let u = -1
  let pendingTools = []
  for (const t of s.turns ?? []) {
    if (t.type !== 'exchange') continue
    const hasAssistantText = !!(t.assistant && t.assistant.text)
    if (t.user || hasAssistantText) {
      const isUser = !!t.user
      const flowPos = flow.length
      if (isUser) {
        u += 1
        us.push({ u, text: String(t.user), tools: [], todos: [], flowPos, userTokens: tokensOf(t.user), assistantTokens: 0, resultTokens: 0 })
        flow.push({ role: 'user', text: String(t.user), u })
        // 把上一 exchange 残留的 pendingTools 不算（本 exchange 的助手工具归属本 U）
        pendingTools = []
      } else if (u >= 0 && t.assistant?.text) {
        flow.push({ role: 'assistant', text: String(t.assistant.text) })
        us[u].assistantTokens = tokensOf(t.assistant.text)
      }
      // 助手工具调用归属：附加在 flow 之后，属于最近的用户消息
      if (t.assistant?.tool_calls?.length) {
        for (const tc of t.assistant.tool_calls) {
          const info = claudeToolInfo(tc)
          if (info === null) continue
          if (info.name === 'todo') {
            if (u >= 0) us[u].todos = info.todos
          } else if (u >= 0) {
            us[u].tools.push({ name: info.name, dir: info.dir, file: info.file })
          }
        }
      }
    }
  }
  return {
    id: s.id,
    corpus: 'claudeset',
    single: !!label?.single,
    proj: label?.proj,
    us,
    flow,
    gt: { coarse: label?.coarse ?? [] },
  }
}

/* ---------------- DSH zstd ---------------- */

/** 解压 zstd（多帧）：execFileSync zstd -d -c（node zlib 只解首帧）。 */
export function decompressZstd(path) {
  return execFileSync('zstd', ['-d', '-c', path], { maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' })
}

/** surfaceOp 可能是字符串 'append'/'replace'，或对象 { op }。append = 追加。 */
export function isAppendSurface(e) {
  const op = typeof e.surfaceOp === 'string' ? e.surfaceOp : (typeof e.surfaceOp === 'object' ? e.surfaceOp?.op : undefined)
  return op === 'append' || op === undefined
}

/** 解析 DSH 事件流 → canonical（只取 fold 可见面：append user/message + assistant/message 文本 + 文件工具 + todo）。 */
export function canonicalizeDsh(path, label) {
  const text = decompressZstd(path)
  const evs = []
  for (const l of text.split('\n')) {
    if (l.trim().length === 0) continue
    try { const o = JSON.parse(l); if (o && o.type) evs.push(o) } catch { /* skip */ }
  }
  const umEvents = evs.filter(e => e.type === 'user/message' && isAppendSurface(e))
  // U 空间 = append user/message 序数（任意 kind）；同时建 event.seq → U 映射
  const seqToU = new Map()
  umEvents.forEach((e, i) => seqToU.set(e.seq, i))
  const us = []
  const flow = []
  let lastU = -1
  for (const e of evs) {
    if (e.type === 'user/message' && isAppendSurface(e)) {
      const u = seqToU.get(e.seq)
      const txt = (e.data?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
      if (u !== lastU + 1) throw new Error(`um event gap at seq ${e.seq}`)
      lastU = u
      us.push({ u, text: txt, tools: [], todos: [], flowPos: flow.length, userTokens: tokensOf(txt), assistantTokens: 0, resultTokens: 0, assistantText: '', resultText: '' })
      flow.push({ role: 'user', text: txt, u })
    } else if (e.type === 'assistant/message') {
      const txt = (e.data?.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
      if (txt.length > 0) flow.push({ role: 'assistant', text: txt })
      if (lastU >= 0) { us[lastU].assistantTokens += tokensOf(txt); us[lastU].assistantText += txt + '\n' }
    } else if (e.type === 'tool/result') {
      if (lastU < 0) continue
      const txt = collectText(messageContent(e)).join('')
      if (txt.length > 0) { us[lastU].resultTokens += tokensOf(txt); us[lastU].resultText += txt + '\n' }
    } else if (e.type === 'tool/call') {
      if (lastU < 0) continue
      const name = String(e.data?.name ?? '').toLowerCase()
      if (!FILE_TOOLS.has(name)) continue
      let args = {}
      try { args = JSON.parse(e.data?.arguments ?? '{}') } catch { args = {} }
      const path = args.file_path ?? args.path ?? ''
      if (typeof path !== 'string' || path.length === 0) continue
      const parts = path.split(/[\\/]/).filter(p => p.length > 0).filter(p => !/^[a-zA-Z]:$/.test(p))
      const file = (parts.at(-1) ?? '').toLowerCase()
      const dirTail = parts.slice(0, -1)
      const trimmed = dirTail.length > 3 ? dirTail.slice(-3) : dirTail
      us[lastU].tools.push({ name, dir: trimmed.join('/').toLowerCase(), file })
    } else if (e.type === 'todo/write') {
      if (lastU < 0) continue
      us[lastU].todos = normalizeTodos(e.data?.todos ?? [])
    }
  }
  // GT：coarse 直给（扩标/holdout）；否则 legacy seq→U
  let coarse = []
  if (Array.isArray(label?.coarse) && label.coarse.length > 0) {
    coarse = [...label.coarse]
  } else {
    for (const seq of label?.seqGt ?? []) {
      const e = evs.find(x => x.seq === seq)
      let target = seq
      if (!e || e.type !== 'user/message') {
        const next = umEvents.find(x => x.seq > seq)
        if (!next) continue
        target = next.seq
      }
      const u = seqToU.get(target)
      if (u !== undefined) coarse.push(u)
    }
    // legacy GT[0] = 会话起点标记（首条真实用户消息）：flip 空间丢弃（等价 claudeset u=0）。
    if (label?.startAsSessionStart && coarse.length > 0) coarse = coarse.slice(1)
  }
  return {
    id: label?.id ?? path,
    corpus: 'dsh',
    single: label?.single ?? false,
    proj: label?.file,
    us,
    flow,
    gt: { coarse: [...new Set(coarse)].sort((a, b) => a - b) },
  }
}

/* ---------------- 标签加载 ---------------- */

export function loadLabelsJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** 按 id8（claudeset）/完整 id（dsh）聚合标签。 */
export function loadClaudesetLabels(path) {
  const j = loadLabelsJson(path)
  const map = new Map()
  for (const s of j.sessions) map.set(typeof s.id === 'string' && s.id.length > 8 ? s.id.slice(0, 8) : s.id, s)
  return map
}

export function loadDshLabels(path) {
  const j = loadLabelsJson(path)
  const map = new Map()
  for (const s of j.sessions) map.set(s.id, s)
  return map
}

/** 本地会话分组目录（按 cwd 前缀），用于解析 zstd 路径。 */
export const DSH_GROUPS = ['--D-deepseek-plugin--', '--C-Users-Administrator-Desktop-card_sample--', '--C-Users-Administrator-Desktop-Chinese-Resume-in-Typst--', '--C-Users-Administrator-Desktop-RootUp--']

/** 在已知分组下解析 zstd 会话文件路径（存在才返回）。 */
export function resolveSessionPath(id, root = null) {
  const base = root ?? 'C:/Users/Administrator/.dsh/sessions'
  for (const g of DSH_GROUPS) {
    const p = `${base}/${g}/${id}/session.jsonl.zstd`
    if (existsSync(p)) return p
  }
  return null
}

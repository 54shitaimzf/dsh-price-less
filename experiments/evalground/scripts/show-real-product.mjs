/**
 * show-real-product — 真实压缩器产出展示：真实网关 (hy3) 跑两次真实压缩
 * （S2×keep-original、S1×expand），把「模型写的程序 → runProgram 产物 →
 * harness 组装后的上下文块」完整落盘为 experiments/evalground/real-compressor-output.md。
 *
 * 数据面 = tests/fixtures/template-battery（真实短流程：auth.js 改动 +
 * 测试运行）+ 一次 60KB 大读取；区域 token 按 runner 口径（工具结果截 12000
 * 字符）计算 → 压缩比门 ACTIVE。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EVAL_ROOT } from '../lib/workspace.mjs'
import { createGateway } from '../lib/gateway.mjs'
import { runProgram, DEFAULT_CODE_RUN } from '../lib/code-run.mjs'
import { makeCompressorBindings, computePointers, verifyRefGroundTruth, rawEchoMarkers, findRawEcho, clusterSubtasks } from '../lib/compressor-io.mjs'
import { validateProductSchema, checkRatio, checkRetention, collectRefs, productCompressedTokens, DEFAULT_RATIO } from '../lib/compressor-validate.mjs'
import { estimateTokens } from '../lib/prefix.mjs'
import { buildCompressorMessages } from '../lib/compressor-prompt.mjs'
import { enrichRefs } from '../lib/compress.mjs'
import { renderSection, renderRetain } from '../lib/assemble.mjs'

const fixture = path.join(EVAL_ROOT, 'tests', 'fixtures', 'template-battery')
const fixtureWorkspace = path.join(fixture, 'workspace')
const baseTranscript = JSON.parse(fs.readFileSync(path.join(fixture, 'transcript.json'), 'utf8')).entries

// 大读取（真实任务常带数万 token 上下文）→ 区域 ≥3000 → 压缩比门 ACTIVE
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rpo-'))
fs.cpSync(fixtureWorkspace, workspace, { recursive: true })
fs.writeFileSync(path.join(workspace, 'src', 'big.txt'), 'x'.repeat(60000))
const bigRead = { type: 'assistant', content: '', toolCalls: [{ id: 'call-big', name: 'read', args: { path: 'src/big.txt' } }] }
const bigTool = { type: 'tool', tool: 'read', arg: { path: 'src/big.txt' }, result: 'x'.repeat(60000) }
const transcript = [...baseTranscript.slice(0, 4), bigRead, bigTool, ...baseTranscript.slice(4)]

// runner 口径的区域消息（工具结果截 12000 字符，runner.mjs:270）
const regionMessages = transcript.map(e => {
  if (e.type === 'assistant') {
    const m = { role: 'assistant', content: String(e.content ?? '') }
    if (e.toolCalls) m.tool_calls = e.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}) } }))
    return m
  }
  if (e.type === 'tool') return { role: 'tool', tool_call_id: e.arg?.id ?? '', content: String(e.result ?? '').slice(0, 12000) }
  return null
}).filter(Boolean)
const regionTokens = estimateTokens(regionMessages.reduce((a, m) => a + (m.content ?? '') + JSON.stringify(m.tool_calls ?? []), ''))

const ctx = { taskId: 'auth-fixture', transcript, workspace }
const bindings = makeCompressorBindings(ctx)
const pointers = computePointers(ctx)
const markers = rawEchoMarkers(ctx)
const rawWorkText = await bindings.read_transcript({ segmentRef: 'task' })
const subtasks = clusterSubtasks(transcript)

const gateway = createGateway()
const MODEL = process.env.COMPRESSOR_CHECK_MODEL ?? 'deepseek-v4-flash-vision-exp'
const MODES = [
  { label: 'S2 × 方案0（keep-original：refs 只留坐标指针）', a1: 's2', a2: 'keep-original' },
  { label: 'S1 × 方案1（expand：refs 由 harness 展开为真实内容 + 热桥接保留）', a1: 's1', a2: 'expand' },
]

const out = []
out.push(`# 真实压缩器产出（真实网关 hy3 · ${new Date().toISOString()}）`)
out.push('')
out.push(`- 数据面：真实短流程 \`tests/fixtures/template-battery\`（auth.js 修复 + 测试运行 + 一次 60KB 大读取）`)
out.push(`- 压缩器读到的原始工作 ≈ ${rawWorkText.length} 字符；区域（runner 口径，工具结果截 12000）≈ **${regionTokens} token**（子流聚类 ${subtasks.length} 个）；门：minRegion=${DEFAULT_RATIO.minRegionTokens} → 压缩比门 ${regionTokens >= DEFAULT_RATIO.minRegionTokens ? 'ACTIVE（真实评估）' : 'SKIP'}`)
out.push('')

for (const mode of MODES) {
  out.push(`---`)
  out.push(`## ${mode.label}`)
  out.push('')
  let call
  try {
    call = await gateway.chatCall({
      provider: 'deepseek', model: MODEL,
      messages: buildCompressorMessages({ rawWorkText, a1: mode.a1, a2: mode.a2 }),
      maxTokens: 16000, timeoutMs: 600000,
    })
  } catch (e) {
    out.push(`**LLM 调用失败**：${String(e.message ?? e)}`)
    continue
  }
  const program = call.text
  out.push(`### ① 模型写的程序（PTC：一次调用，模型只写代码不调工具）`)
  out.push('')
  out.push('```js')
  out.push(program)
  out.push('```')
  out.push(`（usage=${JSON.stringify(call.usage ?? {})}）`)
  out.push('')
  const r = await runProgram({ program, bindings, budgets: DEFAULT_CODE_RUN })
  if (r.error) {
    out.push(`**程序执行失败**：${r.error.kind}: ${r.error.message}`)
    continue
  }
  const product = r.value
  if (!product) { out.push('**程序未返回产物对象**'); continue }
  let expandLog = ''
  if (mode.a2 === 'expand') {
    const problems = await enrichRefs(product, ctx)
    expandLog = problems.length > 0 ? `（${problems.join('; ')}）` : ''
  }
  const schema = validateProductSchema(product)
  const truth = verifyRefGroundTruth(collectRefs(product), pointers)
  const echo = findRawEcho(product, markers)
  const ratio = checkRatio({ productTokens: productCompressedTokens(product), regionTokens })
  const ret = product.retain !== undefined ? checkRetention(product.retain) : null
  out.push(`### ② 产物（总-分：1 summary + ${product.total} 个类型化子任务）`)
  out.push('')
  out.push('```json')
  out.push(JSON.stringify(product, null, 2))
  out.push('```')
  out.push(`（schema=${schema.length === 0 ? 'OK' : schema.join('; ')} · PTR-TRUTH=${truth.length === 0 ? 'OK（refs 均来自真实改动记录）' : truth.join('; ')} · OUT=${echo.length === 0 ? 'OK（无原文回显）' : echo.slice(0, 1)} · RATIO=${ratio.verdict}${ratio.ratio !== null ? ` (${ratio.ratio})` : ''}${ret ? ` · RET=${ret.ok ? 'OK' : ret.reason}` : ''}）`)
  if (schema.length > 0) {
    out.push('')
    out.push(`> **⚠️ 真实模型方差示例（门在工作的证据）**：schema 违例（${schema[0]}）→ 在真实 runner 中该产物**不会被注入上下文**（fail-lazy：继续用完整原文，运行照常）；这正是 schema/PTR/OUT/RATIO 门存在的意义。`)
  }
  out.push('')
  const sectionText = renderSection(product.sections[0], { a2: mode.a2 })
  out.push(`### ③ harness 组装进上下文的 \`[compressed task]\` 块${expandLog}`)
  out.push('')
  out.push('```')
  out.push(sectionText.trimEnd())
  out.push('```')
  if (product.retain && mode.a1 === 's1') {
    out.push(`### ④ S1 热桥接保留节点（瞬态：下次压缩即删）`)
    out.push('')
    out.push('```')
    out.push(renderRetain(product.retain))
    out.push('```')
  }
  out.push('')
}

const file = path.join(EVAL_ROOT, 'real-compressor-output.md')
fs.writeFileSync(file, out.join('\n'), 'utf8')
console.log(`written: ${file} (${out.length} lines)`)

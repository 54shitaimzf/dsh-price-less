/**
 * phase_b_clean_sample：生成干净提示词核验样本（用户核验后才会跑判别）。
 * 输出 datasets/phase-b-clean-sample.txt：
 *   A. batch0 完整组装提示词（system 规则 + 15 条消息窗，与插件 buildPrompt 同构）
 *   B. 每条消息的来源标注视图（sid/u/flip + 字段摘要）
 *   C. 全批统计与残留自查（系统包装/LLM 产出 = 0）
 */
import { readFileSync, writeFileSync } from 'node:fs'

const data = JSON.parse(readFileSync('datasets/discriminator-batches.json', 'utf8'))
const rule = readFileSync('datasets/prompt-discriminator-v1.txt', 'utf8')

function buildPrompt(items) {
  const parts = items.map((it, i) => {
    const h = (it.patches && it.patches.length ? it.patches.join('\n') : '(空)')
    return '[' + (i + 1) + ']\n<anchor>' + it.anchor + '</anchor>\n<history>' + h + '</history>\n<target>' + it.target + '</target>'
  })
  return rule + '\n\n以下是待判消息（' + items.length + ' 条）：\n' + parts.join('\n\n') +
    '\n\n按上述顺序输出一个 JSON 数组，每项形如 {"decision":"continue"|"new_task","label":"仅 new_task 时的一句话标签，≤12字，否则空串","reason":"半句话依据，≤20字"}。只输出 JSON 数组，不要任何其他文本。'
}

const out = []
out.push('# Phase B 干净提示词核验样本（v6：DSH-only，生产同构）')
out.push('')
out.push('数据口径：仅 deepseek harness 会话（local-dsh/local-ext/local-holdout/current-session 的 zstd 事件流）；')
out.push('claudeset 已剔除。输入面 = append user/message 事件中 source.kind === "user"；')
out.push('agent-instructions / plugin / skill-catalog / subagent-report / subagent-settled 等 harness 注入按 kind 滤除。')
out.push('')
out.push('## A. batch0 完整组装提示词')
out.push('')
out.push(buildPrompt(data.batches[0].items))
out.push('')
out.push('## B. 来源标注视图（batch0，每条 = 一个用户消息窗口）')
out.push('')
for (const it of data.batches[0].items) {
  out.push(`- sid=${it.sid.slice(0, 8)} u=${it.u} flip=${it.flip ? 'Y' : 'n'}`)
  out.push(`  anchor(≤350): ${it.anchor.slice(0, 90).replace(/\n/g, '⏎')}`)
  out.push(`  patches(${it.patches.length}): ${it.patches.map(p => p.slice(0, 60).replace(/\n/g, '⏎')).join(' || ')}`)
  out.push(`  target(≤800): ${it.target.slice(0, 110).replace(/\n/g, '⏎')}`)
  if (it.target.length > 800 || it.anchor.length > 350) out.push(`  [截断: target ${it.target.length}c / anchor ${it.anchor.length}c]`)
}
out.push('')
out.push('## C. 统计与残留自查')
out.push('')
const lens = data.batches.map(b => buildPrompt(b.items).length)
out.push(`- 批次: ${data.batches.length}（6条/批，v5 口径 anchor≤350/patches≤350/target≤800）`)
out.push(`- 单批字符: min ${Math.min(...lens)} / max ${Math.max(...lens)} / avg ${Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)}`)

// 残留检查
const probes = {
  'system-reminder: ': /<system-reminder>/g,
  'local-command-caveat: ': /<local-command-caveat>/g,
  'local-command-stdout: ': /<local-command-stdout>/g,
  'command-name: ': /<command-name>/g,
  'interrupt: ': /\[Request interrupted by user/g,
  'resume-summary: ': /This session is being continued from a previous conversation/g,
  'thinking-block: ': /<thinking>/g,
  'tool-call: ': /"tool_calls"/g,
  'api-error: ': /API Error: 401/g,
}
let residual = 0
for (const [label, re] of Object.entries(probes)) {
  let n = 0
  for (const b of data.batches) {
    for (const it of b.items) {
      for (const t of [it.anchor, ...it.patches, it.target]) {
        re.lastIndex = 0
        let m
        while ((m = re.exec(t))) n++
      }
    }
  }
  out.push(`- ${label}${n}`)
  if (n > 0) residual += n
}
out.push(`- 残留总计: ${residual}`)
out.push(`- DSH 会话: ${data.meta.sessions}（kind 直方图: ${JSON.stringify(data.meta.kindHistogram)}）`)
out.push(`- 注入按 kind 滤除: ${data.meta.injectedFiltered}（翻转点落在非 user-kind: ${data.meta.flipOnNonUser}）`)
out.push(`- 判别面: ${data.meta.surface}（L0 拦截 ${data.meta.l0ContinueHits}）`)

writeFileSync('datasets/phase-b-clean-sample.txt', out.join('\n'))
console.log('written datasets/phase-b-clean-sample.txt')
console.log('batch lens:', lens.join(','))
console.log('residual total:', residual)
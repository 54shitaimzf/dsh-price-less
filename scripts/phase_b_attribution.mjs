// phase_b_attribution.mjs —— debug 归因：基线 v2 → debug 判定 + 模型自述理由
// 输出：每个模型的错误位矩阵（基线 vs debug）、全部 reason、漂移位标注、检查项关键词频次
import { readFileSync } from 'node:fs'
const RAW = 'D:/deepseek-plugin/reports/phase-b-raw'
const short = s => { const m = String(s).match(/session-([0-9a-f]{8})-/); return m ? m[1] : String(s).slice(0, 8) }
const pairs = [
  { base: 'v2-minimax-m3.json', dbg: 'debug-minimax-m3.json', name: 'minimax-m3' },
  { base: 'v2-v4-flash.json', dbg: 'debug-deepseek-v4-flash.json', name: 'deepseek-v4-flash' },
  { base: 'hy3-v2.json', dbg: 'debug-hy3.json', name: 'hy3' },
]
for (const p of pairs) {
  const baseItems = JSON.parse(readFileSync(`${RAW}/${p.base}`, 'utf8')).items
  const dbg = JSON.parse(readFileSync(`${RAW}/${p.dbg}`, 'utf8'))
  const bmap = new Map(); for (const it of baseItems) bmap.set(`${short(it.sid)}:${it.u}`, it)
  console.log(`\n################ ${p.name}：基线 v2 (${getS(p.base)}) → debug`)
  console.log(`基线: acc=${getAcc(p.base)} flip=${getF(p.base, 'flip')} nonF=${getF(p.base, 'non')} | debug: acc=${dbg.summary.accuracy} flip=${dbg.summary.flipAccuracy} nonF=${dbg.summary.nonFlipAccuracy}`)
  for (const it of dbg.items) {
    const k = `${short(it.sid)}:${it.u}`
    const b = bmap.get(k)
    const bGot = b && b.decision
    const got = it.decision
    const baseWrong = bGot && bGot !== (it.flip ? 'new_task' : 'continue')
    const dbgWrong = got && got !== (it.flip ? 'new_task' : 'continue')
    if (!baseWrong && !dbgWrong) continue
    const drift = baseWrong !== dbgWrong
    const flag = drift ? (dbgWrong ? '← 基线对/debug错' : '← 基线错/debug对') : ''
    console.log(` ${k} GT=${it.flip ? 'N' : 'C'} 基=${bGot ? (bGot === 'new_task' ? 'N' : 'C') : '?'}${baseWrong ? '✗' : ''} → debug=${got === 'new_task' ? 'N' : got === 'continue' ? 'C' : '?'}${dbgWrong ? '✗' : ''} ${flag}${dbgWrong ? '| 理由: ' + (it.reason ?? '(无)') : ''}${it.thinkText ? ` | thinkLen=${it.thinkText.length}` : ''}`)
  }
}
function getAcc(f) { const j = JSON.parse(readFileSync(`${RAW}/${f}`, 'utf8')); return j.summary.accuracy }
function getF(f, kind) { const j = JSON.parse(readFileSync(`${RAW}/${f}`, 'utf8')); return kind === 'flip' ? j.summary.flipAccuracy : j.summary.nonFlipAccuracy }
function getS(f) { const j = JSON.parse(readFileSync(`${RAW}/${f}`, 'utf8')); return `${j.summary.correct}/${j.summary.total}` }
// 检查项关键词频次（debug 全部 reason）
console.log('\n\n================= 检查项关键词频次（debug reason 全集） =================')
const kw = ['换形态', '换意图', '换对象', '换域', '换主题', '推进', '同一', '延续', '未命中', '讨论', '实操', '报错', '切换']
const freq = {}; for (const w of kw) freq[w] = 0
let n = 0
for (const p of pairs) {
  const dbg = JSON.parse(readFileSync(`${RAW}/${p.dbg}`, 'utf8'))
  for (const it of dbg.items) { if (it.reason) { n++; for (const w of kw) { if (it.reason.includes(w)) freq[w]++ } } }
}
console.log(`理由总数=${n}`)
for (const w of kw) console.log(`  ${w}: ${freq[w]}`)

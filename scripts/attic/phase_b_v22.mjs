// phase_b_v22.mjs —— 三版本（v2/v2.1/v2.2）× 三模型 × 52：准确率配对 + 三方面意图子集
// 三方面意图：①切换面（GT flip 13 条：new_task 检出）②言说/元讨论面（非翻转中讨论/方案/评估/追问机制类：防误报）
// ③延续/收尾面（非翻转中推进/收口/报错/追问细节类：防误报）
import { readFileSync } from 'node:fs'
const RAW = 'D:/deepseek-plugin/reports/phase-b-raw'
const short = s => { const m = String(s).match(/session-([0-9a-f]{8})-/); return m ? m[1] : String(s).slice(0, 8) }
function load(f) {
  const j = JSON.parse(readFileSync(`${RAW}/${f}`, 'utf8'))
  const m = new Map()
  for (const it of j.items) if (it.decision) m.set(`${short(it.sid)}:${it.u}`, { flip: !!it.flip, got: it.decision, tok: it })
  return m
}
// 三方面意图标签：优先手工覆盖，再关键词规则
const TALK = /讨论|方案|评估|标准|观点|看法|为什么|怎么|如何|区别|机制|原理|优劣|讲解|解释|介绍|设计|想法|建议|意见|思路|先说说|先谈|你懂不懂|是什么|哪|觉得|认为/
const CONT_WORD = /收口|清理|报错|Error|error|编译|替换|更新文档|删除|再|继续|启动|通过|git|init|推进/
const MANUAL = {
  'b5f92412:64': 'cont', '17eeebba:115': 'cont', '17eeebba:128': 'flip',
  '14b08b7d:72': 'talk', '17eeebba:208': 'talk', '74a1b607:16': 'talk', '74a1b607:17': 'talk',
}
function classify(k, flip, target) {
  if (MANUAL[k]) return MANUAL[k]
  if (flip) return 'flip'
  const t = String(target)
  const talkHit = TALK.test(t)
  const contHit = CONT_WORD.test(t)
  if (contHit) return 'cont'
  if (talkHit) return 'talk'
  return 'cont'
}
// 主数据集（取窗口 target 用以分类）
const ds = JSON.parse(readFileSync('D:/deepseek-plugin/datasets/discriminator-batches.json', 'utf8'))
const metas = new Map()
for (const b of ds.batches || []) for (const it of b.items || []) {
  const m = String(it.sid).match(/session-([0-9a-f]{8})-/)
  metas.set(`${m[1]}:${it.u}`, { flip: !!it.flip, target: it.target })
}
const versions = { v2: ['v2-minimax-m3.json', 'v2-v4-flash.json', 'hy3-v2.json'], v21: ['v2_1-minimax-m3.json', 'v2_1-deepseek-v4-flash.json', 'v2_1-hy3.json'], v22: ['v2_2-minimax-m3.json', 'v2_2-deepseek-v4-flash.json', 'v2_2-hy3.json'] }
const models = ['minimax-m3', 'deepseek-v4-flash', 'hy3']
let clsTotal = { flip: 0, talk: 0, cont: 0 }
for (const [k, m] of metas) { const c = classify(k, m.flip, m.target); clsTotal[c]++; }
console.log(`三方面意图样本分布：切换（flip）${clsTotal.flip} / 言说（talk）${clsTotal.talk} / 延续（cont）${clsTotal.cont}（共 ${clsTotal.flip + clsTotal.talk + clsTotal.cont}）\n`)
console.log('════ 三版本 × 三模型：总准确率配对 ════')
for (const [ver, files] of Object.entries(versions)) {
  const row = []
  for (let i = 0; i < 3; i++) {
    const m = load(files[i])
    let cor = 0, tot = 0
    for (const v of m.values()) { tot++; if ((v.got === 'new_task') === v.flip) cor++ }
    row.push(`${models[i].slice(0, 8)}: ${cor}/${tot} (${(cor / tot * 100).toFixed(1)}%)`)
  }
  console.log(`${ver}: ${row.join('  |  ')}`)
}
console.log('\n════ 三方面意图面板（每格 = 该子集内准确率 %，n=样本数） ════')
console.log('子集            |      v2 (M/V4/H3)      |     v2.1 (M/V4/H3)     |     v2.2 (M/V4/H3)')
for (const [cn, key] of [['切换面(检出new_task)', 'flip'], ['言说面(防切断)', 'talk'], ['延续面(防切断)', 'cont']]) {
  const cells = []
  for (const ver of ['v2', 'v21', 'v22']) {
    const files = versions[ver]
    const per = []
    for (let i = 0; i < 3; i++) {
      const m = load(files[i])
      let cor = 0, n = 0
      for (const [k, v] of m) {
        const meta = metas.get(k); if (!meta) continue
        if (classify(k, meta.flip, meta.target) !== key) continue
        n++
        if ((v.got === 'new_task') === v.flip) cor++
      }
      per.push(n ? `${(cor / n * 100).toFixed(0)}%(${cor}/${n})` : '-')
    }
    cells.push(per.join('/'))
  }
  console.log(`${cn}  |  ${cells[0]}  |  ${cells[1]}  |  ${cells[2]}`)
}
// 逐条：v2.1→v2.2 变化（minimax/hy3 为关注点）
console.log('\n════ v2.1 → v2.2 逐条变化（三模型投票） ════')
const maps = {}
for (const ver of ['v21', 'v22']) {
  const files = versions[ver]
  maps[ver] = files.map(f => load(f))
}
for (const k of metas.keys()) {
  const changes = []
  for (let i = 0; i < 3; i++) {
    const a = maps.v21[i].get(k), b = maps.v22[i].get(k)
    if (!a || !b) continue
    const aG = (a.got === 'new_task') === a.flip
    const bG = (b.got === 'new_task') === b.flip
    if (aG !== bG) changes.push(`${models[i].slice(0, 5)}:${aG ? '✓' : '✗'}→${bG ? '✓' : '✗'}(${a.got[0]}→${b.got[0]})`)
  }
  if (changes.length) console.log(` ${k} GT=${metas.get(k).flip ? 'N' : 'C'}  ${changes.join('  ')}`)
}

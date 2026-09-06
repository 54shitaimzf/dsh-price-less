/**
 * probe23：最终 holdout 单跑 —— 把 probe22 选取的"参数+优化组合"应用到
 *   holdout 集（本对话 + 2 本地会话），只跑一次，不再迭代。
 *
 * 预注册：接受条件与 probe22 §3 一致（recall ≥0.70 / 每误切孤儿 ≤0.85 / 单意图误开 ≤50%）。
 * 运行：node scripts/mech_probe23.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { canonicalizeDsh, loadLabelsJson } from './mech_replay.mjs'
import { staticFeatures } from './mech_features.mjs'
import { ARMS } from './mech_arms.mjs'
import { sessSummary, utility } from './mech_eval.mjs'

const SS_ROOT = 'C:/Users/Administrator/.dsh/sessions'
const GROUPS = ['--D-deepseek-plugin--', '--C-Users-Administrator-Desktop-card_sample--', '--C-Users-Administrator-Desktop-Chinese-Resume-in-Typst--', '--C-Users-Administrator-Desktop-RootUp--']
function resolveSessionPath(id) {
  for (const g of GROUPS) {
    const p = `${SS_ROOT}/${g}/${id}/session.jsonl.zstd`
    if (existsSync(p)) return p
  }
  return null
}

// probe22 定稿的推荐组合（臂 + 参数）——probe22 完成后由人工替换为冠军臂+参数（本脚本只跑一次）。
// 预注册候选（基于 probe22-diagnostics/mech_diag 的确定性结论）：
//   无切割参照 U=−192；任何机械工作点未达标 → probe23 只作"对照确认"，不宣称获胜组合。
const FINAL_CONF = {
  M0: {},
  M4: {
    w: { corr: 1.0, lex: 0.8, cluster: 0.5, todo: 0.4, cohesion: 0.6, dump: -0.2, goal: -0.3, question: 0.1, imperative: 0.15, lenratio: 0.1, toolwrite: 0.1, toolread: 0.05 },
    theta: 0.9, strongGate: false, mu: 4, sigma: 2,
  },
  M7: {
    w: { lex: 0.8, corr: 1.0, cluster: 0.5, todo: 0.4 },
    theta: 0.5, strongGate: false,
  },
}

const cur = loadLabelsJson('datasets/labels/current-session.json')
const ho = loadLabelsJson('datasets/labels/local-holdout.json')
const sessions = [
  canonicalizeDsh(resolveSessionPath('session-17eeebba-5666-4607-bafa-1befd583f975'), { ...cur, id: 'holdout-current', single: cur.single }),
  ...ho.sessions.map(lab => canonicalizeDsh(resolveSessionPath(lab.id), lab)),
]
for (const s of sessions) s.staticF = staticFeatures(s)

const rep = []
rep.push('# probe23：最终 holdout 单跑（预注册后不再迭代）')
rep.push('')
rep.push('| 会话 | 类型 | U | 翻转 |')
rep.push('|---|---|---|---|')
for (const s of sessions) rep.push(`| ${s.id} | ${s.corpus} ${s.single ? '(单意图)' : '(多意图)'} | ${s.us.length} | ${s.gt.coarse.length} |`)
rep.push('')
rep.push('## 各臂在 holdout 上的表现')
rep.push('')
rep.push('| 臂 | recall | 误切 | 每误切孤儿 | 单意图误开 | U(3,0.5,1) |')
rep.push('|---|---|---|---|---|---|')
for (const [arm, cfg] of Object.entries(FINAL_CONF)) {
  const run = ARMS[arm]?.run
  if (!run) continue
  let hits = 0, misses = 0, fps = 0, orphanFP = 0, singleOpen = 0, singleN = 0, fc = 0
  for (const s of sessions) {
    const cuts = run(s, s.staticF, cfg)
    const sm = sessSummary(s, cuts)
    hits += sm.m.hits; misses += sm.m.misses; fps += sm.m.fps
    orphanFP += sm.bm.falseOrphan; fc += sm.bm.falseCuts
    if (sm.m.single) { singleN++; if (sm.m.fps > 0) singleOpen++ }
  }
  const gtTotal = sessions.reduce((a, s) => a + s.gt.coarse.filter(g => g > 0).length, 0)
  rep.push(`| ${arm} | ${(gtTotal ? hits / gtTotal : 0).toFixed(3)} | ${fc} | ${(fc ? orphanFP / fc : 0).toFixed(3)} | ${singleN ? (100 * singleOpen / singleN).toFixed(1) : '-'}% | ${(hits - 3 * misses - 0.5 * fps - orphanFP).toFixed(1)} |`)
}
writeFileSync('reports/probe23.md', rep.join('\n'))
console.log(rep.join('\n'))
console.log('\nsaved reports/probe23.md')

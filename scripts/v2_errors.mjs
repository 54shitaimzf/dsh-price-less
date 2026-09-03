// v2 三变体错误项全表（按可修性预归类：D=GT数据问题 / P=prompt可修 / M=模型个体）
import { readFileSync } from 'node:fs'
const RAW = 'D:/deepseek-plugin/reports/phase-b-raw'
const files = [['v2-minimax-m3.json', 'MM'], ['v2-v4-flash.json', 'V4'], ['hy3-v2.json', 'HY3']]
const all = {}
for (const [f, tag] of files) {
  const j = JSON.parse(readFileSync(`${RAW}/${f}`, 'utf8'))
  for (const it of j.items) {
    const got = it.decision === 'new_task' ? 'N' : it.decision === 'continue' ? 'C' : '?'
    const wrong = got !== (it.flip ? 'N' : 'C')
    if (wrong) {
      const k = `${it.sid}:${it.u}`
      all[k] = all[k] || { flip: it.flip }
      all[k][tag] = got
    }
  }
}
// 预归类（基于窗口审查）
const cls = {
  '14b08b7d:8': 'D-粗粒度', '14b08b7d:49': 'D-粗粒度', '14b08b7d:88': 'D-粗粒度',
  '17eeebba:128': 'D-GT错标', '17eeebba:5': 'GT存疑',
  'b5f92412:64': 'P-收口例外', 'b5f92412:11': 'P-设计否定', 'c3801781:84': 'P-对象漂移',
  'c3801781:6': 'P-追问锚点', 'c3801781:92': 'P-主题漂移', '74a1b607:17': 'P-追问锚点',
  '17eeebba:49': 'P-元讨论', '17eeebba:61': 'P-元讨论', '17eeebba:188': 'P-元讨论', '17eeebba:199': 'P-元讨论', '17eeebba:208': 'P-元讨论',
  '17eeebba:17': 'M-阶段推进', '17eeebba:34': 'M-阶段推进', '17eeebba:46': 'M-阶段推进', '17eeebba:51': 'M-阶段推进', '17eeebba:102': 'M-阶段推进', '17eeebba:137': 'M-阶段推进',
  'c3801781:16': 'M-立项', 'c3801781:36': 'M-立项',
}
for (const k of Object.keys(all).sort()) {
  const e = all[k]
  console.log(`${k}  GT=${e.flip ? 'N' : 'C'}  [${e.MM ?? '-'} ${e.V4 ?? '-'} ${e.HY3 ?? '-'}]  (${cls[k] || '未归类'})`)
}

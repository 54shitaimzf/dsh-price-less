/**
 * Report rendering: scorecard JSON → Markdown, and arm-level Δ tables.
 */
import fs from 'node:fs'
import path from 'node:path'

export function renderRunReport(sc) {
  const cost = sc.cost ? `$ ${sc.cost.usd.toFixed(4)}（in ${sc.cost.usage?.inputTokens ?? 0} / cr ${sc.cost.usage?.cacheReadTokens ?? 0} / out ${sc.cost.usage?.outputTokens ?? 0}）` : '—'
  const lines = [
    `# ${sc.task} · run ${sc.runId}`,
    '',
    `- 执行模型：${sc.model}（${sc.provider}），judge：${sc.judgeModel ?? '—'}`,
    `- 完成：${sc.finished ? 'DONE' : '未完成'}（${sc.steps} 步 / ${Math.round((sc.elapsedMs ?? 0) / 1000)}s）`,
    `- 成本：${cost}`,
    `- **总分：${sc.total}**（机械 ${sc.mech.score} × ${sc.track.mech} + 代码主观 ${sc.judge.score ?? '—'} × ${sc.track.judge} + 超金色 ${sc.beyondGolden ?? 0}；总分可超过 100）`,
    '',
    '## 机械分',
    ...sc.mech.checks.map(c => `- ${c.pass ? '✅' : '❌'} ${c.check} — ${c.detail}`),
    '',
    sc.mech.violations.length ? '## 反作弊/违规\n' + sc.mech.violations.map(v => `- ⚠️ ${v}`).join('\n') : '',
    '',
    `## 代码主观（judge 盲评：${JSON.stringify(sc.judge.antiCheat ?? {})}）`,
    ...Object.entries(sc.judge.dims ?? {}).map(([k, v]) => `- ${k}: ${v}/5`),
    '',
    ...(sc.subjectivity ? [
      '## 主观评判（资深 reviewer 盲评）',
      `- 总体质量：${sc.subjectivity.overallQuality}/5；是否可放行：${sc.subjectivity.wouldShip === 1 ? '是' : sc.subjectivity.wouldShip === 0 ? '否' : '—'}`,
      `- 过度报告（overReport）：${sc.subjectivity.overReport ?? '—'}；真实超额发现（realExtras）：${sc.subjectivity.realExtras ?? '—'}；金色覆盖：${sc.subjectivity.goldenCoverage ?? '—'}`,
      `- 评语：${sc.subjectivity.narrative ?? '—'}`,
      `- 依据：${sc.subjectivity.evidence ?? '—'}`,
      '',
    ] : ['## 主观评判（未运行/失败）', '']),
    `## 违规扣分：${(sc.penalties ?? []).join(' | ') || '无'}`,
    '',
  ]
  return lines.filter(Boolean).join('\n')
}

export function renderArmSummary(scorecards) {
  const tasks = [...new Set(scorecards.map(s => s.task))]
  const lines = ['# 臂级汇总（Δ = arm − native-auto 对照）', '']
  for (const task of tasks) {
    const rows = scorecards.filter(s => s.task === task)
    const baseline = rows.find(r => r.arm === 'native-auto')
    lines.push(`## ${task}`)
    lines.push('| arm | total | mech | judge | human | 完成 |', '|---|---|---|---|---|---|')
    for (const r of rows) {
      const d = baseline && r.arm !== 'native-auto' ? `（Δ ${r.total - baseline.total >= 0 ? '+' : ''}${r.total - baseline.total}）` : ''
      lines.push(`| ${r.arm} | ${r.total}${d} | ${r.mech.score} | ${r.judge.score ?? '—'} | ${r.human ?? '—'} | ${r.finished ? '✓' : '✗'} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

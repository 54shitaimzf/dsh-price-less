// Public: report panel app (fetch report, render table).
// Baseline: minimal renderer (no filters / groups / copy buttons — those are
// the T3 feature-development target).
import { formatCounts, countTotal } from './format.js'
import { renderPanelHtml } from '../src/render-panel.js'

export async function boot(root = document.getElementById('app')) {
  const res = await fetch('/api/audit')
  const run = await res.json()
  const report = run.report
  root.innerHTML = renderPanelHtml(report)
  const line = document.createElement('div')
  line.id = 'summary-text'
  line.textContent = `${formatCounts(report.summary)} · 共 ${countTotal(report.summary)} 条`
  root.appendChild(line)
}

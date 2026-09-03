/**
 * Shared pure renderer for the audit report panel (used by the browser app,
 * the node tests, and the DOM/text snapshot for the human review packet).
 * Zero DOM access — returns an HTML string.
 * Baseline: summary cards + findings table. (Filters/grouping/copy buttons
 * are the T3 feature-development target and are NOT rendered here yet.)
 */

export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const SEVERITY_LABEL = { error: '错误', warn: '警告', info: '提示' }

export function renderPanelHtml(report) {
  const summary = report.summary
  const cards = ['error', 'warn', 'info'].map(sev => (
    `<div class="card card-${sev}"><span class="count" data-sev="${sev}">${summary[`${sev}s`] ?? 0}</span>`
    + `<span class="label">${SEVERITY_LABEL[sev] ?? sev}</span></div>`
  )).join('\n')
  const rows = (report.findings ?? []).map(f => (
    `<tr class="row-${f.severity}" data-rule="${escapeHtml(f.rule)}" data-severity="${f.severity}">`
    + `<td>${escapeHtml(f.rule)}</td><td>${escapeHtml(f.severity)}</td><td>${escapeHtml(f.message)}</td>`
    + `<td>${escapeHtml(f.file ?? '')}</td></tr>`
  )).join('\n')
  return `<html><body>
<h1>审计报告：${escapeHtml(report.pkg ?? '')} v${escapeHtml(report.version ?? '')}</h1>
<div id="summary-cards">${cards}</div>
<table id="findings"><thead><tr><th>规则</th><th>级别</th><th>说明</th><th>文件</th></tr></thead>
<tbody id="rows">${rows}</tbody></table>
</body></html>`
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyFilter, SEVERITY_ORDER, groupByRule } from '../public/filter.js'
import { formatCounts, countTotal, severityLabel, copyFixSnippet } from '../public/format.js'
import { renderPanelHtml } from '../src/render-panel.js'

const rows = [
  { rule: 'R1', severity: 'error', message: 'a', file: 'package.json' },
  { rule: 'R1', severity: 'error', message: 'b', file: 'package.json' },
  { rule: 'R5', severity: 'warn', message: 'c', file: 'package.json' },
  { rule: 'R9', severity: 'info', message: 'd', file: 'x' },
]

test('SEVERITY_ORDER ranks error > warn > info', () => {
  assert.equal(SEVERITY_ORDER.error, 2)
  assert.equal(SEVERITY_ORDER.info, 0)
})

test('applyFilter with minSeverity warn includes warn AND error rows', () => {
  const filtered = applyFilter(rows, { minSeverity: 'warn' })
  assert.equal(filtered.length, 3)
  assert.deepEqual(filtered.map(r => r.severity).sort(), ['error', 'error', 'warn'])
})

test('applyFilter with minSeverity error includes only errors', () => {
  const filtered = applyFilter(rows, { minSeverity: 'error' })
  assert.equal(filtered.length, 2)
  assert.ok(filtered.every(r => r.severity === 'error'))
})

test('applyFilter with rulePrefix narrows by rule prefix', () => {
  const filtered = applyFilter(rows, { rulePrefix: 'R1' })
  assert.equal(filtered.length, 2)
})

test('countTotal sums numerically (no string concatenation)', () => {
  assert.equal(countTotal({ errors: 2, warns: 1, infos: 4 }), 7)
  assert.equal(countTotal({ errors: 0, warns: 0, infos: 0 }), 0)
})

test('formatCounts renders per-severity labels', () => {
  assert.equal(formatCounts({ errors: 2, warns: 1, infos: 4 }), '错误 2 · 警告 1 · 提示 4')
})

test('severityLabel maps to Chinese labels', () => {
  assert.equal(severityLabel('error'), '错误')
  assert.equal(severityLabel('nope'), 'nope')
})

test('groupByRule groups rows per rule, ordered by severity desc', () => {
  const groups = groupByRule(rows)
  assert.equal(groups.length, 3)
  assert.equal(groups[0].rule, 'R1')
  assert.equal(groups[0].count, 2)
  assert.equal(groups[2].rule, 'R9')
})

test('copyFixSnippet emits the fixed command snippet', () => {
  assert.equal(
    copyFixSnippet({ rule: 'R1', file: 'package.json' }),
    'relaudit fix --rule=R1 --file=package.json',
  )
})

test('renderPanelHtml renders summary cards and finding rows', () => {
  const html = renderPanelHtml({
    pkg: 'dsh-sample-plugin', version: '1.3.0',
    summary: { errors: 2, warns: 1, infos: 1, total: 4 },
    findings: rows,
  })
  assert.ok(html.includes('data-sev="error"'), 'error card missing')
  assert.ok(html.includes('data-rule="R1"'), 'finding row missing')
  assert.ok(html.includes('v1.3.0'))
})

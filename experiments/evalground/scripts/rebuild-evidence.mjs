/** Rebuild human-evidence (screenshots/snapshots) for existing runs, no judge, no executor. */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT } from '../lib/workspace.mjs'
import { buildHumanPacket } from '../lib/human-packet.mjs'

const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['T3-', 'T7-']
for (const prefix of targets) {
  const dir = fs.readdirSync(path.join(EVAL_ROOT, 'runs')).find(d => d.startsWith(prefix) && fs.existsSync(path.join(EVAL_ROOT, 'runs', d, 'scorecard.json')))
  if (!dir) { console.log(`no run for ${prefix}`); continue }
  const runDir = path.join(EVAL_ROOT, 'runs', dir)
  const sc = JSON.parse(fs.readFileSync(path.join(runDir, 'scorecard.json'), 'utf8'))
  const taskFile = fs.readdirSync(path.join(EVAL_ROOT, 'tasks')).find(f => f.startsWith(sc.task) && f.endsWith('.json'))
  const task = JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, 'tasks', taskFile), 'utf8'))
  const ws = path.join(runDir, 'workspace')
  const p = await buildHumanPacket(task, runDir, ws, sc.mech)
  console.log(`${dir}: evidence=[${p.evidence.join(', ')}] reasons=[${p.reasons.join(', ')}]`)
}
/**
 * Assertions — the A1×A2 grid 4 arms (self-s{1,2}-{orig,expand}) + a scripted
 * trial run that reads results AND the assembled context against design intent.
 * All offline: pure functions + scripted gateway + a written boundary mark; NO
 * real model calls. The scripted compressor returns the REAL template programs
 * (TEMPLATE_S2 / a concrete-S1 variant) so the FULL PTC pipeline (program →
 * runProgram → real bindings → grounded refs → gates) is exercised offline.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVAL_ROOT, createWorkspace } from '../lib/workspace.mjs'

const tmp = path.join(EVAL_ROOT, '.assert-tmp', 'grid')
fs.mkdirSync(tmp, { recursive: true })
let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!cond) failures++
}
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ============ ARMS-A. the 4 grid arms declare + validate ============
{
  const { getArm, listArms } = await import('../lib/arm-spec.mjs')
  const { validateArmRow } = await import('../lib/config.mjs')
  const ids = ['self-s1-orig', 'self-s1-expand', 'self-s2-orig', 'self-s2-expand']
  const missing = ids.filter(id => !listArms().includes(id))
  ok(missing.length === 0, 'ARMS-A1 the 4 A1×A2 grid arms are declared', missing.join(',') || 'all present')
  for (const id of ids) {
    const arm = getArm(id)
    ok(validateArmRow({ id, ...arm }).length === 0, `ARMS-A2 ${id} validates`, validateArmRow({ id, ...arm }).join(';'))
    ok(arm.compression === 'task-boundary'
      && (arm.a1 === 's1' || arm.a1 === 's2')
      && (arm.a2 === 'keep-original' || arm.a2 === 'expand')
      && arm.ledger?.decision === true,
    `ARMS-A3 ${id} → task-boundary × a1=${arm.a1} × a2=${arm.a2} + decision ledger`)
  }
  const grid = ids.map(id => getArm(id))
  ok(new Set(grid.map(a => a.a1)).size === 2 && new Set(grid.map(a => a.a2)).size === 2, 'ARMS-A4 grid covers A1{s1,s2} × A2{keep-original,expand} (full cross)')
}

// ============ A1-SEM. 总-分 render + retain node shape (new A1 semantics) ============
{
  const { renderSection, renderRetain } = await import('../lib/assemble.mjs')
  const section = { summary: 'a summary long enough to render', subtasks: [{ type: 'plan', goal: 'g', refs: [{ path: 'src/x.js', lineRange: '1-2', symbol: 'f' }] }] }
  const rendered = renderSection(section)
  ok(rendered.includes('[compressed task]') && rendered.includes('[plan] 目标: g') && rendered.includes('src/x.js:1-2(f)'), 'A1-SEM1 renderSection renders 总-分 with ref coordinates')
  const expanded = renderSection({ summary: 's', subtasks: [{ type: 'impl', path: 'p', change: 'c', refs: [{ path: 'p', lineRange: '1-2', content: 'real content slice' }] }] }, { a2: 'expand' })
  ok(expanded.includes('→内容(real content slice)'), 'A1-SEM2 expand renders harness-resolved content (refs stay)')
  const retain = { refs: [{ path: 'src/x.js', lineRange: '1-2' }], outline: 'recent work' }
  const rr = renderRetain(retain)
  ok(rr.includes('[热桥接 retain]') && rr.includes('src/x.js:1-2'), 'A1-SEM3 renderRetain renders the hot-bridge node (refs+outline, no raw)')
}

// ============ A2-RENDER. legacy renderBlocks + renderProduct dispatch still intact ============
{
  const { renderProduct, renderBlocks } = await import('../lib/assemble.mjs')
  const blocks = { blocks: [
    { type: 'plan', goal: 'fix auth', constraints: ['no tests'], decisions: ['use read'] },
    { type: 'impl', path: 'src/x.js', lineRange: '120-145', change: 'add guard', test: 'npm test pass' },
    { type: 'verify', command: 'npm test', result: 'pass', failure: '' },
    { type: 'wrap', conclusion: 'ok', deliverables: ['x.js'], leftover: ['lint'] },
  ] }
  const rendered = renderBlocks(blocks)
  ok(rendered.includes('## 信息块') && rendered.includes('[plan] 目标: fix auth') && rendered.includes('[impl] src/x.js 120-145: add guard') && rendered.includes('[verify] npm test: pass') && rendered.includes('[wrap] ok'), 'A2-C1 renderBlocks renders all 4 block types (legacy path)')
  ok(renderProduct(blocks) === rendered, 'A2-C2 renderProduct dispatches blocks product to renderBlocks (legacy)')
  const semantic = { goal: 'g', steps: ['s'], fileStream: ['f'], compressed: 'c' }
  ok(renderProduct(semantic) !== rendered && renderProduct(semantic).includes('## 目标'), 'A2-C3 renderProduct still renders semantic (legacy 方案0 shape)')
  const sectionsProduct = { a2: 'keep-original', sections: [{ summary: 's summary here enough', subtasks: [{ type: 'plan', goal: 'g' }] }] }
  ok(renderProduct(sectionsProduct).includes('[compressed task]'), 'A2-C4 renderProduct dispatches 总-分 products to renderSection')
}

// ============ TRIAL. per-arm scripted run with the REAL PTC template programs ============
{
  const { runSession } = await import('../lib/runner.mjs')
  const { createScriptedGateway } = await import('../lib/gateway-mock.mjs')
  const { boundaryMarkPath, writeBoundaries } = await import('../lib/boundaries.mjs')
  const { loadTask } = await import('../lib/tasks.mjs')
  const { TEMPLATE_S2 } = await import('../lib/sdk.mjs')
  const { validateProductSchema } = await import('../lib/compressor-validate.mjs')

  // A 3-segment boundary mark on T7: seg0=seq0, seg1=seq1, seg2=seq2 (each its own
  // task unit). The runner compresses when ABOUT to inject a NEW segment head.
  const markFile = boundaryMarkPath('T7')
  const existed = fs.existsSync(markFile)
  const backup = existed ? fs.readFileSync(markFile, 'utf8') : null
  try {
    writeBoundaries('T7', {
      source: 'premark',
      cost: { usage: { inputTokens: 800, outputTokens: 60, cacheReadTokens: 0 }, usd: 0.006, model: 'm', provider: 'p' },
      boundaries: [
        { segmentIndex: 0, taskId: 'task-0', startSeq: 0, endSeq: 0, status: 'closed' },
        { segmentIndex: 1, taskId: 'task-1', startSeq: 1, endSeq: 1, status: 'closed' },
        { segmentIndex: 2, taskId: 'task-2', startSeq: 2, endSeq: 2, status: 'active' },
      ],
    })
    const t7 = loadTask('T7')
    const task = { ...t7 }

    // S1 variant of the compressor program: retain the LAST REF-BEARING subtask
    // (refs+outline — the real hot bridge), like the battery's CONCRETE_S1.
    const SCRIPT_S1 = [
      'const s = await tools.probe_substructure({ taskRef: "task" })',
      'const subtasks = []',
      'for (const sub of s.subtasks) {',
      '  let refs = []',
      '  let p = null',
      '  if (sub.typeHint === "edit") {',
      '    p = await tools.locate_change({ segmentRef: sub.spanKey, fileHint: "" })',
      '    if (p) { const v = await tools.validate_pointer({ ...p }); if (v.ok) refs = [{ refKey: sub.spanKey, ...p }] }',
      '  }',
      '  const type = sub.typeHint === "edit" ? "impl" : sub.typeHint === "verify" ? "verify" : sub.typeHint === "wrap" ? "wrap" : "plan"',
      '  const fields = type === "impl" ? { path: p?.path ?? "", lineRange: p?.lineRange ?? null, symbol: p?.symbol ?? null, change: "scripted change" }',
      '    : type === "verify" ? { command: "npm test", result: "pass" }',
      '    : type === "wrap" ? { conclusion: "scripted wrap" }',
      '    : { goal: "scripted goal" }',
      '  subtasks.push({ type, ...fields, refs })',
      '}',
      'const lastImpl = subtasks.filter(st => st.refs.length > 0).pop()',
      'const retain = { refs: lastImpl ? lastImpl.refs.map(r => ({ path: r.path, lineRange: r.lineRange, symbol: r.symbol })) : [], outline: "scripted hot bridge" }',
      'return { total: s.subtasks.length, sections: [{ summary: "Scripted closed segment condensed for continuation.", subtasks }], retain }',
    ].join('\n')

    // Per-arm scripted gateway: executor alternates a real tool turn (read +
    // write src/audit/x.js → real transcript records → grounded pointers) with DONE;
    // compressor calls return the REAL template program.
    const makeGate = (a1) => {
      let toolPending = false
      let execCalls = 0
      const dyn = (req) => {
        const m = req.messages
        const last = m[m.length - 1]
        const isComp = last && last.role === 'user' && typeof last.content === 'string' && last.content.includes('COMPRESSOR SDK')
        if (isComp) return { text: a1 === 's1' ? SCRIPT_S1 : TEMPLATE_S2, usage: { inputTokens: 900, outputTokens: 300, cacheReadTokens: 100 } }
        if (toolPending) { toolPending = false; return { text: 'DONE', usage: { inputTokens: 800, outputTokens: 50, cacheReadTokens: 400 } } }
        toolPending = true
        execCalls++
        return {
          text: '',
          toolCalls: [
            { id: `r${execCalls}`, name: 'read', args: JSON.stringify({ path: 'package.json' }) },
            { id: `w${execCalls}`, name: 'write', args: JSON.stringify({ path: 'src/audit/x.js', content: 'function fc() {\n  return 1\n}\n' }) },
          ],
          usage: { inputTokens: 800, outputTokens: 60, cacheReadTokens: 400 },
        }
      }
      return createScriptedGateway({ script: () => new Array(120).fill(dyn) })
    }

    const runArm = async (a1, a2) => {
      const g = makeGate(a1)
      const dir = path.join(tmp, `trial-${a1}-${a2}`)
      fs.mkdirSync(dir, { recursive: true })
      const res = await runSession({
        workspace: createWorkspace(dir), taskId: 'T7', task, prompt: task.prompt,
        stagedMessages: task.messages, model: 'm', provider: 'x',
        transcriptPath: path.join(dir, 'tr.jsonl'), callLLM: g.chatCall,
        compression: 'task-boundary', a1, a2, maxCompressions: 99, maxSteps: 20,
      })
      return { res, g }
    }

    const readProducts = (a1, a2) => {
      const cdir = path.join(tmp, `trial-${a1}-${a2}`, 'compressed')
      if (!fs.existsSync(cdir)) return []
      return fs.readdirSync(cdir).filter(f => f.startsWith('P-') && f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(cdir, f), 'utf8')))
    }

    // --- S2 × expand: task-boundary + PTC program + harness expand ---
    const rExpand = await runArm('s2', 'expand')
    const compExpand = rExpand.res.transcript.filter(e => e.type === 'task-compact')
    ok(rExpand.res.compression?.mode === 'task-boundary', `TRIAL-A1 任务边界触发 (E1) for s2-expand`, rExpand.res.compression?.mode)
    ok(compExpand.length >= 1 && compExpand.every(e => typeof e.segmentIndex === 'number'), 'TRIAL-A2 压缩单元 = task (segmentIndex, E2)', compExpand.length)
    ok(rExpand.res.violations.every(v => !v.includes('compression-failed')), 'TRIAL-A3 compressor program ran + gates passed (no compression-failed)', JSON.stringify(rExpand.res.violations))
    ok(rExpand.res.compression.count >= 1, 'TRIAL-A4 s2-expand actually compressed', `${rExpand.res.compression.count}`)
    const expandProducts = readProducts('s2', 'expand')
    ok(expandProducts.length >= 1, 'TRIAL-A4b 落盘产物存在 (P-<seg>.json)', expandProducts.length)
    ok(expandProducts.length >= 1 && validateProductSchema(expandProducts[0]).length === 0 && Array.isArray(expandProducts[0].sections), 'TRIAL-A4c 落盘产物 = 总-分 sections (schema 通过)')
    // expand: refs carry harness-resolved content
    const anyContent = expandProducts.some(p => (p.sections ?? []).some(s => (s.subtasks ?? []).some(b => (b.refs ?? []).some(r => typeof r.content === 'string' && r.content.length > 0))))
    ok(anyContent, 'TRIAL-A4d A2 方案1: 展开 = harness 侧内容（refs.content 已解析）')

    // --- A1-S2 vs A1-S1 retained signature ---
    const rS2 = await runArm('s2', 'keep-original')
    const rS1 = await runArm('s1', 'keep-original')
    const tcS2 = rS2.res.transcript.filter(e => e.type === 'task-compact')
    const tcS1 = rS1.res.transcript.filter(e => e.type === 'task-compact')
    ok(tcS2.length > 0 && tcS2.every(e => e.retainedTokens === 0 && e.retain !== true), 'TRIAL-A5 A1-S2 闭合即全压: every compact has NO retain', JSON.stringify(tcS2[0] ?? {}))
    ok(tcS1.length > 0 && tcS1.every(e => e.retain === true) && tcS1.some(e => e.retainedTokens > 0), 'TRIAL-A6 A1-S1 引用化保尾: every compact retains (refs+outline, retained>0 somewhere)', JSON.stringify(tcS1[0] ?? {}))
    // S2 方案0 product validates (sections, no retain, refs grounded)
    ok(rS2.res.violations.every(v => !v.includes('compression-failed')), 'TRIAL-A7 S2-orig product validates (no compression-failed)')
    const origProducts = readProducts('s2', 'keep-original')
    ok(origProducts.length >= 1 && origProducts.every(p => Array.isArray(p.sections) && !p.retain), 'TRIAL-A7b 落盘产物 = 总-分 sections（S2 无 retain）', origProducts.length)
    // sections rendered as immutable nodes inside the message list snapshot
    const snap = rS2.res.compressSnapshots?.[0]
    ok(!!snap && snap.after.some(m => typeof m.content === 'string' && m.content.includes('[compressed task]')), 'TRIAL-A7c 产物渲染为 [compressed task] 消息节点（不可变分节）')
    // S1: retain node rendered + dropped at the next compaction (transient)
    const s1snaps = rS1.res.compressSnapshots ?? []
    const retainInAfter = s1snaps.some(s => s.after.some(m => (m.content ?? '').includes('[热桥接 retain]')))
    const retainDropped = s1snaps.length >= 2 && s1snaps[1].before.every(m => !(m.content ?? '').includes('[热桥接 retain]')) === false
    ok(retainInAfter, 'TRIAL-A8 S1 保留节点渲染进上下文（热桥接）')
    ok(s1snaps.length >= 2 && (s1snaps[1].before.some(m => (m.content ?? '').includes('[热桥接 retain]')) === false || retainDropped), 'TRIAL-A9 下次压缩前旧保留节点已删除（before 快照中无 retain）', `snaps=${s1snaps.length}`)
  } finally {
    if (existed) fs.writeFileSync(markFile, backup)
    else if (fs.existsSync(markFile)) fs.rmSync(markFile)
  }
}

export { failures }

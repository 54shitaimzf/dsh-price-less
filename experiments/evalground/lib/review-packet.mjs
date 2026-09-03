/**
 * Review packet — the batch-mode human review surface.
 *
 * One self-contained page (review-packet.html) lists EVERY pending human
 * dimension in experiment order: task info, anchors, and inline evidence
 * (staticified panels rendered in iframe srcdoc; document full text in
 * <pre>). The reviewer scrolls top→bottom, clicks 0–5 per block (or "?" =
 * unsure→3), exports one JSON, and the CLI imports it in one pass:
 *
 *   npm run human:review -- --packet           # generate + open the packet
 *   npm run human:review -- --import=scores.json   # apply + merge everything
 *
 * No file hunting, no cell hunting: everything the reviewer needs for a
 * dimension lives inside its block. Progress persists to localStorage so an
 * accidental refresh never loses clicks.
 */
import fs from 'node:fs'
import path from 'node:path'
import { HUMAN_DIMS, HUMAN_DIM_ANCHORS } from './human-packet.mjs'

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Discover every run that still needs (or, with force, owns) human scoring.
 * Shared by the interactive session and the packet builder.
 */
export function collectPendingRuns(runsDir, { onlyTask, onlyRun, force, tasksDir } = {}) {
  const tdir = tasksDir ?? path.join(path.dirname(runsDir), 'tasks')
  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('T'))
    .map(e => e.name)
    .sort()
    .map(name => {
      const scPath = path.join(runsDir, name, 'scorecard.json')
      if (!fs.existsSync(scPath)) return null
      const sc = JSON.parse(fs.readFileSync(scPath, 'utf8'))
      const taskFile = fs.readdirSync(tdir).find(f => f.startsWith(sc.task) && f.endsWith('.json'))
      if (!taskFile) return null
      const task = JSON.parse(fs.readFileSync(path.join(tdir, taskFile), 'utf8'))
      const dims = (HUMAN_DIMS[sc.task] ?? []).map(d => ({ ...d }))
      if (!task || dims.length === 0 || (task.track?.human ?? 0) === 0) return null
      if (!force && !sc.humanPending) return null
      if (onlyTask && sc.task !== onlyTask) return null
      if (onlyRun && !name.includes(onlyRun)) return null
      return { runDir: path.join(runsDir, name), name, sc, task, dims }
    })
    .filter(Boolean)
}

function collectEvidence(runDir, taskId) {
  const evDir = path.join(runDir, 'human-evidence')
  const out = { panel: null, texts: [], others: [] }
  if (!fs.existsSync(evDir)) return out
  for (const f of fs.readdirSync(evDir).sort()) {
    const p = path.join(evDir, f)
    if (f === 'panel-static.html' && (taskId === 'T3' || taskId === 'T7')) {
      out.panel = { name: f, html: fs.readFileSync(p, 'utf8') }
    } else if (/\.(md|txt)$/.test(f)) {
      out.texts.push({ name: f, text: fs.readFileSync(p, 'utf8') })
    } else {
      out.others.push(f)
    }
  }
  return out
}

/**
 * Build the full review packet page for the given runs.
 * The panel HTML payload is stored JSON-escaped (< → \u003c) so a model
 * </script> can never break out of the data block.
 */
export function buildPacketHtml(runs, opts = {}) {
  const blocks = []
  const panels = {}
  let panelSeq = 0
  for (const r of runs) {
    const ev = collectEvidence(r.runDir, r.sc.task)
    if (ev.panel) panels[`p${panelSeq++}`] = ev.panel.html
    for (const dim of r.dims) {
      const anchors = HUMAN_DIM_ANCHORS[dim.dim] ?? {}
      let evidenceHtml = ''
      if (ev.panel) {
        const pid = `p${panelSeq - 1}`
        evidenceHtml += `<details open class="ev"><summary>面板渲染（真实静态页，非截图）</summary>
          <div class="shot"><iframe data-panel="${pid}" title="${esc(r.sc.task)} panel"></iframe></div>
          <div class="hint">调阅源码/截图：<code>runs/${esc(r.name)}/human-evidence/</code></div></details>`
      }
      for (const t of ev.texts) {
        evidenceHtml += `<details open class="ev"><summary>证据全文：${esc(t.name)}（${t.text.split(/\r?\n/).length} 行）</summary>
          <pre>${esc(t.text)}</pre></details>`
      }
      const weight = dim.weight
      blocks.push(`<section class="blk" data-run="${esc(r.name)}" data-task="${esc(r.sc.task)}" data-dim="${esc(dim.dim)}">
  <div class="hd"><span class="tag">${esc(r.sc.task)}</span><strong>${esc(dim.name)}</strong>
    <span class="w">权重 ${weight}%</span><span class="run">${esc(r.name)}</span>
    <span class="st" data-st>待评</span></div>
  <div class="q">${esc(anchors.question ?? dim.dim)}</div>
  <div class="anch">${['0', '1', '2', '3', '4', '5'].map(b =>
    `<div class="a"><b>${b}</b> ${esc(anchors[b] ?? '')}</div>`).join('')}</div>
  ${evidenceHtml}
  <div class="ctl" data-ctl>
    ${[0, 1, 2, 3, 4, 5].map(s => `<button data-s="${s}" type="button">${s}</button>`).join('')}
    <button data-s="?" type="button" title="不确定：记 3" class="qbtn">?</button>
  </div>
</section>`)
    }
  }
  const payload = JSON.stringify(panels).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>评审单 · Eval Ground Human Review</title>
<style>
:root { --line:#d8dee6; --ink:#1e2733; --sub:#5b6675; --acc:#2563eb; --ok:#16a34a; --warn:#d97706; }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.55 "Segoe UI", system-ui, sans-serif; color:var(--ink); background:#f4f6f9; }
header { position:sticky; top:0; z-index:5; background:#fff; border-bottom:1px solid var(--line);
  padding:10px 18px; display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
header h1 { font-size:17px; margin:0; }
header .bar { flex:1; min-width:140px; height:8px; border-radius:4px; background:#e5e9ef; overflow:hidden; }
header .bar i { display:block; height:100%; width:0; background:var(--ok); transition:width .2s; }
header button { border:1px solid var(--line); background:#fff; border-radius:6px; padding:6px 14px; cursor:pointer; font-size:13px; }
header #exportB { background:var(--acc); border-color:var(--acc); color:#fff; }
.hint2 { font-size:12px; color:var(--sub); }
main { max-width:980px; margin:16px auto; padding:0 12px 40px; }
.blk { background:#fff; border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:16px 0; }
.hd { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.tag { background:#eef2ff; color:#3730a3; border-radius:5px; padding:1px 8px; font-weight:700; font-size:13px; }
.w { color:var(--sub); font-size:12px; }
.run { color:var(--sub); font-size:12px; font-family:Consolas, monospace; }
.st { margin-left:auto; font-size:12px; border-radius:9px; padding:1px 9px; background:#e5e9ef; color:var(--sub); }
.st.done { background:#dcfce7; color:var(--ok); } .st.unsure { background:#fef3c7; color:var(--warn); }
.q { margin:10px 0 4px; font-weight:600; }
.anch { display:grid; grid-template-columns:1fr 1fr; gap:3px 18px; color:var(--sub); font-size:13px; margin:6px 0 10px; }
.anch .a b { color:var(--ink); display:inline-block; min-width:16px; }
.ev { border:1px solid var(--line); border-radius:8px; margin:8px 0; }
.ev summary { cursor:pointer; padding:7px 11px; font-size:13px; }
.ev pre { margin:0; max-height:420px; overflow:auto; padding:10px 12px; background:#fafbfc; font:12px/1.5 Consolas, monospace; white-space:pre-wrap; word-break:break-word; }
.shot iframe { width:100%; height:640px; border:0; background:#fff; }
.hint { font-size:12px; color:var(--sub); padding:0 11px 8px; }
.ctl { display:flex; gap:8px; margin-top:10px; }
.ctl button { min-width:44px; padding:7px 0; border:1px solid var(--line); background:#fff; border-radius:7px;
  font-size:14px; cursor:pointer; }
.ctl button.on { background:var(--acc); border-color:var(--acc); color:#fff; font-weight:700; }
.ctl button.qbtn { min-width:38px; }
</style></head>
<body>
<header>
  <h1>评审单</h1>
  <span class="bar"><i id="prog"></i></span>
  <span id="cnt" class="hint2">0/0</span>
  <button id="resetB" type="button">清空已选</button>
  <button id="exportB" type="button">导出评分 JSON</button>
</header>
<main>
<div class="blk" style="background:#eef6ff;border-color:#bfdbfe">
<b>操作（从头到尾一项一项过，全部在页内完成）：</b>
<ol style="margin:6px 0 0">
<li>每一块 = 一个待评维度：评分结构、判据、锚点、证据（面板已真实渲染、文档全文已内联）都在块内。</li>
<li>对照锚点点击 <b>0–5</b> 打分（绝对档，不与任何基线/参考挂钩）；拿不准点 <b>?</b>（记 3 分并标注 unsure）；不评就跳过不点。</li>
<li>打完点右上角 <b>导出评分 JSON</b>，把 <code>human-scores.json</code> 放到 evalground 目录，运行
<code>npm run human:review -- --import=human-scores.json</code> 一次全部合并。</li>
</ol>
</div>
${blocks.join('\n')}
</main>
<script>
const PANEL_SRC = ${payload};
const store = {
  get(r, d) { try { return localStorage.getItem('eg-rv:' + r + ':' + d) } catch { return null } },
  set(r, d, v) { try { localStorage.setItem('eg-rv:' + r + ':' + d, v) } catch {} },
  del(r, d) { try { localStorage.removeItem('eg-rv:' + r + ':' + d) } catch {} },
};
document.querySelectorAll('iframe[data-panel]').forEach(ifr => {
  const src = PANEL_SRC[ifr.dataset.panel];
  if (src) ifr.srcdoc = src;
});
function refresh() {
  const secs = [...document.querySelectorAll('.blk[data-run]')];
  let done = 0;
  for (const s of secs) {
    const r = s.dataset.run, d = s.dataset.dim, v = store.get(r, d);
    const st = s.querySelector('.st');
    if (v != null) { done++; }
    s.querySelectorAll('.ctl button').forEach(b => b.classList.toggle('on', b.dataset.s === v));
    st.textContent = v == null ? '待评' : v === '?' ? '不确定→3' : '已评 ' + v;
    st.className = 'st' + (v == null ? '' : v === '?' ? ' unsure' : ' done');
  }
  const total = secs.length;
  document.getElementById('prog').style.width = (total ? Math.round(done / total * 100) : 0) + '%';
  document.getElementById('cnt').textContent = done + '/' + total;
}
document.querySelectorAll('.blk[data-run]').forEach(s => {
  const r = s.dataset.run, d = s.dataset.dim;
  s.querySelectorAll('.ctl button').forEach(b => b.addEventListener('click', () => {
    const v = store.get(r, d) === b.dataset.s ? null : b.dataset.s;
    if (v == null) store.del(r, d); else store.set(r, d, v);
    refresh();
  }));
});
document.getElementById('resetB').addEventListener('click', () => {
  document.querySelectorAll('.blk[data-run]').forEach(s => store.del(s.dataset.run, s.dataset.dim));
  refresh();
});
document.getElementById('exportB').addEventListener('click', () => {
  const out = [];
  document.querySelectorAll('.blk[data-run]').forEach(s => {
    const v = store.get(s.dataset.run, s.dataset.dim);
    if (v == null) return;
    out.push({ run: s.dataset.run, task: s.dataset.task, dim: s.dataset.dim,
      score: v === '?' ? 3 : Number(v), notes: v === '?' ? 'unsure' : '' });
  });
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'human-scores.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
refresh();
</script>
</body></html>`
}

/** Write the packet and return its path. */
export function writePacket(runs, outHtml) {
  fs.writeFileSync(outHtml, buildPacketHtml(runs))
  return outHtml
}
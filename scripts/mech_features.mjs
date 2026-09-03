/**
 * mech_features：机械判别器的粒度升级特征（全部确定性、无时间、无模型）。
 *
 * 静态特征（与段状态无关，可一次性预计算，按 U）：
 *   F1  correction 双语两级：f1Strong / f1Fine（方向否决级 vs 细节修正级）
 *   F2  lexical 双语话语标记：f2Lex（加权命中数）
 *   F5  liveness/escape 类别：f5Dump（转储类=低存活）/ f5Goal（目标/约束类=高存活）
 *   F6s 词汇衔接（前序）：f6Prev = jaccard(本 U, 上一用户消息)
 *   F7  工具形态：本 U exchange 内工具类别直方图（read/write/exec/config/other → f7R/f7W/f7X/f7C/f7O）
 *   F9  语用：f9Question / f9Imperative / f9LenRatio
 *
 * 动态特征（依赖段状态[anchor/seenDirs/lastBoundary/lastTodo]，由评分器在回放中注入）：
 *   F3  cluster 连续化：f3PendingCount / f3JaccardDrop / f3NewDirRatio
 *   F4  todo 连续化：f4Ratio（完成比）/ f4Delta（相对上次边界快照）
 *   F6a 词汇衔接（锚）：f6Anchor = jaccard(本 U, 当前任务锚)；f6Dip = 1 - max(f6Anchor, f6Prev)
 *   F8  run-length 软先验：f8RunLen = u - lastBoundaryU
 */

/** 词元化：拉丁词（小写） + CJK 单字/复字（按 2-gram 近似；确定性）。 */
export function tokenize(text) {
  const t = String(text ?? '').toLowerCase()
  const out = []
  for (const m of t.matchAll(/[a-z0-9_][a-z0-9_\-.]*/g)) out.push(m[0])
  // CJK：2-gram（窗口 1 步）
  const cjk = t.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? []
  for (const run of cjk) {
    if (run.length === 1) { out.push(run); continue }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
  }
  return out
}

/** Jaccard 相似度（集合）。 */
export function jaccard(a, b) {
  const sa = new Set(a); const sb = new Set(b)
  if (sa.size === 0 && sb.size === 0) return 0
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter++
  const uni = sa.size + sb.size - inter
  return uni === 0 ? 0 : inter / uni
}

/* ---------------- F1 correction（双语两级） ---------------- */

const CORR_STRONG = new RegExp(
  [
    // EN direction-veto
    '^(no|stop|wait|hold on|wrong|incorrect|cut|scratch|ignore|abandon|revert|undo)\\b',
    '\\b(wrong direction|not what i meant|that\'s not it|you missed|don\'t do\\b|do not do\\b|stop doing|stop that|never mind|scratch that|forget it|on second thought|instead,? try|actually,? (no|stop|wait)|not (that|this|the point))\\b',
    // ZH direction-veto
    '不是这样|不要这样|不是我说的|不是我要的|重新来|方向不对|理解错了|太理想化|不现实|先别动手|停下|别做了|不对，？|错了，？|其实不是|完全不对|根本没|你搞错了|思路不对|这样不对',
  ].join('|'),
  'i',
)
const CORR_FINE = new RegExp(
  [
    '(but|however|yet|except),? (please )?(don\'t|do not|use|change|try|fix|rename|move|delete|add|make)',
    '(should|please|better to|instead of|rather than)\\b',
    '不如|应该|最好是|换成|改成|不要改|别用|其实可以|试试|用.{0,4}(代替|替换)|把.{0,6}改为|保持.{0,6}不变|只保留',
  ].join('|'),
  'i',
)

/** F1：返回 {f1Strong, f1Fine}（命中 0/1 加权：强=1，细=0.4）。 */
export function correctionFeatures(text) {
  const s = CORR_STRONG.test(text) ? 1 : 0
  const f = CORR_FINE.test(text) ? 0.4 : 0
  return { f1Strong: s, f1Fine: f }
}

/* ---------------- F2 lexical（双语话语标记，分级权重） ---------------- */

const LEX_STRONG = new RegExp(
  [
    '\\b(next|ok(ay)?|alright|well|so|now),? (let\'s|we|i|please|start|move|go|do)',
    '\\b(new task|next task|new goal|fresh start|start over|from scratch|switch to|move on to|now for|let\'s (now )?(do|start|write|implement|build|create|set up|add|try))\\b',
    '接下来的|接下来我们|现在我们|好，？我们|好了，？现在|开始做|开始实现|开始写|新任务|新目标|转为|切换(到|为)|下一步|我们来做|现在开始',
    // FR strong（claudeset 语料语义为法语会话）
    '\\b(nouvelle approche|nouveau (projet|plan|sujet|début)|passons|poursuivons|commençons|on (va|passe|continue|va faire)|maintenant, (on|je|nous|il)|prochaine (étape|tâche)|repartir de zéro|à zéro|autre chose|suivant|changeons)\\b',
  ].join('|'),
  'i',
)
const LEX_WEAK = new RegExp(
  [
    '\\b(also|additionally|separately|meanwhile|besides|apart from|anyway|moving on|meanwhile,? let\'s|one more|another (thing|issue|task)|as for)\\b',
    '另外|顺便|此外|还有一件事|换个(角|话题)|再(说|来)一个|对(了|于)|还有个',
    // FR weak
    '\\b(aussi|également|ensuite|puis|en plus|de plus|par ailleurs|sinon|autre (chose|problème|sujet)|enfin|voilà,? pour|à côté)\\b',
  ].join('|'),
  'i',
)

/** F2：返回 {f2Lex}（强=1.0 每类，弱=0.3 每类，上限 2）。 */
export function lexicalFeatures(text) {
  let s = 0
  if (LEX_STRONG.test(text)) s += 1
  if (LEX_WEAK.test(text)) s += 0.3
  return { f2Lex: Math.min(s, 2) }
}

/* ---------------- F5 liveness / escape 类别 ---------------- */

const DUMP_PATTERNS = [
  /```/,                                             // 代码围栏
  /(^|\n)([a-z0-9_\-]+@[a-z0-9\-]+:|Traceback \(most recent call last\)|SyntaxError|TypeError|ReferenceError|ERR_|E[A-Z]+\:\s|Error:|error code \d+|\d+ failed|npm (err|error)|exit code [1-9])/i,
  /(^|\n)(\$|>|#)\s+[a-z0-9_\-\.]+(\s+.+){0,3}\s*(\n|$)/m,   // 命令转储
  /(no such file|not found|command not found|can't find|compilation failed|build failed|test failed)/i,
]
const GOAL_PATTERNS = [
  /(must|should|need (to|it)|required|ensure|make sure|guarantee|always|never|only|no longer|don't|do not|cannot|keep|maintain|still)/i,
  /(我要|我希望|我需要|必须|确保|保证|不要|不能|只|不再|保持|继续|仍然|要求|请(你|务必)(注意|确保|记住|不要))/,
]

/** F5：返回 {f5Dump, f5Goal} ∈ [0,1]（命中即 1）。 */
export function livenessFeatures(text) {
  const dump = DUMP_PATTERNS.some(p => p.test(text)) ? 1 : 0
  const goal = GOAL_PATTERNS.some(p => p.test(text)) ? 1 : 0
  return { f5Dump: dump, f5Goal: goal }
}

/* ---------------- F9 语用 ---------------- */

export function pragmaticFeatures(text, prevLens) {
  const q = /\?\s*$|[吗呢么]\s*[？?]?$/.test(text.trim()) ? 1 : 0
  const imp = /^(please |(could|can|would|will) you |请你|帮我|给我|请|麻烦|来一下|开始|写|实现|做|整理|修复|创建|加|改|删|检查|测试|跑)/i.test(text.trim()) ? 1 : 0
  const len = text.length
  let med = len
  if (prevLens.length > 0) {
    const arr = [...prevLens].sort((a, b) => a - b)
    med = arr[Math.floor(arr.length / 2)] || 1
  }
  const ratio = med === 0 ? 1 : Math.min(len / med, 4) / 4
  return { f9Question: q, f9Imperative: imp, f9LenRatio: ratio }
}

/* ---------------- F7 工具形态（本 exchange） ---------------- */

const TOOL_CLASSES = {
  read: ['read', 'glob', 'grep', 'ls', 'read_image', 'search', 'list'],
  write: ['write', 'edit', 'patch'],
  exec: ['bash', 'pwsh', 'cmd', 'shell', 'run', 'execute'],
  config: ['enterplan', 'exitplan', 'task', 'todo', 'todowrite'],
}

export function toolClassHistogram(tools) {
  const h = { f7R: 0, f7W: 0, f7X: 0, f7C: 0, f7O: 0 }
  for (const t of tools ?? []) {
    const n = String(t.name ?? '').toLowerCase()
    if (TOOL_CLASSES.read.includes(n)) h.f7R++
    else if (TOOL_CLASSES.write.includes(n)) h.f7W++
    else if (TOOL_CLASSES.exec.includes(n)) h.f7X++
    else if (TOOL_CLASSES.config.includes(n)) h.f7C++
    else h.f7O++
  }
  return h
}

/* ---------------- 静态特征打包 ---------------- */

/** 对 canonical session 的全部 U 计算静态特征（含 f6Prev / f9 需要的 prevLens）。 */
export function staticFeatures(session) {
  const out = []
  const prevLens = []
  let prevText = ''
  for (const u of session.us) {
    const text = u.text
    const c = correctionFeatures(text)
    const l = lexicalFeatures(text)
    const lv = livenessFeatures(text)
    const pr = pragmaticFeatures(text, prevLens)
    const th = toolClassHistogram(u.tools)
    const f6Prev = prevText.length > 0 ? jaccard(tokenize(text), tokenize(prevText)) : 0
    out.push({ u: u.u, ...c, ...l, ...lv, ...pr, ...th, f6Prev })
    prevLens.push(text.length)
    if (prevLens.length > 16) prevLens.shift()
    prevText = text
  }
  return out
}

/* ---------------- 动态特征（由回放器注入段状态） ---------------- */

/**
 * 在给定段状态下计算动态特征。
 * state: { anchorText, seenDirs, pendingDir, pendingDirCount, lastTodo, lastBoundaryU, recentDirs }
 * recentDirs = 最近 K 次文件工具访问的 dir（窗口，固定 K=6）。
 */
export function dynamicFeatures(session, u, staticF, state) {
  const text = u.text
  const f3PendingCount = state.pendingDirCount
  // 最近窗口 dir vs 段内已见 dir 的 Jaccard（越大越熟悉，越小越像簇迁移）
  const win = [...new Set(state.recentDirs)]
  const seen = [...new Set(state.seenDirs)]
  const f3JaccardDrop = 1 - jaccard(win, seen)
  // 新目录占比：窗口 dir 中不在 seenDirs 的比例
  const f3NewDirRatio = win.length === 0 ? 0 : win.filter(d => !seen.includes(d)).length / win.length
  const f4Ratio = state.lastTodo === null ? 0 : state.lastTodo
  const f4Delta = Math.max(0, state.lastTodo - (state.todoAtBoundary ?? 0))
  const anchorJac = state.anchorText.length > 0 ? jaccard(tokenize(text), tokenize(state.anchorText)) : 0
  const f6Dip = 1 - Math.max(anchorJac, staticF.f6Prev ?? 0)
  const f8RunLen = u.u - (state.lastBoundaryU ?? -1) - 1
  return { f3PendingCount, f3JaccardDrop, f3NewDirRatio, f4Ratio, f4Delta, f6Anchor: anchorJac, f6Dip, f8RunLen }
}

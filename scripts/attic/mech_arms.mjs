/**
 * mech_arms：判定器臂（M0–M7）— 全部为确定性纯函数回放。
 *
 * 回放引擎（per session，U 序）：
 *   per-U：静态特征（预计算）+ 动态特征（段状态）→ 臂打分 → 若开火：切割（记录 U），重置段状态。
 *   段状态：{ anchorText, seenDirs, pendingDir, pendingDirCount, lastTodo, todoAtBoundary, lastBoundaryU, recentDirs }
 *
 * M0 基线 = 生产原样：直接复用 lib/task/boundary.js 的
 *   isUserCorrection / hasLexicalBoundaryHint / evaluateClusterShift / isTodoAllCompleted / decideBoundary。
 *   （生产事件流 vs 本回放：以 user 消息为判界单位，信号累积于"该 U 的 exchange"后判定——与 probe19 转换同口径。）
 *
 * 臂：
 *   M0  生产 decideBoundary（二元信号、固定权重、1.0 + 强信号门）
 *   M1  连续线性：旧信号族升级连续化（correction/lexical/cluster/todo）+ θ + 可选强门
 *   M2  M1 + F6 词汇衔接（cohesion dip 加权）
 *   M3  M2 + F5 存活类别（dump 低配重 / goal 高配重）
 *   M4  M3 + F8 run-length 软先验（sigmoid；替代硬间隔）
 *   M5  M4 + 级联置信带（中带 → F5+F6 二段复判）
 *   M6  M4 + 硬最小切割间隔（对照臂）
 *   M7  M1 仅旧信号族（无新特征）→ 隔离"参数 vs 特征"贡献
 */
import {
  isUserCorrection,
  hasLexicalBoundaryHint,
  evaluateClusterShift,
  isTodoAllCompleted,
  decideBoundary,
} from '../lib/task/boundary.js'
import { dynamicFeatures } from './mech_features.mjs'

const ROLL_WINDOW = 6

function initState() {
  return {
    anchorText: '',
    seenDirs: [],
    pendingDir: null,
    pendingDirCount: 0,
    lastTodo: null,
    todoAtBoundary: 0,
    lastBoundaryU: -1,
    recentDirs: [],
  }
}

function resetState(afterU, anchorText) {
  return {
    anchorText,
    seenDirs: [],
    pendingDir: null,
    pendingDirCount: 0,
    lastTodo: null,
    todoAtBoundary: 0,
    lastBoundaryU: afterU,
    recentDirs: [],
  }
}

/** 吸收一个 U 的工具/todo 到段状态（簇上下文 + todo 快照）。 */
function absorbTools(state, u) {
  const cluster = { seenDirs: state.seenDirs, pendingDir: state.pendingDir, pendingDirCount: state.pendingDirCount }
  let shiftedAny = false
  const seen = new Set([...cluster.seenDirs])
  let pd = cluster.pendingDir
  let pdc = cluster.pendingDirCount
  let recent = [...state.recentDirs]
  for (const t of u.tools ?? []) {
    const dir = t.dir
    if (dir.length === 0) continue
    const r = evaluateClusterShift(
      { seenDirs: [...seen], pendingDir: pd, pendingDirCount: pdc },
      dir,
    )
    seen.clear(); r.next.seenDirs.forEach(d => seen.add(d))
    pd = r.next.pendingDir
    pdc = r.next.pendingDirCount
    if (r.shifted) {
      shiftedAny = true
      pd = null
      pdc = 0
    }
    recent.push(dir)
    if (recent.length > ROLL_WINDOW) recent = recent.slice(-ROLL_WINDOW)
  }
  let lastTodo = state.lastTodo
  if ((u.todos ?? []).length > 0) {
    const done = u.todos.filter(t => t.status === 'completed').length
    lastTodo = done / u.todos.length
  }
  return {
    ...state,
    seenDirs: [...seen],
    pendingDir: pd,
    pendingDirCount: pdc,
    lastTodo,
    recentDirs: recent,
    pendingShiftSinceLastBoundary: (state.pendingShiftSinceLastBoundary ?? 0) + (shiftedAny ? 1 : 0),
  }
}

/** M0：生产原样判定（binary signals）。 */
export function armM0(session, staticF, params = {}) {
  const cuts = []
  let state = initState()
  for (const u of session.us) {
    const text = u.text
    const signals = []
    if (u.u === 0) signals.push('implicit-start')
    if (isUserCorrection(text)) signals.push('user-correction')
    if (hasLexicalBoundaryHint(text)) signals.push('lexical-hint')
    if ((state.pendingShiftSinceLastBoundary ?? 0) > 0) signals.push('file-cluster-shift')
    const todoEvent = { data: { todos: u.todos ?? [] } }
    if (u.todos && u.todos.length > 0 && isTodoAllCompleted(todoEvent)) signals.push('todo-completed')
    if (u.u === 0) {
      state = resetState(u.u, text)
      cuts.push(u.u)
      state = absorbTools(state, u)
      continue
    }
    const verdict = decideBoundary(signals)
    if (verdict === 'boundary') {
      cuts.push(u.u)
      state = resetState(u.u, text)
      state = absorbTools(state, u)
    } else {
      state = absorbTools(state, u)
    }
  }
  return cuts
}

/* ---------------- 连续臂共用 ---------------- */

const FEAT_KEYS = {
  corr: s => s.f1Strong + s.f1Fine,
  lex: s => s.f2Lex,
  cluster: (s, d) => Math.min(1, d.f3PendingCount / 3) + d.f3NewDirRatio * 0.5 + d.f3JaccardDrop * 0.5,
  todo: (s, d) => d.f4Ratio + d.f4Delta * 0.5,
  cohesion: (s, d) => d.f6Dip,
  dump: s => s.f5Dump,
  goal: s => s.f5Goal,
  runlen: (s, d) => d.f8RunLen,
  question: s => s.f9Question,
  imperative: s => s.f9Imperative,
  lenratio: s => s.f9LenRatio,
  toolwrite: s => s.f7W,
  toolread: s => s.f7R,
}

/**
 * 连续线性打分：score = Σ w_k · φ_k(静态, 动态) + bias；boundary iff score >= θ 且 (strong-gate ? 有强信号 : true)。
 * 强信号 = f1Strong 或 f2Lex>=1（"方向否决/显式切换"）。
 */
function linearScore(s, d, w, bias) {
  let score = bias
  for (const [k, v] of Object.entries(w)) {
    const f = FEAT_KEYS[k]
    if (!f || !v) continue
    score += v * f(s, d)
  }
  return score
}

function runlenPrior(d, mu, sigma) {
  const z = (d.f8RunLen - mu) / sigma
  return 1 / (1 + Math.exp(-z))
}

/** 通用回放：把 arm+params 应用到一个 session。 */
export function replayArm(session, staticF, scorer, opts = {}) {
  const { strongGate = false, minInterval = 0, mu = 3, sigma = 2, band = null, secondStage = null } = opts
  const cuts = []
  let state = initState()
  for (const u of session.us) {
    const text = u.text
    const sf = staticF[u.u]
    if (u.u === 0) {
      state = resetState(u.u, text)
      state = absorbTools(state, u)
      cuts.push(0)
      continue
    }
    const d = dynamicFeatures(session, u, sf, state)
    let raw = scorer(sf, d)
    // M4 soft prior：乘法调制（0.5→1.0 幅度）
    if (opts.useRunlen !== false && mu !== null) {
      const p = runlenPrior(d, mu, sigma)
      raw = raw * (0.5 + 0.5 * p)
    }
    // 硬间隔（M6 对照）
    if (minInterval > 0 && d.f8RunLen < minInterval) {
      state = absorbTools(state, u)
      continue
    }
    const strong = sf.f1Strong === 1 || sf.f2Lex >= 1
    if (strongGate && !strong) {
      state = absorbTools(state, u)
      continue
    }
    let fire = raw >= opts.theta
    if (fire && band) {
      // M5 级联：中带 → 二段复判
      if (raw >= band[0] && raw < band[1] && secondStage) {
        fire = secondStage(sf, d)
      }
    }
    if (fire) {
      cuts.push(u.u)
      state = resetState(u.u, text)
      state = absorbTools(state, u)
    } else {
      state = absorbTools(state, u)
    }
  }
  return cuts
}

/* ---------------- 臂工厂（返回完整 scorer 配置） ---------------- */

const W_DEFAULTS = {
  corr: 1.0, lex: 0.6, cluster: 0.5, todo: 0.4,
  cohesion: 0, dump: 0, goal: 0, runlen: 0,
  question: 0.05, imperative: 0.1, lenratio: 0.1, toolwrite: 0.1, toolread: 0.05,
}

/** M1：连续线性（全部连续特征在列，权重为参数；默认旧信号族权重、新特征 0）。 */
export function armM1(session, staticF, p) {
  const w = { ...W_DEFAULTS, ...p.w }
  return replayArm(session, staticF, (s, d) => linearScore(s, d, w, p.bias ?? 0), {
    theta: p.theta ?? 1.0, strongGate: p.strongGate ?? false, mu: null,
  })
}

/** M2 = M1 + cohesion；M3 = M2 + dump/goal；M4 = M3 + runlen 软先验 —— 均走 armM1 的 w 展开。 */
export function armM4(session, staticF, p) {
  const w = { ...W_DEFAULTS, ...p.w }
  return replayArm(session, staticF, (s, d) => linearScore(s, d, w, p.bias ?? 0), {
    theta: p.theta ?? 1.0, strongGate: p.strongGate ?? false,
    mu: p.mu ?? 3, sigma: p.sigma ?? 2,
  })
}

/** M5：级联置信带。 */
export function armM5(session, staticF, p) {
  const w = { ...W_DEFAULTS, ...p.w }
  const second = (s, d) => (s.f5Dump === 1 ? true : d.f6Dip >= (p.dip ?? 0.5))
  return replayArm(session, staticF, (s, d) => linearScore(s, d, w, p.bias ?? 0), {
    theta: p.theta ?? 1.0, strongGate: p.strongGate ?? false,
    mu: p.mu ?? 3, sigma: p.sigma ?? 2,
    band: p.band ?? [0.8, 1.2], secondStage: second,
  })
}

/** M6：M4 + 硬最小间隔（对照）。 */
export function armM6(session, staticF, p) {
  const w = { ...W_DEFAULTS, ...p.w }
  return replayArm(session, staticF, (s, d) => linearScore(s, d, w, p.bias ?? 0), {
    theta: p.theta ?? 1.0, strongGate: p.strongGate ?? false,
    minInterval: p.minInterval ?? 0,
    mu: p.mu ?? 3, sigma: p.sigma ?? 2,
  })
}

/** M7：M1 但只用旧信号族（corr/lex/cluster/todo）—— 隔离特征贡献。 */
export function armM7(session, staticF, p) {
  const w = { ...W_DEFAULTS, corr: 1.0, lex: 0.6, cluster: 0.5, todo: 0.4 }
  for (const k of ['cohesion', 'dump', 'goal', 'runlen', 'question', 'imperative', 'lenratio', 'toolwrite', 'toolread']) delete w[k]
  Object.assign(w, p.w ?? {})
  return replayArm(session, staticF, (s, d) => linearScore(s, d, w, p.bias ?? 0), {
    theta: p.theta ?? 1.0, strongGate: p.strongGate ?? false, mu: null,
  })
}

/** 臂注册表。 */
export const ARMS = {
  M0: { run: armM0, params: () => [] },
  M1: { run: armM1, params: p => ({ w: p.w, bias: p.bias ?? 0, theta: p.theta ?? 1.0, strongGate: p.strongGate ?? false }) },
  M2: { run: armM1, params: p => ({ w: p.w, bias: p.bias ?? 0, theta: p.theta ?? 1.0, strongGate: p.strongGate ?? false }) },
  M3: { run: armM1, params: p => ({ w: p.w, bias: p.bias ?? 0, theta: p.theta ?? 1.0, strongGate: p.strongGate ?? false }) },
  M4: { run: armM4, params: p => ({ w: p.w, bias: p.bias ?? 0, theta: p.theta ?? 1.0, strongGate: p.strongGate ?? false, mu: p.mu ?? 3, sigma: p.sigma ?? 2 }) },
  M5: { run: armM5, params: p => ({ w: p.w, bias: p.bias ?? 0, theta: p.theta ?? 1.0, strongGate: p.strongGate ?? false, mu: p.mu ?? 3, sigma: p.sigma ?? 2, band: p.band ?? [0.8, 1.2], dip: p.dip ?? 0.5 }) },
  M6: { run: armM6, params: p => ({ w: p.w, bias: p.bias ?? 0, theta: p.theta ?? 1.0, strongGate: p.strongGate ?? false, minInterval: p.minInterval ?? 0, mu: p.mu ?? 3, sigma: p.sigma ?? 2 }) },
  M7: { run: armM7, params: p => ({ w: p.w ?? {}, bias: p.bias ?? 0, theta: p.theta ?? 1.0, strongGate: p.strongGate ?? false }) },
}

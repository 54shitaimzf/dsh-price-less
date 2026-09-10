#!/usr/bin/env node
/**
 * 结构断言引擎（P0 §3.1 立面；P1 起 D 族/S2 修订按 P0 §8-1 协议追加）——docs/11 §1/§2/§4/§9 +
 * docs/10 §1 H2/H4/H6/H14 + docs/12 §2 固化为离线机械断言。规则命名空间：M/S/D；后续工单只追加
 * 规则 + 更新 tests/assert-structure.spec.ts 零位快照 + 补负/正样本，引擎与 CLI 零改动。
 * 输出确定性（P0 §6-2）：无时间戳、无 ANSI、路径 '/' 分隔；--json schema 冻结（P0 §8-2）。
 * exit：0 = 全过（含 vacuous）；1 = 有 fail；2 = 引擎自身异常。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @typedef {{ path: string, text: string }} RuleFile path 用 '/' 分隔
 * @typedef {{ rule: string, path: string, line?: number, message: string }} RuleIssue
 * @typedef {{ id: string, canon: string, appliesTo: (p: string) => boolean,
 *             check: (file: RuleFile, all: Map<string, string>) => Array<{ line?: number, message: string }> }} Rule
 */

const EXCLUDE = /(^|[\\/])(node_modules|lib|experiments|scripts|docs|datasets|reports|\.git)([\\/]|$)/
const SCAN_EXT = /\.(ts|tsx|mjs|css|json)$/
const ROOT_MANIFESTS = ['package.json', 'cordis.patch.yml', 'tsdown.config.ts', 'vitest.config.ts']; const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** 引擎侧文件收集：src/ client/ tests/ 递归（SCAN_EXT）+ 根清单；点项与 EXCLUDE 目录跳过。 */
export function collectFiles(root = ROOT) {
  const files = []
  const walk = (abs) => {
    for (const name of fs.readdirSync(abs).sort()) {
      if (name.startsWith('.')) continue
      const p = path.join(abs, name)
      const rel = path.relative(root, p).split(path.sep).join('/')
      if (EXCLUDE.test(rel)) continue
      if (fs.statSync(p).isDirectory()) walk(p)
      else if (SCAN_EXT.test(rel)) files.push({ path: rel, text: fs.readFileSync(p, 'utf8') })
    }
  }
  for (const base of ['src', 'client', 'tests']) { const abs = path.join(root, base); if (fs.existsSync(abs)) walk(abs) }
  for (const name of ROOT_MANIFESTS) { const abs = path.join(root, name); if (fs.existsSync(abs)) files.push({ path: name, text: fs.readFileSync(abs, 'utf8') }) }
  return files
}

/** 规则执行（纯）：appliesTo 命中 0 文件 → vacuous（显式可见，不算失败）；check 有 issue → fail。 */
export function runRules(files) {
  const all = new Map(files.map((f) => [f.path, f.text]))
  const rules = {}; const issues = []; const vacuous = []
  for (const rule of RULES) {
    const scoped = files.filter((f) => rule.appliesTo(f.path))
    if (scoped.length === 0) { vacuous.push(rule.id); rules[rule.id] = { status: 'vacuous', issueCount: 0 }; continue }
    const found = scoped.flatMap((f) => rule.check(f, all).map((i) => ({ rule: rule.id, path: f.path, line: i.line, message: i.message })))
    issues.push(...found)
    rules[rule.id] = { status: found.length > 0 ? 'fail' : 'pass', issueCount: found.length }
  }
  issues.sort((a, b) => cmp(a.rule, b.rule) || cmp(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0) || cmp(a.message, b.message))
  return { ok: issues.length === 0, rules, vacuous, issues }
}

/** @type {Rule[]} 规则表（语义冻结，改动只许追加；S2 于 P1 两次按工单修订放行面）。 */
export const RULES = [
  { id: 'M1', canon: 'docs/11 §1 表', appliesTo: (p) => p === 'package.json', check: (f) => {
    const pkg = JSON.parse(f.text)
    return [
      ...(pkg.name !== 'dsh-price-less' ? [{ message: `name must be 'dsh-price-less', got ${JSON.stringify(pkg.name ?? null)}` }] : []),
      ...(!/^\d+\.\d+\.\d+/.test(String(pkg.version)) ? [{ message: `version must match /^\\d+\\.\\d+\\.\\d+/, got ${JSON.stringify(pkg.version ?? null)}` }] : []),
    ] } },
  { id: 'M2', canon: 'docs/11 §1 表', appliesTo: (p) => p === 'package.json', check: (f) => {
    const peers = JSON.parse(f.text).peerDependencies ?? {}
    return ['@deepseek-ai/cordis', '@deepseek-ai/dsh-settings', 'schemastery']
      .filter((key) => { const v = peers[key]; return typeof v !== 'string' || !/[<^~>=]/.test(v) })
      .map((key) => ({ message: `peerDependencies.${key} missing or hardcoded exact version (range required), got ${JSON.stringify(peers[key] ?? null)}` })) } },
  { id: 'M3', canon: 'docs/11 §1 表', appliesTo: (p) => p === 'package.json', check: (f, all) => {
    const pkg = JSON.parse(f.text)
    const patch = (pkg.dsh ?? {}).bundle?.patch
    return [
      ...(patch !== './cordis.patch.yml' ? [{ message: `dsh.bundle.patch must be './cordis.patch.yml', got ${JSON.stringify(patch ?? null)}` }] : []),
      ...(!all.has('cordis.patch.yml') ? [{ message: 'cordis.patch.yml not found in file set' }] : []),
      ...(!Array.isArray(pkg.files) || !pkg.files.includes('cordis.patch.yml') ? [{ message: `files must include 'cordis.patch.yml' (npm pack bundle patch), got ${JSON.stringify(pkg.files ?? null)}` }] : []),
    ] } },
  { id: 'M4', canon: 'docs/11 §1 表 + package.json', appliesTo: (p) => p === 'package.json', check: (f) => {
    const pkg = JSON.parse(f.text)
    const c = (pkg.dsh ?? {}).client ?? {}
    return [
      ...(c.platform !== 'web' ? [{ message: `dsh.client.platform must be 'web', got ${JSON.stringify(c.platform ?? null)}` }] : []),
      ...(!Array.isArray(c.inject) || !c.inject.includes('react') || !c.inject.includes('@deepseek-ai/dsh-client-ui-slots') ? [{ message: "dsh.client.inject must be an array containing 'react' and '@deepseek-ai/dsh-client-ui-slots'" }] : []),
      ...(pkg.exports?.['./client'] == null ? [{ message: "exports['./client'] missing" }] : []),
    ] } },
  { id: 'M5', canon: 'docs/11 §1 表（入口铁律）', appliesTo: (p) => p === 'src/index.ts' || p === 'client/index.ts', check: (f) => {
    const reqs = f.path === 'src/index.ts'
      ? [['export const name', 'name'], ['export function apply', 'apply'], [/export\s*\{[^}]*\bConfig\b[^}]*\}/, 'Config re-export']]
      : [['export const name', 'name'], ['export const inject', 'inject'], ['export function apply', 'apply']]
    return reqs.filter(([pat]) => (pat instanceof RegExp ? pat.test(f.text) : f.text.includes(pat)) === false)
      .map(([, label]) => ({ message: `missing required export: ${label}` })) } },
  { id: 'S1', canon: 'docs/11 §2 依赖铁律 + §9', appliesTo: (p) => p.startsWith('src/core/'), check: (f) =>
    [/from\s+['"]@deepseek-ai\//, /from\s+['"]cordis/, /from\s+['"][^'"]*platform/]
      .filter((re) => re.test(f.text))
      .map((re) => ({ message: `core must not import harness/platform (type-only included), matches ${re}` })) },
  { id: 'S2', canon: 'docs/11 §9 + 10 §1 H4', appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'), check: (f) =>
    // 改史/写日志调用归口：.append( 只许 history（H4 改史）+ logger/ignorable-channel（log-only
    // 事实事件，后者属 docs/12 §2 可删除单元）。surfaceOp|sourceEventSeqs 不设路径禁令——
    // docs/10 §1 H1 输入面需读 surfaceOp、docs/11 §2 允许 core 本地重声明；写侧归口由本条 +
    // P6 类型级测试承接（P0 §8-3）。
    /\.append\(/.test(f.text) && f.path !== 'src/platform/history.ts' && f.path !== 'src/platform/logger.ts' && f.path !== 'src/platform/ignorable-channel.ts'
      ? [{ message: '.append( must only appear in src/platform/{history,logger,ignorable-channel}.ts (H4 改史归口 + P1 事实事件端口)' }]
      : [] },
  { id: 'S3', canon: 'docs/11 §4 纪律①', appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'), check: (f) => {
    const out = []; const lines = f.text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trimStart()
      if (!/['"]context-economy\//.test(lines[i]) || t.startsWith('//') || t.startsWith('*')) continue
      if (!/ignorable/.test(lines.slice(Math.max(0, i - 1), i + 4).join('\n'))) out.push({ line: i + 1, message: "'context-economy/*' event anchor without 'ignorable' in window [i-1, i+3] (heuristic v1, 11 §4 纪律①)" })
    }
    return out } },
  { id: 'S4', canon: 'docs/11 §2 依赖铁律', appliesTo: (p) => p.startsWith('client/'), check: (f) => /from\s+['"][^'"]*\.\.\/src\//.test(f.text) ? [{ message: 'client must not import host src via ../src/' }] : [] },
  { id: 'S5', canon: 'docs/11 §2（无 timer）', appliesTo: (p) => p.startsWith('src/') || p.startsWith('client/'), check: (f) => f.text.includes('setInterval(') ? [{ message: 'timer forbidden: host half is event-driven, no polling loop (docs/11 §2)' }] : [] },
  { id: 'D1', canon: 'docs/11 §4 纪律②', appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'), check: (f) => {
    const lines = f.text.split('\n'); const out = []
    for (let i = 0; i < lines.length; i++) if (/on\('session\/event'/.test(lines[i]) && /await/.test(lines.slice(i, i + 11).join('\n'))) out.push({ line: i + 1, message: 'firehose listener body contains await within 10 lines (async bypass required, 11 §4 纪律②: never block append)' })
    return out } },
  { id: 'D2', canon: 'docs/10 §1 H2/H6', appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'), check: (f) =>
    /on\('agent\/pre-step'|on\('tools\/execute'/.test(f.text) && !/return next\(/.test(f.text)
      ? [{ message: "waterfall listener (agent/pre-step | tools/execute) must return next() (docs/10 §1 H2/H6)" }]
      : [] },
  { id: 'D3', canon: 'docs/12 §2/§4', appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'), check: (f) =>
    // 解耦锁定（docs/12 §2）：ignorable 通道概念只许居于可删除单元（ignorable-channel.ts +
    // logger.ts 发射路径）——越界即红，保证上游合并后机制代码零改动的原子删除。
    // 能力探测 = 结构化常量 SESSION_LOG_INTENT（ea04b581a5），不再匹配 append.toString；
    // import/调用 emitFact 的路径同样锁死（事实发射只准经 logger.ts 的 emitCeFact 词汇表门）。
    // HC3 追加 setFactReplay（镜像事实回灌钩子）——与 setFactMirror 同级：低层注册名只许居于
    // 可删除单元，装配点走 logger.ts 的 register* 包装（index.ts 因此不出现通道概念）。
    (/IgnorableSessionEventMap|SESSION_LOG_INTENT|IgnorableChannel|setFactMirror|setFactReplay|factModeStats|emitFact\(|from\s+['"][^'"]*ignorable-channel[^'"]*['"]/).test(f.text) && f.path !== 'src/platform/ignorable-channel.ts' && f.path !== 'src/platform/logger.ts' && f.path !== 'src/domains/judge-facts.ts' && f.path !== 'src/domains/task-facts.ts' && f.path !== 'src/domains/optimize-facts.ts' && f.path !== 'src/domains/shear-facts.ts' && f.path !== 'src/domains/assemble-facts.ts' && f.path !== 'src/domains/compaction-facts.ts' && f.path !== 'src/domains/restore-facts.ts'
      ? [{ message: 'ignorable-channel concepts must stay in the removable unit (platform/ignorable-channel.ts + logger.ts emit path, docs/12 §2)' }]
      : [] },
    { id: 'D4', canon: 'docs/09 §1/§2 + docs/11 §2 + docs/13 §3.6',
      appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'),
      check: (f) => /(ctx\.storageDomain|storageDomain|defineDomain|domainTable)/.test(f.text)
        && f.path !== 'src/platform/storage.ts' && f.path !== 'src/index.ts'
        ? [{ message: 'storageDomain/defineDomain/domainTable must only appear in platform/storage.ts (index.ts wiring allowed, docs/09 §1)' }]
        : [] },
  { id: 'D5', canon: 'docs/10 §1 H13 + docs/11 §2 + docs/13 §3.7',
    appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'),
    check: (f) => /(ctx\.skills|skills\/change|SkillSummary|SkillDefinition|@deepseek-ai\/dsh-skill)/.test(f.text)
      && f.path !== 'src/platform/skills.ts' && f.path !== 'src/index.ts'
      ? [{ message: 'skill registry concepts must only appear in platform/skills.ts (index.ts wiring allowed, docs/10 §1 H13)' }]
      : [] },
  { id: 'D6', canon: 'docs/10 §1 H12 + docs/11 §2 + docs/12 §1 C2',
    appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'),
    check: (f) => /(ctx\.llm|llm\/stream|llm\.stream|\bGenerateOptions\b|\bTokenUsage\b|\bStreamChunk\b|\bLlmRuntime\b)/.test(f.text)
      && f.path !== 'src/platform/llm.ts'
      ? [{ message: 'llm service concepts must only appear in platform/llm.ts (H12 辅助调用端口收口, docs/10 §1 H12)' }]
      : [] },

  { id: 'D7', canon: 'docs/10 §1 H4/H5（compaction/* 全族）+ docs/11 §2 history.ts', appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'), check: (f) =>
    /(CompactionId|compaction\/start|compaction\/end|compaction\/prune|compaction\/summary|toolPairingBalanced|@deepseek-ai\/dsh-compaction)/.test(f.text)
      && f.path !== 'src/platform/history.ts'
      ? [{ message: 'history protocol concepts (H4/H5 compaction/* + pairing guard) must only appear in src/platform/history.ts (docs/10 §1 H4/H5)' }]
      : [] },
  { id: 'D8', canon: 'docs/10 §1 H6 + docs/11 §2 + docs/13 §3.9', appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'), check: (f) =>
    /(tools\/execute|tools\/post-execute|PostToolDecision|ToolDispatchExecution|ToolExecutionResult|\bToolExecution\b|@deepseek-ai\/dsh-tools)/.test(f.text)
      && f.path !== 'src/platform/tools.ts'
      ? [{ message: 'tool event concepts must only appear in platform/tools.ts (H6 工具端口收口, docs/10 §1 H6)' }]
      : [] },
  { id: 'D9', canon: 'docs/10 §1 H11 + docs/11 §2 + docs/13 §3.11', appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'), check: (f) =>
    /(ctx\.connection|connection\.rpc|ConnectionRpcResult|ConnectionRpcHandler|HostConnectionRpc|ClientConnectionRpc|@deepseek-ai\/dsh-client-connection)/.test(f.text)
      && f.path !== 'src/platform/star-bridge.ts' && f.path !== 'src/index.ts'
      ? [{ message: 'connection RPC bridge concepts must only appear in src/platform/star-bridge.ts (index.ts wiring allowed, docs/13 §3.11)' }]
      : [] },
  { id: 'D10', canon: 'docs/05 确定性优先 + docs/11 §9', appliesTo: (p) => p.startsWith('src/core/shear/'), check: (f) =>
    // 剪切纯核 = 确定性 fold（同输入同账）：时钟/随机一律不许出现（P15b 起进 CI）。
    [/\bMath\.random\(/, /\bDate\.now\(/, /\bnew Date\(/]
      .filter((re) => re.test(f.text))
      .map((re) => ({ message: `core/shear must stay deterministic (no clock/random), matches ${re}` })) },
  { id: 'D11', canon: 'docs/10 §1 H15 + docs/11 §2 + docs/04 §2 通道 A',
    appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'),
    check: (f) =>
      // 盘上取真收口（P17b）：fs 服务概念只许居于 platform/files.ts——上游换后端只改这一处。
      /(ctx\.fs\b|ctx\.get\(['"]fs['"]\)|@deepseek-ai\/dsh-fs|\bFileSystem\b|\bFsTarget\b|\bFsVersion\b|\bFsInfo\b|\breadText\(|\bstreamText\()/.test(f.text)
        && f.path !== 'src/platform/files.ts'
        ? [{ message: 'filesystem concepts must only appear in src/platform/files.ts (H15 盘上取真收口, docs/10 §1 H15)' }]
        : [] },
  { id: 'D12', canon: 'docs/05 确定性优先 + docs/11 §9（装配器确定性）',
    appliesTo: (p) => p.startsWith('src/core/assemble/'),
    check: (f) =>
      // 装配纯核 = 字节稳定 fold（同输入同装配字节）：时钟/随机一律不许出现（P17a 起进 CI）。
      [/\bMath\.random\(/, /\bDate\.now\(/, /\bnew Date\(/]
        .filter((re) => re.test(f.text))
        .map((re) => ({ message: `core/assemble must stay deterministic (no clock/random), matches ${re}` })) },
  { id: 'D15', canon: 'docs/10 §1 H7 + docs/04 §1（影子价同源）',
    appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'),
    check: (f) =>
      // 计量服务收口（P19b）：token-meter 概念只许居于 platform/meter.ts（index.ts 接线允许）——
      // 影子价必须与 harness 固定估计器同源，换估计器只改这一处。
      /(ctx\.tokenMeter|@deepseek-ai\/dsh-token-meter|\bTokenMeter\b|\bTokenMeasurement\b|\bheuristicTokens\b)/.test(f.text)
        && f.path !== 'src/platform/meter.ts' && f.path !== 'src/index.ts'
        ? [{ message: 'token-meter concepts must only appear in src/platform/meter.ts (index.ts wiring allowed, docs/04 §1 影子价同源)' }]
        : [] },
  { id: 'D14', canon: 'docs/10 §1 H2/H3 + docs/11 §2（步准入与请求失败端口收口）',
    appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'),
    check: (f) =>
      // H2/H3 收口（P19a + P20b）：agent/pre-step 与 agent/request-error waterfall、dsh-agent 类型面
      // 只许居于 platform/agent-step.ts——域侧只见 { session, turn, step } 与 'retry'/'pass' 词汇。
      /(agent\/pre-step|agent\/request-error|@deepseek-ai\/dsh-agent|\bPreStepDecision\b|\bRequestErrorAction\b|\bAgentPreStepPayload\b|\bAgentRequestErrorPayload\b)/.test(f.text)
        && f.path !== 'src/platform/agent-step.ts'
        ? [{ message: 'agent/pre-step concepts must only appear in src/platform/agent-step.ts (H2/H3 端口收口；含 agent/request-error, docs/10 §1)' }]
        : [] },
  { id: 'D17', canon: 'docs/05 确定性优先 + docs/11 §9（恢复纯核确定性）',
    appliesTo: (p) => p.startsWith('src/core/restore/'),
    check: (f) =>
      // 恢复纯核 = 确定性审计/重放（同输入同账）：时钟/随机一律不许出现（P21a 起进 CI；at 由域侧传入）。
      [/\bMath\.random\(/, /\bDate\.now\(/, /\bnew Date\(/]
        .filter((re) => re.test(f.text))
        .map((re) => ({ message: `core/restore must stay deterministic (no clock/random), matches ${re}` })) },
  { id: 'D16', canon: 'docs/10 §1 H9 + docs/11 §2（恢复端口收口）',
    appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'),
    check: (f) =>
      // H9 收口（P21a）：agent/session-start 字面与 SessionStartSource 类型面只许居于
      // platform/agent-step.ts——域侧只见 { session, source }。
      /(agent\/session-start|\bSessionStartSource\b|\bAgentSessionStartPayload\b)/.test(f.text)
        && f.path !== 'src/platform/agent-step.ts' && f.path !== 'src/index.ts'
        ? [{ message: 'agent/session-start concepts must only appear in src/platform/agent-step.ts (H9 端口收口, docs/10 §1)' }]
        : [] },
  { id: 'D13', canon: 'docs/05 确定性优先 + docs/11 §9（压缩调用确定性）',
    appliesTo: (p) => p.startsWith('src/core/compress/'),
    check: (f) =>
      // 压缩调用纯核 = 字节稳定渲染/校验（同输入同字节）：时钟/随机一律不许出现（P18 起进 CI）。
      [/\bMath\.random\(/, /\bDate\.now\(/, /\bnew Date\(/]
        .filter((re) => re.test(f.text))
        .map((re) => ({ message: `core/compress must stay deterministic (no clock/random), matches ${re}` })) },
]

/** CLI：文本（默认，按规则 id 排序 + fail 明细缩进两格）或 --json（schema 冻结）。 */
export function main(argv = process.argv.slice(2)) {
  try {
    const result = runRules(collectFiles(ROOT))
    if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2))
    else {
      for (const id of Object.keys(result.rules).sort()) {
        console.log(`${id} ${result.rules[id].status.toUpperCase()} ${RULES.find((r) => r.id === id)?.canon}`)
        for (const i of result.issues) if (i.rule === id) console.log(`  - ${i.path}${i.line == null ? '' : `:${i.line}`} ${i.message}`)
      }
      console.log(`ok=${result.ok} vacuous=[${result.vacuous.sort().join(',')}]`)
    }
    return result.ok ? 0 : 1
  } catch (e) {
    console.error(`assert-structure: engine error: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
}

if (process.argv[1] != null && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) process.exitCode = main()

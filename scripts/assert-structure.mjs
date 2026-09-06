#!/usr/bin/env node
/**
 * 结构断言引擎（P0 工单 §3.1）——docs/11 §1 manifest 表 / §2 依赖铁律 / §4 日志纪律① /
 * §9 结构验收 + docs/10 §1 H4（改史唯一通道）固化为离线机械断言。
 * 规则命名空间：M=manifest，S=structure，D=域规则（P6 起）。后续工单只追加规则 + 更新
 * tests/assert-structure.spec.ts 零位快照 + 补负/正样本，引擎与 CLI 零改动（P0 §8-1）。
 * 输出确定性（P0 §6-2）：无时间戳、无 ANSI 颜色、路径一律 '/' 分隔；--json schema 冻结（P0 §8-2）。
 * exit：0 = 全过（含 vacuous）；1 = 有 fail；2 = 引擎自身异常（如 package.json 解析失败）。
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
const ROOT_MANIFESTS = ['package.json', 'cordis.patch.yml', 'tsdown.config.ts', 'vitest.config.ts']
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

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
  const rules = {}
  const issues = []
  const vacuous = []
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

/** @type {Rule[]} 规则表（P0 §3.1 表逐条；语义冻结，改动只许追加）。 */
export const RULES = [
  { id: 'M1', canon: 'docs/11 §1 表', appliesTo: (p) => p === 'package.json', check: (f) => {
    const pkg = JSON.parse(f.text)
    const out = []
    if (pkg.name !== '@dsh-external/dsh-context-economy') out.push({ message: `name must be '@dsh-external/dsh-context-economy', got ${JSON.stringify(pkg.name ?? null)}` })
    if (!/^\d+\.\d+\.\d+/.test(String(pkg.version))) out.push({ message: `version must match /^\\d+\\.\\d+\\.\\d+/, got ${JSON.stringify(pkg.version ?? null)}` })
    return out } },
  { id: 'M2', canon: 'docs/11 §1 表', appliesTo: (p) => p === 'package.json', check: (f) => {
    const peers = JSON.parse(f.text).peerDependencies ?? {}
    const out = []
    for (const key of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-settings', 'schemastery']) {
      const v = peers[key]
      if (typeof v !== 'string' || !/[<^~>=]/.test(v)) out.push({ message: `peerDependencies.${key} missing or hardcoded exact version (range required), got ${JSON.stringify(v ?? null)}` })
    }
    return out } },
  { id: 'M3', canon: 'docs/11 §1 表', appliesTo: (p) => p === 'package.json', check: (f, all) => {
    const patch = (JSON.parse(f.text).dsh ?? {}).bundle?.patch
    const out = []
    if (patch !== './cordis.patch.yml') out.push({ message: `dsh.bundle.patch must be './cordis.patch.yml', got ${JSON.stringify(patch ?? null)}` })
    if (!all.has('cordis.patch.yml')) out.push({ message: 'cordis.patch.yml not found in file set' })
    return out } },
  { id: 'M4', canon: 'docs/11 §1 表 + package.json', appliesTo: (p) => p === 'package.json', check: (f) => {
    const pkg = JSON.parse(f.text)
    const c = (pkg.dsh ?? {}).client ?? {}
    const out = []
    if (c.platform !== 'web') out.push({ message: `dsh.client.platform must be 'web', got ${JSON.stringify(c.platform ?? null)}` })
    if (!Array.isArray(c.inject) || !c.inject.includes('react') || !c.inject.includes('@deepseek-ai/dsh-client-ui-slots')) out.push({ message: "dsh.client.inject must be an array containing 'react' and '@deepseek-ai/dsh-client-ui-slots'" })
    if (pkg.exports?.['./client'] == null) out.push({ message: "exports['./client'] missing" })
    return out } },
  { id: 'M5', canon: 'docs/11 §1 表（入口铁律）', appliesTo: (p) => p === 'src/index.ts' || p === 'client/index.ts', check: (f) => {
    const reqs = f.path === 'src/index.ts'
      ? [['export const name', 'name'], ['export function apply', 'apply'], [/export\s*\{[^}]*\bConfig\b[^}]*\}/, 'Config re-export']]
      : [['export const name', 'name'], ['export const inject', 'inject'], ['export function apply', 'apply']]
    const out = []
    for (const [pat, label] of reqs) {
      const hit = pat instanceof RegExp ? pat.test(f.text) : f.text.includes(pat)
      if (!hit) out.push({ message: `missing required export: ${label}` })
    }
    return out } },
  { id: 'S1', canon: 'docs/11 §2 依赖铁律 + §9', appliesTo: (p) => p.startsWith('src/core/'), check: (f) => {
    const out = []
    for (const re of [/from\s+['"]@deepseek-ai\//, /from\s+['"]cordis/, /from\s+['"][^'"]*platform/]) {
      if (re.test(f.text)) out.push({ message: `core must not import harness/platform (type-only included), matches ${re}` })
    }
    return out } },
  { id: 'S2', canon: 'docs/11 §9 + 10 §1 H4', appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'), check: (f) =>
    /surfaceOp|sourceEventSeqs|\.append\(/.test(f.text) && f.path !== 'src/platform/history.ts'
      ? [{ message: 'surface history mutation keywords (surfaceOp/sourceEventSeqs/.append) must only appear in src/platform/history.ts' }]
      : [] },
  { id: 'S3', canon: 'docs/11 §4 纪律①', appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'), check: (f) => {
    const out = []
    const lines = f.text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trimStart()
      if (!/['"]context-economy\//.test(lines[i]) || t.startsWith('//') || t.startsWith('*')) continue
      if (!/ignorable/.test(lines.slice(Math.max(0, i - 1), i + 4).join('\n'))) out.push({ line: i + 1, message: "'context-economy/*' event anchor without 'ignorable' in window [i-1, i+3] (heuristic v1, 11 §4 纪律①)" })
    }
    return out } },
  { id: 'S4', canon: 'docs/11 §2 依赖铁律', appliesTo: (p) => p.startsWith('client/'), check: (f) =>
    /from\s+['"][^'"]*\.\.\/src\//.test(f.text) ? [{ message: 'client must not import host src via ../src/' }] : [] },
  { id: 'S5', canon: 'docs/11 §2（无 timer）', appliesTo: (p) => p.startsWith('src/') || p.startsWith('client/'), check: (f) =>
    f.text.includes('setInterval(') ? [{ message: 'timer forbidden: host half is event-driven, no polling loop (docs/11 §2)' }] : [] },
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

#!/usr/bin/env node
/**
 * 安装 dsh-price-less 预设到用户预设根（presets/price-less/；N3 协商通道已退役，docs/legacy.md §9）。
 * 只写 `$DSH_HOME/.agent-presets/<name>/`（用户可控目录），不动其它任何路径；幂等覆盖。
 * 用法：node scripts/install-preset.mjs [--name price-less] [--dry-run]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const name = argOf('--name', 'price-less')
if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error(`install-preset: 非法预设 id "${name}"（只允许小写字母/数字/连字符）。`)
  process.exit(1)
}
const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const src = path.join(ROOT, 'presets', name)
const dst = path.join(home, '.agent-presets', name)
if (!fs.existsSync(path.join(src, 'agent.cordis.yml'))) {
  console.error(`install-preset: 仓库内没有预设 ${src}\n可用预设：${fs.existsSync(path.join(ROOT, 'presets')) ? fs.readdirSync(path.join(ROOT, 'presets')).join(', ') : '(无)'}`)
  process.exit(1)
}
/**
 * 逐文件比对源与目标（用户预设根是**手装**的输入，不随包更新 ⇒ 漂移是常态；
 * 2026-09-11 实测主目录那份落后仓内源 45 行，连 N 系列时代的描述都还在）。
 * @returns 有差异的文件数（新增 + 更新）
 */
function drift() {
  let n = 0
  for (const f of fs.readdirSync(src)) {
    if (!fs.statSync(path.join(src, f)).isFile()) continue
    const a = fs.existsSync(path.join(dst, f)) ? fs.readFileSync(path.join(dst, f), 'utf8') : undefined
    const b = fs.readFileSync(path.join(src, f), 'utf8')
    const state = a === undefined ? 'create' : a === b ? 'same' : 'update'
    if (state !== 'same') n++
    console.log(`  ${state.padEnd(6)} ${f}${state === 'same' ? '' : `  (${a?.length ?? 0} → ${b.length} B)`}`)
  }
  return n
}

if (argv.includes('--check')) {
  const n = drift()
  console.log(`install-preset --check: ${name} — ${n} file(s) differ from ${src}`)
  process.exit(n === 0 ? 0 : 1)
}
if (argv.includes('--dry-run')) {
  console.log(`[dry-run] ${src} -> ${dst}`)
  drift()
  process.exit(0)
}
fs.mkdirSync(path.dirname(dst), { recursive: true })
const drifted = drift()
fs.cpSync(src, dst, { recursive: true, force: true })
console.log(`install-preset: ${name} -> ${dst}（${drifted} 个文件更新）`)
console.log('新开会话时在预设选择器里选「价格低耗」；已在跑的会话不受影响。')
console.log('注意：本预设的 compaction 组挂的是 dsh-price-less/provider ⇒ 需宿主已加载含该入口的 lib/（重启后生效）。')

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
if (argv.includes('--dry-run')) {
  console.log(`[dry-run] ${src} -> ${dst}`)
  for (const f of fs.readdirSync(src)) console.log(`  ${f}`)
  process.exit(0)
}
fs.mkdirSync(path.dirname(dst), { recursive: true })
fs.cpSync(src, dst, { recursive: true, force: true })
console.log(`install-preset: ${name} -> ${dst}`)
console.log('新开会话时在预设选择器里选「价格低耗」；已在跑的会话不受影响。')

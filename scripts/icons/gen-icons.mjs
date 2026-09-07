/**
 * gen-icons.mjs —— 图标生成管线（sharp / libvips = 成熟 SVG 渲染引擎）。
 *
 * - 官方鲸鱼路径：从 DSH_CHECKOUT 的 FishLogo.tsx 提取（单源，不手抄），
 *   落盘 scripts/icons/whale-official.json（版本化，带出处）。
 * - 源 SVG：scripts/icons/src/*.svg，内嵌 {{FISH}} 占位符会被替换为官方路径。
 * - 输出：docs/icons/<stem>.png（512×512 成品）；小尺寸预览进 .tmp-icons/out/（gitignored）。
 *
 * 用法：
 *   node scripts/icons/gen-icons.mjs            # 全部渲染
 *   node scripts/icons/gen-icons.mjs --measure  # 测官方鲸鱼 bbox（定位用）
 *   node scripts/icons/gen-icons.mjs --only a   # 只渲染指定源
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const ICONS = join(__dirname)            // scripts/icons/
const SRC = join(ICONS, 'src')
const OUT = join(ROOT, 'docs', 'icons')
const SCRATCH = join(ROOT, '.tmp-icons', 'out')
const DSH = process.env.DSH_CHECKOUT || (existsSync('G:/deepseek-harness') ? 'G:/deepseek-harness' : null)
const require = createRequire(import.meta.url)

const OFFICIAL_FISH = join(ICONS, 'whale-official.json')

/* ---------- sharp 解析（成熟引擎，零安装） ---------- */
function resolveSharp() {
  if (!DSH || !existsSync(DSH)) throw new Error('DSH_CHECKOUT 未设置或不存在：需要含 sharp 的 harness checkout')
  const pnpm = join(DSH, 'node_modules', '.pnpm')
  if (existsSync(pnpm)) {
    for (const dir of readdirSync(pnpm)) {
      if (dir.startsWith('sharp@')) {
        const p = join(pnpm, dir, 'node_modules', 'sharp')
        if (existsSync(join(p, 'package.json'))) return p
      }
    }
  }
  for (const c of [join(DSH, 'apps', 'web', 'node_modules', 'sharp'), join(DSH, 'node_modules', 'sharp')]) {
    if (existsSync(join(c, 'package.json'))) return c
  }
  throw new Error('sharp 未在 harness checkout 中找到')
}

/* ---------- 官方鲸鱼路径提取（单源） ---------- */
function extractOfficialFish() {
  const src = join(DSH, 'packages', 'client', 'ui-primitives', 'src', 'FishLogo.tsx')
  const text = readFileSync(src, 'utf8')
  const m = text.match(/FISH_LOGO_PATH = '([^']+)'/)
  if (!m) throw new Error('FishLogo.tsx 中未找到 FISH_LOGO_PATH')
  const json = {
    source: join(DSH.split(/:|\//).pop(), 'packages/client/ui-primitives/src/FishLogo.tsx'),
    viewBox: { width: 23.16, height: 17.04 },
    path: m[1],
  }
  const existing = existsSync(OFFICIAL_FISH) ? readFileSync(OFFICIAL_FISH, 'utf8') : null
  const next = JSON.stringify(json, null, 1)
  if (existing !== next) writeFileSync(OFFICIAL_FISH, next)
  return json
}

/* ---------- 渲染 ---------- */
const sharp = require(resolveSharp())

async function renderTo(svgText, size, file) {
  const buf = Buffer.from(svgText)
  await sharp(buf).resize(size, size, { fit: 'contain' }).png().toFile(file)
}

async function renderAll(svgText, stem) {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(SCRATCH, { recursive: true })
  await renderTo(svgText, 512, join(OUT, `${stem}.png`))
  for (const s of [128, 64, 48, 32]) {
    await renderTo(svgText, s, join(SCRATCH, `${stem}@${s}.png`))
  }
  console.log(`rendered ${stem}: docs/icons/${stem}.png (512) + previews 128/64/48/32`)
}

/* ---------- bbox 测量（定位布局用） ---------- */
async function measure(fish) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="magenta"/><path d="${fish.path}" fill="white" transform="translate(0 0) scale(22.11)"/></svg>`
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
      const isWhite = a > 200 && r > 200 && g > 200 && b > 200
      if (isWhite) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  const s = 22.11
  console.log(`bbox @scale(${s})： x [${minX},${maxX}] y [${minY},${maxY}]  →  path 单位 x [${(minX / s).toFixed(2)},${(maxX / s).toFixed(2)}] y [${(minY / s).toFixed(2)},${(maxY / s).toFixed(2)}]`)
  console.log(`body(左半) 竖直范围 y=[${(minY / s).toFixed(2)},${(maxY / s).toFixed(2)}]，眼点参考 x≈14.46 y≈11.25`)
}

/* ---------- 主流程 ---------- */
const args = process.argv.slice(2)
const fish = extractOfficialFish()
console.log(`官方鲸鱼路径：${fish.path.length} chars（${fish.viewBox.width}×${fish.viewBox.height}）`)

if (args.includes('--measure')) {
  await measure(fish)
  process.exit(0)
}

const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const sources = readdirSync(SRC).filter(f => f.endsWith('.svg') && (only ? f.startsWith(only) : true))
if (sources.length === 0) { console.error('src 目录为空或 --only 无匹配'); process.exit(1) }
for (const f of sources) {
  if (!f.includes('{{FISH}}') && !readFileSync(join(SRC, f), 'utf8').includes('{{FISH}}')) continue
  const svg = readFileSync(join(SRC, f), 'utf8').replaceAll('{{FISH}}', fish.path)
  await renderAll(svg, f.replace(/\.svg$/, ''))
}
console.log('done')
